// Updated: 2026-04-26 — new standalone buildVisitIndex Lambda handler
// Mirrors the VI pre-pass from generateSummaryWorker exactly (callBedrock + file_key)

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');

const REGION = process.env.AWS_REGION || 'us-east-1';
const DOCS_TABLE = process.env.DOCUMENTS_TABLE || 'chartreview-documents-prod';
const BUCKET = process.env.S3_BUCKET || 'chartreview-documents-prod';
const API_KEY = process.env.API_KEY || '';

const BEDROCK_MODELS = [
  'us.anthropic.claude-sonnet-4-6',
  'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
];

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const bedrock = new BedrockRuntimeClient({ region: REGION });
const s3 = new S3Client({ region: REGION });

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,x-api-key,x-org-id',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
};

const respond = (statusCode, body) => ({
  statusCode,
  headers: { ...CORS, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

// ── Auth ──────────────────────────────────────────────────────────────────────
const authenticate = (event) => {
  const key = event.headers?.['x-api-key'] || event.headers?.['X-Api-Key'] || '';
  return key === API_KEY;
};

// ── callBedrock: identical to generate_summary.js ────────────────────────────
const callBedrock = async (fileKeys, prompt, schema) => {
  const contentBlocks = [];
  for (const fileKey of fileKeys) {
    const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: fileKey }));
    const chunks = [];
    for await (const chunk of obj.Body) chunks.push(chunk);
    const pdfBase64 = Buffer.concat(chunks).toString('base64');
    contentBlocks.push({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 },
    });
  }
  contentBlocks.push({ type: 'text', text: prompt });

  const bedrockPayload = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 8000,
    messages: [{ role: 'user', content: contentBlocks }],
    tools: [{
      name: 'structured_output',
      description: 'Return structured data',
      input_schema: schema,
    }],
    tool_choice: { type: 'tool', name: 'structured_output' },
  };

  let lastErr;
  for (const modelId of BEDROCK_MODELS) {
    try {
      console.log(`callBedrock: trying model ${modelId}`);
      const cmd = new InvokeModelCommand({
        modelId,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify(bedrockPayload),
      });
      const res = await bedrock.send(cmd);
      const parsed = JSON.parse(Buffer.from(res.body).toString('utf-8'));
      const toolUse = parsed.content?.find(b => b.type === 'tool_use');
      if (!toolUse) throw new Error('Bedrock returned no tool_use block');
      console.log(`callBedrock: success with model ${modelId}`);
      return toolUse.input;
    } catch (err) {
      const isThrottle = err.message?.includes('Too many tokens') ||
                         err.name === 'ThrottlingException' ||
                         err.$metadata?.httpStatusCode === 429;
      console.warn(`callBedrock: model ${modelId} failed — ${err.message}`);
      lastErr = err;
      if (!isThrottle) throw err;
    }
  }
  throw lastErr;
};

// ── resolveFileKey: identical to generate_summary.js ─────────────────────────
const resolveFileKey = (doc) => {
  if (doc.file_key) return doc.file_key;
  if (doc.org_id && doc.aws_document_id && doc.file_name) {
    return `orgs/${doc.org_id}/documents/${doc.aws_document_id}/${doc.file_name}`;
  }
  return null;
};

// ── VI prompt: identical to generate_summary.js ───────────────────────────────
const buildVisitIndexPrompt = () => `You are reviewing medical-legal documents. Your ONLY task is to extract a complete list of every clinical encounter date found in the document.

For each clinical encounter found, extract:
1. date - the date of service (YYYY-MM-DD format). PRIMARY SOURCE: the document header or note title (e.g. "Visit Note - November 7, 2022"). Do NOT use dates mentioned in the HPI, injury narrative, or referral text as visit dates.
2. provider - the treating provider's name and credentials (e.g. "Arthur J. Taylor, MD")
3. facility - the facility or practice name (e.g. "Nevada Orthopedic & Spine Center", "Centennial Hills Hospital Emergency Department")
4. visit_type - a brief label: "Office Visit", "ER Visit", "Surgery", "Physical Therapy", "Radiology", "C-4 Form", "IME", "Chiropractic", "Ambulance", etc.

RULES:
- Include EVERY encounter -- office visits, ER, surgery, PT/OT, radiology, C-4 forms, IMEs, ambulance, etc.
- Each unique date + provider combination is a separate entry.
- Do NOT include administrative documents (therapy orders, authorization requests, appointment reminders, fax covers).
- ONLY include radiology visits (MRI, X-ray, CT, bone scan, etc.) if the actual radiology report document is present in the text -- not just an order or reference to imaging.
- CRITICAL: The HPI section often mentions the date of injury (e.g. "injury date 10/31/2022") -- this is NOT the visit date. The visit date is always in the document header.
- IMPORTANT: Textract OCR may output page footers and headers from adjacent pages mixed into the text stream. Always look for the primary document header date.
- Do NOT include the date of injury as a visit date unless confirmed by a "Visit Note [date]" header on that exact date.
- Keep it fast and simple -- no clinical content needed, just date/provider/facility/type.
- If a date appears in a document header but no provider is identifiable, still include the entry with provider as "Not Documented".

Return all entries in the visits array.`;

const viSchema = {
  type: 'object',
  properties: {
    patient_name: { type: 'string' },
    visits: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          date: { type: 'string' },
          provider: { type: 'string' },
          facility: { type: 'string' },
          visit_type: { type: 'string' },
        },
      },
    },
  },
};

// ── Handler ───────────────────────────────────────────────────────────────────
exports.buildVisitIndexHandler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return respond(200, {});
  if (!authenticate(event)) return respond(401, { error: 'Unauthorized' });

  const orgId = event.headers?.['x-org-id'] || event.headers?.['X-Org-Id'] || '';
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return respond(400, { error: 'Invalid JSON' }); }

  const { doc_ids } = body; // array of aws_document_ids (parts, not shells)
  if (!Array.isArray(doc_ids) || doc_ids.length === 0) {
    return respond(400, { error: 'doc_ids array required' });
  }

  console.log(`buildVisitIndex: org=${orgId}, doc_ids=${JSON.stringify(doc_ids)}`);

  try {
    // Fetch DynamoDB records for all requested IDs
    const docRecords = [];
    for (const id of doc_ids) {
      const r = await dynamo.send(new GetCommand({ TableName: DOCS_TABLE, Key: { aws_document_id: id } }));
      if (r.Item) docRecords.push(r.Item);
      else console.warn(`buildVisitIndex: not found in DynamoDB: ${id}`);
    }

    // Build parts list with file_key (skip fully non-clinical)
    const allParts = [];
    for (const doc of docRecords) {
      const fileKey = resolveFileKey(doc);
      if (!fileKey) { console.warn(`buildVisitIndex: no file_key for ${doc.aws_document_id}`); continue; }
      const pc = doc.page_classifications || [];
      const allNonClinical = pc.length > 0 && pc.every(p => !p.is_clinical && !p.restored);
      if (allNonClinical) { console.log(`buildVisitIndex: skipping non-clinical ${doc.aws_document_id}`); continue; }
      allParts.push({ id: doc.aws_document_id, file_key: fileKey, label: doc.file_name || doc.aws_document_id });
    }

    console.log(`buildVisitIndex: ${allParts.length} parts to process`);

    // VI pre-pass — parallel with concurrency 4 (identical to generateSummaryWorker)
    const VI_CONCURRENCY = 4;
    const viResults = new Array(allParts.length).fill(null);

    for (let vi = 0; vi < allParts.length; vi += VI_CONCURRENCY) {
      const viChunk = allParts.slice(vi, vi + VI_CONCURRENCY);
      await Promise.all(viChunk.map(async (viPart, chunkIdx) => {
        const partIdx = vi + chunkIdx;
        try {
          const viResult = await callBedrock([viPart.file_key], buildVisitIndexPrompt(), viSchema);
          if (Array.isArray(viResult.visits)) {
            viResults[partIdx] = viResult.visits
              .filter(v => v.date && /^\d{4}-\d{2}-\d{2}$/.test(v.date));
          }
          console.log(`VI: ${viPart.label} -> ${(viResults[partIdx] || []).length} visits`);
        } catch (e) {
          console.warn(`VI failed for ${viPart.id}: ${e.message}`);
        }
      }));
    }

    let allEntries = [];
    let patientName = '';
    for (const tagged of viResults) {
      if (tagged) allEntries = allEntries.concat(tagged);
    }

    // Deduplicate by date+provider
    const seen = new Set();
    allEntries = allEntries.filter(v => {
      const k = `${v.date}|${(v.provider || '').toLowerCase().trim()}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    // Exclude pure admin entries
    allEntries = allEntries.filter(v =>
      !/admin|fax|authorization|reminder|order/i.test(v.visit_type || '')
    );

    // Sort chronologically
    allEntries.sort((a, b) => (a.date || '').localeCompare(b.date || ''));

    console.log(`buildVisitIndex: complete, ${allEntries.length} visits`);
    return respond(200, { visits: allEntries, patient_name: patientName });

  } catch (err) {
    console.error('buildVisitIndex error:', err);
    return respond(500, { error: err.message });
  }
};

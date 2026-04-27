// build_visit_index.js
// Updated: 2026-04-26 — standalone Visit Index Lambda, zero shared code with generateSummaryWorker
// Triggered by POST /visit-index/build
// Accepts: { doc_ids: string[], org_id: string }
// Creates a job, invokes self async, returns { job_id }
// Worker: reads docs from DynamoDB, runs VI pre-pass via Bedrock, writes known_visits to job record

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
const { randomUUID } = require('crypto');

const dynamo  = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const bedrock = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'us-east-1' });
const s3      = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });
const lambda  = new LambdaClient({ region: process.env.AWS_REGION || 'us-east-1' });

const DOCS_TABLE  = process.env.DOCUMENTS_TABLE  || 'chartreview-documents-prod';
const JOBS_TABLE  = process.env.JOBS_TABLE        || 'chartreview-jobs-prod';
const S3_BUCKET   = process.env.S3_BUCKET         || 'chartreview-documents-prod';
const API_KEY     = process.env.API_KEY            || '';
const WORKER_FN   = process.env.VI_WORKER_FUNCTION || 'chartreview-pro-prod-buildVisitIndexWorker';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type,x-api-key,x-org-id',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
};

// ─── Auth helper ──────────────────────────────────────────────────────────────
const checkAuth = (event) => {
  const key = event.headers?.['x-api-key'] || event.headers?.['X-Api-Key'] || '';
  return key === API_KEY;
};

// ─── Job helpers ──────────────────────────────────────────────────────────────
const createJob = async (job_id, org_id) => {
  await dynamo.send(new UpdateCommand({
    TableName: JOBS_TABLE, Key: { job_id },
    UpdateExpression: 'SET #s = :s, org_id = :o, created_at = :now, updated_at = :now, job_type = :t',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':s': 'running', ':o': org_id, ':now': new Date().toISOString(), ':t': 'visit_index' },
  }));
};

const markJobComplete = async (job_id, result) => {
  await dynamo.send(new UpdateCommand({
    TableName: JOBS_TABLE, Key: { job_id },
    UpdateExpression: 'SET #s = :s, #res = :r, updated_at = :now',
    ExpressionAttributeNames: { '#s': 'status', '#res': 'result' },
    ExpressionAttributeValues: { ':s': 'complete', ':r': result, ':now': new Date().toISOString() },
  }));
};

const markJobFailed = async (job_id, msg) => {
  await dynamo.send(new UpdateCommand({
    TableName: JOBS_TABLE, Key: { job_id },
    UpdateExpression: 'SET #s = :s, error_message = :e, updated_at = :now',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':s': 'failed', ':e': msg, ':now': new Date().toISOString() },
  }));
};

// ─── Fetch doc records ────────────────────────────────────────────────────────
const fetchDocRecords = async (docIds) => {
  const records = [];
  for (const id of docIds) {
    const r = await dynamo.send(new GetCommand({ TableName: DOCS_TABLE, Key: { aws_document_id: id } }));
    if (r.Item) records.push(r.Item);
    else console.warn(`fetchDocRecords: not found: ${id}`);
  }
  return records;
};

// ─── Resolve S3 file key ──────────────────────────────────────────────────────
const resolveFileKey = (doc) => {
  if (doc.file_key) return doc.file_key;
  if (doc.org_id && doc.aws_document_id && doc.file_name)
    return `orgs/${doc.org_id}/documents/${doc.aws_document_id}/${doc.file_name}`;
  return null;
};

// ─── Bedrock call (PDF vision) ────────────────────────────────────────────────
const MODELS = [
  'us.anthropic.claude-sonnet-4-5-20251125-v1:0',
  'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
];

const callBedrock = async (fileKeys, prompt, schema) => {
  const content = [];
  for (const key of fileKeys) {
    try {
      const obj = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }));
      const chunks = [];
      for await (const chunk of obj.Body) chunks.push(chunk);
      const b64 = Buffer.concat(chunks).toString('base64');
      content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } });
    } catch (e) {
      console.warn(`callBedrock: S3 read failed for ${key}: ${e.message}`);
    }
  }
  if (content.length === 0) throw new Error('No S3 files loaded');
  content.push({ type: 'text', text: prompt });

  const body = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 4096,
    messages: [{ role: 'user', content }],
    tools: [{ name: 'respond', description: 'Respond with structured data', input_schema: schema }],
    tool_choice: { type: 'tool', name: 'respond' },
  };

  for (const modelId of MODELS) {
    try {
      const res = await bedrock.send(new InvokeModelCommand({
        modelId, body: JSON.stringify(body), contentType: 'application/json', accept: 'application/json',
      }));
      const parsed = JSON.parse(Buffer.from(res.body).toString());
      const toolUse = parsed.content?.find(b => b.type === 'tool_use');
      if (toolUse?.input) return toolUse.input;
      throw new Error('No tool_use in response');
    } catch (e) {
      console.warn(`Bedrock model ${modelId} failed: ${e.message}`);
    }
  }
  throw new Error('All Bedrock models failed');
};

// ─── VI prompt ────────────────────────────────────────────────────────────────
const buildVisitIndexPrompt = () => `You are reviewing medical-legal documents. Your ONLY task is to extract a complete list of every clinical encounter from the document text provided.

For each clinical encounter found, extract:
1. date - the date of service (YYYY-MM-DD format). PRIMARY SOURCE: the document header or note title.
2. provider - the treating provider's name and credentials (e.g. "Arthur J. Taylor, MD")
3. facility - the facility or practice name
4. visit_type - a brief label: "Office Visit", "ER Visit", "Surgery", "Physical Therapy", "Radiology", "C-4 Form", "IME", etc.

RULES:
- Include EVERY encounter -- office visits, ER, surgery, PT/OT, radiology, C-4 forms, IMEs, etc.
- Each unique date + provider combination is a separate entry.
- Do NOT include administrative documents (therapy orders, authorization requests, appointment reminders, fax covers).
- ONLY include radiology visits if the actual radiology report is present in the document.
- CRITICAL: The HPI section often mentions the date of injury -- this is NOT the visit date.
- Do NOT include the date of injury as a visit date unless confirmed by a "Visit Note [date]" header on that exact date.
- Keep it fast and simple -- no clinical content needed, just date/provider/facility/type.
- If a date appears in a document header but no provider is identifiable, still include the entry with provider as "Not Documented".

Return all entries in the visits array.`;

// ─── VI Schema ───────────────────────────────────────────────────────────────
const VI_SCHEMA = {
  type: 'object',
  properties: {
    patient_name: { type: 'string' },
    visits: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          date:      { type: 'string' },
          provider:  { type: 'string' },
          facility:  { type: 'string' },
          visit_type:{ type: 'string' },
        },
      },
    },
  },
};

// ─── Start handler (returns job_id immediately) ───────────────────────────────
const buildVisitIndexStart = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (!checkAuth(event)) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Unauthorized' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { body = {}; }
  const { doc_ids = [], org_id } = body;
  const resolvedOrgId = org_id || event.headers?.['x-org-id'] || '';

  if (!doc_ids.length) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'doc_ids required' }) };

  const job_id = randomUUID();
  await createJob(job_id, resolvedOrgId);

  // Invoke worker async
  await lambda.send(new InvokeCommand({
    FunctionName: WORKER_FN,
    InvocationType: 'Event',
    Payload: JSON.stringify({ job_id, doc_ids, org_id: resolvedOrgId }),
  }));

  console.log(`buildVisitIndexStart: job_id=${job_id} docs=${doc_ids.length}`);
  return { statusCode: 200, headers: CORS, body: JSON.stringify({ job_id }) };
};

// ─── Worker handler (runs VI pre-pass, writes result) ────────────────────────
const buildVisitIndexWorker = async (event) => {
  const { job_id, doc_ids, org_id } = event;
  console.log(`buildVisitIndexWorker start: job_id=${job_id} docs=${doc_ids?.length}`);

  try {
    const docRecords = await fetchDocRecords(doc_ids);
    if (!docRecords.length) { await markJobFailed(job_id, 'No documents found in DynamoDB'); return; }

    // Build allParts (clinical only)
    const allParts = [];
    for (const doc of docRecords) {
      const partClassif = doc.page_classifications || [];
      const allNonClinical = partClassif.length > 0 && partClassif.every(p => !p.is_clinical && !p.restored);
      if (allNonClinical) { console.log(`Skipping non-clinical: ${doc.aws_document_id}`); continue; }
      const fileKey = resolveFileKey(doc);
      if (!fileKey) { console.warn(`No file_key for ${doc.aws_document_id}`); continue; }
      allParts.push({ id: doc.aws_document_id, label: doc.file_name || doc.aws_document_id, file_key: fileKey });
    }

    if (!allParts.length) { await markJobFailed(job_id, 'All documents are non-clinical'); return; }

    // VI pre-pass — parallel, 4 at a time
    const VI_CONCURRENCY = 4;
    const viResults = new Array(allParts.length).fill(null);
    let patientName = '';

    for (let vi = 0; vi < allParts.length; vi += VI_CONCURRENCY) {
      const viChunk = allParts.slice(vi, vi + VI_CONCURRENCY);
      await Promise.all(viChunk.map(async (viPart, ci) => {
        const partIdx = vi + ci;
        try {
          const viResult = await callBedrock([viPart.file_key], buildVisitIndexPrompt(), VI_SCHEMA);
          if (!patientName && viResult.patient_name) patientName = viResult.patient_name;
          if (Array.isArray(viResult.visits)) {
            viResults[partIdx] = viResult.visits
              .filter(v => v.date && /^\d{4}-\d{2}-\d{2}$/.test(v.date))
              .map(v => ({ ...v, source_doc_id: viPart.id, source_part_label: viPart.label }));
          }
          console.log(`VI: ${viPart.label} -> ${(viResults[partIdx] || []).length} visits`);
        } catch (e) {
          console.warn(`VI failed for ${viPart.id}: ${e.message}`);
        }
      }));
    }

    // Flatten + deduplicate
    let knownVisits = viResults.flat().filter(Boolean);
    const seen = new Set();
    knownVisits = knownVisits.filter(v => {
      const k = `${v.date}|${(v.provider || '').toLowerCase()}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    knownVisits = knownVisits.filter(v =>
      !/admin|fax|authorization|reminder|order/i.test(v.visit_type || '')
    );
    knownVisits.sort((a, b) => (a.date || '').localeCompare(b.date || ''));

    console.log(`buildVisitIndexWorker complete: ${knownVisits.length} visits`);
    await markJobComplete(job_id, { known_visits: knownVisits, patient_name: patientName });
  } catch (err) {
    console.error('buildVisitIndexWorker error:', err.message);
    await markJobFailed(job_id, err.message);
  }
};

module.exports = { buildVisitIndexStart, buildVisitIndexWorker };

// Updated: 2026-04-25 — Gamma summary generation: pure AWS Bedrock, no Base44 relay
// Flow:
//   POST /summaries/generate  -> generateSummaryStart  -> { job_id }
//   generateSummaryWorker     -> fetches S3 PDFs, calls Bedrock, writes to DynamoDB
//   GET  /jobs/{job_id}       -> getJobHandler (existing) -> { status, result }

const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
const { randomUUID } = require('crypto');
const { validateApiKey } = require('./auth');

const s3      = new S3Client({ region: process.env.AWS_REGION || 'us-east-1', requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' });
const dynamo  = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const bedrock = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'us-east-1' });
const lambda  = new LambdaClient({ region: process.env.AWS_REGION || 'us-east-1' });

const BUCKET         = process.env.S3_BUCKET          || 'chartreview-documents-prod';
const DOCS_TABLE     = process.env.DOCUMENTS_TABLE     || 'chartreview-documents-prod';
const SUMMARIES_TABLE= process.env.SUMMARIES_TABLE     || 'chartreview-summaries-prod';
const JOBS_TABLE     = process.env.JOBS_TABLE          || 'chartreview-jobs-prod';
const BEDROCK_MODEL  = 'us.anthropic.claude-sonnet-4-6';
const WORKER_FN      = process.env.GENERATE_WORKER_FUNCTION_NAME || 'chartreview-pro-prod-generateSummaryWorker';

const response = (statusCode, body) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,x-api-key,x-org-id',
  },
  body: JSON.stringify(body),
});

// ─── Fetch PDF from S3 as base64 ─────────────────────────────────────────────
const fetchPdfBase64 = async (fileKey) => {
  const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: fileKey }));
  const chunks = [];
  for await (const chunk of obj.Body) { chunks.push(chunk); }
  return Buffer.concat(chunks).toString('base64');
};

// ─── Get file_key for a document (direct or via parts) ───────────────────────
const resolveFileKey = async (doc) => {
  if (doc.file_key) return doc.file_key;
  // No file_key — reconstruct from known pattern
  if (doc.org_id && doc.aws_document_id && doc.file_name) {
    return `orgs/${doc.org_id}/documents/${doc.aws_document_id}/${doc.file_name}`;
  }
  return null;
};

// ─── Build the main extraction prompt ────────────────────────────────────────
const buildPrompt = (knownVisitsChecklist = [], skipPages = []) => {
  const checklistSection = knownVisitsChecklist.length > 0 ? `
KNOWN VISITS CHECKLIST (from pre-pass):
${knownVisitsChecklist.map(v => `- ${v.date} | ${v.provider || 'Unknown'} | ${v.facility || ''} | ${v.visit_type || ''}`).join('\n')}
Make sure every visit on this list is represented in your output. Do not invent visits not in the document.
` : '';

  const skipSection = skipPages.length > 0 ? `
SKIP THESE PAGES (non-clinical, administrative): ${skipPages.join(', ')}
Do not extract visits from these pages.
` : '';

  return `You are a medical-legal document analyst. Extract EVERY clinical encounter from this document.

Include: ER visits, office visits, surgery, physical therapy, occupational therapy, radiology, IME, chiropractic, C-4 forms, ambulance, specialist consults.
Exclude: billing pages, authorization forms, HIPAA forms, fax covers, appointment reminders, records request letters.
${checklistSection}${skipSection}
For each clinical encounter extract:
- visit_date: YYYY-MM-DD format. This is the DATE OF SERVICE, not injury date. Look in document headers and note titles.
- rendering_provider: Full name and credentials (e.g. "Arthur J. Taylor, MD")
- practice_setting: Facility or practice name AND visit type (e.g. "Nevada Orthopedic & Spine Center — Office Visit", "Centennial Hills Hospital — Emergency Department", "C-4 Workers Compensation Report")
- chief_complaint: Primary complaint documented
- hpi_summary: History of present illness, mechanism of injury, symptom description
- injury_date: YYYY-MM-DD if documented
- pain_scale: Numeric pain score if documented (e.g. "7/10")
- symptom_progression: One of: improved, same, worse, not_documented
- physical_exam_findings: All physical exam findings documented
- imaging_findings: Any imaging results (X-ray, MRI, CT) referenced or reported
- lab_findings: Any lab results documented
- impression_diagnosis: Diagnoses and ICD-10 codes if present
- icd10_codes: Array of ICD-10 codes if documented (e.g. ["S13.4XXA", "M54.2"])
- treatment_plan: Treatment prescribed, medications, referrals, follow-up plan

RULES:
- Each unique date + provider = separate visit entry.
- If a date appears without a provider, use "Not Documented" for rendering_provider.
- Do NOT use the injury date as a visit date unless the patient was actually seen that day.
- C-4 forms: practice_setting must include "C-4 Workers Compensation Report". visit_date = date of injury (this is intentional for C-4 only).
- PT/OT: include every session as a separate visit if documented. If only a date range is given, use the first and last dates.
- Return ALL visits — do not summarize or collapse multiple visits into one.`;
};

// ─── Build Visit Index prompt ─────────────────────────────────────────────────
const buildViPrompt = () => `You are reviewing medical-legal documents. Extract a complete list of every clinical encounter.

For each encounter:
- date: YYYY-MM-DD (date of service, NOT injury date)
- provider: treating provider name and credentials
- facility: facility or practice name
- visit_type: "Office Visit", "ER Visit", "Surgery", "Physical Therapy", "Radiology", "C-4 Form", "IME", "Chiropractic", etc.

RULES:
- Include every encounter — office, ER, surgery, PT/OT, radiology, C-4, IME, ambulance.
- Each unique date + provider = separate entry.
- Exclude administrative documents (authorization requests, fax covers, appointment reminders).
- If date visible but no provider, use "Not Documented".

Return all entries in the visits array.`;

// ─── Call Bedrock with PDF + prompt ──────────────────────────────────────────
const callBedrock = async (pdfBase64, prompt, schema) => {
  const payload = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 8000,
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
        { type: 'text', text: prompt + '\n\nRespond ONLY with valid JSON matching this schema:\n' + JSON.stringify(schema) }
      ]
    }]
  };

  const resp = await bedrock.send(new InvokeModelCommand({
    modelId: BEDROCK_MODEL,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify(payload),
  }));

  const raw = JSON.parse(Buffer.from(resp.body).toString('utf-8'));
  const text = raw.content?.[0]?.text || '';
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Bedrock returned no JSON: ' + text.slice(0, 200));
  return JSON.parse(match[0]);
};

// ─── START handler — called by frontend, kicks off async worker ───────────────
const generateSummaryStartHandler = async (event) => {
  try {
    const body = JSON.parse(event.body || '{}');
    const { doc_ids, patient_name, org_id: bodyOrgId, run_vi_prepass = true } = body;
    const orgId = event._orgId || bodyOrgId;

    if (!orgId) return response(400, { error: 'x-org-id required' });
    if (!doc_ids || !doc_ids.length) return response(400, { error: 'doc_ids required' });

    const job_id = randomUUID();
    const now = new Date().toISOString();

    // Write job record
    await dynamo.send(new PutCommand({
      TableName: JOBS_TABLE,
      Item: {
        job_id,
        job_type: 'generate_summary',
        status: 'running',
        org_id: orgId,
        doc_ids,
        patient_name: patient_name || '',
        run_vi_prepass,
        created_at: now,
        updated_at: now,
      }
    }));

    // Fire worker async
    await lambda.send(new InvokeCommand({
      FunctionName: WORKER_FN,
      InvocationType: 'Event',
      Payload: JSON.stringify({ job_id, doc_ids, patient_name, org_id: orgId, run_vi_prepass }),
    }));

    console.log(`generateSummaryStart: job_id=${job_id} docs=${doc_ids.length}`);
    return response(200, { job_id });
  } catch (err) {
    console.error('generateSummaryStart error:', err);
    return response(500, { error: err.message });
  }
};

// ─── WORKER — runs async, no HTTP timeout ─────────────────────────────────────
const generateSummaryWorker = async (event) => {
  const { job_id, doc_ids, patient_name, org_id, run_vi_prepass = true } = event;
  console.log(`generateSummaryWorker start: job_id=${job_id} docs=${doc_ids?.length}`);

  const markFailed = async (msg) => {
    await dynamo.send(new UpdateCommand({
      TableName: JOBS_TABLE,
      Key: { job_id },
      UpdateExpression: 'SET #s = :s, error_message = :e, updated_at = :now',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':s': 'failed', ':e': msg, ':now': new Date().toISOString() }
    }));
  };

  try {
    // ── 1. Fetch all document records from DynamoDB ──
    const docRecords = [];
    for (const id of doc_ids) {
      const r = await dynamo.send(new GetCommand({ TableName: DOCS_TABLE, Key: { aws_document_id: id } }));
      if (r.Item) docRecords.push(r.Item);
    }
    if (!docRecords.length) { await markFailed('No documents found'); return; }
    console.log(`generateSummaryWorker: fetched ${docRecords.length} doc records`);

    // ── 2. Optional VI pre-pass — one PDF at a time, collect known visits ──
    let knownVisits = [];
    if (run_vi_prepass) {
      console.log('generateSummaryWorker: starting VI pre-pass');
      for (const doc of docRecords) {
        try {
          const fileKey = await resolveFileKey(doc);
          if (!fileKey) { console.warn(`VI: no file_key for ${doc.aws_document_id}`); continue; }
          const pdfBase64 = await fetchPdfBase64(fileKey);
          const viSchema = {
            type: 'object',
            properties: {
              patient_name: { type: 'string' },
              visits: { type: 'array', items: { type: 'object', properties: {
                date: { type: 'string' }, provider: { type: 'string' },
                facility: { type: 'string' }, visit_type: { type: 'string' }
              }}}
            }
          };
          const viResult = await callBedrock(pdfBase64, buildViPrompt(), viSchema);
          const visits = (viResult.visits || []).filter(v => v.date && /^\d{4}-\d{2}-\d{2}$/.test(v.date));
          knownVisits = knownVisits.concat(visits.map(v => ({ ...v, source_doc_id: doc.aws_document_id })));
          console.log(`VI pre-pass: ${doc.file_name} -> ${visits.length} visits`);
        } catch (viErr) {
          console.warn(`VI pre-pass failed for ${doc.aws_document_id}:`, viErr.message);
        }
      }
      // Deduplicate
      const viSeen = new Set();
      knownVisits = knownVisits.filter(v => {
        const k = `${v.date}|${(v.provider || '').toLowerCase()}`;
        if (viSeen.has(k)) return false;
        viSeen.add(k); return true;
      });
      console.log(`VI pre-pass complete: ${knownVisits.length} unique visits`);
    }

    // ── 3. Main extraction pass — one PDF at a time ──
    const fullSchema = {
      type: 'object',
      properties: {
        patient_name: { type: 'string' },
        case_number: { type: 'string' },
        visits: { type: 'array', items: { type: 'object', properties: {
          visit_date: { type: 'string' }, rendering_provider: { type: 'string' },
          practice_setting: { type: 'string' }, chief_complaint: { type: 'string' },
          hpi_summary: { type: 'string' }, injury_date: { type: 'string' },
          pain_scale: { type: 'string' }, symptom_progression: { type: 'string' },
          physical_exam_findings: { type: 'string' }, imaging_findings: { type: 'string' },
          lab_findings: { type: 'string' }, impression_diagnosis: { type: 'string' },
          icd10_codes: { type: 'array', items: { type: 'string' } },
          treatment_plan: { type: 'string' }
        }}}
      }
    };

    let allVisits = [];
    let detectedPatientName = patient_name || '';
    let detectedCaseNumber = '';

    for (const doc of docRecords) {
      try {
        const fileKey = await resolveFileKey(doc);
        if (!fileKey) { console.warn(`Main pass: no file_key for ${doc.aws_document_id}`); continue; }

        // Build skip pages from page_classifications
        const skipPages = (doc.page_classifications || [])
          .filter(p => !p.is_clinical && !p.restored)
          .map(p => p.page);

        console.log(`Main pass: processing ${doc.file_name} (skipPages: ${skipPages.length})`);
        const pdfBase64 = await fetchPdfBase64(fileKey);
        const result = await callBedrock(pdfBase64, buildPrompt(knownVisits, skipPages), fullSchema);

        if (!detectedPatientName && result.patient_name) detectedPatientName = result.patient_name;
        if (!detectedCaseNumber && result.case_number) detectedCaseNumber = result.case_number;

        const visits = Array.isArray(result.visits) ? result.visits : [];
        allVisits = allVisits.concat(visits.map(v => ({ ...v, _source_doc: doc.aws_document_id })));
        console.log(`Main pass: ${doc.file_name} -> ${visits.length} visits`);
      } catch (docErr) {
        console.error(`Main pass failed for ${doc.aws_document_id}:`, docErr.message);
      }
    }

    console.log(`generateSummaryWorker: total visits collected = ${allVisits.length}`);

    // ── 4. Write completed job result ──
    await dynamo.send(new UpdateCommand({
      TableName: JOBS_TABLE,
      Key: { job_id },
      UpdateExpression: 'SET #s = :s, result = :r, updated_at = :now',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':s': 'complete',
        ':r': {
          patient_name: detectedPatientName,
          case_number: detectedCaseNumber,
          visits: allVisits,
          doc_count: docRecords.length,
          visit_count: allVisits.length,
        },
        ':now': new Date().toISOString()
      }
    }));

    console.log(`generateSummaryWorker complete: job_id=${job_id} visits=${allVisits.length}`);
  } catch (err) {
    console.error('generateSummaryWorker fatal error:', err);
    await markFailed(err.message);
  }
};

// ─── HTTP entry point ──────────────────────────────────────────────────────────
const generateSummaryHandler = async (event) => {
  // Direct Lambda invoke for worker (no HTTP context)
  if (event.job_id && event.doc_ids) {
    await generateSummaryWorker(event);
    return;
  }
  return generateSummaryStartHandler(event);
};

module.exports = {
  generateSummaryStart:  validateApiKey(generateSummaryStartHandler),
  generateSummaryWorker: generateSummaryWorker, // no auth — internal Lambda invoke only
};

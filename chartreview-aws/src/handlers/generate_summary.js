// Updated: 2026-04-25 — Gamma summary generation: pure AWS Bedrock, no Base44 relay
// Prompt ported directly from original chartreview-pro MedicalSummaries.jsx (battle-tested)

const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
const { randomUUID } = require('crypto');
const { validateApiKey } = require('./auth');

const s3      = new S3Client({ region: process.env.AWS_REGION || 'us-east-1', requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' });
const dynamo  = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const bedrock = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'us-east-1' });
const lambda  = new LambdaClient({ region: process.env.AWS_REGION || 'us-east-1' });

const BUCKET          = process.env.S3_BUCKET           || 'chartreview-documents-prod';
const DOCS_TABLE      = process.env.DOCUMENTS_TABLE      || 'chartreview-documents-prod';
const JOBS_TABLE      = process.env.JOBS_TABLE           || 'chartreview-jobs-prod';
const BEDROCK_MODEL   = 'us.anthropic.claude-sonnet-4-6';
const WORKER_FN       = process.env.GENERATE_WORKER_FUNCTION_NAME || 'chartreview-pro-prod-generateSummaryWorker';

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

// ─── Resolve file_key for a document ─────────────────────────────────────────
const resolveFileKey = (doc) => {
  if (doc.file_key) return doc.file_key;
  if (doc.org_id && doc.aws_document_id && doc.file_name) {
    return `orgs/${doc.org_id}/documents/${doc.aws_document_id}/${doc.file_name}`;
  }
  return null;
};

// ─── Sanitize visits (ported from original app) ───────────────────────────────
const sanitizeVisits = (visits, patientName) => {
  const stringFields = ['visit_date','rendering_provider','practice_setting','chief_complaint',
    'hpi_summary','injury_date','pain_scale','symptom_progression','physical_exam_findings',
    'imaging_findings','lab_findings','impression_diagnosis','treatment_plan'];
  const validProgressions = ['improved','same','worse','not_documented'];
  return (visits || []).map(visit => {
    const clean = { ...visit };
    stringFields.forEach(field => {
      const val = clean[field];
      if (val === null || val === undefined || val === false) clean[field] = '';
      else if (typeof val === 'object') clean[field] = JSON.stringify(val);
      else if (typeof val !== 'string') clean[field] = String(val);
    });
    if (!Array.isArray(clean.icd10_codes)) clean.icd10_codes = [];
    if (!validProgressions.includes(clean.symptom_progression)) clean.symptom_progression = 'not_documented';
    const patientLower = patientName?.toLowerCase();
    if (clean.practice_setting && patientLower && clean.practice_setting.toLowerCase().includes(patientLower)) {
      clean.practice_setting = '';
    }
    return clean;
  });
};

// ─── Deduplicate visits ───────────────────────────────────────────────────────
const deduplicateVisits = (visits) => {
  const exactKeys = new Set();
  return visits.filter(visit => {
    const dateKey = (visit.visit_date || '').trim().toLowerCase();
    const providerKey = (visit.rendering_provider || '').trim().toLowerCase();
    const settingKey = (visit.practice_setting || '').trim().toLowerCase();
    if (!dateKey && !providerKey) return true;
    const key = `${dateKey}|${providerKey}|${settingKey}`;
    if (exactKeys.has(key)) return false;
    exactKeys.add(key);
    return true;
  });
};

// ─── Build extraction prompt (ported from original app) ───────────────────────
const buildPrompt = (docCount, totalDocs) => {
  const multiDocNote = totalDocs > 1
    ? `CRITICAL: You are analyzing ${docCount} documents (part of a larger set of ${totalDocs}) which may be parts of a single medical record split across multiple files, or related records for the same patient. You MUST extract entries from ALL documents/files and combine them into a single comprehensive summary. Do not stop after the first document.`
    : '';

  return `You are a medical-legal document analyst. Analyze these ${docCount} medical document(s) and extract ALL entries (office visits, expert reports, IME reports, chart reviews, etc.) across ALL documents.

${multiDocNote}

DOCUMENT TYPE HANDLING:
You may encounter different types of documents. Handle each type as follows:

A) OFFICE VISIT / CLINICAL NOTES (standard patient visit records):
    Extract each visit as a separate entry with all standard fields.
    CRITICAL: Always extract and include the actual practice setting/facility name from the document. Do NOT default to generic "office visit" or leave practice_setting empty.
    - NEVER label as simply "Office Visit" or "Clinic" — always include the specific facility/provider name from the document header, letterhead, or provider information section

B) EXPERT MEDICAL REPORTS / IME / CHART REVIEWS / CONSULTATIONS / RADIOLOGY REPORTS:
   Use the EXACT document type as labeled in the document itself. Do NOT relabel or generalize. Examples:
   - "Independent Medical Examination" or "IME" → practice_setting: "Independent Medical Examination"
   - "Consultation Report" → practice_setting: "Consultation Report"
   - "Chart Review" or "Record Review" → practice_setting: "Chart Review"
   - "Radiology Report", "MRI Report", "X-Ray Report", "CT Report" → practice_setting: "Radiology Report" (or specific modality)
   - "Narrative Report" → practice_setting: "Narrative Report"
   - "Agreed Medical Examination" or "AME" → practice_setting: "Agreed Medical Examination"
   - "Qualified Medical Evaluation" or "QME" → practice_setting: "Qualified Medical Evaluation"
   NEVER default to "Independent Medical Examination" unless those exact words (or "IME") appear in the document.
   For all these types:
   - rendering_provider: the expert/reviewing physician's name
   - chief_complaint: the stated purpose of the report
   - hpi_summary: expert's review of history and background
   - physical_exam_findings: examination findings if physically examined, otherwise leave empty
   - impression_diagnosis: expert's opinions, conclusions, diagnoses
   - treatment_plan: expert's recommendations or causation opinions
   - imaging_findings: any imaging reviewed or interpreted by the expert
   - visit_date: date the report was authored or examination performed

C) POLICE REPORTS:
   - rendering_provider: reporting officer's name and badge number
   - practice_setting: "Police Report"
   - chief_complaint: incident type (e.g., "Motor Vehicle Collision")
   - hpi_summary: narrative of incident — how it occurred, parties involved, witnesses, road/weather conditions, citations
   - physical_exam_findings: officer's observations about injuries at scene
   - impression_diagnosis: officer's conclusions, fault determination, citations
   - treatment_plan: emergency services dispatched or recommended at scene
   - visit_date: date of incident or report

D) AMBULANCE / EMS REPORTS:
   - rendering_provider: paramedic/EMT name or unit number
   - practice_setting: "Ambulance / EMS Report"
   - chief_complaint: patient's chief complaint at scene
   - hpi_summary: mechanism of injury, scene description, patient condition on arrival, reported symptoms
   - physical_exam_findings: vital signs (BP, HR, RR, O2 sat, GCS), physical findings, neurological status
   - impression_diagnosis: EMS impression/working diagnosis
   - treatment_plan: treatment on scene and during transport (IV, medications, immobilization, O2), destination facility
   - visit_date: date of incident/transport

E) C-4 FORMS (Workers' Compensation Board Doctor's Report / WCB Form C-4):
    STRICT IDENTIFICATION: Only treat as C-4 if document EXPLICITLY shows official WCB Form C-4 header, title block, or reference (e.g., "Form C-4", "Workers' Compensation Board", "WCB Report"). Do NOT label regular office visits as C-4.
    For ACTUAL C-4 forms only:
    - rendering_provider: treating physician's name (signature block or printed name)
    - practice_setting: "C-4 Workers' Compensation Report"
    - impression_diagnosis: diagnosis only — ICD codes if present, otherwise written diagnosis
    - visit_date: date form was completed or examination date — CRITICAL to extract even if rest is illegible
    - hpi_summary, chief_complaint, physical_exam_findings, treatment_plan: leave empty
    - CROSS-REFERENCE: If C-4 date matches an office visit in same document set, use that visit's provider/diagnosis to fill illegible C-4 fields. Note when extrapolated.
    - ORDERING: C-4 entry must use same visit_date as corresponding office visit. Place C-4 entry BEFORE the regular office visit of the same date.

DEDUPLICATION RULE: If same date has BOTH a physician progress report AND an office visit from the SAME provider, ONLY include the office visit. The office visit contains the actual clinical information.

CRITICAL DATE AND TIMELINE ACCURACY:
- Pay EXTREME attention to dates. Multiple visits can occur at the SAME LOCATION on DIFFERENT DATES — treat each as a separate visit.
- Match ALL findings, exams, and imaging to the CORRECT visit date they were documented on.
- NEVER include information from a future visit in an earlier visit.
- NEVER reference events that haven't occurred yet chronologically.
- If a location appears multiple times with different dates, create separate visit entries for each date.

For EACH entry, extract:
1. visit_date — BE PRECISE, critical for timeline accuracy (YYYY-MM-DD)
2. rendering_provider — doctor's name only, not patient name
3. practice_setting — specific facility/practice name AND visit type
4. chief_complaint — brief statement of visit or report purpose
5. hpi_summary — SUMMARIZE CONCISELY (3-5 sentences max): key symptoms and onset, injury date if applicable (only on first visit), pain scale, mechanism of injury, symptom progression, relevant PMH only if directly related. For expert reports: summarize expert's history review.
6. physical_exam_findings — KEY PERTINENT POSITIVES ONLY: pain (location, severity), ROM limitations with measurements, deformity/scarring, neurological findings, swelling/tenderness. Do NOT list normal findings. Keep to 3-5 bullet points. Leave empty for expert reports with no physical exam.
7. imaging_findings — EXACTLY as written, do NOT summarize, ONLY if performed or reviewed on THIS visit date
8. lab_findings — ONLY if labs actually performed on THIS visit date, otherwise empty string
9. impression_diagnosis — diagnoses with ICD-10 codes if provided (do NOT add codes if not in source). For expert reports: expert opinions, causation analysis, conclusions.
10. treatment_plan — SUMMARIZE CONCISELY (2-4 key points): main interventions, medications, procedures, referrals, activity restrictions, follow-up timeline. For expert reports: recommendations, causation opinions, prognosis.

Be thorough but CONCISE. Focus on clinically significant information only.

CRITICAL FORMATTING RULES:
- Every field must be a plain text string. NEVER return null, arrays, or objects for text fields.
- If information is not available for a field, return an empty string "".
- The icd10_codes field must always be an array of strings (can be empty []).

Return ALL entries found across ALL documents as separate entries in the visits array.
Also extract:
- patient_name (consistent across documents)
- case_number (consistent across documents)`;
};

// ─── Build Visit Index prompt ─────────────────────────────────────────────────
const buildViPrompt = () =>
  `You are reviewing medical-legal documents. Extract a complete list of every clinical encounter.

For each encounter:
- date: YYYY-MM-DD (date of service, NOT injury date)
- provider: treating provider name and credentials
- facility: facility or practice name
- visit_type: "Office Visit", "ER Visit", "Surgery", "Physical Therapy", "Radiology", "C-4 Form", "IME", "Chiropractic", etc.

RULES:
- Include every encounter — office, ER, surgery, PT/OT, radiology, C-4, IME, ambulance.
- Each unique date + provider = separate entry.
- Exclude administrative documents (authorization requests, fax covers, appointment reminders).
- If date visible but no provider identifiable, use "Not Documented".
Return all entries in the visits array.`;

// ─── Call Bedrock with PDF base64 + prompt ────────────────────────────────────
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
  if (!match) throw new Error('Bedrock returned no JSON. Raw: ' + text.slice(0, 300));
  return JSON.parse(match[0]);
};

// ─── Response schema ──────────────────────────────────────────────────────────
const FULL_SCHEMA = {
  type: 'object',
  properties: {
    patient_name: { type: 'string' },
    case_number: { type: 'string' },
    visits: { type: 'array', items: { type: 'object', properties: {
      visit_date: { type: 'string' },
      rendering_provider: { type: 'string' },
      practice_setting: { type: 'string' },
      chief_complaint: { type: 'string' },
      hpi_summary: { type: 'string' },
      injury_date: { type: 'string' },
      pain_scale: { type: 'string' },
      symptom_progression: { type: 'string', enum: ['improved','same','worse','not_documented'] },
      physical_exam_findings: { type: 'string' },
      imaging_findings: { type: 'string' },
      lab_findings: { type: 'string' },
      impression_diagnosis: { type: 'string' },
      icd10_codes: { type: 'array', items: { type: 'string' } },
      treatment_plan: { type: 'string' }
    }}}
  }
};

const VI_SCHEMA = {
  type: 'object',
  properties: {
    patient_name: { type: 'string' },
    visits: { type: 'array', items: { type: 'object', properties: {
      date: { type: 'string' },
      provider: { type: 'string' },
      facility: { type: 'string' },
      visit_type: { type: 'string' }
    }}}
  }
};

// ─── START handler — called by frontend, kicks off async worker ───────────────
const generateSummaryStartHandler = async (event) => {
  try {
    const body = JSON.parse(event.body || '{}');
    const { doc_ids, patient_name = '', run_vi_prepass = true } = body;
    const orgId = event._orgId;

    if (!orgId) return response(400, { error: 'x-org-id required' });
    if (!doc_ids?.length) return response(400, { error: 'doc_ids required' });

    const job_id = randomUUID();
    const now = new Date().toISOString();

    await dynamo.send(new PutCommand({
      TableName: JOBS_TABLE,
      Item: { job_id, job_type: 'generate_summary', status: 'running', org_id: orgId, doc_ids, patient_name, run_vi_prepass, created_at: now, updated_at: now }
    }));

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

// ─── WORKER — runs async, 900s timeout, no HTTP timeout ──────────────────────
const generateSummaryWorker = async (event) => {
  const { job_id, doc_ids, patient_name = '', org_id, run_vi_prepass = true } = event;
  console.log(`generateSummaryWorker start: job_id=${job_id} docs=${doc_ids?.length}`);

  const markFailed = async (msg) => {
    await dynamo.send(new UpdateCommand({
      TableName: JOBS_TABLE, Key: { job_id },
      UpdateExpression: 'SET #s = :s, error_message = :e, updated_at = :now',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':s': 'failed', ':e': msg, ':now': new Date().toISOString() }
    }));
  };

  try {
    // ── 1. Fetch all document records ──
    const docRecords = [];
    for (const id of doc_ids) {
      const r = await dynamo.send(new GetCommand({ TableName: DOCS_TABLE, Key: { aws_document_id: id } }));
      if (r.Item) docRecords.push(r.Item);
      else console.warn(`generateSummaryWorker: doc not found: ${id}`);
    }
    if (!docRecords.length) { await markFailed('No documents found in DynamoDB'); return; }
    console.log(`generateSummaryWorker: loaded ${docRecords.length} doc records`);

    // ── 2. VI pre-pass — collect known visits ──
    let knownVisits = [];
    if (run_vi_prepass) {
      console.log('generateSummaryWorker: starting VI pre-pass');
      for (const doc of docRecords) {
        try {
          const fileKey = resolveFileKey(doc);
          if (!fileKey) { console.warn(`VI: no file_key for ${doc.aws_document_id}`); continue; }
          const pdfBase64 = await fetchPdfBase64(fileKey);
          const viResult = await callBedrock(pdfBase64, buildViPrompt(), VI_SCHEMA);
          const visits = (viResult.visits || []).filter(v => v.date && /^\d{4}-\d{2}-\d{2}$/.test(v.date));
          knownVisits = knownVisits.concat(visits.map(v => ({ ...v, source_doc_id: doc.aws_document_id })));
          console.log(`VI: ${doc.file_name} -> ${visits.length} visits`);
        } catch (e) {
          console.warn(`VI pre-pass failed for ${doc.aws_document_id}: ${e.message}`);
        }
      }
      // Deduplicate VI results
      const seen = new Set();
      knownVisits = knownVisits.filter(v => {
        const k = `${v.date}|${(v.provider || '').toLowerCase()}`;
        if (seen.has(k)) return false;
        seen.add(k); return true;
      });
      console.log(`VI pre-pass complete: ${knownVisits.length} unique visits`);
    }

    // ── 3. Main extraction pass ──
    let allVisits = [];
    let detectedPatient = patient_name;
    let detectedCase = '';
    const totalDocs = docRecords.length;

    for (let i = 0; i < docRecords.length; i++) {
      const doc = docRecords[i];
      try {
        const fileKey = resolveFileKey(doc);
        if (!fileKey) { console.warn(`Main: no file_key for ${doc.aws_document_id}`); continue; }

        // Build skip-pages instruction from page_classifications
        const skipPages = (doc.page_classifications || [])
          .filter(p => !p.is_clinical && !p.restored)
          .map(p => p.page);
        const skipNote = skipPages.length
          ? `\nSKIP THESE PAGES (non-clinical/administrative, do not extract visits from them): ${skipPages.join(', ')}`
          : '';

        // Inject known visits checklist
        const checklistNote = knownVisits.length
          ? `\nKNOWN VISITS CHECKLIST (from pre-pass — ensure all are represented):\n` +
            knownVisits.map(v => `- ${v.date} | ${v.provider || 'Unknown'} | ${v.facility || ''} | ${v.visit_type || ''}`).join('\n')
          : '';

        const prompt = buildPrompt(1, totalDocs) + checklistNote + skipNote;
        console.log(`Main pass [${i+1}/${totalDocs}]: ${doc.file_name} skipPages=${skipPages.length}`);

        const pdfBase64 = await fetchPdfBase64(fileKey);
        const result = await callBedrock(pdfBase64, prompt, FULL_SCHEMA);

        if (!detectedPatient && result.patient_name) detectedPatient = result.patient_name;
        if (!detectedCase && result.case_number) detectedCase = result.case_number;

        const visits = Array.isArray(result.visits) ? result.visits : [];
        allVisits = allVisits.concat(visits.map(v => ({ ...v, _source_doc: doc.aws_document_id })));
        console.log(`Main pass [${i+1}/${totalDocs}]: ${visits.length} visits extracted`);
      } catch (e) {
        console.error(`Main pass failed for ${doc.aws_document_id}: ${e.message}`);
      }
    }

    // ── 4. Sanitize + deduplicate ──
    const sanitized = sanitizeVisits(allVisits, detectedPatient);
    const deduped = deduplicateVisits(sanitized);

    // ── 5. Sort chronologically ──
    deduped.sort((a, b) => {
      if (!a.visit_date) return 1;
      if (!b.visit_date) return -1;
      return new Date(a.visit_date + 'T00:00:00') - new Date(b.visit_date + 'T00:00:00');
    });

    console.log(`generateSummaryWorker: ${allVisits.length} raw -> ${deduped.length} after sanitize/dedup`);

    // ── 6. Write result ──
    await dynamo.send(new UpdateCommand({
      TableName: JOBS_TABLE, Key: { job_id },
      UpdateExpression: 'SET #s = :s, result = :r, updated_at = :now',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':s': 'complete',
        ':r': { patient_name: detectedPatient, case_number: detectedCase, visits: deduped, doc_count: docRecords.length, visit_count: deduped.length },
        ':now': new Date().toISOString()
      }
    }));

    console.log(`generateSummaryWorker complete: job_id=${job_id} visits=${deduped.length}`);
  } catch (err) {
    console.error('generateSummaryWorker fatal:', err);
    await markFailed(err.message);
  }
};

// ─── Entry point (handles both HTTP and direct Lambda invoke) ─────────────────
const generateSummaryHandler = async (event) => {
  if (event.job_id && event.doc_ids) {
    await generateSummaryWorker(event);
    return;
  }
  return generateSummaryStartHandler(event);
};

module.exports = {
  generateSummaryStart:  validateApiKey(generateSummaryStartHandler),
  generateSummaryWorker: generateSummaryWorker,
};

// Updated: 2026-04-26 — v4: strengthen date accuracy (checklist overrides HPI dates); fix diagnosis field leakage from treatment plan
// Surgical swaps only:
//   1. base44.integrations.Core.InvokeLLM({ file_urls, prompt, response_json_schema })
//      → callBedrock(fileKeys, prompt, schema) via S3 fetch + Bedrock InvokeModelCommand
//   2. awsProxy(`/documents/${id}/download-url`) → resolveFileKey(doc) from DynamoDB
//   3. Wrap generateSummary logic with job tracking (write status to chartreview-jobs-prod)
// All other logic (BATCH_SIZE, VI_CONCURRENCY, runBatch, recovery pass, C-4 pass,
// sanitizeVisits, deduplicateVisits, enforceOneC4, buildPrompt, buildVisitIndexPrompt)
// is identical to v56 MedicalSummaries.jsx.

const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
const { randomUUID } = require('crypto');
const { validateApiKey } = require('./auth');

const s3      = new S3Client({ region: process.env.AWS_REGION || 'us-east-1', requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' });
const dynamo  = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const bedrock = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'us-east-1' });
const lambda  = new LambdaClient({ region: process.env.AWS_REGION || 'us-east-1' });

const BUCKET        = process.env.S3_BUCKET            || 'chartreview-documents-prod';
const DOCS_TABLE    = process.env.DOCUMENTS_TABLE       || 'chartreview-documents-prod';
const JOBS_TABLE    = process.env.JOBS_TABLE            || 'chartreview-jobs-prod';
// Model fallback chain: try each in order when throttled
const BEDROCK_MODELS = [
  'us.anthropic.claude-sonnet-4-6',               // primary: cross-region Sonnet 4.6
  'us.anthropic.claude-sonnet-4-5-20250929-v1:0', // fallback: cross-region Sonnet 4.5
];
const WORKER_FN     = process.env.GENERATE_WORKER_FUNCTION_NAME || 'chartreview-pro-prod-generateSummaryWorker';

const httpResponse = (statusCode, body) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,x-api-key,x-org-id',
  },
  body: JSON.stringify(body),
});

// ─── AWS swap #1: replaces InvokeLLM ─────────────────────────────────────────
// Original: base44.integrations.Core.InvokeLLM({ prompt, file_urls, response_json_schema })
// New: fetch each PDF from S3 as base64, send to Bedrock with same prompt + schema
const callBedrock = async (fileKeys, prompt, schema) => {
  // Build content array: one document block per PDF (mirrors file_urls behavior)
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
      console.log('callBedrock input keys: ' + Object.keys(toolUse.input || {}).join(','));
      return toolUse.input;
    } catch (err) {
      const isThrottle = err.message?.includes('Too many tokens') ||
                         err.name === 'ThrottlingException' ||
                         err.$metadata?.httpStatusCode === 429;
      console.warn(`callBedrock: model ${modelId} failed — ${err.message}`);
      lastErr = err;
      if (!isThrottle) throw err; // non-throttle errors: don't try other models
      // throttled: try next model in chain
    }
  }
  throw lastErr; // all models exhausted
};

// ─── AWS swap #2: replaces awsProxy(/documents/${id}/download-url) ────────────
// Original: awsProxy(`/documents/${id}/download-url`) → { download_url }
// New: look up DynamoDB record → return file_key for S3 fetch
const resolveFileKey = (doc) => {
  if (doc.file_key) return doc.file_key;
  if (doc.org_id && doc.aws_document_id && doc.file_name) {
    return `orgs/${doc.org_id}/documents/${doc.aws_document_id}/${doc.file_name}`;
  }
  return null;
};

// ─── Fetch all doc records from DynamoDB for given IDs ───────────────────────
const fetchDocRecords = async (docIds) => {
  const records = [];
  for (const id of docIds) {
    const r = await dynamo.send(new GetCommand({ TableName: DOCS_TABLE, Key: { aws_document_id: id } }));
    if (r.Item) records.push(r.Item);
    else console.warn(`fetchDocRecords: not found: ${id}`);
  }
  return records;
};

// ─── Job status helpers ───────────────────────────────────────────────────────
const markJobFailed = async (job_id, msg) => {
  await dynamo.send(new UpdateCommand({
    TableName: JOBS_TABLE, Key: { job_id },
    UpdateExpression: 'SET #s = :s, error_message = :e, updated_at = :now',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':s': 'failed', ':e': msg, ':now': new Date().toISOString() },
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

const setJobStatus = async (job_id, status_msg) => {
  try {
    await dynamo.send(new UpdateCommand({
      TableName: JOBS_TABLE, Key: { job_id },
      UpdateExpression: 'SET status_msg = :m, updated_at = :now',
      ExpressionAttributeValues: { ':m': status_msg, ':now': new Date().toISOString() },
    }));
  } catch (e) {
    console.warn('setJobStatus failed:', e.message);
  }
};

// ─── Ported verbatim from v56 MedicalSummaries.jsx ───────────────────────────

const toTitleCase = (str) => {
  if (!str) return str;
  const allCaps = str === str.toUpperCase() && /[A-Z]{2}/.test(str);
  if (!allCaps) return str;
  const credentialsPattern = /\b(MD|DO|PA|NP|RN|PT|OT|DC|DPT|LCSW|PhD|DDS|DMD|CRNA|CNS|APRN|EMT|RPA|MPH|MBA|JD|Esq|Jr|Sr|II|III|IV)\b/gi;
  const credentialMatches = {};
  str.replace(credentialsPattern, (m) => { credentialMatches[m.toUpperCase()] = m; });
  return str.replace(/\b\w+/g, (word) => {
    const upper = word.toUpperCase();
    if (credentialMatches[upper]) return credentialMatches[upper];
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  });
};


// ─── Original app logic (verbatim from chartreview-pro) + Claude 4.x brevity constraints ──

const deduplicateVisits = (visits) => {
  const visitList = visits || [];

  // Step 1: Remove exact duplicates (same date + provider + setting)
  const exactKeys = new Set();
  const deduped = visitList.filter((visit, idx) => {
    const dateKey = (visit.visit_date || '').trim().toLowerCase();
    const providerKey = (visit.rendering_provider || '').trim().toLowerCase();
    const settingKey = (visit.practice_setting || '').trim().toLowerCase();
    if (!dateKey && !providerKey) return true; // no identifying info, keep
    const key = `${dateKey}|${providerKey}|${settingKey}`;
    if (exactKeys.has(key)) return false;
    exactKeys.add(key);
    return true;
  });

  return deduped;
};

const sanitizeVisits = (visits, patientName) => {
  const stringFields = ['visit_date','rendering_provider','practice_setting','chief_complaint','hpi_summary','injury_date','pain_scale','symptom_progression','physical_exam_findings','imaging_findings','lab_findings','impression_diagnosis','treatment_plan'];
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

const enforceOneC4 = (visitList) => {
  const c4s = visitList.filter(v => (v.practice_setting || '').toLowerCase().includes('c-4'));
  if (c4s.length <= 1) return visitList;
  const sorted = [...c4s].sort((a, b) => (a.visit_date || '').localeCompare(b.visit_date || ''));
  const keepId = sorted[0];
  return visitList.filter(v => {
    if ((v.practice_setting || '').toLowerCase().includes('c-4')) return v === keepId;
    return true;
  });
};

const buildPrompt = (rawChunkText, docCount, chunkLabel = '', knownVisitsChecklist = [], skipPages = []) => {
  const chunkText = String(rawChunkText || '').replace(/`/g, "'").split('${').join('(');
  const multiDocNote = docCount > 1
    ? `CRITICAL: You are analyzing a batch of documents (part of a larger set of ${docCount} total). These may be parts of a single medical record split across multiple files, or related records for the same patient. You MUST extract entries from ALL documents/files and combine them into a single comprehensive summary. Do not stop after the first document.`
    : '';
  const checklistSection = knownVisitsChecklist.length > 0
    ? `\n\nKNOWN VISITS CHECKLIST (from pre-pass — ensure ALL are represented in your output):\n` +
      knownVisitsChecklist.map(v => `- ${v.date} | ${v.provider || 'Unknown'} | ${v.facility || ''} | ${v.visit_type || ''}`).join('\n') +
      `\n\nCRITICAL: Every date in the checklist above MUST appear in your output visits array — including PT/OT therapy sessions. If you cannot find detail for a visit, still include it with the date and provider populated.`
    : '';
  const skipPagesSection = skipPages.length > 0
    ? `\n\nSKIP THESE PAGES (non-clinical/administrative, confirmed by pre-classification — do not extract visits from pages: ${skipPages.join(', ')})`
    : '';

  return `You are a medical-legal document analyst. Analyze these ${docCount} medical document(s)${chunkLabel} and extract ALL entries (office visits, expert reports, IME reports, chart reviews, etc.) across ALL documents.

CRITICAL OUTPUT RULES — MUST FOLLOW FOR EVERY FIELD:
- Be concise. Summarize and condense — do NOT transcribe verbatim from the document.
- Maximum 2-3 sentences per field unless otherwise specified below.
- Extract PERTINENT POSITIVES ONLY — omit normal/unremarkable findings entirely.
- ICD codes must ALWAYS appear inline in parentheses at the end of impression_diagnosis only — NEVER as a numbered list, NEVER in separate lines.
- visit_date MUST be in YYYY-MM-DD format always (e.g. 2026-01-20). Never return any other date format.
- Every field must be a plain text string. NEVER return null, arrays, or objects for text fields.
- If information is not available for a field, return an empty string "".

${multiDocNote}

DOCUMENT TYPE HANDLING:
You may encounter different types of documents. Handle each type as follows:

A) OFFICE VISIT / CLINICAL NOTES (standard patient visit records):
   Extract each visit as a separate entry with all standard fields.
   CRITICAL: Always extract and include the actual practice setting/facility name from the document. Do NOT default to generic "office visit" or leave practice_setting empty.

B) EXPERT MEDICAL REPORTS / IME / CHART REVIEWS / CONSULTATIONS / RADIOLOGY REPORTS:
   Use the EXACT document type as labeled in the document itself. Do NOT relabel or generalize. Examples:
   - "Independent Medical Examination" or "IME" → practice_setting: "Independent Medical Examination"
   - "Consultation Report" → practice_setting: "Consultation Report"
   - "Chart Review" or "Record Review" → practice_setting: "Chart Review"
   - "Radiology Report", "MRI Report" → practice_setting: "Radiology Report"
   - "Agreed Medical Examination" or "AME" → practice_setting: "Agreed Medical Examination"
   - "Qualified Medical Evaluation" or "QME" → practice_setting: "Qualified Medical Evaluation"
   NEVER default to "Independent Medical Examination" unless those exact words appear in the document.
   Fields: rendering_provider, chief_complaint (report purpose), hpi_summary (expert's history review),
   physical_exam_findings (only if expert physically examined patient), impression_diagnosis (expert opinions/conclusions),
   treatment_plan (expert recommendations), imaging_findings (imaging reviewed), visit_date (report date).

C) POLICE REPORTS:
   - practice_setting: "Police Report"
   - rendering_provider: officer name and badge number
   - chief_complaint: incident type (e.g. "Motor Vehicle Collision")
   - hpi_summary: narrative — mechanism, parties, conditions, citations. Concise.
   - physical_exam_findings: officer observations about injuries at scene
   - impression_diagnosis: officer conclusions, fault, citations
   - treatment_plan: emergency services dispatched
   - visit_date: date of incident

D) AMBULANCE / EMS REPORTS:
   - practice_setting: "Ambulance / EMS Report"
   - rendering_provider: paramedic/EMT name or unit
   - chief_complaint: patient's chief complaint at scene
   - hpi_summary: mechanism, scene, patient condition, reported symptoms. Concise.
   - physical_exam_findings: vitals (BP, HR, RR, O2 sat, GCS) and key physical findings only
   - impression_diagnosis: EMS working diagnosis
   - treatment_plan: treatment on scene and during transport, destination facility
   - visit_date: date of incident

E) C-4 FORMS (Workers' Compensation Board / WCB Form C-4):
   STRICT IDENTIFICATION: Only treat as C-4 if the document EXPLICITLY shows "Form C-4", "Workers' Compensation Board", or "WCB Report" header.
   - practice_setting: "C-4 Workers' Compensation Report"
   - rendering_provider: treating physician name (from signature block)
   - impression_diagnosis: diagnosis only with ICD codes inline in parentheses
   - visit_date: form completion date or examination date in YYYY-MM-DD format
   - hpi_summary, chief_complaint, physical_exam_findings, treatment_plan: leave empty
   - ORDERING: place C-4 entry BEFORE the regular office visit of the same date

DEDUPLICATION RULE: If the same date has BOTH a physician progress report AND an office visit from the SAME provider, include the office visit only.

CRITICAL: Extract EACH visit as a separate entry. Multiple visits at the same location on different dates = separate entries.

CRITICAL DATE ACCURACY:
- visit_date MUST be YYYY-MM-DD format (e.g. 2026-01-20). This is mandatory.
- Match ALL findings to the CORRECT visit date they were documented on.
- Never include information from a future visit in an earlier visit.

For EACH entry extract:

1. visit_date — YYYY-MM-DD format, mandatory
2. rendering_provider — doctor name only, not patient name
3. practice_setting — specific facility name, never generic "Office Visit"
4. chief_complaint — brief statement of visit purpose

5. hpi_summary — CONCISE, 2-3 sentences max:
   - Key presenting symptoms and onset
   - Injury date if applicable (first visit only) — must be before or on visit date
   - Pain scale if provided (e.g. "7/10")
   - Whether symptoms improved, same, or worse
   - Do NOT mention future events

6. physical_exam_findings — PERTINENT POSITIVES ONLY, 3-5 key findings max:
   - Pain location and severity if significant
   - Range of motion limitations with measurements
   - Neurological findings only if present (numbness, tingling)
   - Swelling/tenderness only if notable
   - OMIT all normal/unremarkable findings entirely
   - For expert reports with no physical exam: leave empty

7. imaging_findings — include exactly as written, only if performed or reviewed on THIS visit date
8. lab_findings — only if labs actually performed on THIS visit date, otherwise empty string
9. impression_diagnosis — expert opinions and diagnoses; ICD-10 codes inline in parentheses at end only
10. treatment_plan — CONCISE, 2-4 key points max:
    - Main interventions (medications, therapy, procedures)
    - Activity restrictions if any
    - Follow-up timeline
    - Omit routine instructions

Return ALL entries found across ALL documents as separate entries in the visits array.
Also extract: patient_name and case_number (consistent across documents).

${chunkText ? `DOCUMENT TEXT:\n\`\`\`\n${chunkText}\n\`\`\`` : ''}
${checklistSection}
${skipPagesSection}`;
};


// ═══════════════════════════════════════════════════════════════════════════════
// GENERATE SUMMARY — CONCURRENT CHUNK ARCHITECTURE
// Updated: 2026-05-03
//
// Architecture:
//   generateSummaryWorker (coordinator):
//     1. Fetches doc records + builds allParts
//     2. Runs VI pre-pass (VI_CONCURRENCY=4) to build knownVisits checklist
//     3. Builds batches (BATCH_SIZE=1), splits into CHUNK_SIZE=20 slices
//     4. Fires all chunk-worker Lambdas simultaneously (Event invocation)
//     5. Polls DynamoDB for all chunk sub-jobs to complete (or fail)
//     6. Merges all partial visits, runs recovery pass, deduplicates
//     7. Marks parent job complete
//
//   generateSummaryChunkWorker:
//     - Receives { job_id, chunk_job_id, batches (serialized), knownVisits,
//                  patientName, totalBatches, chunkIndex }
//     - Runs BATCH_CONCURRENCY=4 over its slice of batches
//     - Writes partial visits + status to chunk sub-job record
//     - Marks chunk sub-job complete or failed
//
// Why: Lambda hard limit is 900s (15 min). 90 batches × ~10s each = 900s exactly.
// With 5 concurrent chunks of 20, each chunk finishes in ~2-3 min, well under limit.
// ═══════════════════════════════════════════════════════════════════════════════

const CHUNK_SIZE        = 20;   // batches per chunk worker
const BATCH_SIZE        = 1;    // docs per batch (isolated Bedrock call)
const BATCH_CONCURRENCY = 4;    // concurrent batches within a chunk
const CHUNK_FN          = process.env.GENERATE_CHUNK_WORKER_FUNCTION_NAME || 'chartreview-pro-prod-generateSummaryChunkWorker';

// ── generateSummaryChunkWorker ────────────────────────────────────────────────
// Processes a slice of batches, writes partial results to its chunk sub-job.
const generateSummaryChunkWorker = async (event) => {
  const {
    job_id,         // parent job (for status messages)
    chunk_job_id,   // this chunk's sub-job record
    batches,        // array of batch arrays (each batch = array of part objects)
    knownVisits,    // VI checklist from coordinator
    patientNameHint,
    chunkIndex,
    totalBatches,   // total across ALL chunks (for display)
    batchOffset,    // index of first batch in this chunk (for display)
  } = event;

  console.log(`chunkWorker[${chunkIndex}] start: ${batches.length} batches, chunk_job_id=${chunk_job_id}`);

  const chunkVisits = [];
  let patientName   = patientNameHint || '';
  let caseNumber    = '';

  const fullSchema = {
    type: 'object',
    properties: {
      patient_name: { type: 'string' },
      case_number:  { type: 'string' },
      visits: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            visit_date:            { type: 'string' },
            rendering_provider:    { type: 'string' },
            practice_setting:      { type: 'string' },
            chief_complaint:       { type: 'string' },
            hpi_summary:           { type: 'string' },
            injury_date:           { type: 'string' },
            pain_scale:            { type: 'string' },
            symptom_progression:   { type: 'string', enum: ['improved', 'same', 'worse', 'not_documented'] },
            physical_exam_findings:{ type: 'string' },
            imaging_findings:      { type: 'string' },
            lab_findings:          { type: 'string' },
            impression_diagnosis:  { type: 'string' },
            icd10_codes:           { type: 'array', items: { type: 'string' } },
            treatment_plan:        { type: 'string' },
          },
        },
      },
    },
  };

  const simplifiedSchema = {
    type: 'object',
    properties: {
      visits: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            visit_date:           { type: 'string' },
            rendering_provider:   { type: 'string' },
            practice_setting:     { type: 'string' },
            hpi_summary:          { type: 'string' },
            impression_diagnosis: { type: 'string' },
            treatment_plan:       { type: 'string' },
          },
        },
      },
    },
  };

  const runBatch = async (batch, batchIndex, knownVisitsChecklist = []) => {
    const fileKeys = batch.map(p => p.file_key).filter(Boolean);
    if (!fileKeys.length) {
      console.warn(`Chunk[${chunkIndex}] Batch ${batchIndex + 1}: no valid file keys, skipping`);
      return null;
    }
    const globalBatchNum = batchOffset + batchIndex + 1;
    const batchLabel = totalBatches > 1 ? ` [Batch ${globalBatchNum} of ${totalBatches}]` : '';
    try {
      const result = await callBedrock(fileKeys, buildPrompt(knownVisitsChecklist, batchLabel), fullSchema);
      return result;
    } catch (err) {
      console.warn(`Chunk[${chunkIndex}] Batch ${batchIndex + 1}: JSON error, retrying with simplified schema...`, err.message);
      try {
        const result = await callBedrock(fileKeys, buildPrompt(knownVisitsChecklist, batchLabel), simplifiedSchema);
        return result;
      } catch (retryErr) {
        console.error(`Chunk[${chunkIndex}] Batch ${batchIndex + 1}: retry also failed:`, retryErr.message);
        return null;
      }
    }
  };

  try {
    // Process batches BATCH_CONCURRENCY at a time
    for (let i = 0; i < batches.length; i += BATCH_CONCURRENCY) {
      const slice = batches.slice(i, i + BATCH_CONCURRENCY);
      const sliceEnd = Math.min(i + BATCH_CONCURRENCY, batches.length);
      const globalStart = batchOffset + i + 1;
      const globalEnd   = batchOffset + sliceEnd;
      console.log(`Chunk[${chunkIndex}]: processing batches ${globalStart}-${globalEnd} of ${totalBatches}`);

      // Update parent job status so frontend sees progress
      await setJobStatus(job_id, `Analyzing batches ${globalStart}–${globalEnd} of ${totalBatches}...`);

      const results = await Promise.all(
        slice.map((batch, j) => runBatch(batch, i + j, knownVisits || []))
      );
      for (const result of results) {
        if (!result) continue;
        if (!patientName && result.patient_name) patientName = result.patient_name;
        if (!caseNumber  && result.case_number)  caseNumber  = result.case_number;
        const clean = sanitizeVisits(result.visits || [], patientName);
        chunkVisits.push(...clean);
      }
    }

    console.log(`chunkWorker[${chunkIndex}] complete: ${chunkVisits.length} visits`);

    // Write partial result to chunk sub-job
    await dynamo.send(new UpdateCommand({
      TableName: JOBS_TABLE,
      Key: { job_id: chunk_job_id },
      UpdateExpression: 'SET #s = :s, #res = :r, updated_at = :now',
      ExpressionAttributeNames: { '#s': 'status', '#res': 'result' },
      ExpressionAttributeValues: {
        ':s': 'complete',
        ':r': { visits: chunkVisits, patient_name: patientName, case_number: caseNumber },
        ':now': new Date().toISOString(),
      },
    }));

  } catch (err) {
    console.error(`chunkWorker[${chunkIndex}] fatal:`, err);
    await dynamo.send(new UpdateCommand({
      TableName: JOBS_TABLE,
      Key: { job_id: chunk_job_id },
      UpdateExpression: 'SET #s = :s, error_message = :e, updated_at = :now',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':s': 'failed', ':e': err.message, ':now': new Date().toISOString() },
    }));
  }
};

// ── generateSummaryWorker (coordinator) ──────────────────────────────────────
const generateSummaryWorker = async (event) => {
  const { job_id, doc_ids, patient_name = '', org_id } = event;
  console.log(`generateSummaryWorker (coordinator) start: job_id=${job_id} docs=${doc_ids?.length}`);

  try {
    // ── 1. Fetch doc records ──────────────────────────────────────────────────
    const docRecords = await fetchDocRecords(doc_ids);
    if (!docRecords.length) { await markJobFailed(job_id, 'No documents found in DynamoDB'); return; }
    console.log(`coordinator: loaded ${docRecords.length} doc records`);

    // ── 2. Build allParts (filter non-clinical) ───────────────────────────────
    const allParts = [];
    for (const doc of docRecords) {
      const partClassif = doc.page_classifications || [];
      const allNonClinical = partClassif.length > 0 && partClassif.every(p => !p.is_clinical && !p.restored);
      if (allNonClinical) {
        console.log(`Skipping fully non-clinical part ${doc.aws_document_id} (${doc.file_name})`);
        continue;
      }
      const fileKey = resolveFileKey(doc);
      if (!fileKey) { console.warn(`No file_key for ${doc.aws_document_id}`); continue; }
      allParts.push({
        id: doc.aws_document_id,
        label: doc.file_name || doc.aws_document_id,
        file_key: fileKey,
        file_size: doc.file_size || 0,
        page_classifications: partClassif,
      });
    }
    if (!allParts.length) { await markJobFailed(job_id, 'All documents are non-clinical'); return; }

    // ── 3. VI pre-pass (VI_CONCURRENCY=4) ────────────────────────────────────
    let knownVisits = [];
    let patientName = patient_name;
    let caseNumber  = '';
    try {
      await setJobStatus(job_id, 'Building visit checklist (pre-pass)...');
      const VI_CONCURRENCY = 4;
      const viResults = new Array(allParts.length).fill(null);
      const viSchema = {
        type: 'object',
        properties: {
          patient_name: { type: 'string' },
          visits: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                date:             { type: 'string' },
                provider:         { type: 'string' },
                facility:         { type: 'string' },
                visit_type:       { type: 'string' },
                source_doc_id:    { type: 'string' },
                source_part_label:{ type: 'string' },
              },
            },
          },
        },
      };
      for (let vi = 0; vi < allParts.length; vi += VI_CONCURRENCY) {
        const viChunk = allParts.slice(vi, vi + VI_CONCURRENCY);
        await Promise.all(viChunk.map(async (viPart, chunkIdx) => {
          const partIdx = vi + chunkIdx;
          try {
            const viResult = await callBedrock([viPart.file_key], buildVisitIndexPrompt(), viSchema);
            if (Array.isArray(viResult.visits)) {
              viResults[partIdx] = viResult.visits
                .filter(v => v.date && /^\d{4}-\d{2}-\d{2}$/.test(v.date))
                .map(v => ({ ...v, source_doc_id: viPart.id, source_part_label: viPart.label }));
            }
            console.log(`VI: ${viPart.label} -> ${(viResults[partIdx] || []).length} visits`);
          } catch (e) {
            console.warn(`VI pre-pass failed for ${viPart.id}: ${e.message}`);
          }
        }));
      }
      for (const tagged of viResults) {
        if (tagged) knownVisits = knownVisits.concat(tagged);
      }
      // Deduplicate by date+provider
      const viSeen = new Set();
      knownVisits = knownVisits.filter(v => {
        const k = `${v.date}|${(v.provider || '').toLowerCase()}`;
        if (viSeen.has(k)) return false;
        viSeen.add(k); return true;
      });
      // Filter admin visit types
      knownVisits = knownVisits.filter(v =>
        !/admin|fax|authorization|reminder|order/i.test(v.visit_type || '')
      );
      console.log(`VI pre-pass complete: ${knownVisits.length} unique visits`);
    } catch (viErr) {
      console.warn('VI pre-pass failed (non-fatal):', viErr.message);
      knownVisits = [];
    }

    // ── 4. Build batches + split into chunks of CHUNK_SIZE ───────────────────
    const batches = [];
    for (let start = 0; start < allParts.length; start += BATCH_SIZE) {
      batches.push(allParts.slice(start, start + BATCH_SIZE));
    }
    const totalBatches = batches.length;
    console.log(`coordinator: ${totalBatches} batches → chunks of ${CHUNK_SIZE}`);
    await setJobStatus(job_id, `Launching ${Math.ceil(totalBatches / CHUNK_SIZE)} parallel workers for ${totalBatches} batches...`);

    // Split into chunks
    const batchChunks = [];
    for (let c = 0; c < totalBatches; c += CHUNK_SIZE) {
      batchChunks.push(batches.slice(c, c + CHUNK_SIZE));
    }
    const numChunks = batchChunks.length;
    console.log(`coordinator: firing ${numChunks} chunk workers`);

    // ── 5. Create chunk sub-jobs + fire all chunk workers simultaneously ─────
    const chunkJobIds = [];
    for (let ci = 0; ci < numChunks; ci++) {
      const chunk_job_id = randomUUID();
      chunkJobIds.push(chunk_job_id);
      // Create sub-job record
      await dynamo.send(new UpdateCommand({
        TableName: JOBS_TABLE,
        Key: { job_id: chunk_job_id },
        UpdateExpression: 'SET #s = :s, created_at = :now, updated_at = :now, job_type = :t, parent_job_id = :p',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: {
          ':s': 'running',
          ':now': new Date().toISOString(),
          ':t': 'generate_summary_chunk',
          ':p': job_id,
        },
      }));
    }

    // Fire all chunk workers simultaneously (Event = async, no wait)
    await Promise.all(batchChunks.map(async (chunkBatches, ci) => {
      const batchOffset = ci * CHUNK_SIZE;
      await lambda.send(new InvokeCommand({
        FunctionName: CHUNK_FN,
        InvocationType: 'Event',
        Payload: Buffer.from(JSON.stringify({
          job_id,
          chunk_job_id: chunkJobIds[ci],
          batches: chunkBatches,
          knownVisits,
          patientNameHint: patientName,
          chunkIndex: ci,
          totalBatches,
          batchOffset,
        })),
      }));
      console.log(`coordinator: fired chunk worker ${ci} (batches ${batchOffset + 1}-${batchOffset + chunkBatches.length})`);
    }));

    // ── 6. Poll for all chunks to complete (max 12 min = 720s / 10s intervals) ─
    const MAX_WAIT_MS  = 12 * 60 * 1000;
    const POLL_INTERVAL_MS = 10000;
    const startTime = Date.now();
    let allDone = false;

    while (!allDone && (Date.now() - startTime) < MAX_WAIT_MS) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

      const statusChecks = await Promise.all(chunkJobIds.map(cjid =>
        dynamo.send(new UpdateCommand({
          TableName: JOBS_TABLE,
          Key: { job_id: cjid },
          UpdateExpression: 'SET updated_at = :now',
          ExpressionAttributeValues: { ':now': new Date().toISOString() },
          ReturnValues: 'ALL_NEW',
        })).then(r => r.Attributes)
      ));

      const statuses = statusChecks.map(a => a?.status || 'running');
      const doneCount  = statuses.filter(s => s === 'complete' || s === 'failed').length;
      const failCount  = statuses.filter(s => s === 'failed').length;
      console.log(`coordinator poll: ${doneCount}/${numChunks} done (${failCount} failed)`);
      await setJobStatus(job_id, `Processing... ${doneCount} of ${numChunks} workers complete`);

      if (doneCount === numChunks) allDone = true;
    }

    if (!allDone) {
      console.warn('coordinator: timed out waiting for chunk workers — proceeding with available results');
    }

    // ── 7. Collect all chunk results ──────────────────────────────────────────
    let allVisits = [];
    await setJobStatus(job_id, 'Merging results...');

    for (const cjid of chunkJobIds) {
      const r = await dynamo.send(new UpdateCommand({
        TableName: JOBS_TABLE,
        Key: { job_id: cjid },
        UpdateExpression: 'SET updated_at = :now',
        ExpressionAttributeValues: { ':now': new Date().toISOString() },
        ReturnValues: 'ALL_NEW',
      }));
      const chunkResult = r.Attributes?.result;
      if (!patientName && chunkResult?.patient_name) patientName = chunkResult.patient_name;
      if (!caseNumber  && chunkResult?.case_number)  caseNumber  = chunkResult.case_number;
      if (Array.isArray(chunkResult?.visits)) {
        allVisits = allVisits.concat(chunkResult.visits);
        console.log(`coordinator: merged ${chunkResult.visits.length} visits from chunk ${cjid.slice(0,8)}`);
      }
    }

    // ── 8. Merge + dedup + sort ───────────────────────────────────────────────
    await setJobStatus(job_id, 'Merging and deduplicating visits...');
    allVisits = deduplicateVisits(allVisits);
    allVisits.sort((a, b) => {
      if (!a.visit_date) return 1;
      if (!b.visit_date) return -1;
      const dateDiff = (a.visit_date||'').localeCompare(b.visit_date||'');
      if (dateDiff !== 0) return dateDiff;
      const aIsC4 = (a.practice_setting || '').toLowerCase().includes('c-4');
      const bIsC4 = (b.practice_setting || '').toLowerCase().includes('c-4');
      if (aIsC4 && !bIsC4) return -1;
      if (!aIsC4 && bIsC4) return 1;
      return 0;
    });

    // ── 9. Recovery pass (same as before) ────────────────────────────────────
    if (knownVisits.length > 0) {
      const foundDates   = new Set(allVisits.map(v => (v.visit_date || '').trim()).filter(Boolean));
      const missingVisits = knownVisits.filter(v => v.date && !foundDates.has(v.date));

      if (missingVisits.length > 0) {
        console.log(`Recovery pass: ${missingVisits.length} missing visits:`, missingVisits.map(v => v.date));
        await setJobStatus(job_id, `Recovery pass: searching for ${missingVisits.length} missing visit${missingVisits.length !== 1 ? 's' : ''}...`);
        const recSchema = {
          type: 'object',
          properties: {
            visits: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  visit_date:             { type: 'string' },
                  rendering_provider:     { type: 'string' },
                  practice_setting:       { type: 'string' },
                  chief_complaint:        { type: 'string' },
                  hpi_summary:            { type: 'string' },
                  injury_date:            { type: 'string' },
                  pain_scale:             { type: 'string' },
                  symptom_progression:    { type: 'string', enum: ['improved', 'same', 'worse', 'not_documented'] },
                  physical_exam_findings: { type: 'string' },
                  imaging_findings:       { type: 'string' },
                  lab_findings:           { type: 'string' },
                  impression_diagnosis:   { type: 'string' },
                  icd10_codes:            { type: 'array', items: { type: 'string' } },
                  treatment_plan:         { type: 'string' },
                },
              },
            },
          },
        };
        const bySourceDoc = {};
        for (const mv of missingVisits) {
          const srcId = mv.source_doc_id || 'unknown';
          if (!bySourceDoc[srcId]) bySourceDoc[srcId] = [];
          bySourceDoc[srcId].push(mv);
        }
        const recGroups = Object.entries(bySourceDoc);
        const REC_CONCURRENCY = 3;
        for (let rg = 0; rg < recGroups.length; rg += REC_CONCURRENCY) {
          const recChunk = recGroups.slice(rg, rg + REC_CONCURRENCY);
          await Promise.all(recChunk.map(async ([srcDocId, mvGroup]) => {
            const srcPart    = allParts.find(p => p.id === srcDocId);
            const recFileKey = srcPart?.file_key || allParts[0]?.file_key;
            if (!recFileKey) return;
            const visitList  = mvGroup.map(v => `- ${v.date} | ${v.provider || 'Unknown'} | ${v.facility || ''}`).join('\n');
            const recPrompt  = `You are reviewing medical-legal documents. A specific clinical visit is known to exist in these records but was missed in the prior extraction pass.\n\nTARGET VISIT${mvGroup.length > 1 ? 'S' : ''}:\n${visitList}\n\nYour task: Find the above visit${mvGroup.length > 1 ? 's' : ''} in the provided document and extract full clinical details for ${mvGroup.length > 1 ? 'each one' : 'it'}. If you cannot find it, return an empty visits array. Do not extract any other visits.`;
            try {
              const recResult = await callBedrock([recFileKey], recPrompt, recSchema);
              if (Array.isArray(recResult.visits) && recResult.visits.length > 0) {
                const recClean = sanitizeVisits(recResult.visits, patientName);
                allVisits = allVisits.concat(recClean);
                console.log(`Recovery: recovered ${recClean.length} visit(s) from ${srcDocId}`);
              }
            } catch (recErr) {
              console.warn(`Recovery failed for ${srcDocId}:`, recErr.message);
            }
          }));
        }
        allVisits = deduplicateVisits(allVisits);
        allVisits.sort((a, b) => {
          if (!a.visit_date) return 1;
          if (!b.visit_date) return -1;
          return (a.visit_date||'').localeCompare(b.visit_date||'');
        });
      }
    }

    // ── 10. Checklist date correction ─────────────────────────────────────────
    if (knownVisits.length > 0) {
      const checklistDates = new Set(knownVisits.map(v => v.date));
      allVisits = allVisits.map(v => {
        const d = (v.visit_date || '').trim();
        if (!d || checklistDates.has(d)) return v;
        const provider = (v.rendering_provider || '').toLowerCase();
        const facility = (v.practice_setting   || '').toLowerCase();
        let bestMatch = null, bestScore = 0;
        for (const cv of knownVisits) {
          let score = 0;
          const cvProvider = (cv.provider || '').toLowerCase();
          const cvFacility = (cv.facility  || '').toLowerCase();
          for (const w of provider.split(/\s+/).filter(w => w.length > 2)) {
            if (cvProvider.includes(w)) score += 2;
          }
          for (const w of facility.split(/\s+/).filter(w => w.length > 3)) {
            if (cvFacility.includes(w)) score += 1;
          }
          if (score > bestScore) { bestScore = score; bestMatch = cv; }
        }
        if (bestMatch && bestScore > 0) {
          console.log(`CHECKLIST_CORRECT: corrected ${d} -> ${bestMatch.date} (score ${bestScore})`);
          return { ...v, visit_date: bestMatch.date };
        }
        return v;
      });
    }

    console.log(`coordinator complete: ${allVisits.length} visits`);
    if (allVisits.length === 0 && knownVisits.length > 0) {
      console.warn(`coordinator: WARNING — 0 visits despite ${knownVisits.length} VI entries`);
    }

    await setJobStatus(job_id, `Saving ${allVisits.length} visits...`);
    await markJobComplete(job_id, {
      patient_name: patientName || '',
      case_number:  caseNumber  || '',
      visits:       allVisits,
      doc_count:    docRecords.length,
      visit_count:  allVisits.length,
    });

  } catch (err) {
    console.error('coordinator fatal:', err);
    await markJobFailed(job_id, err.message);
  }
};


// ═══════════════════════════════════════════════════════════════════════════════
// BUILD VISIT INDEX — reuses all existing infrastructure, stops after VI pre-pass
// Updated: 2026-04-28 — replaces standalone build_visit_index.js entirely
// ═══════════════════════════════════════════════════════════════════════════════

const buildVisitIndexWorkerFn = async (event) => {
  const { job_id, doc_ids, org_id, patient_name: inputPatientName = '' } = event;
  console.log(`buildVisitIndexWorker start: job_id=${job_id} docs=${doc_ids?.length}`);

  try {
    await dynamo.send(new UpdateCommand({
      TableName: JOBS_TABLE, Key: { job_id },
      UpdateExpression: 'SET #s = :s, updated_at = :now',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':s': 'running', ':now': new Date().toISOString() },
    }));

    // Fetch doc records — identical to generateSummaryWorker
    const docRecords = await fetchDocRecords(doc_ids);
    if (!docRecords.length) {
      await markJobFailed(job_id, 'No documents found in DynamoDB');
      return;
    }

    // Build allParts — identical to generateSummaryWorker
    const allParts = [];
    for (const doc of docRecords) {
      const partClassif = doc.page_classifications || [];
      const allNonClinical = partClassif.length > 0 && partClassif.every(p => !p.is_clinical && !p.restored);
      if (allNonClinical) { console.log(`Skipping non-clinical ${doc.aws_document_id}`); continue; }
      const fileKey = resolveFileKey(doc);
      if (!fileKey) { console.warn(`No file_key for ${doc.aws_document_id}`); continue; }
      allParts.push({ id: doc.aws_document_id, label: doc.file_name || doc.aws_document_id, file_key: fileKey });
    }

    if (!allParts.length) { await markJobFailed(job_id, 'All documents are non-clinical'); return; }

    // VI pre-pass — identical to generateSummaryWorker
    const VI_CONCURRENCY = 4;
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

    const viResults = new Array(allParts.length).fill(null);
    let extractedPatientName = inputPatientName || '';
    for (let vi = 0; vi < allParts.length; vi += VI_CONCURRENCY) {
      const viChunk = allParts.slice(vi, vi + VI_CONCURRENCY);
      await Promise.all(viChunk.map(async (viPart, chunkIdx) => {
        const partIdx = vi + chunkIdx;
        try {
          const viResult = await callBedrock([viPart.file_key], buildVisitIndexPrompt(), viSchema);
          if (Array.isArray(viResult.visits)) {
            viResults[partIdx] = viResult.visits.filter(v => v.date && /^\d{4}-\d{2}-\d{2}$/.test(v.date));
          }
          if (viResult.patient_name && !extractedPatientName) extractedPatientName = viResult.patient_name;
          console.log(`VI: ${viPart.label} -> ${(viResults[partIdx] || []).length} visits`);
        } catch (e) {
          console.warn(`VI failed for ${viPart.id}: ${e.message}`);
        }
      }));
    }

    let knownVisits = [];
    for (const tagged of viResults) { if (tagged) knownVisits = knownVisits.concat(tagged); }

    // Deduplicate
    const viSeen = new Set();
    knownVisits = knownVisits.filter(v => {
      const k = `${v.date}|${(v.provider || '').toLowerCase()}`;
      if (viSeen.has(k)) return false;
      viSeen.add(k); return true;
    });
    knownVisits = knownVisits.filter(v => !/admin|fax|authorization|reminder|order/i.test(v.visit_type || ''));
    knownVisits.sort((a, b) => (a.date || '').localeCompare(b.date || ''));

    console.log(`buildVisitIndexWorker complete: ${knownVisits.length} visits`);

    // Write result — same pattern as markJobComplete
    await dynamo.send(new UpdateCommand({
      TableName: JOBS_TABLE, Key: { job_id },
      UpdateExpression: 'SET #s = :s, #res = :r, updated_at = :now',
      ExpressionAttributeNames: { '#s': 'status', '#res': 'result' },
      ExpressionAttributeValues: { ':s': 'complete', ':r': { known_visits: knownVisits, patient_name: extractedPatientName || inputPatientName || '' }, ':now': new Date().toISOString() },
    }));

  } catch (err) {
    console.error('buildVisitIndexWorker error:', err);
    await markJobFailed(job_id, err.message);
  }
};

const buildVisitIndexStartHandler = async (event) => {
  const body = typeof event.body === 'string' ? JSON.parse(event.body) : (event.body || {});
  const { doc_ids, patient_name: bodyPatientName = '' } = body;
  const org_id = event._orgId || body.org_id || '';

  if (!doc_ids?.length) return httpResponse(400, { error: 'doc_ids required' });

  const job_id = randomUUID();
  await dynamo.send(new UpdateCommand({
    TableName: JOBS_TABLE, Key: { job_id },
    UpdateExpression: 'SET #s = :s, created_at = :now, updated_at = :now, job_type = :t, org_id = :oid',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':s': 'pending', ':now': new Date().toISOString(), ':t': 'visit_index', ':oid': org_id },
  }));

  // Invoke worker asynchronously — reuses the same generateSummaryWorker Lambda function pattern
  await lambda.send(new InvokeCommand({
    FunctionName: process.env.VI_WORKER_FUNCTION_NAME || 'chartreview-pro-prod-buildVisitIndexWorker',
    InvocationType: 'Event',
    Payload: Buffer.from(JSON.stringify({ job_id, doc_ids, org_id, patient_name: bodyPatientName })),
  }));

  console.log(`buildVisitIndexStart: job_id=${job_id} docs=${doc_ids.length}`);
  return httpResponse(200, { job_id });
};

module.exports = {
module.exports = {
  generateSummaryStart:       validateApiKey(generateSummaryStartHandler),
  generateSummaryWorker:      generateSummaryWorker,
  generateSummaryChunkWorker: generateSummaryChunkWorker,
  buildVisitIndexStart:       validateApiKey(buildVisitIndexStartHandler),
  buildVisitIndexWorker:      buildVisitIndexWorkerFn,
};

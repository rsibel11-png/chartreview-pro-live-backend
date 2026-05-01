// generate_summary.js
// Rewritten: 2026-05-01 — original app prompt ported verbatim, InvokeLLM → Bedrock/AWS
// sanitizeVisits + deduplicateVisits from original app (chartreview-pro)
// VI pre-pass and BVI removed for clean baseline
// enforceOneC4, EXCLUDED_PATTERNS, misdated ER logic removed — original app did not use these

'use strict';

const { DynamoDBClient, GetItemCommand, UpdateItemCommand, QueryCommand, ScanCommand } = require('@aws-sdk/client-dynamodb');
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb');

const dynamo = new DynamoDBClient({ region: 'us-east-1' });
const bedrock = new BedrockRuntimeClient({ region: 'us-east-1' });
const lambda = new LambdaClient({ region: 'us-east-1' });
const s3 = new S3Client({ region: 'us-east-1' });

const TABLE_NAME = process.env.DOCUMENTS_TABLE || 'chartreview-documents-prod';
const JOBS_TABLE = process.env.JOBS_TABLE || 'chartreview-jobs-prod';
const S3_BUCKET = process.env.S3_BUCKET || 'chartreview-documents-prod';
const PRIMARY_MODEL = 'us.anthropic.claude-3-5-sonnet-20241022-v2:0';
const FALLBACK_MODEL = 'us.anthropic.claude-3-5-sonnet-20240620-v1:0';

const BATCH_SIZE = 1;
const BATCH_CONCURRENCY = 4;

// ─── Auth ─────────────────────────────────────────────────────────────────────
const validateApiKey = (handler) => async (event) => {
  const key = event.headers?.['x-api-key'] || event.headers?.['X-Api-Key'];
  if (key !== process.env.API_KEY) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }
  return handler(event);
};

const getOrgId = (event) => {
  return event.headers?.['x-org-id'] || event.headers?.['X-Org-Id'] || '';
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
const jsonResponse = (statusCode, body) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,X-Api-Key,X-Org-Id',
  },
  body: JSON.stringify(body),
});

const getFileBytes = async (fileKey) => {
  const cmd = new GetObjectCommand({ Bucket: S3_BUCKET, Key: fileKey });
  const res = await s3.send(cmd);
  const chunks = [];
  for await (const chunk of res.Body) chunks.push(chunk);
  return Buffer.concat(chunks).toString('base64');
};

// ─── Original app sanitizeVisits (verbatim port from chartreview-pro) ──────────
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

// ─── Original app deduplicateVisits (verbatim port from chartreview-pro) ──────
const deduplicateVisits = (visits) => {
  const visitList = visits || [];
  const exactKeys = new Set();
  const deduped = visitList.filter((visit) => {
    const dateKey = (visit.visit_date || '').trim().toLowerCase();
    const providerKey = (visit.rendering_provider || '').trim().toLowerCase();
    const settingKey = (visit.practice_setting || '').trim().toLowerCase();
    if (!dateKey && !providerKey) return true;
    const key = `${dateKey}|${providerKey}|${settingKey}`;
    if (exactKeys.has(key)) return false;
    exactKeys.add(key);
    return true;
  });
  return deduped;
};

// ─── Original app prompt (verbatim port from chartreview-pro) ─────────────────
const buildPrompt = (docCount, chunkLabel = '') => {
  const total = docCount;
  return `You are a medical-legal document analyst. Analyze these medical document(s) and extract ALL entries (office visits, expert reports, IME reports, chart reviews, etc.) across ALL documents.

${total > 1 ? `CRITICAL: You are analyzing documents (part of a larger set of ${total}) which may be parts of a single medical record split across multiple files, or related records for the same patient. You MUST extract entries from ALL documents/files and combine them into a single comprehensive summary. Do not stop after the first document.` : ''}

DOCUMENT TYPE HANDLING:
You may encounter different types of documents. Handle each type as follows:

A) OFFICE VISIT / CLINICAL NOTES (standard patient visit records):
    Extract each visit as a separate entry with all standard fields.
    CRITICAL: Always extract and include the actual practice setting/facility name from the document. Do NOT default to generic "office visit" or leave practice_setting empty.
    Examples of what to extract:
    - If document says "Smith Family Medical Group", use "Smith Family Medical Group" as practice_setting
    - If from "XYZ Orthopedic Associates", use "XYZ Orthopedic Associates"
    - If from "Community Hospital Emergency Department", use "Community Hospital Emergency Department"
    - NEVER label as simply "Office Visit" or "Clinic" — always include the specific facility/provider name from the document header, letterhead, or provider information section

B) EXPERT MEDICAL REPORTS / INDEPENDENT MEDICAL EXAMINATIONS (IME) / CHART REVIEWS / CONSULTATIONS / RADIOLOGY REPORTS:
   Use the EXACT document type as labeled in the document itself. Do NOT relabel or generalize — use the specific type stated. Examples:
   - If the document says "Independent Medical Examination" or "IME" → practice_setting: "Independent Medical Examination"
   - If the document says "Consultation Report" or "Consultative Evaluation" → practice_setting: "Consultation Report"
   - If the document says "Chart Review" or "Record Review" → practice_setting: "Chart Review"
   - If the document says "Radiology Report", "MRI Report", "X-Ray Report", "CT Report" → practice_setting: "Radiology Report"
   - If the document says "Narrative Report" or "Narrative Summary" → practice_setting: "Narrative Report"
   - If the document says "Agreed Medical Examination" or "AME" → practice_setting: "Agreed Medical Examination"
   - If the document says "Qualified Medical Evaluation" or "QME" → practice_setting: "Qualified Medical Evaluation"
   - If none of the above apply, use the most accurate label based on what is stated in the document header or title
   NEVER default to "Independent Medical Examination" unless those exact words (or "IME") appear in the document.
   For all of these types:
   - rendering_provider: the expert/reviewing physician's name
   - chief_complaint: the stated purpose of the report
   - hpi_summary: the expert's review of history and background as summarized in the report
   - physical_exam_findings: examination findings if the expert physically examined the patient, otherwise leave empty
   - impression_diagnosis: the expert's opinions, conclusions, and diagnoses
   - treatment_plan: the expert's recommendations or causation opinions
   - imaging_findings: any imaging reviewed or interpreted by the expert
   - visit_date: the date the report was authored or the examination was performed

C) POLICE REPORTS:
   Treat as a single entry with:
   - rendering_provider: the reporting officer's name and badge number if available
   - practice_setting: "Police Report"
   - chief_complaint: the incident type (e.g., "Motor Vehicle Collision", "Incident Report")
   - hpi_summary: narrative description of the incident — how it occurred, parties involved, witness statements, road/weather conditions, and any citations issued. Summarize concisely.
   - physical_exam_findings: any observations about injuries noted by the officer at the scene
   - impression_diagnosis: officer's conclusions, fault determination, or citations issued
   - treatment_plan: any emergency services dispatched or recommended at scene
   - visit_date: the date of the incident or report

D) AMBULANCE / EMS REPORTS (pre-hospital care records):
   Treat as a single entry with:
   - rendering_provider: the paramedic/EMT name or unit number
   - practice_setting: "Ambulance / EMS Report"
   - chief_complaint: the patient's chief complaint at the scene
   - hpi_summary: mechanism of injury, scene description, patient condition on arrival, and patient's reported symptoms. Summarize concisely.
   - physical_exam_findings: vital signs (BP, HR, RR, O2 sat, GCS), physical findings, and neurological status at scene
   - impression_diagnosis: EMS impression/working diagnosis
   - treatment_plan: treatment administered on scene and during transport (IV, medications, immobilization, oxygen, etc.), and destination facility
   - visit_date: the date of the incident/transport

E) C-4 FORMS (Workers' Compensation Board Doctor's Report / WCB Form C-4):
    STRICT IDENTIFICATION: Only treat as a C-4 if the document EXPLICITLY shows the official WCB Form C-4 header, title block, or reference number (e.g., "Form C-4", "Workers' Compensation Board", "WCB Report"). Do NOT label regular office visits or injury reports as C-4 unless the actual form is present.

    For ACTUAL C-4 forms only:
    - rendering_provider: the treating physician's name (look for signature block or printed name at bottom of form)
    - practice_setting: "C-4 Workers' Compensation Report"
    - impression_diagnosis: diagnosis only — ICD codes if present, otherwise the written diagnosis
    - visit_date: the date the form was completed or the examination date — this is CRITICAL to extract even if the rest of the form is illegible
    - hpi_summary: leave empty
    - chief_complaint: leave empty
    - physical_exam_findings: leave empty
    - treatment_plan: leave empty
    - CROSS-REFERENCE: If the C-4 date matches an office visit in the same document set, use that visit's rendering provider and/or diagnosis to fill in any illegible C-4 fields. Explicitly note when extrapolated (e.g., "Extrapolated from same-date office visit").
    - ORDERING: The C-4 entry must use the same visit_date as the corresponding office visit so it appears together in chronological order. In the visits array, place the C-4 entry BEFORE the regular office visit entry of the same date.

DEDUPLICATION RULE - Physician Progress Reports vs. Office Visits:
If the same date has BOTH a physician progress report AND an office visit from the SAME provider, IGNORE the physician progress report and ONLY include the office visit. The office visit record contains the actual clinical information, while the progress report is typically a summary/administrative document.

CRITICAL: If the document(s) contain MULTIPLE office visits or patient encounters, you MUST extract each visit separately as individual entries in the visits array.

CRITICAL DATE AND TIMELINE ACCURACY:
- Pay EXTREME attention to dates mentioned in the documents
- Multiple visits can occur at the SAME LOCATION on DIFFERENT DATES - treat each as a separate visit
- Match ALL findings, exams, and imaging to the CORRECT visit date they were documented on
- NEVER include information from a future visit in an earlier visit
- NEVER reference events (like accidents or injuries) that haven't occurred yet chronologically
- If a location appears multiple times with different dates, create separate visit entries for each date
- Double-check that all information in a visit entry actually occurred on or before that visit date

For EACH entry found across ALL documents, extract the following information:

IMPORTANT: Summarize and condense information - do NOT simply transcribe. Extract only the most relevant and pertinent information.

1. Visit date (if mentioned) - BE PRECISE, this is critical for timeline accuracy
2. Rendering provider name - extract the doctor's name only, not the patient name
3. Practice/setting - for expert reports use "Medical Expert Report", "Independent Medical Examination", or "Chart Review" as appropriate
4. Chief complaint - brief statement of visit purpose or report purpose

5. History of Present Illness (HPI) - SUMMARIZE CONCISELY:
   - Key presenting symptoms and their onset
   - Injury date if applicable (only on first visit) - VERIFY this injury date is BEFORE or ON the visit date
   - Pain scale where provided (e.g., "7/10")
   - Mechanism of injury (brief)
   - Whether symptoms are improved, the same, or worse from prior examinations
   - Relevant past medical history only if directly related
   - For expert reports: summarize the expert's review of the history
   - Keep this section focused and concise, 3-5 sentences maximum
   - DO NOT mention future events or injuries

6. Physical Examination Findings - SUMMARIZE KEY PERTINENT POSITIVES ONLY:
   - ONLY include findings documented on THIS specific visit/report date
   - Pain (location, severity) - only mention if significant
   - Loss of motion/range of motion limitations with specific measurements
   - Deformity, scar formation - only if present
   - Neurological findings (numbness, tingling, burning) - only if present
   - Swelling, tenderness - only if notable
   - Do NOT list normal findings
   - Keep concise, bullet-point style, 3-5 key findings maximum
   - For expert reports with no physical exam: leave empty

7. Imaging findings (X-ray, MRI, CT scans) - include EXACTLY as written, do NOT summarize these, ONLY if performed or reviewed on THIS visit/report date
8. Lab findings (bloodwork panels) - ONLY include if labs were actually performed on THIS visit date, otherwise return empty string
9. Impression/diagnosis - for expert reports include expert opinions, causation analysis, and conclusions with ICD-10 codes if provided (do not fabricate ICD codes)
10. Treatment Plan / Recommendations - SUMMARIZE CONCISELY:
    - Main interventions (medications, therapy, procedures) for clinical visits
    - For expert reports: expert's recommendations, causation opinions, prognosis
    - Activity restrictions if any
    - Follow-up timeline
    - Keep to 2-4 key points, omit routine instructions

Be thorough but CONCISE. Focus on clinically significant information only.

CRITICAL FORMATTING RULES:
- Every field must be a plain text string. NEVER return null, arrays, or objects for text fields.
- If information is not available for a field, return an empty string "".
- The icd10_codes field must always be an array of strings (can be empty []).

Return ALL entries found across ALL documents as separate entries in the visits array.

Also extract:
- Patient name (should be consistent across documents)
- Case number (should be consistent across documents)${chunkLabel ? `\n\nNote: ${chunkLabel}` : ''}`;
};

// ─── JSON schema for Bedrock tool ─────────────────────────────────────────────
const visitSchema = {
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
          symptom_progression:   { type: 'string', enum: ['improved','same','worse','not_documented'] },
          physical_exam_findings:{ type: 'string' },
          imaging_findings:      { type: 'string' },
          lab_findings:          { type: 'string' },
          impression_diagnosis:  { type: 'string' },
          icd10_codes:           { type: 'array', items: { type: 'string' } },
          treatment_plan:        { type: 'string' },
        }
      }
    }
  }
};

// ─── Bedrock call (Vision — PDF bytes) ────────────────────────────────────────
const callBedrock = async (fileKeys, prompt, schema, modelId = PRIMARY_MODEL) => {
  const content = [];

  for (const key of fileKeys) {
    try {
      const b64 = await getFileBytes(key);
      content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } });
    } catch (e) {
      console.warn(`callBedrock: could not fetch ${key}: ${e.message}`);
    }
  }

  content.push({ type: 'text', text: prompt });

  const body = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 8000,
    tools: [{
      name: 'extract_visits',
      description: 'Extract all medical visits and encounters from the documents',
      input_schema: schema,
    }],
    tool_choice: { type: 'tool', name: 'extract_visits' },
    messages: [{ role: 'user', content }],
  };

  const cmd = new InvokeModelCommand({
    modelId,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify(body),
  });

  const res = await bedrock.send(cmd);
  const parsed = JSON.parse(Buffer.from(res.body).toString('utf-8'));
  const toolBlock = parsed.content?.find(b => b.type === 'tool_use' && b.name === 'extract_visits');
  if (!toolBlock?.input) throw new Error('No tool_use block in Bedrock response');
  return toolBlock.input;
};

// ─── generateSummaryWorker ────────────────────────────────────────────────────
const generateSummaryWorker = async (event) => {
  const { job_id, doc_ids, org_id } = typeof event.body === 'string'
    ? JSON.parse(event.body) : (event.body || event);

  console.log(`generateSummaryWorker start: job_id=${job_id} docs=${doc_ids?.length}`);

  const updateJob = async (status, extra = {}) => {
    const now = new Date().toISOString();
    await dynamo.send(new UpdateItemCommand({
      TableName: JOBS_TABLE,
      Key: marshall({ job_id }),
      UpdateExpression: 'SET #s = :s, updated_at = :u' + (Object.keys(extra).length
        ? ', ' + Object.keys(extra).map((k,i) => `#k${i} = :v${i}`).join(', ') : ''),
      ExpressionAttributeNames: {
        '#s': 'status',
        ...Object.fromEntries(Object.keys(extra).map((k,i) => [`#k${i}`, k]))
      },
      ExpressionAttributeValues: marshall({
        ':s': status, ':u': now,
        ...Object.fromEntries(Object.keys(extra).map((k,i) => [`:v${i}`, extra[k]]))
      }),
    }));
  };

  try {
    await updateJob('processing');

    // Fetch all document parts from DynamoDB
    const allParts = [];
    for (const docId of doc_ids) {
      // Direct lookup by primary key first
      const direct = await dynamo.send(new GetItemCommand({
        TableName: TABLE_NAME,
        Key: marshall({ aws_document_id: docId }),
      }));
      if (direct.Item) {
        const doc = unmarshall(direct.Item);
        if (doc.status === 'processed' && doc.file_key) {
          allParts.push(doc);
          continue;
        }
      }
      // Fallback: scan for parts with matching original_document_id
      const scanRes = await dynamo.send(new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: 'original_document_id = :id AND #s = :processed',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: marshall({ ':id': docId, ':processed': 'processed' }),
      }));
      const parts = (scanRes.Items || []).map(unmarshall).filter(p => p.file_key);
      if (parts.length > 0) allParts.push(...parts);
    }

    console.log(`generateSummaryWorker: ${allParts.length} parts fetched`);
    if (allParts.length === 0) throw new Error('No processed document parts found');

    // Batch into groups of BATCH_SIZE
    const batches = [];
    for (let i = 0; i < allParts.length; i += BATCH_SIZE) {
      batches.push(allParts.slice(i, i + BATCH_SIZE));
    }

    console.log(`generateSummaryWorker: ${batches.length} batches (BATCH_SIZE=${BATCH_SIZE})`);

    let allVisits = [];
    let patientName = '';
    let caseNumber = '';

    // Process batches with concurrency cap
    const runBatch = async (batch, batchIndex) => {
      const fileKeys = batch.map(p => p.file_key);
      const chunkLabel = batches.length > 1
        ? `This is batch ${batchIndex + 1} of ${batches.length}. Extract ALL visits from these documents.`
        : '';
      const prompt = buildPrompt(allParts.length, chunkLabel);

      let result;
      try {
        result = await callBedrock(fileKeys, prompt, visitSchema, PRIMARY_MODEL);
      } catch (e) {
        console.warn(`Batch ${batchIndex} primary model failed: ${e.message} — trying fallback`);
        result = await callBedrock(fileKeys, prompt, visitSchema, FALLBACK_MODEL);
      }

      const visits = sanitizeVisits(result?.visits || [], result?.patient_name || '');
      console.log(`Batch ${batchIndex}: ${visits.length} visits extracted`);
      if (result?.patient_name && !patientName) patientName = result.patient_name;
      if (result?.case_number && !caseNumber) caseNumber = result.case_number;
      return visits;
    };

    // Run with BATCH_CONCURRENCY
    for (let i = 0; i < batches.length; i += BATCH_CONCURRENCY) {
      const chunk = batches.slice(i, i + BATCH_CONCURRENCY);
      const results = await Promise.all(chunk.map((batch, j) => runBatch(batch, i + j)));
      for (const r of results) allVisits = allVisits.concat(r);
    }

    // Deduplicate
    const deduped = deduplicateVisits(allVisits);

    // Sort by visit_date
    deduped.sort((a, b) => {
      if (!a.visit_date) return 1;
      if (!b.visit_date) return -1;
      return (a.visit_date || '').localeCompare(b.visit_date || '');
    });

    console.log(`generateSummaryWorker complete: ${deduped.length} visits after dedup`);

    await updateJob('completed', {
      result: JSON.stringify({
        visits: deduped,
        patient_name: patientName,
        case_number: caseNumber,
        visit_count: deduped.length,
      })
    });

  } catch (err) {
    console.error('generateSummaryWorker error:', err);
    await updateJob('failed', { error: err.message });
  }
};

// ─── generateSummaryStart ─────────────────────────────────────────────────────
const generateSummaryStartHandler = async (event) => {
  const body = typeof event.body === 'string' ? JSON.parse(event.body) : (event.body || {});
  const { doc_ids } = body;
  const org_id = getOrgId(event);

  if (!doc_ids || !Array.isArray(doc_ids) || doc_ids.length === 0) {
    return jsonResponse(400, { error: 'doc_ids array required' });
  }

  const job_id = `sum_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();

  await dynamo.send(new UpdateItemCommand({
    TableName: JOBS_TABLE,
    Key: marshall({ job_id }),
    UpdateExpression: 'SET #s = :s, job_type = :jt, org_id = :org, doc_ids = :d, created_at = :c, updated_at = :u',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: marshall({
      ':s': 'pending', ':jt': 'generate_summary',
      ':org': org_id, ':d': doc_ids,
      ':c': now, ':u': now,
    }),
  }));

  // Invoke worker async
  const workerName = process.env.SUMMARY_WORKER_FUNCTION_NAME || 'chartreview-pro-prod-generateSummaryWorker';
  await lambda.send(new InvokeCommand({
    FunctionName: workerName,
    InvocationType: 'Event',
    Payload: Buffer.from(JSON.stringify({ job_id, doc_ids, org_id })),
  }));

  console.log(`generateSummaryStart: job_id=${job_id} docs=${doc_ids.length}`);
  return jsonResponse(200, { job_id });
};

// ─── buildVisitIndexStart / Worker (preserved — isolated) ────────────────────
const buildVisitIndexPrompt = () => {
  return `You are a medical-legal document analyst. Extract a chronological visit index from these medical documents.

For each visit or encounter found, extract:
- visit_date: exact date in YYYY-MM-DD format
- rendering_provider: doctor or provider name
- facility: clinic, hospital, or facility name
- visit_type: type of encounter (e.g., "Office Visit", "Physical Therapy", "Emergency", "Radiology", "IME", "C-4")

Return ALL encounters found. Be thorough — do not skip any visit dates.
Include every PT/OT session as a separate entry.

CRITICAL: Return dates in YYYY-MM-DD format only.`;
};

const viSchema = {
  type: 'object',
  properties: {
    patient_name: { type: 'string' },
    case_number: { type: 'string' },
    visits: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          visit_date:         { type: 'string' },
          rendering_provider: { type: 'string' },
          facility:           { type: 'string' },
          visit_type:         { type: 'string' },
        }
      }
    }
  }
};

const buildVisitIndexWorkerFn = async (event) => {
  const { job_id, doc_ids, org_id } = typeof event.body === 'string'
    ? JSON.parse(event.body) : (event.body || event);

  console.log(`buildVisitIndexWorker start: job_id=${job_id} docs=${doc_ids?.length}`);

  const updateJob = async (status, extra = {}) => {
    const now = new Date().toISOString();
    await dynamo.send(new UpdateItemCommand({
      TableName: JOBS_TABLE,
      Key: marshall({ job_id }),
      UpdateExpression: 'SET #s = :s, updated_at = :u' + (Object.keys(extra).length
        ? ', ' + Object.keys(extra).map((k,i) => `#k${i} = :v${i}`).join(', ') : ''),
      ExpressionAttributeNames: {
        '#s': 'status',
        ...Object.fromEntries(Object.keys(extra).map((k,i) => [`#k${i}`, k]))
      },
      ExpressionAttributeValues: marshall({
        ':s': status, ':u': new Date().toISOString(),
        ...Object.fromEntries(Object.keys(extra).map((k,i) => [`:v${i}`, extra[k]]))
      }),
    }));
  };

  try {
    await updateJob('processing');

    const allParts = [];
    for (const docId of doc_ids) {
      // Direct lookup by primary key first
      const direct = await dynamo.send(new GetItemCommand({
        TableName: TABLE_NAME,
        Key: marshall({ aws_document_id: docId }),
      }));
      if (direct.Item) {
        const doc = unmarshall(direct.Item);
        if (doc.status === 'processed' && doc.file_key) {
          allParts.push(doc);
          continue;
        }
      }
      // Fallback: scan for parts with matching original_document_id
      const scanRes = await dynamo.send(new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: 'original_document_id = :id AND #s = :processed',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: marshall({ ':id': docId, ':processed': 'processed' }),
      }));
      const parts = (scanRes.Items || []).map(unmarshall).filter(p => p.file_key);
      if (parts.length > 0) allParts.push(...parts);
    }

    if (allParts.length === 0) throw new Error('No processed document parts found');

    const VI_CONCURRENCY = 4;
    const knownVisits = [];
    let patientName = '';
    let caseNumber = '';

    for (let vi = 0; vi < allParts.length; vi += VI_CONCURRENCY) {
      const viChunk = allParts.slice(vi, vi + VI_CONCURRENCY);
      await Promise.all(viChunk.map(async (viPart) => {
        try {
          const viResult = await callBedrock([viPart.file_key], buildVisitIndexPrompt(), viSchema);
          if (viResult?.visits) {
            knownVisits.push(...(viResult.visits || []));
            if (viResult.patient_name && !patientName) patientName = viResult.patient_name;
            if (viResult.case_number && !caseNumber) caseNumber = viResult.case_number;
          }
        } catch (e) {
          console.warn(`VI pre-pass failed for ${viPart.aws_document_id}: ${e.message}`);
        }
      }));
    }

    // Deduplicate by date+provider
    const seen = new Set();
    const uniqueVisits = knownVisits.filter(v => {
      const k = `${v.visit_date}|${(v.rendering_provider||'').toLowerCase()}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    uniqueVisits.sort((a, b) => (a.visit_date || '').localeCompare(b.visit_date || ''));

    console.log(`buildVisitIndexWorker complete: ${uniqueVisits.length} visits`);

    await updateJob('completed', {
      result: JSON.stringify({
        visits: uniqueVisits,
        patient_name: patientName,
        case_number: caseNumber,
        visit_count: uniqueVisits.length,
      })
    });

  } catch (err) {
    console.error('buildVisitIndexWorker error:', err);
    await updateJob('failed', { error: err.message });
  }
};

const buildVisitIndexStartHandler = async (event) => {
  const body = typeof event.body === 'string' ? JSON.parse(event.body) : (event.body || {});
  const { doc_ids } = body;
  const org_id = getOrgId(event);

  if (!doc_ids || !Array.isArray(doc_ids) || doc_ids.length === 0) {
    return jsonResponse(400, { error: 'doc_ids array required' });
  }

  const job_id = `vi_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();

  await dynamo.send(new UpdateItemCommand({
    TableName: JOBS_TABLE,
    Key: marshall({ job_id }),
    UpdateExpression: 'SET #s = :s, job_type = :jt, org_id = :org, doc_ids = :d, created_at = :c, updated_at = :u',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: marshall({
      ':s': 'pending', ':jt': 'build_visit_index',
      ':org': org_id, ':d': doc_ids,
      ':c': now, ':u': now,
    }),
  }));

  await lambda.send(new InvokeCommand({
    FunctionName: process.env.VI_WORKER_FUNCTION_NAME || 'chartreview-pro-prod-buildVisitIndexWorker',
    InvocationType: 'Event',
    Payload: Buffer.from(JSON.stringify({ job_id, doc_ids, org_id })),
  }));

  console.log(`buildVisitIndexStart: job_id=${job_id} docs=${doc_ids.length}`);
  return jsonResponse(200, { job_id });
};

// ─── Exports ──────────────────────────────────────────────────────────────────
module.exports = {
  generateSummaryStart:  validateApiKey(generateSummaryStartHandler),
  generateSummaryWorker: generateSummaryWorker,
  buildVisitIndexStart:  validateApiKey(buildVisitIndexStartHandler),
  buildVisitIndexWorker: buildVisitIndexWorkerFn,
};

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
  'us.anthropic.claude-3-5-sonnet-20241022-v2:0', // primary: Claude 3.5 Sonnet v2 — matches Base44 original app
  'us.anthropic.claude-3-5-sonnet-20240620-v1:0', // fallback: Claude 3.5 Sonnet v1
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

const deduplicateVisits = (visits) => {
  const visitList = visits || [];
  const exactKeys = new Set();
  const deduped = visitList.filter((visit) => {
    const dateKey = (visit.visit_date || '').trim().toLowerCase();
    const providerKey = (visit.rendering_provider || '').trim().toLowerCase();
    const settingKey = (visit.practice_setting || '').trim().toLowerCase();
    if (!dateKey && !providerKey) return true;
    // Primary key: date + provider + setting
    const primaryKey = `${dateKey}|${providerKey}|${settingKey}`;
    if (!exactKeys.has(primaryKey)) {
      exactKeys.add(primaryKey);
      return true;
    }
    // Same date+provider+setting: check HPI content fingerprint (first 60 chars)
    // to allow genuinely distinct same-day visits (e.g. two separate office encounters)
    const hpiSnippet = (visit.hpi_summary || visit.chief_complaint || '').trim().toLowerCase().slice(0, 60);
    const contentKey = `${primaryKey}|hpi:${hpiSnippet}`;
    if (hpiSnippet && !exactKeys.has(contentKey)) {
      exactKeys.add(contentKey);
      return true;
    }
    return false;
  });
  return deduped;
};

const sanitizeVisits = (visits, patientName) => {
  const stringFields = ['visit_date','rendering_provider','practice_setting','chief_complaint','hpi_summary','injury_date','pain_scale','symptom_progression','physical_exam_findings','imaging_findings','lab_findings','impression_diagnosis','treatment_plan'];
  const validProgressions = ['improved','same','worse','not_documented'];

  const isLikelyMisdatedER = (visit, allVisits) => {
    if (!/emergency|urgent care|ER|ED/i.test(visit.practice_setting || '')) return false;
    const injuryDateStr = visit.injury_date || '';
    const visitDateStr  = visit.visit_date  || '';
    if (!injuryDateStr || !visitDateStr) return false;
    if (injuryDateStr === visitDateStr) return false;
    const injuryDate = new Date(injuryDateStr + 'T00:00:00');
    const visitDate  = new Date(visitDateStr  + 'T00:00:00');
    if (isNaN(injuryDate) || isNaN(visitDate)) return false;
    const daysDiff = Math.abs((visitDate - injuryDate) / (1000 * 60 * 60 * 24));
    if (daysDiff > 7) return false;
    const realERExists = allVisits.some(v =>
      v !== visit &&
      /emergency|urgent care|ER|ED/i.test(v.practice_setting || '') &&
      (v.visit_date || '') === injuryDateStr
    );
    return !realERExists;
  };

  const enforceOneC4 = (visitList) => {
    const isC4 = (v) => {
      const s = (v.practice_setting || '').toLowerCase();
      return s.includes('c-4') || s.includes('wcb') || s.includes("workers' compensation report");
    };
    const c4Visits = visitList.filter(isC4);
    if (c4Visits.length <= 1) return visitList;
    const sorted = [...c4Visits].sort((a, b) => {
      if (!a.visit_date) return 1;
      if (!b.visit_date) return -1;
      return (a.visit_date||'').localeCompare(b.visit_date||'');
    });
    const earliest = sorted[0];
    const toRemove = new Set(sorted.slice(1).map(v => v));
    return visitList.filter(v => !toRemove.has(v));
  };

  return enforceOneC4((visits || [])
    .filter(visit => {
      const setting = (visit.practice_setting || '').toLowerCase();
      return !/(pacu|post.?anesthesia|pre.?op|post.?op|operating room|anesthesia|nursing note|medication administration|intake form|patient registration|appointment reminder|authorization|fax cover)/i.test(setting);
    })
    .map(visit => {
      const clean = { ...visit };
      clean.rendering_provider = toTitleCase(clean.rendering_provider);
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
      // Strip street addresses from practice_setting (e.g. "Clinic, 123 Main St, City, ST 12345")
      if (clean.practice_setting) {
        // Remove anything after a comma that looks like a street address (number + street word)
        clean.practice_setting = clean.practice_setting
          .replace(/,\s*\d+\s+[A-Za-z].*$/, '')  // ", 2800 East Desert Inn..." 
          .replace(/\s*\d{5}(?:-\d{4})?\s*$/, '') // trailing zip codes
          .replace(/,\s*(?:Ste|Suite|Floor|Fl|Bldg|Building|Unit|#)\s*[\w-]+\s*$/i, '') // suite/floor
          .trim()
          .replace(/,\s*$/, ''); // trailing comma
      }
      return clean;
    })
    .map((visit, _, arr) => {
      if (isLikelyMisdatedER(visit, arr)) {
        return { ...visit, visit_date: visit.injury_date };
      }
      return visit;
    })
  );
};

const buildVisitIndexPrompt = () => {
  return `You are reviewing medical-legal documents. Your ONLY task is to extract a complete list of every clinical encounter date, provider name, and facility/location.

For each clinical encounter found, extract:
1. date - the date of service (YYYY-MM-DD format). PRIMARY SOURCE: the document header or note title (e.g. "Visit Note - November 7, 2022" → 2022-11-07). The vitals table Date column also confirms the visit date. NEVER use the injury date or any date mentioned inside the HPI narrative as the visit date — the HPI often says things like "injury date 10/31/2022" which is NOT the visit date.
2. provider - the treating provider's name and credentials (e.g. "Arthur J. Taylor, MD")
3. facility - the facility or practice name (e.g. "Nevada Orthopedic & Spine Center", "Centennial Hills Hospital Emergency Department", "Dignity Health Physical Therapy")
4. visit_type - a brief label: "Office Visit", "ER Visit", "Surgery", "Physical Therapy", "Radiology", "C-4 Form", "IME", "Chiropractic", etc.

RULES:
- Include EVERY encounter -- office visits, ER, surgery, PT/OT, radiology, C-4 forms, IMEs, ambulance, etc.
- Each unique date + provider combination is a separate entry.
- Do NOT include administrative documents (therapy orders, authorization requests, appointment reminders, fax covers).
- ONLY include radiology visits (MRI, X-ray, CT, bone scan, etc.) if the actual radiology report document is present in the text — meaning it has its own document header, date stamp, and impression/findings section. Do NOT create a radiology visit entry simply because a physician's note mentions that an imaging study was ordered or that results were reviewed. A reference to imaging inside another provider's note is NOT a visit.
- CRITICAL: The HPI section often mentions the date of injury (e.g. "injury date 10/31/2022") -- this is NOT the visit date. The visit date is ALWAYS in the document header (e.g. "Visit Note November 7, 2022" or "Visit Note - November 7, 2022") or vitals table.
- IMPORTANT: Textract OCR may output page footers and headers from adjacent pages mixed into the text stream. Always look for the pattern "Visit Note [Month] [Day], [Year]" or "Visit Note [Month] [Day] [Year]" (with or without dash/comma) — this is the authoritative visit date. A date in the HPI like "she fell on 10/31/2022 and went to the ER" does NOT make 10/31 or 11/1 a visit date for THIS note.
- Do NOT include the date of injury as a visit date unless confirmed by a "Visit Note [date]" header on that exact date.
- Keep it fast and simple -- no clinical content needed, just date/provider/facility/type.
- If a date appears in a document header but no provider is identifiable, still include the entry with provider as "Not Documented".

Return all entries in the visits array.`;
};

const buildPrompt = (rawChunkText, docCount, chunkLabel = '', knownVisitsChecklist = [], skipPages = []) => {
  const chunkText = String(rawChunkText || '').replace(/`/g, "'").split('${').join('(');
  const multiDocNote = docCount > 1
    ? `CRITICAL: You are analyzing a batch of documents (part of a larger set of ${docCount} total). These may be parts of a single medical record split across multiple files, or related records for the same patient. You MUST extract entries from ALL documents/files in this batch and combine them into a single comprehensive response. Do not stop after the first document.`
    : '';
  const checklistSection = knownVisitsChecklist.length > 0
    ? `\n\nKNOWN VISITS CHECKLIST (from pre-pass — ensure ALL are represented in your output):\n` +
      knownVisitsChecklist.map(v => `- ${v.date} | ${v.provider || 'Unknown'} | ${v.facility || ''} | ${v.visit_type || ''}`).join('\n') +
      `\n\nCRITICAL: Every date in the checklist above MUST appear in your output visits array — including PT/OT therapy visits. If you cannot find clinical details for a checklist date, still include a visit entry with visit_date set to that date and fields set to "Not Documented".`
    : '';
  const skipPagesSection = skipPages.length > 0
    ? `\n\nSKIP THESE PAGES (non-clinical/administrative, confirmed by pre-classification — do not extract visits from page numbers): ${skipPages.join(', ')}`
    : '';

  return `You are a medical-legal document analyst. Analyze these ${docCount} medical document(s)${chunkLabel} and extract ALL entries (office visits, expert reports, IME reports, chart reviews, etc.) across ALL documents.

${multiDocNote}

DOCUMENT TYPE HANDLING:
You may encounter different types of documents. Handle each type as follows:

A) OFFICE VISIT / CLINICAL NOTES (standard patient visit records):
    Extract each visit as a separate entry with all standard fields.
    CRITICAL: Always extract and include the actual practice name/facility name from the document. Do NOT default to generic "office visit" or leave practice_setting empty.
    DIAGNOSIS FIELD RULE: impression_diagnosis must contain ONLY diagnosis names and ICD-10 codes from the Impression or Assessment section (e.g. "Foot Pain, Left (M79.672); Hallux Valgus (M20.10)"). Stop at the first line of treatment/plan text. The EHR may show diagnoses in a two-column layout with ICD codes in gray subtext — extract only the diagnosis name + ICD code pairs, NOT the plan or recommendations that follow.
    - NEVER label as simply "Office Visit" or "Clinic" — always include the specific facility/provider name from the document header, letterhead, or provider information section
    - practice_setting must be the PRACTICE NAME ONLY — do NOT include street addresses, suite numbers, zip codes, or city/state. Example: "Desert Orthopaedic Center" NOT "Desert Orthopaedic Center, 2800 East Desert Inn Road, Ste 100, Las Vegas, NV"
    - If the document shows "Facility Name - Branch/Location" format (e.g. "Desert Orthopaedic Center - Desert Inn"), keep that format as the name

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
   - impression_diagnosis: expert's opinions, conclusions, diagnoses (diagnosis names and ICD codes ONLY — do NOT include treatment plan text or recommendations here)
   - treatment_plan: expert's recommendations or causation opinions
   - imaging_findings: any imaging reviewed or interpreted by the expert
   - impression_diagnosis for ALL document types: list ONLY the diagnosis name(s) and ICD-10 code(s) as written in the Impression/Assessment/Plan section. Format: "Diagnosis Name (ICD-10: X00.0)". Do NOT include treatment recommendations, plan text, follow-up instructions, or clinical observations in this field — those belong in treatment_plan.
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
- Match ALL findings, exams, and imaging to the CORRECT visit date. Do not aggregate findings from multiple dates into a single entry.
- The PRIMARY source for visit_date is the document header or note title (e.g. "Visit Note - November 7, 2022" → 2022-11-07). ALWAYS use this date — it overrides everything else on the page.
- Dates in vitals tables (e.g. "11/07/22 10:19") confirm the visit date — use the date portion only (2022-11-07), ignoring the time.
- Dates in signature blocks, "Medications Obtained and Reviewed [date]", or "Reviewed [date]" also confirm the service date.
- NEVER use a date from the HPI narrative as the visit_date. The HPI often mentions the date of injury (e.g. "Injury occurred 10/31/2022") — this is NOT the visit date. The visit date is in the document header.
- The date of injury is NEVER the visit date unless the document header explicitly shows the patient was seen on that exact day.
- KNOWN VISITS CHECKLIST OVERRIDE: If a date appears in the KNOWN VISITS CHECKLIST above, you MUST use that exact date as visit_date for the matching visit. This is an absolute rule with no exceptions. Do NOT output a different date for a visit that matches a checklist entry.
- If you find a date in the document body (e.g. in the HPI, injury narrative, or referral text) that does NOT appear in the KNOWN VISITS CHECKLIST, do NOT create a visit for it UNLESS you can see a complete visit note for that date in the documents you are currently reviewing. If the checklist is present but a date is missing from it, it likely belongs to a different batch — skip it. Do NOT invent or hallucinate visits for dates not supported by an actual note in this batch.
- Valid visit_date values are: (a) dates explicitly listed in the KNOWN VISITS CHECKLIST that you can find evidence of in THIS batch, or (b) dates from document headers for complete visit notes present in THIS batch that are genuinely absent from the checklist.

PHYSICAL THERAPY INSTRUCTIONS:
- Extract EACH PT session as a separate visit entry — one entry per date.
- Include the specific facility name (e.g. "Dignity Health Physical Therapy - Las Vegas") in practice_setting.
- Do not combine or summarize PT visits.

${chunkText ? `DOCUMENT TEXT:\n\`\`\`\n${chunkText}\n\`\`\`` : ''}
${checklistSection}
${skipPagesSection}`;
};

// ─── generateSummaryWorker — ported v56 generateSummary logic ────────────────
const generateSummaryWorker = async (event) => {
  const { job_id, doc_ids, patient_name = '', org_id } = event;
  console.log(`generateSummaryWorker start: job_id=${job_id} docs=${doc_ids?.length}`);

  try {
    // Fetch all doc records from DynamoDB
    const docRecords = await fetchDocRecords(doc_ids);
    if (!docRecords.length) { await markJobFailed(job_id, 'No documents found in DynamoDB'); return; }
    console.log(`generateSummaryWorker: loaded ${docRecords.length} doc records`);

    // Build allParts — same logic as v56 but using DynamoDB records instead of frontend doc objects
    // AWS swap #2: instead of awsProxy download-url, we resolve file_key directly from the record
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

    let allVisits = [];
    let patientName = patient_name;
    let caseNumber = '';

    // ── VI pre-pass (v53 parallel, VI_CONCURRENCY=4) ──────────────────────────
    let knownVisits = [];
    try {
      await setJobStatus(job_id, 'Building visit checklist (pre-pass)...');
      console.log('generateSummaryWorker: starting VI pre-pass (parallel)');
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
                date: { type: 'string' },
                provider: { type: 'string' },
                facility: { type: 'string' },
                visit_type: { type: 'string' },
                source_doc_id: { type: 'string' },
                source_part_label: { type: 'string' },
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
            // AWS swap #2: use file_key directly instead of download-url
            const viResult = await callBedrock([viPart.file_key], buildVisitIndexPrompt(), viSchema);
            if (Array.isArray(viResult.visits)) {
              viResults[partIdx] = viResult.visits
                .filter(v => v.date && /^\d{4}-\d{2}-\d{2}$/.test(v.date))
                .map(v => ({ ...v, source_doc_id: viPart.id, source_part_label: viPart.label }));
            }
            console.log(`VI: ${viPart.label} -> ${(viResults[partIdx] || []).length} visits`);
            console.log(`VI_DEBUG [${viPart.label}] raw visits:`, JSON.stringify((viResults[partIdx] || []).map(v => ({ date: v.date, provider: v.provider, facility: v.facility, type: v.visit_type }))));
          } catch (e) {
            console.warn(`VI pre-pass failed for ${viPart.id}: ${e.message}`);
          }
        }));
      }

      for (const tagged of viResults) {
        if (tagged) knownVisits = knownVisits.concat(tagged);
      }
      // Deduplicate knownVisits by date+provider
      const viSeen = new Set();
      knownVisits = knownVisits.filter(v => {
        const k = `${v.date}|${(v.provider || '').toLowerCase()}`;
        if (viSeen.has(k)) return false;
        viSeen.add(k);
        return true;
      });
      // Exclude administrative visit types
      knownVisits = knownVisits.filter(v =>
        !/admin|fax|authorization|reminder|order/i.test(v.visit_type || '')
      );
      console.log(`VI pre-pass complete: ${knownVisits.length} unique visits`);
      console.log('VI checklist dates:', JSON.stringify(knownVisits.map(v => ({ date: v.date, provider: v.provider, type: v.visit_type }))));
    } catch (viErr) {
      console.warn('VI pre-pass failed (non-fatal):', viErr.message);
      knownVisits = [];
    }

    // ── Build batches (BATCH_SIZE=1, BATCH_OVERLAP=0, BATCH_CONCURRENCY=4) ────
    // Each part gets its own isolated Bedrock call — avoids output token
    // competition and schema confusion when VI checklist is large (Sonnet 4.6).
    const BATCH_SIZE = 1;
    const BATCH_OVERLAP = 0;
    const batches = [];
    for (let start = 0; start < allParts.length; start += BATCH_SIZE) {
      batches.push(allParts.slice(start, start + BATCH_SIZE));
    }
    const totalBatches = batches.length;
    const BATCH_CONCURRENCY = 4;
    console.log(`generateSummaryWorker: ${totalBatches} batches, concurrency=${BATCH_CONCURRENCY}`);

    const fullSchema = {
      type: 'object',
      properties: {
        patient_name: { type: 'string' },
        case_number: { type: 'string' },
        visits: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              visit_date: { type: 'string' },
              rendering_provider: { type: 'string' },
              practice_setting: { type: 'string' },
              chief_complaint: { type: 'string' },
              hpi_summary: { type: 'string' },
              injury_date: { type: 'string' },
              pain_scale: { type: 'string' },
              symptom_progression: { type: 'string', enum: ['improved', 'same', 'worse', 'not_documented'] },
              physical_exam_findings: { type: 'string' },
              imaging_findings: { type: 'string' },
              lab_findings: { type: 'string' },
              impression_diagnosis: { type: 'string' },
              icd10_codes: { type: 'array', items: { type: 'string' } },
              treatment_plan: { type: 'string' },
            },
          },
        },
      },
    };

    const simpleSchema = {
      type: 'object',
      properties: {
        patient_name: { type: 'string' },
        case_number: { type: 'string' },
        visits: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              visit_date: { type: 'string' },
              rendering_provider: { type: 'string' },
              practice_setting: { type: 'string' },
              hpi_summary: { type: 'string' },
              impression_diagnosis: { type: 'string' },
              treatment_plan: { type: 'string' },
              icd10_codes: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
    };

    // ── runBatch — AWS swap #1: callBedrock instead of InvokeLLM ─────────────
    const runBatch = async (batch, batchIndex, knownVisitsChecklist = []) => {
      // AWS swap #2: use file_key instead of download-url
      const fileKeys = batch.map(p => p.file_key).filter(Boolean);
      const skipPages = batch.flatMap(p =>
        (p.page_classifications || []).filter(pc => !pc.is_clinical).map(pc => pc.page)
      );
      if (fileKeys.length === 0) {
        console.warn(`Batch ${batchIndex + 1}: no valid file keys, skipping`);
        return null;
      }
      const batchLabel = totalBatches > 1 ? ` [Batch ${batchIndex + 1} of ${totalBatches}]` : '';
      let result;
      try {
        // AWS swap #1: callBedrock instead of InvokeLLM
        result = await callBedrock(
          fileKeys,
          buildPrompt('', allParts.length, batchLabel, knownVisitsChecklist, skipPages),
          fullSchema
        );
      } catch (llmErr) {
        if (/invalid json|json|delimiter|expecting/i.test(llmErr.message || '')) {
          console.warn(`Batch ${batchIndex + 1}: JSON error, retrying with simplified schema...`);
          try {
            result = await callBedrock(
              fileKeys,
              buildPrompt('', allParts.length, batchLabel + ' [retry]', knownVisitsChecklist, skipPages),
              simpleSchema
            );
          } catch (retryErr) {
            console.error(`Batch ${batchIndex + 1}: retry also failed:`, retryErr.message);
            return null;
          }
        } else {
          throw llmErr;
        }
      }
      return result;
    };

    // ── Main pass: process batches BATCH_CONCURRENCY at a time (identical to v56) ──
    for (let i = 0; i < totalBatches; i += BATCH_CONCURRENCY) {
      const chunk = batches.slice(i, i + BATCH_CONCURRENCY);
      const chunkEnd = Math.min(i + BATCH_CONCURRENCY, totalBatches);
      console.log(`Main pass: batches ${i + 1}-${chunkEnd} of ${totalBatches}`);
      await setJobStatus(job_id, `Analyzing batches ${i + 1}–${chunkEnd} of ${totalBatches}...`);
      const chunkResults = await Promise.all(
        chunk.map((batch, j) => runBatch(batch, i + j, knownVisits))
      );
      for (const result of chunkResults) {
        if (!result) continue;
        if (!patientName && result.patient_name) patientName = result.patient_name;
        if (!caseNumber && result.case_number) caseNumber = result.case_number;
        const clean = sanitizeVisits(result.visits, patientName);
        console.log('DIAG result.visits type=' + typeof result.visits + ' isArray=' + Array.isArray(result.visits) + ' len=' + (Array.isArray(result.visits) ? result.visits.length : 'n/a') + ' afterSanitize=' + clean.length);
        allVisits = allVisits.concat(clean);
      }
    }


        // ── Merge + deduplicate + sort (identical to v56) ─────────────────────────
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

    // ── Recovery pass (identical to v56) ──────────────────────────────────────
    if (knownVisits.length > 0) {
      const foundDates = new Set(allVisits.map(v => (v.visit_date || '').trim()).filter(Boolean));
      const missingVisits = knownVisits.filter(v => {
        if (!v.date) return false;
        // PT visits are included in recovery pass
        return !foundDates.has(v.date);
      });

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
                  visit_date: { type: 'string' },
                  rendering_provider: { type: 'string' },
                  practice_setting: { type: 'string' },
                  chief_complaint: { type: 'string' },
                  hpi_summary: { type: 'string' },
                  injury_date: { type: 'string' },
                  pain_scale: { type: 'string' },
                  symptom_progression: { type: 'string', enum: ['improved', 'same', 'worse', 'not_documented'] },
                  physical_exam_findings: { type: 'string' },
                  imaging_findings: { type: 'string' },
                  lab_findings: { type: 'string' },
                  impression_diagnosis: { type: 'string' },
                  icd10_codes: { type: 'array', items: { type: 'string' } },
                  treatment_plan: { type: 'string' },
                },
              },
            },
          },
        };

        // Group by source_doc_id (v51: target exact part, not positional guess)
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
            const srcPart = allParts.find(p => p.id === srcDocId);
            const recFileKey = srcPart?.file_key || allParts[0]?.file_key;
            if (!recFileKey) return;
            const visitList = mvGroup.map(v => `- ${v.date} | ${v.provider || 'Unknown'} | ${v.facility || ''}`).join('\n');
            const recPrompt = `You are reviewing medical-legal documents. A specific clinical visit is known to exist in these records but was missed in the prior extraction pass.

TARGET VISIT${mvGroup.length > 1 ? 'S' : ''}:
${visitList}

Your task: Find the above visit${mvGroup.length > 1 ? 's' : ''} in the provided document and extract full clinical details for ${mvGroup.length > 1 ? 'each one' : 'it'}. If you cannot find it, return an empty visits array. Do not extract any other visits.`;
            try {
              // AWS swap #1: callBedrock instead of InvokeLLM
              const recResult = await callBedrock([recFileKey], recPrompt, recSchema);
              if (Array.isArray(recResult.visits) && recResult.visits.length > 0) {
                const recClean = sanitizeVisits(recResult.visits, patientName);
                allVisits = allVisits.concat(recClean);
                console.log(`Recovery: recovered ${recClean.length} visit(s) from ${srcDocId}`);
              } else {
                console.warn(`Recovery: Bedrock returned 0 visits for ${srcDocId} (possible throttle/limit) -- keeping existing visits`);
              }
            } catch (recErr) {
              console.warn(`Recovery failed for ${srcDocId}:`, recErr.message);
            }
          }));
        }

        // Final dedup after recovery
        allVisits = deduplicateVisits(allVisits);
        allVisits.sort((a, b) => {
          if (!a.visit_date) return 1;
          if (!b.visit_date) return -1;
          return (a.visit_date||'').localeCompare(b.visit_date||'');
        });
      } // end else if (missingVisits.length > 0)
    } // end if (knownVisits.length > 0)

    // ── Checklist enforcement: correct any visit whose date is not in the VI checklist ──
    // The VI pre-pass is the ground truth for visit dates (built from document headers).
    // If the main pass returns a date not in the checklist, it is a mislabeled visit --
    // find the best matching checklist entry by provider/facility and correct the date.
    if (knownVisits.length > 0) {
      const checklistDates = new Set(knownVisits.map(v => v.date));
      allVisits = allVisits.map(v => {
        const d = (v.visit_date || '').trim();
        if (!d || checklistDates.has(d)) return v; // date is correct, no action needed

        // Date is not in checklist -- find best matching checklist entry
        const provider = (v.provider || '').toLowerCase();
        const facility = (v.practice_setting || '').toLowerCase();

        // Score each checklist entry by provider/facility similarity
        let bestMatch = null;
        let bestScore = 0;
        for (const cv of knownVisits) {
          let score = 0;
          const cvProvider = (cv.provider || '').toLowerCase();
          const cvFacility = (cv.facility || '').toLowerCase();
          // Check for word overlap in provider name
          const providerWords = provider.split(/\s+/).filter(w => w.length > 2);
          for (const w of providerWords) {
            if (cvProvider.includes(w)) score += 2;
          }
          // Check facility overlap
          const facilityWords = facility.split(/\s+/).filter(w => w.length > 3);
          for (const w of facilityWords) {
            if (cvFacility.includes(w)) score += 1;
          }
          if (score > bestScore) {
            bestScore = score;
            bestMatch = cv;
          }
        }

        if (bestMatch && bestScore > 0) {
          console.log(`CHECKLIST_CORRECT: corrected visit_date ${d} -> ${bestMatch.date} (provider match score ${bestScore}, provider: ${v.provider})`);
          return { ...v, visit_date: bestMatch.date };
        } else {
          // No provider match -- date is likely a phantom, log and keep original
          console.log(`CHECKLIST_CORRECT: no match found for date ${d} provider "${v.provider}" -- keeping as-is`);
          return v;
        }
      });
    }

    console.log(`generateSummaryWorker complete: ${allVisits.length} visits`);
    if (allVisits.length === 0 && knownVisits.length > 0) {
      console.warn(`generateSummaryWorker: WARNING -- 0 visits written despite ${knownVisits.length} VI entries. Possible Bedrock throttle/timeout on all batches.`);
    }
    await setJobStatus(job_id, `Saving ${allVisits.length} visits...`);

    await markJobComplete(job_id, {
      patient_name: patientName || '',
      case_number: caseNumber || '',
      visits: allVisits,
      doc_count: docRecords.length,
      visit_count: allVisits.length,
    });

  } catch (err) {
    console.error('generateSummaryWorker fatal:', err);
    await markJobFailed(job_id, err.message);
  }
};

// ─── generateSummaryStart — kick off job + invoke worker async ────────────────
const generateSummaryStartHandler = async (event) => {
  const body = typeof event.body === 'string' ? JSON.parse(event.body) : (event.body || {});
  const { doc_ids, patient_name = '' } = body;
  const org_id = event._orgId || body.org_id || '';

  if (!doc_ids?.length) return httpResponse(400, { error: 'doc_ids required' });

  const job_id = randomUUID();
  await dynamo.send(new UpdateCommand({
    TableName: JOBS_TABLE, Key: { job_id },
    UpdateExpression: 'SET #s = :s, created_at = :now, updated_at = :now, job_type = :t, org_id = :oid',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':s': 'running', ':now': new Date().toISOString(), ':t': 'generate_summary', ':oid': org_id },
  }));

  // Invoke worker asynchronously
  await lambda.send(new InvokeCommand({
    FunctionName: WORKER_FN,
    InvocationType: 'Event',
    Payload: Buffer.from(JSON.stringify({ job_id, doc_ids, patient_name, org_id })),
  }));

  console.log(`generateSummaryStart: job_id=${job_id} docs=${doc_ids.length}`);
  return httpResponse(200, { job_id });
};

// ─── Entry point ─────────────────────────────────────────────────────────────
const generateSummaryHandler = async (event) => {
  if (event.job_id && event.doc_ids) {
    await generateSummaryWorker(event);
    return;
  }
  return generateSummaryStartHandler(event);
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
  generateSummaryStart:  validateApiKey(generateSummaryStartHandler),
  generateSummaryWorker: generateSummaryWorker,
  buildVisitIndexStart:  validateApiKey(buildVisitIndexStartHandler),
  buildVisitIndexWorker: buildVisitIndexWorkerFn,
};



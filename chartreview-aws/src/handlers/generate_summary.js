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
  'us.anthropic.claude-sonnet-4-6',               // primary: cross-region Sonnet 4.6 (no version suffix)
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
    ? `CRITICAL: You are analyzing a batch of documents (part of a larger set of ${docCount} total). These may be parts of a single patient record. Extract every encounter found in THIS batch only.`
    : '';

  return `You are a medical-legal document analyst. Your job is to extract EVERY clinical encounter from this document   including but not limited to:
- Emergency Room (ER) visits
- Urgent Care visits  
- Private or group physician office visits (orthopedic, neurology, pain management, primary care, etc.)
- Surgical visits and operative reports
- Radiology center visits (MRI, CT, X-ray, ultrasound reports)
- Physical Therapy / Occupational Therapy sessions
- Chiropractic visits
- Ambulance / EMS reports
- C-4 Workers' Compensation forms
- IME / Expert reports / Chart reviews
- Hospital admissions and discharge summaries
- Any other clinical or medical-legal encounter

${skipPages.length > 0 ? `SKIP PAGES: The following page numbers in this PDF contain non-clinical photographs or surveillance images -- do NOT extract visits from pages: ${skipPages.join(', ')}.\n` : ''}
DO NOT skip any encounter type. Every date with a provider interaction is a separate entry.

${chunkText ? `DOCUMENT TEXT${chunkLabel}:\n${chunkText}\n` : ''}DOCUMENT TYPE HANDLING:
You may encounter different types of documents. Handle each type as follows:

A) OFFICE VISIT / CLINICAL NOTES (standard patient visit records):
    Extract each visit as a separate entry with all standard fields.
    CRITICAL: Always extract and include the actual practice setting/facility name from the document. Do NOT default to generic "office visit" or leave practice_setting empty.
    Examples of what to extract:
    - If document says "Smith Family Medical Group", use "Smith Family Medical Group" as practice_setting
    - If from "XYZ Orthopedic Associates", use "XYZ Orthopedic Associates" 
    - If from "Community Hospital Emergency Department", use "Community Hospital Emergency Department"
    - NEVER label as simply "Office Visit" or "Clinic" -- always include the specific facility/provider name from the document header, letterhead, or provider information section
    IMPORTANT: Visit type labels are NOT facility names. "Follow-up Consultation", "New Patient Visit", "Follow-up", "Initial Consultation", "Progress Note" -- these describe the TYPE of visit, NOT the facility. Look past these labels to find the actual practice or facility name in the letterhead, header, or footer. If you cannot find a facility name, use the rendering provider's name + "Office" (e.g., "James Dettling, M.D. Office").

B) EXPERT MEDICAL REPORTS / INDEPENDENT MEDICAL EXAMINATIONS (IME) / CHART REVIEWS / CONSULTATIONS / RADIOLOGY REPORTS:
   Use the EXACT document type as labeled in the document itself. Do NOT relabel or generalize   use the specific type stated. Examples:
   - If the document says "Independent Medical Examination" or "IME"   practice_setting: "Independent Medical Examination"
   - If the document says "Consultation Report" or "Consultative Evaluation"   practice_setting: "Consultation Report"
   - If the document says "Chart Review" or "Record Review"   practice_setting: "Chart Review"
   - If the document says "Radiology Report", "MRI Report", "X-Ray Report", "CT Report"   practice_setting: use the imaging facility name if present (e.g., "Pueblo Medical Imaging", "Centennial Hills Radiology"), followed by the modality in parentheses if helpful (e.g., "Pueblo Medical Imaging (MRI)"). If no facility name is identifiable, use the modality type (e.g., "MRI Report", "CT Report")
   - If the document says "Narrative Report" or "Narrative Summary"   practice_setting: "Narrative Report"
   - If the document says "Agreed Medical Examination" or "AME"   practice_setting: "Agreed Medical Examination"
   - If the document says "Qualified Medical Evaluation" or "QME"   practice_setting: "Qualified Medical Evaluation"
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
   - hpi_summary: narrative description of the incident
   - physical_exam_findings: any observations about injuries noted by the officer at the scene
   - impression_diagnosis: officer's conclusions, fault determination, or citations issued
   - treatment_plan: any emergency services dispatched or recommended at scene
   - visit_date: the date of the incident or report

D) AMBULANCE / EMS REPORTS (pre-hospital care records):
   Treat as a single entry with:
   - rendering_provider: the paramedic/EMT name or unit number
   - practice_setting: "Ambulance / EMS Report"
   - chief_complaint: the patient's chief complaint at the scene
   - hpi_summary: mechanism of injury, scene description, patient condition on arrival
   - physical_exam_findings: vital signs, physical findings, and neurological status at scene
   - impression_diagnosis: EMS impression/working diagnosis
   - treatment_plan: treatment administered on scene and during transport, and destination facility
   - visit_date: the date of the incident/transport

E) C-4 FORMS (Workers' Compensation Board Doctor's Report / WCB Form C-4):
    STRICT IDENTIFICATION: Only treat as a C-4 if ALL of the following are true:
    1. The actual text of the C-4 form is physically present in the document you are reading -- you must see the WCB Form C-4 header, title block, or form fields in the text itself (e.g., "Form C-4", "Workers' Compensation Board", "WCB Report", form field labels like "Date of Injury", "Last Day Worked", "Supervisor Name" in a structured form layout). Do NOT infer or assume a C-4 exists based on the visit being workers' comp related.
    2. The visit date is at or near the EARLIEST date in the entire document set -- the C-4 is the intake form completed at the FIRST visit for the industrial accident. There is only ONE C-4 per case. It will typically be found embedded within the initial ER or first office visit records, not in follow-up notes.
    3. Do NOT label any follow-up visits, post-operative visits, or subsequent office visits as C-4, even if those notes reference the workers' comp claim or injury. Only the initial treating visit generates a C-4 form.

    If you find what appears to be C-4 form text at multiple dates, include ONLY the one with the earliest date and treat all others as regular office visits.
    If no actual C-4 form text is found anywhere in the documents, do not create a C-4 entry at all.

    For the ONE C-4 entry:
    - rendering_provider: the treating physician's name (look for signature block or printed name at bottom of form)
    - practice_setting: "C-4 Workers' Compensation Report"
    - impression_diagnosis: diagnosis only -- ICD codes if present, otherwise the written diagnosis
    - visit_date: the date the form was completed or the examination date -- this is CRITICAL to extract even if the rest of the form is illegible
    - hpi_summary: leave empty
    - chief_complaint: leave empty
    - physical_exam_findings: leave empty
    - treatment_plan: leave empty
    - CROSS-REFERENCE: If the C-4 date matches an office visit in the same document set, use that visit's rendering provider and/or diagnosis to fill in any illegible C-4 fields. Explicitly note when extrapolated (e.g., "Extrapolated from same-date office visit").
    - ORDERING: Place the C-4 entry BEFORE the regular office visit entry of the same date.
DEDUPLICATION RULE: If the same date has BOTH a physician progress report AND an office visit from the SAME provider, IGNORE the physician progress report and ONLY include the office visit.

CRITICAL DATE AND TIMELINE ACCURACY:
- Pay EXTREME attention to dates mentioned in the documents
- Multiple visits can occur at the SAME LOCATION on DIFFERENT DATES - treat each as a separate visit
- Match ALL findings, exams, and imaging to the CORRECT visit date
- NEVER include information from a future visit in an earlier visit
- NEVER reference events that haven't occurred yet chronologically
- The visit_date MUST be the DATE OF SERVICE (the date the clinical encounter actually occurred) -- NOT the date of injury, NOT the date the report was typed, NOT the date of dictation
- "Date of Injury" and "Date of Accident" are NEVER the visit_date unless the patient was seen on that exact day (e.g. same-day ER visit). Even then, use the actual clinical service date from the note header, not the injury date field
- For ER visits: the service date is typically in the note header or the "Date of Service" / "Encounter Date" field -- it is almost always ONE DAY AFTER the injury date for overnight incidents. Use that date, not the injury date
- If you see only one date on a document and it matches a known injury date, look harder -- there is almost always a separate service/encounter date elsewhere in the document
- The visit_date will almost always appear in the DOCUMENT HEADER (top of the note), not in the body narrative (HPI, subjective section). The injury date is commonly mentioned in the HPI/narrative -- do NOT use that date as the visit_date
- For orthopedic/specialist consultation notes (e.g. "Follow-up Consultation", "Orthopedic Consultation"): the visit date is in the note header or the date the note was authored -- NOT the date of injury mentioned in the HPI. Example: if HPI says "patient injured on 8/12/2024" but the note header says "Date of Service: 3/15/2025", use 3/15/2025.
- EXCEPTION: Occupational medicine / workers comp facilities (e.g. Concentra, Workcare, Occumed, or any note labeled "Workers Compensation" or "Occupational Medicine") often include BOTH the date of injury AND the date of service in the header -- in that case use the "Date of Service" or "Visit Date" field, not the "Date of Injury" field

For EACH entry found, extract:
1. Visit date (YYYY-MM-DD)   BE PRECISE
2. Rendering provider name   doctor's name only, not patient name
3. Practice/setting   specific facility name or document type
4. Chief complaint   brief statement of visit purpose
5. HPI   SUMMARIZE CONCISELY: key symptoms, injury date (first visit only), pain scale, mechanism, symptom progression. 3-5 sentences max.
6. Physical Examination   key pertinent positives only: pain location/severity, ROM with measurements, neurological findings, swelling. Do NOT list normal findings. 3-5 key findings max.
7. Imaging findings   include EXACTLY as written, ONLY if performed on THIS visit date
8. Lab findings   ONLY if labs actually performed on THIS visit date
9. Impression/diagnosis   with ICD-10 codes if provided (do NOT add codes if not in source)
10. Treatment Plan   SUMMARIZE: main interventions, expert recommendations, restrictions, follow-up. 2-4 key points.

CRITICAL EXTRACTION RULES:
(1) Extract EVERY clinical encounter   office visits, ER visits, surgical reports, radiology reports, IMEs, C-4 forms, ambulance reports, police reports. Do NOT skip any.
(2) For EVERY non-PT visit, you MUST populate hpi_summary, impression_diagnosis, and treatment_plan if that information exists anywhere in the text for that encounter. A visit with only date/provider and empty content fields is almost always an error   go back and fill it in.
(3) NEVER return a visit with all content fields empty unless it is truly just a C-4 form with no clinical notes.
(4) NEVER hallucinate   only use information explicitly in the text.
(5) Every field must be a plain text string. NEVER return null, arrays, or objects for text fields.
(6) If information is truly not available, return an empty string "".
(7) The icd10_codes field must always be an array of strings (can be empty []).
(8) PHYSICAL/OCCUPATIONAL THERAPY VISITS: Extract EVERY individual PT/OT session as its own separate record. Do NOT collapse multiple PT sessions into one. Do NOT summarize a series of visits as a single entry. Each visit date = one record. PT notes are often brief one-liners (date, therapist initials, modalities, exercise sets) -- each one is a separate visit and must be extracted individually. If a page contains 10 PT visit dates, return 10 separate visit records.
(9) For PT visits: practice_setting should be the full facility name (e.g. "Dignity Health Physical Therapy", "Nevada Rehabilitation Institute"). Do NOT abbreviate to just "PT" or "Physical Therapy". Consistent facility naming across all records is critical.
(10) For PT/OT visits, map document sections to output fields as follows:
    - SUBJECTIVE / Pain Assessment / Chief Complaint / History → hpi_summary (include pain scale if documented, e.g. "4/10 at best, 8/10 at worst")
    - OBJECTIVE / Objective Examination / Range of Motion / Strength Testing / Sensory Assessment / Gait / Balance / Palpation / Functional Observations → physical_exam_findings (include specific ROM measurements, MMT grades, sensory findings, gait observations)
    - ASSESSMENT / Assessment of Complexity / Patient Response → treatment_plan (include response to PT intervention, goals progress, plan)
    - Diagnoses / Medical DX / ICD codes → impression_diagnosis
    - Activity Log / PT Interventions / Treatments / Exercise Activities → include key interventions in treatment_plan
    - NEVER return empty strings for these fields if the PT note contains SUBJECTIVE, OBJECTIVE, or ASSESSMENT sections.

Return ALL entries found as separate entries in the visits array.
Also extract: patient_name, case_number.` + (knownVisitsChecklist.length > 0 ? ('\n\nKNOWN VISIT CHECKLIST (pre-pass):\nThe following clinical encounters are known to exist in this document set. Scan carefully for each and ensure it appears in your output. If a note is present but partially cut off, extract what is available -- do not skip it entirely.\n' + knownVisitsChecklist.map(v => '- ' + v.date + ' | ' + (v.provider||'Unknown') + ' | ' + (v.facility||'') + ' | ' + (v.visit_type||'')).join('\n') + '\n\nIf a listed visit is NOT found in the documents you are currently reviewing, omit it -- it may be in a different batch. Only include visits you can see evidence of in these documents.') : '');
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
          console.warn(`Batch ${batchIndex + 1}: JSON error, retrying with fullSchema...`);
          try {
            result = await callBedrock(
              fileKeys,
              buildPrompt('', allParts.length, batchLabel + ' [retry]', knownVisitsChecklist, skipPages),
              fullSchema
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


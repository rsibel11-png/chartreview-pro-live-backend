// redact_document.js — ChartReview Pro redaction Lambda
// Route: POST /documents/{aws_document_id}/redact
// Worker: redactDocumentWorker (900s, invoked async)
// Updated: 2026-05-24 — fix box alignment offset + add address/phone/insurance regex patterns

'use strict';

const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl }                                  = require('@aws-sdk/s3-request-presigner');
const { DynamoDBClient }                               = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { BedrockRuntimeClient, InvokeModelCommand }     = require('@aws-sdk/client-bedrock-runtime');
const { LambdaClient, InvokeCommand }                  = require('@aws-sdk/client-lambda');
const { PDFDocument, rgb }                             = require('pdf-lib');
const { randomUUID }                                   = require('crypto');
const { validateApiKey }                               = require('./auth');

const s3           = new S3Client({ region: process.env.AWS_REGION || 'us-east-1', requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' });
const dynamo       = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const bedrock      = new BedrockRuntimeClient({ region: 'us-east-1' });
const lambdaClient = new LambdaClient({ region: process.env.AWS_REGION || 'us-east-1' });

const BUCKET     = process.env.S3_BUCKET       || 'chartreview-documents-prod';
const DOCS_TABLE = process.env.DOCUMENTS_TABLE || 'chartreview-documents-prod';
const JOBS_TABLE = process.env.JOBS_TABLE      || 'chartreview-jobs-prod';
const MODEL_ID   = process.env.MODEL_ID        || 'us.anthropic.claude-sonnet-4-6';
const WORKER_FN  = process.env.REDACT_WORKER_FUNCTION_NAME || 'chartreview-pro-prod-redactDocumentWorker';

// ── helpers ───────────────────────────────────────────────────────────────────

const respond = function(statusCode, body) {
  return {
    statusCode: statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization,x-api-key,x-org-id',
    },
    body: JSON.stringify(body),
  };
};

async function getS3Bytes(key) {
  const resp = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const chunks = [];
  for await (const chunk of resp.Body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function updateJob(job_id, patch) {
  const keys   = Object.keys(patch);
  const sets   = keys.map(function(k, i) { return '#f' + i + ' = :v' + i; }).join(', ');
  const names  = {};
  const values = {};
  keys.forEach(function(k, i) { names['#f' + i] = k; });
  Object.values(patch).forEach(function(v, i) { values[':v' + i] = v; });
  await dynamo.send(new UpdateCommand({
    TableName: JOBS_TABLE,
    Key: { job_id: job_id },
    UpdateExpression: 'SET ' + sets,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  }));
}

// ── STEP 1: Regex scan of extracted_text to find known PII values ─────────────

function extractKnownPiiValues(extractedText) {
  if (!extractedText || typeof extractedText !== 'string') return [];

  const found = new Set();

  const patterns = [
    // Patient name — labeled
    /(?:PATIENT(?:'S)?\s*NAME?|PT\s*NAME|CLIENT\s*NAME|CLAIMANT|PATIENT)\s*[:\-]\s*([A-Z][A-Z ,'\-\.]{2,50})/gi,
    // Patient name — "Patient's Name: Vilma N. Mora Maldonado" style (mixed case)
    /Patient(?:'s)?\s*Name\s*[:\-]\s*([A-Za-z][A-Za-z ,'\-\.]{4,60})/g,
    // DOB — capture date + optional age on same line
    /(?:DOB|D\.O\.B\.|DATE\s*OF\s*BIRTH|BIRTH\s*DATE|BIRTHDATE|BIRTH\s*DT)\s*[:\-]\s*([\d\/\-\.]+(?:\s+AGE\s*[:\-]?\s*\d{1,3})?)/gi,
    // DOB in "Date of Birth: 05/21/1969, 56 years" style
    /\bDOB\s*[:\-]\s*([\d\/]+)/gi,
    // Age standalone
    /\bAGE\s*[:\-]\s*(\d{1,3})\b/gi,
    // Account / financial
    /(?:ACCOUNT#?|ACCT#?|FIN#?|FINANCIAL\s*NO?|VISIT#?|PATIENT\s*NO?|PAT#?)\s*[:\-]\s*([A-Z0-9\-]{4,30})/gi,
    // Unit / room / bed
    /(?:UNIT\s*#?|ROOM\s*(?:\/\s*BED)?|BED|WARD)\s*[:\-]\s*([A-Z0-9\-\.]{2,20})/gi,
    // SSN
    /\b(\d{3}-\d{2}-\d{4})\b/g,
    // MRN
    /(?:MRN#?|MR#?|MED\s*REC(?:ORD)?(?:\s*NO?)?|CHART#?|PATIENT\s*#)\s*[:\-]?\s*([A-Z0-9\-]{4,20})/gi,
    // Insurance plan / group / member / policy / subscriber
    /(?:PLAN\s*#?|GROUP\s*#?|MEMBER\s*(?:ID|#)?|POLICY\s*(?:NO?|#)?|SUBSCRIBER\s*(?:ID|#)?)\s*[:\-]?\s*([A-Z0-9\-]{6,30})/gi,
    // Driver license
    /(?:DL#?|DRIVER\s*(?:S?\s*)?LICENSE|LICENSE\s*NO?)\s*[:\-]\s*([A-Z0-9\-]{4,20})/gi,
    // Personal phone — labeled
    /(?:(?:HOME|CELL|MOBILE|PT|PATIENT|PERSONAL)\s+)?PHONE\s*[:\-]\s*([\(\d][\d\(\)\-\.\s]{8,14})/gi,
    // Phone in plain format — 10-digit standalone (area code in parens or not)
    /\((\d{3})\)\s*(\d{3}-\d{4})/g,
    // Email
    /(?:EMAIL|E-MAIL)\s*[:\-]\s*([\w\.\+\-]+@[\w\-]+\.[\w\.]+)/gi,
    // Street address — labeled
    /(?:HOME\s*ADDRESS|ADDRESS|ADDR|MAILING\s*ADDRESS)\s*[:\-]\s*(.{10,80})/gi,
    // Street address — standalone line pattern (number + street name + optional unit)
    /\b(\d{1,5}\s+[A-Z][A-Za-z0-9\s,\.]{5,60}(?:Ave|St|Blvd|Dr|Rd|Hwy|Highway|Way|Ln|Ct|Pl|Box|Suite|Ste|#)\s*[\w\d\s,\.]{0,20})\b/g,
    // City, State ZIP line following an address
    /\b([A-Z][a-zA-Z\s]{2,20},\s*[A-Z]{2}\s+\d{5}(?:-\d{4})?)\b/g,
  ];

  for (const pattern of patterns) {
    let match;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(extractedText)) !== null) {
      // For phone pattern with two groups
      let val;
      if (match[2]) {
        val = ('(' + match[1] + ') ' + match[2]).trim();
      } else {
        val = match[1] && match[1].trim();
      }
      if (!val || val.length < 3) continue;
      // Filter pure short numeric codes
      if (/^[\d\s\-]{1,6}$/.test(val)) continue;
      // Filter all-lowercase clinical sentences
      if (/^[a-z\s,\.]{20,}$/.test(val)) continue;
      found.add(val);
    }
  }

  return Array.from(found);
}

// ── STEP 2: Bedrock visual pass ───────────────────────────────────────────────

async function detectPiiInPdf(pdfBytes, knownPiiValues) {
  const pdfBase64 = pdfBytes.toString('base64');

  const confirmedSection = knownPiiValues && knownPiiValues.length > 0
    ? [
        '=== CONFIRMED PATIENT PII — YOU MUST REDACT ALL OF THESE ===',
        '',
        'The following strings have been confirmed as patient PII.',
        'Find EVERY occurrence on EVERY page and draw a bounding box around it.',
        'Cover the entire text including any leading/trailing characters on the same line segment.',
        '',
        knownPiiValues.map(function(v) { return '  - "' + v + '"'; }).join('\n'),
        '',
      ].join('\n')
    : '';

  const prompt = [
    'You are a HIPAA privacy redaction assistant reviewing medical records for a workers compensation law firm.',
    'Your task is to identify and redact PATIENT personally identifiable information (PII) only.',
    '',
    confirmedSection,
    '=== BOX PLACEMENT RULE — CRITICAL ===',
    '',
    'Bounding boxes must cover the ENTIRE PII value, including any leading characters.',
    'Common mistake to avoid: starting the box too far to the right and clipping the first characters.',
    'When in doubt, make the box slightly wider and start it slightly further LEFT.',
    'The x coordinate should begin at or slightly before the first character of the PII value.',
    'Add 0.005 to the width beyond what you think is needed, to ensure full coverage.',
    '',
    '=== THE CORE NAME RULE ===',
    '',
    'KEEP a name if it has any professional credential attached:',
    '  Medical: MD, M.D., DO, D.O., NP, PA, PA-C, RN, R.N., LVN, LPN, DPM, DC, PT, OT,',
    '    CRNA, FNP, CNP, APRN, PharmD, DDS, DMD, MBBS',
    '  Administrative: Esq., JD, Administrator, Supervisor, Case Manager, Director',
    '  Law enforcement: Officer, Detective, Deputy, Sergeant, Sgt., Lieutenant, Lt.,',
    '    Corporal, Cpl., Sheriff, Badge #, Investigator',
    '',
    'REDACT a bare name with NO credential — it is the patient name.',
    '',
    '=== ALSO REDACT — PATIENT PII ===',
    '',
    '1. PATIENT NAME — bare name with no credential (see Core Name Rule above)',
    '   Labels: PATIENT, PT NAME, NAME, PT:, CLIENT NAME, CLAIMANT, Patient\'s Name',
    '',
    '2. DATE OF BIRTH + AGE',
    '   Labels: DOB, D.O.B., DATE OF BIRTH, BIRTH DATE, BIRTHDATE, Birth Date, DOB:',
    '   Include the age value if on the same line.',
    '   Also redact "DOB: 05/21/1969" appearing in page footers (e.g. "Vilma N. Mora Maldonado DOB 05/21/1969")',
    '',
    '3. PATIENT ACCOUNT / FINANCIAL NUMBER',
    '   Labels: ACCOUNT#, ACCT#, FIN#, VISIT#, PATIENT NO, PAT#',
    '',
    '4. PATIENT UNIT / ROOM / BED',
    '   Labels: UNIT#, ROOM, ROOM/BED, BED, WARD',
    '',
    '5. SSN — any XXX-XX-XXXX number',
    '',
    '6. PATIENT HOME ADDRESS',
    '   Redact the full address block: street, city, state, ZIP.',
    '   Common patterns: "1828 E State Highway 168 Box 578" on one line, "Moapa, NV 89025-9117" on next.',
    '   Redact ALL lines that form the address.',
    '',
    '7. PATIENT PERSONAL PHONE NUMBER',
    '   Redact any phone number associated with the patient.',
    '   Common patterns: "(818) 497-1726" appearing in a patient info block.',
    '   Do NOT redact hospital/clinic phone numbers (those appear next to facility names).',
    '',
    '8. PATIENT PERSONAL EMAIL',
    '',
    '9. MRN — labels: MRN, MR#, MED REC, CHART#, Patient #',
    '',
    '10. INSURANCE / MEMBER / POLICY / PLAN / GROUP IDs',
    '    Labels: MEMBER ID, POLICY#, GROUP#, SUBSCRIBER ID, Plan #, Group #',
    '    Redact the ID numbers — keep the insurance company name.',
    '',
    '11. DRIVER LICENSE NUMBER',
    '',
    '12. PATIENT PHOTO, PATIENT HANDWRITTEN SIGNATURE',
    '',
    '=== DO NOT REDACT ===',
    '',
    '- Names with professional credentials (MD, RN, PA, DO, Officer, etc.)',
    '- Hospital / facility names and addresses',
    '- Report titles, section headers, form field labels',
    '- Procedure / diagnosis codes (CPT, ICD)',
    '- Dates of service, admission, discharge — these are NOT date of birth',
    '- Clinical content: diagnoses, meds, vitals, labs, imaging results',
    '- Hospital / clinic phone numbers and fax numbers',
    '- Page numbers, timestamps, print dates, fax metadata',
    '- Insurance company names (CORVEL CORPORATION W/C, UMR, etc.) — only redact the ID numbers',
    '',
    '=== OUTPUT FORMAT ===',
    '',
    'IMPORTANT: Each box x coordinate must start at or slightly before the first character of the value.',
    'Do not start boxes after the colon or separator — cover the full value text.',
    '',
    'Return a JSON object keyed by 0-based page index.',
    'Normalized coordinates 0.0–1.0, top-left origin:',
    '{',
    '  "0": [',
    '    { "label": "Patient Name", "x": 0.12, "y": 0.08, "width": 0.42, "height": 0.018 },',
    '    { "label": "DOB+Age",     "x": 0.05, "y": 0.10, "width": 0.32, "height": 0.018 },',
    '    { "label": "Address",     "x": 0.04, "y": 0.14, "width": 0.55, "height": 0.040 }',
    '  ],',
    '  "1": []',
    '}',
    '',
    'Use a single box that spans multiple lines for multi-line address blocks.',
    'Empty array for pages with no patient PII.',
    'Return ONLY the JSON object — no explanation, no markdown.',
  ].filter(Boolean).join('\n');

  const body = JSON.stringify({
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 8192,
    temperature: 0,
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
        { type: 'text', text: prompt },
      ],
    }],
  });

  const resp = await bedrock.send(new InvokeModelCommand({
    modelId: MODEL_ID,
    contentType: 'application/json',
    accept: 'application/json',
    body: body,
  }));

  const result  = JSON.parse(Buffer.from(resp.body).toString('utf-8'));
  const rawText = (result.content && result.content[0] && result.content[0].text) || '{}';
  const cleaned = rawText.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

  try {
    return JSON.parse(cleaned);
  } catch (e) {
    console.warn('PII detection parse failed:', rawText.slice(0, 300));
    return {};
  }
}

// ── STEP 3: Apply redaction boxes — with generous left-side padding ───────────

async function applyRedactions(pdfBytes, piiByPage) {
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const pages  = pdfDoc.getPages();

  for (const pageIndexStr of Object.keys(piiByPage)) {
    const pageIndex = parseInt(pageIndexStr, 10);
    const boxes     = piiByPage[pageIndexStr];
    if (pageIndex >= pages.length || !boxes || !boxes.length) continue;

    const page = pages[pageIndex];
    const sz   = page.getSize();
    const w    = sz.width;
    const h    = sz.height;

    for (const box of boxes) {
      const px  = box.x * w;
      const py  = h - (box.y + box.height) * h;
      const pw  = box.width  * w;
      const ph  = box.height * h;
      // Use asymmetric padding: more on the left to compensate for Claude's
      // tendency to start boxes slightly too far right
      const padLeft  = 8;
      const padRight = 4;
      const padVert  = 3;
      page.drawRectangle({
        x:      Math.max(0, px - padLeft),
        y:      Math.max(0, py - padVert),
        width:  Math.min(w, pw + padLeft + padRight),
        height: Math.min(h, ph + padVert * 2),
        color:   rgb(0, 0, 0),
        opacity: 1,
      });
    }
  }

  return Buffer.from(await pdfDoc.save({ useObjectStreams: false }));
}

// ── Fetch extracted_text from DynamoDB ────────────────────────────────────────

async function fetchExtractedText(doc_id) {
  const docRes = await dynamo.send(new GetCommand({ TableName: DOCS_TABLE, Key: { aws_document_id: doc_id } }));
  const doc    = docRes.Item || {};
  let text     = doc.extracted_text || '';

  try {
    if (doc.original_document_id) {
      const parentRes = await dynamo.send(new GetCommand({
        TableName: DOCS_TABLE,
        Key: { aws_document_id: doc.original_document_id },
      }));
      if (parentRes.Item && parentRes.Item.extracted_text) {
        text = parentRes.Item.extracted_text + '\n' + text;
      }
    }
  } catch (e) {
    console.warn('Could not fetch parent doc text:', e.message);
  }

  return text;
}

// ── START handler ─────────────────────────────────────────────────────────────

const _redactDocumentStart = async function(event) {
  const doc_id = event.pathParameters && event.pathParameters.aws_document_id;
  if (!doc_id) return respond(400, { error: 'Missing document ID' });

  const docRes = await dynamo.send(new GetCommand({ TableName: DOCS_TABLE, Key: { aws_document_id: doc_id } }));
  const doc    = docRes.Item;
  if (!doc) return respond(404, { error: 'Document not found' });

  const fileKey = doc.file_key || doc.s3_key;
  if (!fileKey) return respond(400, { error: 'Document has no S3 key' });

  const job_id = randomUUID();
  const now    = new Date().toISOString();

  await dynamo.send(new PutCommand({
    TableName: JOBS_TABLE,
    Item: {
      job_id:           job_id,
      type:             'redact',
      status:           'processing',
      doc_id:           doc_id,
      org_id:           doc.org_id || null,
      created_at:       now,
      updated_at:       now,
      progress_message: 'Starting redaction...',
    },
  }));

  await lambdaClient.send(new InvokeCommand({
    FunctionName:   WORKER_FN,
    InvocationType: 'Event',
    Payload:        Buffer.from(JSON.stringify({ job_id: job_id, doc_id: doc_id, doc: doc })),
  }));

  return respond(200, { job_id: job_id, status: 'processing' });
};

module.exports.redactDocumentStart = validateApiKey(_redactDocumentStart);

// ── WORKER handler ────────────────────────────────────────────────────────────

module.exports.redactDocumentWorker = async function(event) {
  const job_id = event.job_id;
  const doc_id = event.doc_id;
  const doc    = event.doc;

  try {
    await updateJob(job_id, { progress_message: 'Fetching document...', updated_at: new Date().toISOString() });

    const fileKey  = doc.file_key || doc.s3_key;
    const pdfBytes = await getS3Bytes(fileKey);

    // Step 1: regex scan
    await updateJob(job_id, { progress_message: 'Scanning text for known PII patterns...', updated_at: new Date().toISOString() });
    const extractedText  = await fetchExtractedText(doc_id);
    const knownPiiValues = extractKnownPiiValues(extractedText);
    console.log('Regex PII found (' + knownPiiValues.length + '):', JSON.stringify(knownPiiValues.slice(0, 15)));

    // Step 2: Bedrock visual pass in 20-page chunks
    const masterDoc  = await PDFDocument.load(pdfBytes);
    const totalPages = masterDoc.getPageCount();
    const CHUNK_SIZE = 20;
    const allPii     = {};

    for (let start = 0; start < totalPages; start += CHUNK_SIZE) {
      const end     = Math.min(start + CHUNK_SIZE, totalPages);
      const indices = [];
      for (let i = start; i < end; i++) indices.push(i);

      await updateJob(job_id, {
        progress_message: 'Analyzing pages ' + (start + 1) + '–' + end + ' of ' + totalPages + '...',
        updated_at: new Date().toISOString(),
      });

      const subDoc = await PDFDocument.create();
      const copied = await subDoc.copyPages(masterDoc, indices);
      copied.forEach(function(p) { subDoc.addPage(p); });
      const subBytes = Buffer.from(await subDoc.save());

      const chunkPii = await detectPiiInPdf(subBytes, knownPiiValues);

      for (const chunkPageStr of Object.keys(chunkPii)) {
        const globalPage = start + parseInt(chunkPageStr, 10);
        const boxes      = chunkPii[chunkPageStr];
        if (boxes && boxes.length) allPii[String(globalPage)] = boxes;
      }
    }

    // Step 3: apply black boxes
    const totalRedactions    = Object.values(allPii).reduce(function(s, b) { return s + b.length; }, 0);
    const totalPagesAffected = Object.keys(allPii).length;

    await updateJob(job_id, {
      progress_message: 'Applying ' + totalRedactions + ' redaction(s) across ' + totalPagesAffected + ' page(s)...',
      updated_at: new Date().toISOString(),
    });

    const redactedBytes = await applyRedactions(pdfBytes, allPii);

    const keyParts     = fileKey.split('/');
    const origFilename = keyParts.pop();
    const baseName     = origFilename.replace(/\.pdf$/i, '');
    const redactedKey  = keyParts.concat([baseName + '_REDACTED.pdf']).join('/');
    const redactedName = baseName + '_REDACTED.pdf';

    await updateJob(job_id, { progress_message: 'Saving redacted document...', updated_at: new Date().toISOString() });

    await s3.send(new PutObjectCommand({
      Bucket:      BUCKET,
      Key:         redactedKey,
      Body:        redactedBytes,
      ContentType: 'application/pdf',
    }));

    const newDocId = randomUUID();
    await dynamo.send(new PutCommand({
      TableName: DOCS_TABLE,
      Item: {
        aws_document_id:   newDocId,
        org_id:            doc.org_id       || null,
        patient_id:        doc.patient_id   || null,
        folder_name:       doc.folder_name  || null,
        provider_name:     doc.provider_name|| null,
        original_filename: redactedName,
        file_key:          redactedKey,
        s3_key:            redactedKey,
        is_redacted:       true,
        redacted_from:     doc_id,
        redaction_count:   totalRedactions,
        redacted_pages:    totalPagesAffected,
        confirmed_pii:     knownPiiValues.length,
        status:            'processed',
        is_clinical:       doc.is_clinical || false,
        created_at:        new Date().toISOString(),
        updated_at:        new Date().toISOString(),
      },
    }));

    const downloadUrl = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: BUCKET, Key: redactedKey }),
      { expiresIn: 3600 }
    );

    await updateJob(job_id, {
      status:           'complete',
      progress_message: 'Redaction complete — ' + totalRedactions + ' item(s) redacted across ' + totalPagesAffected + ' page(s). (' + knownPiiValues.length + ' confirmed via text scan)',
      result: {
        new_doc_id:      newDocId,
        download_url:    downloadUrl,
        redaction_count: totalRedactions,
        redacted_pages:  totalPagesAffected,
        confirmed_pii:   knownPiiValues.length,
      },
      updated_at: new Date().toISOString(),
    });

  } catch (err) {
    console.error('Redaction worker error:', err);
    await updateJob(job_id, {
      status:           'error',
      progress_message: 'Redaction failed: ' + err.message,
      updated_at:       new Date().toISOString(),
    });
  }
};

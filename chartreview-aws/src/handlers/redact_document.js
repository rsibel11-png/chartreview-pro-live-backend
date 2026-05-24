// redact_document.js — ChartReview Pro redaction Lambda
// Route: POST /documents/{aws_document_id}/redact
// Worker: redactDocumentWorker (900s, invoked async)
// Updated: 2026-05-23 — hybrid approach: regex text scan + Bedrock visual pass

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
// Returns an array of string values that are confirmed patient PII.
// These get passed into the Bedrock prompt so Claude knows exactly what to find.

function extractKnownPiiValues(extractedText) {
  if (!extractedText || typeof extractedText !== 'string') return [];

  const found = new Set();

  // Each pattern: capture the VALUE after the label, across many EMR label variants.
  const patterns = [
    // Patient name
    /(?:PATIENT|PT\s*NAME|PATIENT\s*NAME|CLIENT\s*NAME|CLAIMANT|NAME)\s*[:\-]\s*([A-Z][A-Z ,'\-\.]{2,50})/gi,
    // DOB — capture date + optional age
    /(?:DOB|D\.O\.B\.|DATE\s*OF\s*BIRTH|BIRTH\s*DATE|BIRTHDATE|BIRTH\s*DT)\s*[:\-]\s*([\d\/\-\.]+(?:\s+AGE\s*[:\-]?\s*\d{1,3})?)/gi,
    // Age standalone (in case on its own line)
    /\bAGE\s*[:\-]\s*(\d{1,3})\b/gi,
    // Account / financial number
    /(?:ACCOUNT#?|ACCT#?|FIN#?|FINANCIAL\s*NO?|VISIT#?|PATIENT\s*NO?|PAT#?)\s*[:\-]\s*([A-Z0-9\-]{4,30})/gi,
    // Unit / room / bed
    /(?:UNIT\s*#?|ROOM\s*(?:\/\s*BED)?|BED|WARD)\s*[:\-]\s*([A-Z0-9\-\.]{2,20})/gi,
    // SSN
    /\b(\d{3}-\d{2}-\d{4})\b/g,
    // MRN
    /(?:MRN|MR#?|MED\s*REC|MEDICAL\s*RECORD\s*NO?|CHART#?)\s*[:\-]\s*([A-Z0-9\-]{4,20})/gi,
    // Member / insurance ID
    /(?:MEMBER\s*(?:ID|#)?|POLICY\s*(?:NO?|#)?|GROUP\s*(?:NO?|#)?|SUBSCRIBER\s*(?:ID|#)?|PLAN\s*ID|INS(?:URANCE)?\s*ID)\s*[:\-]\s*([A-Z0-9\-]{4,30})/gi,
    // Driver license
    /(?:DL#?|DRIVER\s*(?:S?\s*)?LICENSE|LICENSE\s*NO?)\s*[:\-]\s*([A-Z0-9\-]{4,20})/gi,
    // Phone (patient personal — 10-digit format)
    /(?:(?:HOME|CELL|MOBILE|PT|PATIENT)\s*)?PHONE\s*[:\-]\s*([\d\(\)\-\.\s]{10,15})/gi,
    // Email
    /(?:EMAIL|E-MAIL)\s*[:\-]\s*([\w\.\+\-]+@[\w\-]+\.[\w\.]+)/gi,
    // Home address
    /(?:HOME\s*ADDRESS|ADDRESS|ADDR|MAILING\s*ADDRESS)\s*[:\-]\s*(.{10,80})/gi,
  ];

  for (const pattern of patterns) {
    let match;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(extractedText)) !== null) {
      const val = match[1] && match[1].trim();
      if (val && val.length >= 2) {
        // Filter out obvious false positives: all-lowercase clinical text,
        // pure numeric sequences that look like codes, very short strings
        const isLikelyCode = /^[\d\s]{1,8}$/.test(val);
        const isTooShort   = val.length < 2;
        if (!isLikelyCode && !isTooShort) {
          found.add(val);
        }
      }
    }
  }

  return Array.from(found);
}

// ── STEP 2: Bedrock visual pass — find bounding boxes ────────────────────────
// knownPiiValues: string[] from regex scan — Claude must find and box these specifically.

async function detectPiiInPdf(pdfBytes, knownPiiValues) {
  const pdfBase64 = pdfBytes.toString('base64');

  // Build the confirmed PII list section if we have regex hits
  const confirmedSection = knownPiiValues && knownPiiValues.length > 0
    ? [
        '=== CONFIRMED PATIENT PII — YOU MUST REDACT THESE ===',
        '',
        'The following values have been confirmed as patient PII via text analysis.',
        'You MUST find and draw a bounding box around each one wherever it appears on any page.',
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
    '=== THE CORE NAME RULE ===',
    '',
    'When you encounter a person\'s name anywhere in the document, apply this test:',
    '',
    'KEEP the name if it is followed by (or associated with) any professional credential:',
    '  Medical: MD, M.D., DO, D.O., NP, PA, PA-C, RN, R.N., LVN, LPN, DPM, DC, PT, OT,',
    '    CRNA, FNP, CNP, APRN, PharmD, DDS, DMD, MBBS',
    '  Administrative: Esq., JD, Administrator, Supervisor, Case Manager, Director',
    '  Law enforcement: Officer, Detective, Deputy, Sergeant, Sgt., Lieutenant, Lt.,',
    '    Corporal, Cpl., Sheriff, Badge #, Investigator',
    '',
    'REDACT the name if it has NO professional credential attached.',
    '  A bare name with no credential = patient name = redact it.',
    '',
    '=== ALSO REDACT — PATIENT PII ===',
    '',
    '1. PATIENT NAME — bare name with no credential (see Core Name Rule)',
    '   Labels: PATIENT, PT NAME, NAME, PT:, CLIENT NAME, CLAIMANT',
    '',
    '2. DATE OF BIRTH + AGE',
    '   Labels: DOB, D.O.B., DATE OF BIRTH, BIRTH DATE, BIRTHDATE, BIRTH DT, BD',
    '   Include the age value if on same line: AGE, AGE:',
    '',
    '3. PATIENT ACCOUNT / FINANCIAL NUMBER',
    '   Labels: ACCOUNT#, ACCT#, FIN#, FINANCIAL NO, VISIT#, PATIENT NO, PAT#',
    '',
    '4. PATIENT UNIT / ROOM / BED',
    '   Labels: UNIT#, ROOM, ROOM/BED, BED, WARD',
    '',
    '5. SSN — any XXX-XX-XXXX number',
    '',
    '6. PATIENT HOME ADDRESS, PERSONAL PHONE, PERSONAL EMAIL',
    '',
    '7. MRN — labels: MRN, MR#, MED REC, CHART#',
    '',
    '8. INSURANCE / MEMBER / POLICY ID — labels: MEMBER ID, POLICY#, GROUP#, SUBSCRIBER ID',
    '',
    '9. DRIVER LICENSE NUMBER',
    '',
    '10. PATIENT PHOTO, PATIENT SIGNATURE',
    '',
    '=== DO NOT REDACT ===',
    '',
    '- Names with professional credentials (MD, RN, Officer, etc.)',
    '- Hospital / facility names',
    '- Report titles, section headers, field labels',
    '- Procedure / diagnosis codes (CPT, ICD)',
    '- Dates of service, admission, discharge (NOT date of birth)',
    '- Clinical content: diagnoses, meds, vitals, labs',
    '- Hospital phone/fax numbers and addresses',
    '- Page numbers, timestamps, system headers',
    '- Fax metadata',
    '',
    '=== OUTPUT FORMAT ===',
    '',
    'Return bounding boxes ONLY around the PII values — not the field labels.',
    'Example: "PATIENT: SMITH,JOHN" → box covers "SMITH,JOHN" only.',
    'Example: "DOB: 03/15/80  AGE: 45" → one box covering "03/15/80  AGE: 45".',
    '',
    'Return a JSON object keyed by 0-based page index.',
    'Normalized coordinates 0.0–1.0, top-left origin:',
    '{',
    '  "0": [',
    '    { "label": "Patient Name", "x": 0.12, "y": 0.08, "width": 0.40, "height": 0.018 },',
    '    { "label": "DOB+Age",     "x": 0.05, "y": 0.10, "width": 0.30, "height": 0.018 }',
    '  ],',
    '  "1": []',
    '}',
    '',
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

// ── STEP 3: Apply redaction boxes to PDF ─────────────────────────────────────

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
      const pad = 3;
      page.drawRectangle({
        x:      Math.max(0, px - pad),
        y:      Math.max(0, py - pad),
        width:  Math.min(w, pw + pad * 2),
        height: Math.min(h, ph + pad * 2),
        color:   rgb(0, 0, 0),
        opacity: 1,
      });
    }
  }

  return Buffer.from(await pdfDoc.save({ useObjectStreams: false }));
}

// ── Fetch extracted_text from all DynamoDB parts for a document ───────────────

async function fetchExtractedText(doc_id, org_id) {
  // Primary doc
  const docRes = await dynamo.send(new GetCommand({ TableName: DOCS_TABLE, Key: { aws_document_id: doc_id } }));
  const doc    = docRes.Item || {};
  let text     = doc.extracted_text || '';

  // If this is a split part, also grab siblings via original_document_id
  // (best effort — if it fails we still have the primary text)
  try {
    if (doc.original_document_id) {
      // Fetch the parent doc too
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

    // ── Step 1: regex scan of stored extracted_text ──────────────────────
    await updateJob(job_id, { progress_message: 'Scanning text for known PII patterns...', updated_at: new Date().toISOString() });

    const extractedText  = await fetchExtractedText(doc_id, doc.org_id);
    const knownPiiValues = extractKnownPiiValues(extractedText);
    console.log('Regex found ' + knownPiiValues.length + ' confirmed PII values:', knownPiiValues.slice(0, 10));

    // ── Step 2: Bedrock visual pass in 20-page chunks ────────────────────
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

      // Pass confirmed PII values into every chunk so Claude knows what to find
      const chunkPii = await detectPiiInPdf(subBytes, knownPiiValues);

      for (const chunkPageStr of Object.keys(chunkPii)) {
        const globalPage = start + parseInt(chunkPageStr, 10);
        const boxes      = chunkPii[chunkPageStr];
        if (boxes && boxes.length) allPii[String(globalPage)] = boxes;
      }
    }

    // ── Step 3: apply black boxes ─────────────────────────────────────────
    const totalRedactions    = Object.values(allPii).reduce(function(s, b) { return s + b.length; }, 0);
    const totalPagesAffected = Object.keys(allPii).length;

    await updateJob(job_id, {
      progress_message: 'Applying ' + totalRedactions + ' redaction(s) across ' + totalPagesAffected + ' page(s)...',
      updated_at: new Date().toISOString(),
    });

    const redactedBytes = await applyRedactions(pdfBytes, allPii);

    // ── Save redacted PDF to S3 ───────────────────────────────────────────
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

    // ── Save new DynamoDB record ──────────────────────────────────────────
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
      progress_message: 'Redaction complete — ' + totalRedactions + ' item(s) redacted across ' + totalPagesAffected + ' page(s). ' +
                        '(' + knownPiiValues.length + ' confirmed via text scan)',
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

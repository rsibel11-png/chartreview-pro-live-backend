// redact_document.js — ChartReview Pro redaction Lambda
// Route: POST /documents/{aws_document_id}/redact
// Worker: redactDocumentWorker (900s, invoked async)
// Updated: 2026-05-23 — broadened label synonyms for cross-EMR coverage

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

// ── PII detection via Bedrock vision ─────────────────────────────────────────

async function detectPiiInPdf(pdfBytes) {
  const pdfBase64 = pdfBytes.toString('base64');

  const prompt = [
    'You are a HIPAA privacy redaction assistant reviewing medical records for a workers compensation law firm.',
    'Your task is to identify and redact PATIENT personally identifiable information (PII) only.',
    'The examples below show specific values but the rules apply to ALL patients and ALL document formats.',
    '',
    '=== REDACT THESE — PATIENT PII ===',
    '',
    '1. PATIENT NAME',
    '   Labels (any variant): PATIENT, PT NAME, PATIENT NAME, NAME, PT:, CLIENT NAME, CLAIMANT',
    '   Also redact patient names in demographic header blocks even without a label.',
    '   Also redact patient name when it appears inline in narrative text.',
    '   Redact only the name value, not the label.',
    '   Example patterns: "PATIENT: SMITH,JOHN A", "Pt Name: Jane Doe", "Name: Robert Garcia"',
    '',
    '2. DATE OF BIRTH and AGE',
    '   Labels (any variant): DOB, D.O.B., DATE OF BIRTH, BIRTH DATE, BIRTHDATE, BIRTH DT, BD',
    '   Also redact the numeric age value when it appears on the same line as the DOB.',
    '   Labels for age: AGE, AGE:',
    '   Example patterns: "DOB: 05/21/69  AGE: 56", "Birth Date: January 3, 1975", "D.O.B.: 03/15/80"',
    '',
    '3. PATIENT ACCOUNT / FINANCIAL NUMBER',
    '   Labels (any variant): ACCOUNT#, ACCOUNT NO, ACCT#, ACCT NO, FIN#, FIN NO, FINANCIAL NO,',
    '   VISIT#, VISIT NO, ENCOUNTER#, PATIENT NO, PAT#, PAT NO',
    '   Example patterns: "ACCOUNT#: D00136377973", "FIN#: 123456789", "Visit No: 987654"',
    '',
    '4. PATIENT UNIT / ROOM / BED ASSIGNMENT',
    '   Labels (any variant): UNIT#, UNIT NO, ROOM, ROOM/BED, BED, LOCATION, WARD',
    '   These identify the patient location and must be redacted.',
    '   Example patterns: "UNIT #: D003081753", "ROOM/BED: D.DTCS-2", "Room: 412B"',
    '',
    '5. SOCIAL SECURITY NUMBER',
    '   Labels (any variant): SSN, SS#, SOC SEC, SOCIAL SECURITY',
    '   Also redact any 9-digit number in XXX-XX-XXXX format even without a label.',
    '',
    '6. PATIENT HOME ADDRESS',
    '   Street address, city, state, zip code belonging to the patient.',
    '   Labels (any variant): ADDRESS, HOME ADDRESS, ADDR, MAILING ADDRESS, PT ADDRESS',
    '',
    '7. PATIENT PERSONAL PHONE NUMBER OR EMAIL',
    '   Labels (any variant): PHONE, HOME PHONE, CELL, MOBILE, PT PHONE, EMAIL, E-MAIL',
    '   Do NOT redact hospital/clinic phone numbers or fax numbers.',
    '',
    '8. MEDICAL RECORD NUMBER (MRN)',
    '   Labels (any variant): MRN, MR#, MED REC, MEDICAL RECORD NO, CHART#, CHART NO',
    '   Do NOT confuse with encounter numbers, billing codes, or procedure codes.',
    '',
    '9. PATIENT INSURANCE / MEMBER / POLICY IDENTIFIERS',
    '   Labels (any variant): MEMBER ID, MEMBER #, POLICY NO, POLICY#, GROUP#, GROUP NO,',
    '   INSURANCE ID, INS ID, SUBSCRIBER ID, SUBSCRIBER#, PLAN ID, CLAIM#',
    '   Redact the ID value — do NOT redact the insurance company name.',
    '',
    '10. DRIVER LICENSE NUMBER',
    '    Labels (any variant): DL#, DL NO, DRIVER LICENSE, DRIVERS LICENSE, LICENSE NO',
    '',
    '11. PATIENT PHOTO OR PHOTO ID',
    '    Any photograph of the patient face, or a scanned photo ID card belonging to the patient.',
    '',
    '12. PATIENT HANDWRITTEN SIGNATURE',
    '    Any handwritten signature area labeled with the patient name or "Patient Signature".',
    '',
    '=== DO NOT REDACT — KEEP VISIBLE ===',
    '',
    '- Treating physician, provider, or clinician names and credentials',
    '  Labels: ATTEND, ATTENDING, PHYSICIAN, PROVIDER, MD, DO, NP, PA, AUTHOR, ORDERING MD',
    '  Examples: "ATTEND: Ching,Wilbert MD", "Physician: Dr. Sarah Lee", "Roman A. Sibel, MD"',
    '',
    '- Hospital, clinic, or facility names',
    '  Examples: "St. Rose Dominican Hospitals", "Sunrise Hospital", "Cedars-Sinai"',
    '',
    '- Report titles, section headers, form labels, field labels',
    '  Examples: "Med Rec", "Subjective", "Objective", "Discharge Summary", "History & Physical"',
    '',
    '- Internal billing or encounter reference numbers (not patient-linked IDs)',
    '  Examples: "38204004", encounter sequence numbers in visit logs',
    '',
    '- Procedure and diagnosis codes',
    '  Examples: "CPT 27691", "ICD M79.3", "0SRS01Z", "27650"',
    '',
    '- Dates of service, admission dates, discharge dates, report dates',
    '  Labels: ADM DT, ADMIT DATE, DISCHARGE DATE, SERVICE DATE, DOS, REP SRV DT',
    '  These are clinical dates, NOT date of birth — do NOT redact them.',
    '',
    '- Clinical content: diagnoses, symptoms, medications, vital signs, lab values, imaging results',
    '',
    '- Hospital or clinic phone numbers, fax numbers, and addresses',
    '',
    '- Page numbers, timestamps, print dates, system-generated document headers',
    '  Examples: "Page 1 of 4", "GMH001-03  4/8/2026", "CorVel Received Date: 10/14/2025"',
    '',
    '- Fax cover sheet metadata (fax server info, transmission dates, page counts)',
    '',
    '- Referring party names on fax cover sheets when they are staff or organizations',
    '  Example: "From: Rebecca Carlos" on a hospital fax — keep visible',
    '',
    '=== CRITICAL DISTINCTION: DATES ===',
    'DATE OF BIRTH = patient PII → REDACT',
    'Date of service / admission / discharge / report date = clinical data → DO NOT REDACT',
    'When a date appears next to "DOB:", "Birth Date:", or "D.O.B." → redact it.',
    'When a date appears next to "ADM DT:", "DOS:", "Date of Service:", "REP SRV DT:" → keep it.',
    '',
    '=== OUTPUT FORMAT ===',
    '',
    'Return bounding boxes ONLY around the PII values — not the field labels.',
    'Example: for "PATIENT: SMITH,JOHN" — box covers "SMITH,JOHN" only, not "PATIENT:"',
    'Example: for "DOB: 03/15/80  AGE: 45" — one box covering "03/15/80  AGE: 45"',
    '',
    'Return a JSON object keyed by 0-based page index.',
    'Use normalized coordinates (0.0-1.0, top-left origin):',
    '{',
    '  "0": [',
    '    { "label": "Patient Name", "x": 0.12, "y": 0.08, "width": 0.40, "height": 0.018 },',
    '    { "label": "DOB+Age",     "x": 0.05, "y": 0.10, "width": 0.30, "height": 0.018 }',
    '  ],',
    '  "1": []',
    '}',
    '',
    'If a page has no patient PII, return an empty array for that page.',
    'Return ONLY the JSON object — no explanation, no markdown.',
  ].join('\n');

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

// ── Apply redaction boxes to PDF ──────────────────────────────────────────────

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
    await updateJob(job_id, { progress_message: 'Fetching document from S3...', updated_at: new Date().toISOString() });

    const fileKey  = doc.file_key || doc.s3_key;
    const pdfBytes = await getS3Bytes(fileKey);

    const masterDoc  = await PDFDocument.load(pdfBytes);
    const totalPages = masterDoc.getPageCount();
    const CHUNK_SIZE = 20;
    const allPii     = {};

    for (let start = 0; start < totalPages; start += CHUNK_SIZE) {
      const end     = Math.min(start + CHUNK_SIZE, totalPages);
      const indices = [];
      for (let i = start; i < end; i++) indices.push(i);

      await updateJob(job_id, {
        progress_message: 'Analyzing pages ' + (start + 1) + ' to ' + end + ' of ' + totalPages + '...',
        updated_at: new Date().toISOString(),
      });

      const subDoc = await PDFDocument.create();
      const copied = await subDoc.copyPages(masterDoc, indices);
      copied.forEach(function(p) { subDoc.addPage(p); });
      const subBytes = Buffer.from(await subDoc.save());

      const chunkPii = await detectPiiInPdf(subBytes);

      for (const chunkPageStr of Object.keys(chunkPii)) {
        const globalPage = start + parseInt(chunkPageStr, 10);
        const boxes      = chunkPii[chunkPageStr];
        if (boxes && boxes.length) allPii[String(globalPage)] = boxes;
      }
    }

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
        org_id:            doc.org_id            || null,
        patient_id:        doc.patient_id         || null,
        folder_name:       doc.folder_name        || null,
        provider_name:     doc.provider_name      || null,
        original_filename: redactedName,
        file_key:          redactedKey,
        s3_key:            redactedKey,
        is_redacted:       true,
        redacted_from:     doc_id,
        redaction_count:   totalRedactions,
        redacted_pages:    totalPagesAffected,
        status:            'processed',
        is_clinical:       doc.is_clinical        || false,
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
      progress_message: 'Redaction complete - ' + totalRedactions + ' item(s) redacted across ' + totalPagesAffected + ' page(s).',
      result: {
        new_doc_id:      newDocId,
        download_url:    downloadUrl,
        redaction_count: totalRedactions,
        redacted_pages:  totalPagesAffected,
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

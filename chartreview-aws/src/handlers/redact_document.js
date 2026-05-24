// redact_document.js — ChartReview Pro redaction Lambda
// Route: POST /documents/{aws_document_id}/redact
// Updated: 2026-05-24 — comprehensive label variants + radiology/C-4/handwritten form + Name: Acct: patterns

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

// ── STEP 1: Regex scan — extract all known PII values from stored text ────────

function extractKnownPiiValues(extractedText) {
  if (!extractedText || typeof extractedText !== 'string') return [];

  const found = new Set();

  const patterns = [
    // Patient name — ALL label variants
    /(?:PATIENT(?:'S)?\s*(?:NAME?)?|PT\s*NAME|PATIENT\s*NAME|CLIENT\s*NAME|CLAIMANT)\s*[:\-]\s*([A-Z][A-Z ,'\-\.]{2,60})/gi,
    // Mixed-case patient name labels
    /Patient(?:'s)?\s*(?:Name)?\s*[:\-]\s*([A-Za-z][A-Za-z ,'\-\.]{4,60})/g,
    // "Name: MORA-MALDONADO,VILMA N" — radiology/short form header (Name: without PATIENT prefix)
    /\bName\s*[:\-]\s*([A-Z][A-Z ,'\-\.]{4,50})/g,
    // Standalone patient name as first non-empty line (bare name, no label) — caught by Bedrock visual
    // DOB — all variants
    /(?:DOB|D\.O\.B\.|DATE\s*OF\s*BIRTH|BIRTH\s*(?:DATE|DT)|BIRTHDATE|Date\s*of\s*Birth)\s*[:\-]\s*([\d\/\-\.]+(?:\s+AGE\s*[:\-]?\s*\d{1,3})?)/gi,
    /\bDOB\s*[:\-]\s*([\d\/]+)/gi,
    /\bAGE\s*[:\-]\s*(\d{1,3})\b/gi,
    // Account / financial — all variants including "Acct:" (abbreviated radiology format)
    /(?:ACCOUNT\s*(?:NO\.?|NUMBER|#)?|ACCT\s*(?:NO\.?|#)?|FIN#?|FINANCIAL\s*NO?|VISIT#?|PATIENT\s*NO?|PAT#?|EPISODE\s*ID)\s*[:\-]\s*([A-Z0-9\-]{4,30})/gi,
    /\bAcct\s*[:\-]\s*([A-Z0-9\-]{4,20})/g,
    // Unit / room / bed
    /(?:UNIT\s*(?:NO\.?|NUMBER|#)?|ROOM\s*(?:\/\s*BED)?|BED\b|WARD\b)\s*[:\-]\s*([A-Z0-9\-\.]{2,20})/gi,
    // SSN
    /\b(\d{3}-\d{2}-\d{4})\b/g,
    // MRN — all variants
    /(?:MRN#?|MR#?|MED(?:ICAL)?\s*REC(?:ORD)?(?:\s*NO\.?)?|CHART#?|PATIENT\s*#|Patient\s*#)\s*[:\-]?\s*([A-Z0-9\-]{4,20})/gi,
    // Insurance IDs — plan, group, member, policy, subscriber, claim
    /(?:PLAN\s*#?|GROUP\s*#?|MEMBER\s*(?:ID|#)?|POLICY\s*(?:NO\.?|#)?|SUBSCRIBER\s*(?:ID|#)?|CLAIM\s*#?|CLM#?)\s*[:\-]?\s*([A-Z0-9\-]{4,30})/gi,
    // Driver license
    /(?:DL#?|DRIVER\s*(?:S?\s*)?LICENSE|LICENSE\s*NO?)\s*[:\-]\s*([A-Z0-9\-]{4,20})/gi,
    // Personal phone
    /(?:(?:HOME|CELL|MOBILE|PT|PATIENT|PERSONAL)\s+)?PHONE\s*[:\-]\s*([\(\d][\d\(\)\-\.\s]{8,14})/gi,
    /PHONE\s*[:\-]\s*([\(\d][\d\(\)\-\.\s]{8,14})/gi,
    // Standalone 10-digit phone in parens format
    /\((\d{3})\)\s*(\d{3}[-\s]\d{4})/g,
    // Email
    /(?:EMAIL|E-MAIL)\s*[:\-]\s*([\w\.\+\-]+@[\w\-]+\.[\w\.]+)/gi,
    // Address — labeled
    /(?:HOME\s*ADDRESS|ADDRESS|ADDR|MAILING\s*ADDRESS)\s*[:\-]\s*(.{10,80})/gi,
    // Address — street number pattern
    /\b(\d{1,5}\s+[A-Z][A-Za-z0-9\s,\.]{5,60}(?:Ave|St|Blvd|Dr|Rd|Hwy|Highway|Way|Ln|Ct|Pl|Box|Suite|Ste)\s*[\w\d\s,\.]{0,20})/g,
    // City State ZIP
    /\b([A-Z][a-zA-Z\s]{2,25},\s*[A-Z]{2}\s+\d{5}(?:-\d{4})?)\b/g,
  ];

  for (var i = 0; i < patterns.length; i++) {
    var pattern = patterns[i];
    var match;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(extractedText)) !== null) {
      var val;
      if (pattern.source.indexOf('(\\d{3})') !== -1 && match[2]) {
        val = ('(' + match[1] + ') ' + match[2]).trim();
      } else {
        val = match[1] && match[1].trim();
      }
      if (!val || val.length < 3) continue;
      if (/^[\d\s\-\.]{1,6}$/.test(val)) continue;
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
    ? '=== CONFIRMED PATIENT PII — MUST REDACT ALL ===\n\n' +
      'These strings are confirmed patient PII. Find EVERY occurrence on EVERY page.\n' +
      'Draw a bounding box around each one wherever it appears.\n\n' +
      knownPiiValues.map(function(v) { return '  - "' + v + '"'; }).join('\n') + '\n'
    : '';

  const prompt = [
    'You are a HIPAA privacy redaction assistant reviewing workers compensation medical records.',
    'Redact PATIENT personally identifiable information (PII) only.',
    '',
    confirmedSection,
    '=== BOX PLACEMENT — CRITICAL ===',
    'Start boxes slightly LEFT of the first PII character — never too far right.',
    'Add 0.008 to width to ensure full coverage. When in doubt, make the box wider.',
    '',
    '=== CORE NAME RULE ===',
    'KEEP names with professional credentials: MD, DO, NP, PA, PA-C, RN, LVN, LPN, DPM,',
    'DC, CRNA, FNP, APRN, PharmD, DDS, Esq., JD, Officer, Detective, Deputy, Sgt., Sheriff.',
    'REDACT bare names with NO credential anywhere — headers, footers, fax pages, narratives.',
    '',
    '=== REDACT ALL OF THESE ===',
    '',
    '1. PATIENT NAME (bare, no credential)',
    '   Labels: PATIENT, PATIENTS NAME, PATIENT NAME, PT NAME, NAME, PT:, CLIENT, CLAIMANT,',
    '   "Name:" in radiology headers, standalone name line at top of fax or report pages.',
    '   Also: patient name in "PATIENT NAME: ___  ACCOUNT #: ___" footer lines.',
    '   Also: patient name as first bold line in orthopedic/office visit reports (e.g. "Vilma N. Mora Maldonado").',
    '',
    '2. DATE OF BIRTH + AGE (same line)',
    '   Labels: DOB, D.O.B., DATE OF BIRTH, BIRTH DATE, Date of Birth, DOB:',
    '   Include AGE value if on same line. Redact DOB in footers, fax metadata, and form fields.',
    '   "DOB: 05/21/1969" appearing as a plain text line in auth forms — redact it.',
    '',
    '3. ACCOUNT / FINANCIAL NUMBER',
    '   Labels: ACCOUNT#, ACCOUNT NO, ACCOUNT NUMBER, ACCT#, ACCT NO, ACCT:, FIN#, VISIT#, PAT#',
    '   Also: "Acct: D00136377973" in radiology headers (abbreviated format).',
    '',
    '4. UNIT / ROOM / BED',
    '   Labels: UNIT#, UNIT NO, UNIT NUMBER, ROOM, ROOM/BED, BED, WARD, LOCATION',
    '',
    '5. SSN — XXX-XX-XXXX pattern anywhere, including handwritten C-4 forms.',
    '',
    '6. PATIENT ADDRESS (full block)',
    '   Street + city + state + ZIP. Redact as one tall box covering all lines.',
    '   Common format: "1828 E State Highway 168 Box 578" then "Moapa, NV 89025-9117".',
    '   Also redact addresses in PT/OT orders, therapy forms, and C-4 forms even if unlabeled.',
    '',
    '7. PATIENT PERSONAL PHONE',
    '   Any phone linked to patient: "(818) 497-1726".',
    '   In authorization forms it may appear as "PHONE: 818-497-1726" — redact the number.',
    '   Do NOT redact hospital/clinic phone numbers near facility names.',
    '',
    '8. PATIENT EMAIL',
    '',
    '9. MRN — Labels: MRN, MR#, MED REC, CHART#, Patient #, Patient#: 403522',
    '   Also: "MRN: D003081753" in radiology headers.',
    '',
    '10. INSURANCE / CLAIM IDs',
    '    Labels: PLAN #, GROUP #, MEMBER ID, POLICY #, SUBSCRIBER ID, CLAIM #, CLM#',
    '    Redact the numbers — keep insurance company names.',
    '',
    '11. DRIVER LICENSE NUMBER',
    '',
    '12. PATIENT PHOTO or HANDWRITTEN PATIENT SIGNATURE',
    '',
    '13. HANDWRITTEN C-4 FORM FIELDS',
    '    C-4 / workers comp claim forms often have handwritten data.',
    '    Redact ALL handwritten entries in: employee name, address, DOB, SSN, phone fields.',
    '    The printed field labels can remain — only redact the written/typed values.',
    '',
    '=== DO NOT REDACT ===',
    '- Names with credentials (MD, RN, PA, DO, Officer, etc.)',
    '- Hospital/facility names and addresses',
    '- Report section headers and field labels',
    '- CPT/ICD codes, procedure codes',
    '- Dates of service, admission, discharge, exam, report dates (NOT date of birth)',
    '- Clinical content: diagnoses, medications, vitals, lab values',
    '- Hospital/clinic phone and fax numbers',
    '- Page numbers, print timestamps, CorVel scan dates, fax metadata',
    '- Insurance company names (CORVEL, UMR, CLARK COUNTY) — only redact ID numbers',
    '- Employer name, attorney name, adjuster name, claim numbers',
    '',
    '=== KEY DATE DISTINCTION ===',
    'Date of Birth / DOB / Birth Date → REDACT',
    'Date of service / exam / admission / discharge / report → DO NOT REDACT',
    '',
    '=== OUTPUT FORMAT ===',
    'Return bounding boxes around PII VALUES ONLY — not labels.',
    '"PATIENT NAME: MORA-MALDONADO,VILMA N" → box covers "MORA-MALDONADO,VILMA N" only.',
    '"DOB: 05/21/69  AGE: 56" → one box covering "05/21/69  AGE: 56".',
    'Multi-line address → one tall box spanning all lines.',
    '',
    'JSON object keyed by 0-based page index, normalized coords 0.0-1.0, top-left origin:',
    '{',
    '  "0": [',
    '    {"label":"Patient Name","x":0.10,"y":0.08,"width":0.45,"height":0.018},',
    '    {"label":"DOB+Age","x":0.05,"y":0.10,"width":0.35,"height":0.018},',
    '    {"label":"Address","x":0.04,"y":0.20,"width":0.55,"height":0.050}',
    '  ],',
    '  "1": []',
    '}',
    'Empty array for pages with no patient PII.',
    'Return ONLY the JSON — no explanation, no markdown.',
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

// ── STEP 3: Apply black boxes — generous left-side padding ───────────────────

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
      const px       = box.x * w;
      const py       = h - (box.y + box.height) * h;
      const pw       = box.width  * w;
      const ph       = box.height * h;
      const padLeft  = 8;
      const padRight = 5;
      const padVert  = 3;
      page.drawRectangle({
        x:      Math.max(0, px - padLeft),
        y:      Math.max(0, py - padVert),
        width:  Math.min(w - Math.max(0, px - padLeft), pw + padLeft + padRight),
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
    console.warn('Could not fetch parent doc:', e.message);
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
      job_id: job_id, type: 'redact', status: 'processing',
      doc_id: doc_id, org_id: doc.org_id || null,
      created_at: now, updated_at: now,
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

    await updateJob(job_id, { progress_message: 'Scanning text for known PII...', updated_at: new Date().toISOString() });
    const extractedText  = await fetchExtractedText(doc_id);
    const knownPiiValues = extractKnownPiiValues(extractedText);
    console.log('Regex PII (' + knownPiiValues.length + '):', JSON.stringify(knownPiiValues.slice(0, 20)));

    const masterDoc  = await PDFDocument.load(pdfBytes);
    const totalPages = masterDoc.getPageCount();
    const CHUNK_SIZE = 20;
    const allPii     = {};

    for (let start = 0; start < totalPages; start += CHUNK_SIZE) {
      const end     = Math.min(start + CHUNK_SIZE, totalPages);
      const indices = [];
      for (let i = start; i < end; i++) indices.push(i);

      await updateJob(job_id, {
        progress_message: 'Analyzing pages ' + (start + 1) + '\u2013' + end + ' of ' + totalPages + '...',
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

    await updateJob(job_id, { progress_message: 'Saving redacted file...', updated_at: new Date().toISOString() });

    await s3.send(new PutObjectCommand({
      Bucket: BUCKET, Key: redactedKey,
      Body: redactedBytes, ContentType: 'application/pdf',
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
      progress_message: 'Redaction complete — ' + totalRedactions + ' item(s) across ' + totalPagesAffected +
                        ' page(s). (' + knownPiiValues.length + ' confirmed via text scan)',
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

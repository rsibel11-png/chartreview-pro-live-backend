// redact_document.js — ChartReview Pro redaction Lambda
// Route: POST /documents/{aws_document_id}/redact
// Updated: 2026-05-25 — Textract-coordinate-first redaction + Claude vision for handwritten only

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
    statusCode,
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
    Key: { job_id },
    UpdateExpression: 'SET ' + sets,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  }));
}

// ── STEP 1: Regex scan — extract all known PII values from stored text ────────

function extractKnownPiiValues(extractedText) {
  // Demographics-only: ONLY extract values that appear after an explicit demographic label.
  // This prevents matching clinical narrative text.
  if (!extractedText || typeof extractedText !== 'string') return [];
  var found = new Set();

  var patterns = [
    // Patient name — must follow an explicit label on the same line
    /^(?:PATIENT|Patient)\s*[:\|]\s*([A-Z][A-Z\-,'\. ]{4,50})$/mg,
    /^(?:PATIENT(?:'S)?\s*NAME?|PT\.?\s*NAME)\s*[:\|]\s*([A-Za-z][A-Za-z\-,'\. ]{4,50})$/mgi,
    /^Patient\s*Name\s*[:\|]\s*([A-Za-z][A-Za-z\-,'\. ]{4,50})$/mgi,
    /^(?:CLAIMANT|CLIENT)\s*[:\|]\s*([A-Za-z][A-Za-z\-,'\. ]{4,50})$/mgi,
    // PPR form — "Patient's Name" field
    /Patient['']?s?\s*Nam[e]?\s*[:\|]?\s{0,5}([A-Z][A-Z\-,'\. ]{4,50})/gi,

    // Date of birth — must follow label
    /(?:DOB|D\.O\.B\.|DATE\s*OF\s*BIRTH|BIRTH\s*(?:DATE|DT)|BIRTHDATE|Birth\s*Date)\s*[:\|]\s*([\d]{1,2}[\/\-][\d]{1,2}[\/\-][\d]{2,4})/gi,
    /DOB\s*[:\|]\s*([\d]{1,2}[\/\-][\d]{1,2}[\/\-][\d]{2,4})/gi,

    // SSN — only the xxx-xx-xxxx format (distinctive enough to match freely)
    /(\d{3}-\d{2}-\d{4})/g,

    // MRN — must follow label
    /(?:MRN#?|MR\s*#|MED(?:ICAL)?\s*REC(?:ORD)?\s*(?:NO\.?|#)?|CHART\s*#|MRN\s*[:\|])\s*[:\|]?\s*([A-Z0-9\-]{4,20})/gi,

    // Account / unit numbers — must follow explicit label
    /(?:ACCOUNT\s*(?:NO\.?|NUMBER|#)|ACCT\s*(?:NO\.?|#)|Acct#)\s*[:\|]\s*([A-Z0-9\-]{4,30})/gi,
    /(?:UNIT\s*(?:NO\.?|NUMBER|#)|Unit\s*(?:No\.?|#)|Unit#)\s*[:\|]\s*([A-Z0-9\-]{4,30})/gi,
    /FIN#?\s*[:\|]\s*([A-Z0-9\-]{4,20})/gi,

    // Insurance / claim IDs — must follow label
    /(?:Plan\s*#|Plan\s*No\.?|GROUP\s*#|Group\s*No\.?|MEMBER\s*(?:ID|#)|Member\s*ID|POLICY\s*(?:NO\.?|#)|CLM#?|Claim\s*#)\s*[:\|]?\s*([A-Z0-9\-]{4,30})/gi,

    // Phone — must follow label OR be (xxx) xxx-xxxx format
    /(?:PHONE|CELL|MOBILE|TEL(?:EPHONE)?)\s*[:\|]\s*([\d\(\)\-\.\s]{10,15})/gi,
    /\((\d{3})\)\s*(\d{3}[-\s]\d{4})/g,

    // Address — ONLY when explicitly labeled; do not free-match street addresses
    /(?:HOME\s*)?ADDRESS\s*[:\|]\s*(.{10,80}?)(?:
|$)/gi,

    // Email
    /(?:EMAIL|E-MAIL)\s*[:\|]\s*([\w\.\+\-]+@[\w\-]+\.[\w\.]+)/gi,
  ];

  for (var i = 0; i < patterns.length; i++) {
    var pattern = patterns[i];
    var match;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(extractedText)) !== null) {
      var val;
      if (pattern.source.indexOf('(\d{3})') !== -1 && match[2]) {
        val = ('(' + match[1] + ') ' + match[2]).trim();
      } else {
        val = (match[1] || '').trim();
      }
      if (!val || val.length < 5) continue;
      // Skip ICD/CPT codes
      if (/^[A-Z]\d{2}\.?\d{0,3}[A-Z]?$/.test(val)) continue;
      // Skip pure clinical lowercase text
      if (/^[a-z\s,\.]{15,}$/.test(val)) continue;
      // Skip values that are just a number — too ambiguous
      if (/^\d{1,3}$/.test(val)) continue;
      found.add(val);
    }
  }
  return Array.from(found);
}

// ── STEP 2A: Textract-coordinate-based redaction ──────────────────────────────
// Returns piiByPage map using exact Textract bounding boxes — no LLM needed

function normalizeForMatch(str) {
  return (str || '').toLowerCase().replace(/[\s\-,\.]/g, '');
}

function findBoxesFromBlocks(wordBlocks, piiValues) {
  // Build a map of page -> list of word blocks
  var pageMap = {};
  for (var i = 0; i < wordBlocks.length; i++) {
    var b = wordBlocks[i];
    var pg = b.p || 1;
    if (!pageMap[pg]) pageMap[pg] = [];
    pageMap[pg].push(b);
  }

  var result = {}; // page (0-indexed) -> array of boxes

  for (var pi = 0; pi < piiValues.length; pi++) {
    var pii = piiValues[pi];
    var piiNorm = normalizeForMatch(pii);
    if (piiNorm.length < 2) continue;

    // Try to match pii value against concatenated word sequences on each page
    var pageNums = Object.keys(pageMap);
    for (var pg2i = 0; pg2i < pageNums.length; pg2i++) {
      var pageNum = parseInt(pageNums[pg2i], 10);
      var pageWords = pageMap[pageNum];
      var pageIdx = pageNum - 1; // convert to 0-based

      // Sliding window: try 1 to 6 consecutive words — exact match only, min 6 chars
      for (var start = 0; start < pageWords.length; start++) {
        for (var len = 1; len <= 6 && start + len <= pageWords.length; len++) {
          var slice = pageWords.slice(start, start + len);
          var concat = normalizeForMatch(slice.map(function(w) { return w.t; }).join(''));
          if (piiNorm.length >= 6 && concat === piiNorm) {
            // Compute bounding box that covers all words in slice
            var minL = Math.min.apply(null, slice.map(function(w) { return w.l; }));
            var minT = Math.min.apply(null, slice.map(function(w) { return w.tp; }));
            var maxR = Math.max.apply(null, slice.map(function(w) { return w.l + w.w; }));
            var maxB = Math.max.apply(null, slice.map(function(w) { return w.tp + w.h; }));
            if (!result[String(pageIdx)]) result[String(pageIdx)] = [];
            result[String(pageIdx)].push({
              label: 'textract:' + pii.substring(0, 30),
              x: Math.max(0, minL - 0.005),
              y: minT,
              width: Math.min(1, (maxR - minL) + 0.01),
              height: maxB - minT,
            });
            // Do NOT break -- continue scanning to find ALL occurrences on this page
          }
        }
      }
    }
  }

  return result;
}

async function loadTextractBlocks(fileKey) {
  try {
    var blocksKey = fileKey.replace(/\/[^\/]+$/, '') + '/textract_blocks.json';
    var resp = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: blocksKey }));
    var chunks = [];
    for await (var chunk of resp.Body) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
  } catch (e) {
    console.log('No textract blocks found (will use Claude vision):', e.message);
    return null;
  }
}

// ── STEP 2B: Claude vision pass — handwritten content only ───────────────────

async function detectHandwrittenPii(pdfBytes, knownPiiValues) {
  const pdfBase64 = pdfBytes.toString('base64');

  const confirmedSection = knownPiiValues && knownPiiValues.length > 0
    ? '=== CONFIRMED PATIENT PII — MUST REDACT ALL ===\n\n' +
      'These strings are confirmed patient PII. Find EVERY handwritten occurrence.\n\n' +
      knownPiiValues.map(function(v) { return '  - "' + v + '"'; }).join('\n') + '\n'
    : '';

  const prompt = [
    'You are a HIPAA redaction assistant for workers compensation medical records.',
    'Your job is to find and return bounding boxes for PATIENT DEMOGRAPHIC information only.',
    'Clinical content must be preserved — only identity/contact information is redacted.',
    '',
    '=== WHAT TO REDACT (patient demographics only) ===',
    '',
    'PATIENT NAME — the patient name value, not provider names:',
    '  e.g. "Patient: MORA-MALDONADO,VILMA N"  →  redact "MORA-MALDONADO,VILMA N"',
    '  e.g. "PATIENT: Smith, John A"  →  redact "Smith, John A"',
    '  e.g. handwritten name on C-4 form patient name field',
    '',
    'DATE OF BIRTH:',
    '  e.g. "DOB: 05/21/69"  →  redact "05/21/69"',
    '  e.g. "DATE OF BIRTH: 05/21/1969"  →  redact the date value',
    '  e.g. "Birth Date: 05/21/69  AGE: 56"  →  redact the date and age',
    '',
    'MRN / UNIT / ACCOUNT NUMBERS:',
    '  e.g. "UNIT #: D003081753"  →  redact "D003081753"',
    '  e.g. "ACCOUNT#: D00136377973"  →  redact "D00136377973"',
    '  e.g. "MRN#: 403522"  →  redact "403522"',
    '  e.g. "Patient #: 403522"  →  redact the number',
    '',
    'SSN: any value in xxx-xx-xxxx format',
    '',
    'INSURANCE / CLAIM IDs:',
    '  e.g. "Plan #: 354000611225"  →  redact the number',
    '  e.g. "Group #: 76414937"  →  redact the number',
    '  e.g. "CLM#: 0583WC260300444"  →  redact the number',
    '',
    'PATIENT ADDRESS AND PHONE:',
    '  e.g. "1828 E State Highway 168 Box 578, Moapa, NV 89025"  →  redact',
    '  e.g. "(818) 497-1726"  →  redact',
    '',
    'PATIENT PHOTO or PATIENT SIGNATURE on forms',
    '',
    '=== WHAT NOT TO REDACT ===',
    '',
    'Provider names: "Electronically Signed by Ching,Wilbert MD"  →  DO NOT redact',
    'Dates of service: "SERVICE DT: 10/08/25"  →  DO NOT redact',
    'Diagnoses: "S52.021A – Displaced fracture of olecranon"  →  DO NOT redact',
    'ICD/CPT codes: "S52.131A", "W01.0XXA"  →  DO NOT redact',
    'Medications: "Hydrocodone 10mg", "gabapentin 600mg"  →  DO NOT redact',
    'Clinical narrative: HPI, exam findings, assessment/plan  →  DO NOT redact',
    'Facility names: "Sunrise Hospital", "Nevada Orthopedic"  →  DO NOT redact',
    'Report numbers: "RPT #: 1003-0280"  →  DO NOT redact',
    'Employer: "DISTRICT ATTORNEY OF FAMIL"  →  DO NOT redact',
    '',
    confirmedSection,
    '=== BOX PLACEMENT ===',
    'Cover the VALUE only, not the label. E.g. for "DOB: 05/21/69" cover only "05/21/69".',
    'Start slightly LEFT of the value (subtract ~0.005 from x). Add ~0.008 to width.',
    'For multi-line values, use one box per line.',
    '',
    '=== OUTPUT FORMAT ===',
    'JSON object keyed by 0-based page index.',
    'Only include pages that have demographics to redact. Omit pages with nothing to redact.',
    'Return ONLY valid JSON — no explanation, no markdown.',
    '{',
    '  "0": [{"label":"patient name","x":0.08,"y":0.05,"width":0.38,"height":0.018}],',
    '  "3": [{"label":"DOB","x":0.22,"y":0.08,"width":0.12,"height":0.016},{"label":"unit number","x":0.10,"y":0.11,"width":0.20,"height":0.016}]',
    '}',
  ].filter(Boolean).join('\n');

  const body = JSON.stringify({
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 4096,
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
    body,
  }));

  const result  = JSON.parse(Buffer.from(resp.body).toString('utf-8'));
  const rawText = (result.content && result.content[0] && result.content[0].text) || '{}';
  const cleaned = rawText.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try { return JSON.parse(cleaned); } catch (e) { return {}; }
}

// ── STEP 3: Apply black boxes ─────────────────────────────────────────────────

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
      const px      = box.x * w;
      const py      = h - (box.y + box.height) * h;
      const pw      = box.width  * w;
      const ph      = box.height * h;
      const padL    = 8;
      const padR    = 5;
      const padV    = 3;
      page.drawRectangle({
        x:      Math.max(0, px - padL),
        y:      Math.max(0, py - padV),
        width:  Math.min(w - Math.max(0, px - padL), pw + padL + padR),
        height: Math.min(h, ph + padV * 2),
        color:   rgb(0, 0, 0),
        opacity: 1,
      });
    }
  }

  return Buffer.from(await pdfDoc.save({ useObjectStreams: false }));
}

// ── Merge two piiByPage maps ──────────────────────────────────────────────────

function mergePiiMaps(a, b) {
  var out = {};
  var keys = new Set(Object.keys(a).concat(Object.keys(b)));
  keys.forEach(function(k) {
    out[k] = (a[k] || []).concat(b[k] || []);
  });
  return out;
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
      job_id, type: 'redact', status: 'processing',
      doc_id, org_id: doc.org_id || null,
      created_at: now, updated_at: now,
      progress_message: 'Starting redaction...',
    },
  }));

  await lambdaClient.send(new InvokeCommand({
    FunctionName:   WORKER_FN,
    InvocationType: 'Event',
    Payload:        Buffer.from(JSON.stringify({ job_id, doc_id, doc })),
  }));

  return respond(200, { job_id, status: 'processing' });
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

    // ── Try Textract-coordinate path first ──
    var textractPii = {};
    var usedTextract = false;
    const wordBlocks = await loadTextractBlocks(fileKey);

    if (wordBlocks && wordBlocks.length > 0 && knownPiiValues.length > 0) {
      await updateJob(job_id, { progress_message: 'Mapping PII to Textract coordinates...', updated_at: new Date().toISOString() });
      textractPii = findBoxesFromBlocks(wordBlocks, knownPiiValues);
      const textractHits = Object.values(textractPii).reduce(function(s, b) { return s + b.length; }, 0);
      console.log('Textract coordinate hits:', textractHits, 'across', Object.keys(textractPii).length, 'pages');
      usedTextract = textractHits > 0;
    }

    // ── Always run Claude vision for handwritten content ──
    const masterDoc  = await PDFDocument.load(pdfBytes);
    const totalPages = masterDoc.getPageCount();
    const CHUNK_SIZE = 20;
    var claudePii    = {};

    await updateJob(job_id, { progress_message: 'Scanning for handwritten PII...', updated_at: new Date().toISOString() });

    for (let start = 0; start < totalPages; start += CHUNK_SIZE) {
      const end     = Math.min(start + CHUNK_SIZE, totalPages);
      const indices = [];
      for (let i = start; i < end; i++) indices.push(i);

      const subDoc = await PDFDocument.create();
      const copied = await subDoc.copyPages(masterDoc, indices);
      copied.forEach(function(p) { subDoc.addPage(p); });
      const subBytes = Buffer.from(await subDoc.save());

      const chunkPii = await detectHandwrittenPii(subBytes, knownPiiValues);

      for (const chunkPageStr of Object.keys(chunkPii)) {
        const globalPage = start + parseInt(chunkPageStr, 10);
        const boxes      = chunkPii[chunkPageStr];
        if (boxes && boxes.length) claudePii[String(globalPage)] = boxes;
      }
    }

    // ── If no Textract blocks available, also run full Claude pass ──
    if (!usedTextract) {
      console.log('No Textract blocks — running full Claude vision pass');
      await updateJob(job_id, { progress_message: 'Running full visual PII scan (no Textract data)...', updated_at: new Date().toISOString() });

      for (let start = 0; start < totalPages; start += CHUNK_SIZE) {
        const end     = Math.min(start + CHUNK_SIZE, totalPages);
        const indices = [];
        for (let i = start; i < end; i++) indices.push(i);

        const subDoc = await PDFDocument.create();
        const copied = await subDoc.copyPages(masterDoc, indices);
        copied.forEach(function(p) { subDoc.addPage(p); });
        const subBytes = Buffer.from(await subDoc.save());

        // Full prompt for legacy docs without Textract blocks
        const chunkPii = await detectHandwrittenPii(subBytes, knownPiiValues);
        for (const chunkPageStr of Object.keys(chunkPii)) {
          const globalPage = start + parseInt(chunkPageStr, 10);
          const boxes      = chunkPii[chunkPageStr];
          if (boxes && boxes.length) {
            claudePii[String(globalPage)] = (claudePii[String(globalPage)] || []).concat(boxes);
          }
        }
      }
    }

    // ── Merge Textract + Claude boxes ──
    const allPii             = mergePiiMaps(textractPii, claudePii);
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
        redaction_method:  usedTextract ? 'textract+claude' : 'claude_only',
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
                        ' page(s). Method: ' + (usedTextract ? 'Textract coordinates + Claude handwriting' : 'Claude vision only'),
      result: {
        new_doc_id:       newDocId,
        download_url:     downloadUrl,
        redaction_count:  totalRedactions,
        redacted_pages:   totalPagesAffected,
        confirmed_pii:    knownPiiValues.length,
        method:           usedTextract ? 'textract+claude' : 'claude_only',
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

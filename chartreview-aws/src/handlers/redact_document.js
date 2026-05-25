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
const pdfjsLib                                         = require('pdfjs-dist/legacy/build/pdf.js');
const sharp                                            = require('sharp');
const { JSDOM }                                        = require('jsdom');
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
    /\b(?:HOME\s*)?ADDRESS\s*[:|]\s*(.{10,80})/gi,

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

async function detectPiiInImage(pngBase64, imgW, imgH, knownPiiValues) {
  const confirmedSection = knownPiiValues && knownPiiValues.length > 0
    ? '=== CONFIRMED PATIENT PII VALUES ===\n\n' +
      'These exact strings appear in this document. Find and box every occurrence:\n\n' +
      knownPiiValues.map(function(v) { return '  - "' + v + '"'; }).join('\n') + '\n'
    : '';

  const prompt = [
    'You are a HIPAA redaction assistant for workers compensation medical records.',
    'This image is ' + imgW + ' x ' + imgH + ' pixels.',
    'Return bounding boxes in PIXEL coordinates (origin = top-left corner of image).',
    '',
    confirmedSection,
    '=== WHAT TO REDACT ===',
    '',
    'PATIENT NAME:',
    '  Redact only the NAME VALUE, not the label.',
    '  e.g. "PATIENT: MORA-MALDONADO,VILMA N" -> box covers "MORA-MALDONADO,VILMA N" only',
    '  e.g. "PATIENT\'S NAME: [name]" -> box covers the name value only',
    '',
    'DATE OF BIRTH:',
    '  Redact only the DATE VALUE when labeled: DOB, D.O.B., DATE OF BIRTH, Birth Date, Birthdate.',
    '  e.g. "DOB: 05/21/69  AGE: 56" -> box covers "05/21/69" AND "56"',
    '  e.g. "DATE OF BIRTH: 05/21/1969" -> box covers the date value only',
    '',
    'MRN / UNIT / ACCOUNT NUMBERS:',
    '  e.g. "UNIT #: D003081753" -> box covers "D003081753"',
    '  e.g. "ACCOUNT#: D00136377973" -> box covers "D00136377973"',
    '  e.g. "Acct: D00136377973" -> box covers "D00136377973"',
    '  e.g. "MRN#: 403522" -> box covers "403522"',
    '',
    'ADDRESS / PHONE / SSN:',
    '  Redact full street address lines, phone numbers labeled PHONE:, SSN values.',
    '',
    'COMPACT HEADER RULE:',
    '  Many pages have a 4-line header: Patient / Unit# / Date / Acct#',
    '  The Date: line in this block is a REPORT date. DO NOT REDACT it.',
    '  Only redact Patient name value and Acct# value in this block.',
    '',
    'SERVICE DATE RULE - DO NOT redact dates labeled:',
    '  Date:  DATE:  ADM DT:  REP SRV DT:  SERVICE DT:  Discharge date:  Admission date:',
    '  Any date appearing in clinical notes, vitals tables, medication orders.',
    '',
    '=== OUTPUT FORMAT ===',
    'Return a JSON array of boxes. Each box: {"label":"...","x":N,"y":N,"width":N,"height":N}',
    'All values are INTEGERS in pixels. x,y = top-left corner of the box.',
    'If nothing to redact on this page, return an empty array: []',
    'Return ONLY valid JSON - no explanation, no markdown.',
  ].filter(Boolean).join('\n');

  const body = JSON.stringify({
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 4096,
    temperature: 0,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: pngBase64 } },
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
  const rawText = (result.content && result.content[0] && result.content[0].text) || '[]';
  const cleaned = rawText.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.warn('detectPiiInImage parse error:', e.message, 'raw:', rawText.slice(0, 200));
    return [];
  }
}


async function applyRedactions(pdfBytes, piiByPage) {
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const pages  = pdfDoc.getPages();

  for (const pageIndexStr of Object.keys(piiByPage)) {
    const pageIndex  = parseInt(pageIndexStr, 10);
    const entry      = piiByPage[pageIndexStr];
    if (pageIndex >= pages.length || !entry || !entry.boxes || !entry.boxes.length) continue;

    const page        = pages[pageIndex];
    const sz          = page.getSize();
    const pdfH        = sz.height;
    const pdfW        = sz.width;
    const renderScale = entry.scale;

    for (const box of entry.boxes) {
      const pdfX  = box.x / renderScale;
      const pdfY  = pdfH - (box.y + box.height) / renderScale;
      const pdfBW = box.width  / renderScale;
      const pdfBH = box.height / renderScale;
      page.drawRectangle({
        x:      Math.max(0, pdfX),
        y:      Math.max(0, pdfY),
        width:  Math.min(pdfW - Math.max(0, pdfX), pdfBW),
        height: Math.min(pdfH, pdfBH),
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

    // Extract known PII values from stored Textract text to anchor Claude's redaction
    const extractedText  = await fetchExtractedText(doc_id);
    const knownPiiValues = extractKnownPiiValues(extractedText);
    console.log('Known PII values (' + knownPiiValues.length + '):', JSON.stringify(knownPiiValues.slice(0, 15)));

    const masterDoc  = await PDFDocument.load(pdfBytes);
    const totalPages = masterDoc.getPageCount();
    const CHUNK_SIZE = 20;
    const allPii     = {};

    const RENDER_DPI   = 150;
    const RENDER_SCALE = RENDER_DPI / 72;
    const pdfJsDoc = await pdfjsLib.getDocument({ data: new Uint8Array(pdfBytes) }).promise;

    for (let pageIdx = 0; pageIdx < totalPages; pageIdx++) {
      if (pageIdx % 5 === 0) {
        await updateJob(job_id, {
          progress_message: 'Scanning page ' + (pageIdx + 1) + ' of ' + totalPages + '...',
          updated_at: new Date().toISOString(),
        });
      }
      const pdfJsPage  = await pdfJsDoc.getPage(pageIdx + 1);
      const viewport   = pdfJsPage.getViewport({ scale: RENDER_SCALE });
      const imgW       = Math.round(viewport.width);
      const imgH       = Math.round(viewport.height);

      // Render PDF page to SVG via pdfjs (pure JS, no native binaries)
      const dom        = new JSDOM('<!DOCTYPE html><html><body></body></html>');
      global.document  = dom.window.document;
      const opList     = await pdfJsPage.getOperatorList();
      const svgGfx     = new pdfjsLib.SVGGraphics(pdfJsPage.commonObjs, pdfJsPage.objs);
      const svgEl      = await svgGfx.getSVG(opList, viewport);
      const serializer = new dom.window.XMLSerializer();
      const svgStr     = serializer.serializeToString(svgEl);

      // Convert SVG to PNG via sharp (prebuilt binary, no node-gyp)
      const pngBuffer  = await sharp(Buffer.from(svgStr)).resize(imgW, imgH).png().toBuffer();
      const pngBase64  = pngBuffer.toString('base64');

      const boxes = await detectPiiInImage(pngBase64, imgW, imgH, knownPiiValues);
      if (boxes && boxes.length) {
        allPii[String(pageIdx)] = { boxes, imgW, imgH, scale: RENDER_SCALE };
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

// redact_document.js — ChartReview Pro redaction Lambda
// Route: POST /documents/{aws_document_id}/redact
// Updated: 2026-05-25 — Claude vision on raw PDF bytes (no rasterization)

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

// ── Helpers ────────────────────────────────────────────────────────────────────

async function getS3Bytes(key) {
  const resp = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const chunks = [];
  for await (const chunk of resp.Body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function updateJob(job_id, patch) {
  await dynamo.send(new UpdateCommand({
    TableName: JOBS_TABLE,
    Key: { job_id },
    UpdateExpression: 'SET ' + Object.keys(patch).map((k, i) => '#k' + i + ' = :v' + i).join(', '),
    ExpressionAttributeNames:  Object.fromEntries(Object.keys(patch).map((k, i) => ['#k' + i, k])),
    ExpressionAttributeValues: Object.fromEntries(Object.keys(patch).map((k, i) => [':v' + i, patch[k]])),
  }));
}

async function fetchExtractedText(doc_id) {
  try {
    const resp = await dynamo.send(new GetCommand({ TableName: DOCS_TABLE, Key: { aws_document_id: doc_id } }));
    return (resp.Item && resp.Item.extracted_text) ? resp.Item.extracted_text : '';
  } catch (e) {
    console.warn('fetchExtractedText error:', e.message);
    return '';
  }
}

function extractKnownPiiValues(extractedText) {
  if (!extractedText) return [];
  const values = [];

  // Patient name — various label formats
  var namePatterns = [
    /PATIENT[:\s]+([A-Z][A-Z\-,\.\s']+(?:N|M|F)?)\s*$/im,
    /PATIENT'?S?\s*NAME[:\s]+([A-Z][A-Z\-,\.\s']+)/im,
    /Patient:\s*([A-Z][A-Z\-,\.\s']+)/im,
    /^([A-Z][A-Z\-]+,\s*[A-Z][A-Z\s]+)\s+(?:DOB|MRN|UNIT)/im,
  ];
  for (var i = 0; i < namePatterns.length; i++) {
    var m = extractedText.match(namePatterns[i]);
    if (m && m[1] && m[1].trim().length > 3) {
      var name = m[1].trim().replace(/\s+/g, ' ');
      if (!values.includes(name)) values.push(name);
      // Also add comma-flipped version
      var parts = name.split(',');
      if (parts.length === 2) {
        var flipped = parts[1].trim() + ' ' + parts[0].trim();
        if (!values.includes(flipped)) values.push(flipped);
      }
      break;
    }
  }

  // DOB
  var dobMatch = extractedText.match(/(?:DOB|D\.O\.B\.|DATE OF BIRTH|Birth\s*Date)[:\s]+(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i);
  if (dobMatch && !values.includes(dobMatch[1])) values.push(dobMatch[1]);

  // MRN / Unit / Account
  var idPatterns = [
    /UNIT\s*#?[:\s]+([A-Z0-9]{6,})/i,
    /ACCOUNT\s*#?[:\s]+([A-Z0-9]{6,})/i,
    /ACCT\s*#?[:\s]+([A-Z0-9]{6,})/i,
    /MRN\s*#?[:\s]+([A-Z0-9]{4,})/i,
  ];
  for (var j = 0; j < idPatterns.length; j++) {
    var im = extractedText.match(idPatterns[j]);
    if (im && !values.includes(im[1])) values.push(im[1]);
  }

  // Address — first street address line
  var addrMatch = extractedText.match(/(\d{3,5}\s+[A-Z][A-Za-z0-9\s,\.#]+(?:Ave|St|Rd|Blvd|Pkwy|Hwy|Dr|Ln|Way|Ct)[^\n]*)/i);
  if (addrMatch && !values.includes(addrMatch[1].trim())) values.push(addrMatch[1].trim());

  console.log('[REDACT] Known PII values (' + values.length + '):', JSON.stringify(values));
  return values;
}

// ── Claude vision on a single PDF page (sent as raw PDF bytes) ─────────────────
// Claude accepts PDF documents natively — no rasterization needed.
// Returns array of {label, x, y, width, height} in PDF points (origin = bottom-left).

async function detectPiiOnPage(singlePagePdfBytes, pageWidth, pageHeight, knownPiiValues) {
  const confirmedSection = knownPiiValues && knownPiiValues.length > 0
    ? '=== CONFIRMED PATIENT PII VALUES ===\n\nThese exact strings appear in this document. Find and box every occurrence:\n\n' +
      knownPiiValues.map(function(v) { return '  - "' + v + '"'; }).join('\n') + '\n'
    : '';

  const prompt = [
    'You are a HIPAA redaction assistant for workers compensation medical records.',
    'This PDF page is ' + Math.round(pageWidth) + ' x ' + Math.round(pageHeight) + ' points (PDF coordinate space).',
    'PDF coordinates: origin (0,0) = BOTTOM-LEFT corner. x increases right, y increases up.',
    'Return bounding boxes in PDF POINT coordinates.',
    '',
    confirmedSection,
    '=== WHAT TO REDACT ===',
    '',
    'PATIENT NAME: Redact the name VALUE only, not the label.',
    '  e.g. "PATIENT: MORA-MALDONADO,VILMA N" -> box covers "MORA-MALDONADO,VILMA N" only',
    '',
    'DATE OF BIRTH: Redact the date VALUE when labeled DOB, D.O.B., DATE OF BIRTH, Birth Date.',
    '  e.g. "DOB: 05/21/69" -> box covers "05/21/69" only',
    '',
    'MRN / UNIT / ACCOUNT NUMBERS: Redact the value only.',
    '  e.g. "UNIT #: D003081753" -> box covers "D003081753"',
    '  e.g. "ACCOUNT#: D00136377973" -> box covers "D00136377973"',
    '',
    'ADDRESS / PHONE / SSN: Redact full street address lines, phone numbers labeled PHONE:, SSN values.',
    '',
    'COMPACT HEADER RULE: Many pages have a 4-line header: Patient / Unit# / Date / Acct#',
    '  The "Date:" line in this block is a REPORT date. DO NOT REDACT it.',
    '  Only redact Patient name value and Acct# value in this block.',
    '',
    'SERVICE DATE RULE - DO NOT redact dates labeled:',
    '  Date:  DATE:  ADM DT:  REP SRV DT:  SERVICE DT:  Discharge date:  Admission date:',
    '  Any date in clinical notes, vitals tables, or medication orders.',
    '',
    '=== OUTPUT FORMAT ===',
    'Return a JSON array of boxes. Each box: {"label":"...","x":N,"y":N,"width":N,"height":N}',
    'All values are numbers in PDF points. x,y = BOTTOM-LEFT corner of the box.',
    'If nothing to redact on this page, return: []',
    'Return ONLY valid JSON — no explanation, no markdown.',
  ].filter(Boolean).join('\n');

  const body = JSON.stringify({
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 4096,
    temperature: 0,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'document',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: singlePagePdfBytes.toString('base64'),
          },
        },
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
  // Extract JSON array from response — handles code fences and preamble text
  let cleaned = rawText.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const firstBracket = cleaned.indexOf('[');
  const lastBracket  = cleaned.lastIndexOf(']');
  if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
    cleaned = cleaned.slice(firstBracket, lastBracket + 1);
  }
  try {
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.warn('detectPiiOnPage parse error:', e.message, 'raw:', rawText.slice(0, 200));
    return [];
  }
}

// ── Apply redaction boxes to PDF ───────────────────────────────────────────────
// Boxes are in PDF points with bottom-left origin — matches pdf-lib natively.

async function applyRedactions(pdfBytes, piiByPage) {
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const pages  = pdfDoc.getPages();

  for (const pageIndexStr of Object.keys(piiByPage)) {
    const pageIndex = parseInt(pageIndexStr, 10);
    const boxes     = piiByPage[pageIndexStr];
    if (pageIndex >= pages.length || !boxes || !boxes.length) continue;

    const page = pages[pageIndex];

    for (const box of boxes) {
      const x = Math.max(0, box.x);
      const y = Math.max(0, box.y);
      const w = box.width;
      const h = box.height;
      page.drawRectangle({ x, y, width: w, height: h, color: rgb(0, 0, 0), opacity: 1 });
    }
  }

  return Buffer.from(await pdfDoc.save({ useObjectStreams: false }));
}

// ── START handler ──────────────────────────────────────────────────────────────

async function _redactDocumentStart(event) {
  try {
    const body          = typeof event.body === 'string' ? JSON.parse(event.body) : (event.body || {});
    const aws_document_id = event.pathParameters && event.pathParameters.aws_document_id;
    const org_id        = body.org_id || (event.requestContext && event.requestContext.authorizer && event.requestContext.authorizer.org_id);

    if (!aws_document_id) return { statusCode: 400, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: 'Missing aws_document_id' }) };

    // Load document record
    const docResp = await dynamo.send(new GetCommand({ TableName: DOCS_TABLE, Key: { aws_document_id } }));
    const doc     = docResp.Item;
    if (!doc) return { statusCode: 404, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: 'Document not found' }) };

    const job_id = randomUUID();
    await dynamo.send(new PutCommand({
      TableName: JOBS_TABLE,
      Item: {
        job_id,
        type:             'redact',
        aws_document_id,
        org_id:           org_id || doc.org_id,
        status:           'processing',
        progress_message: 'Starting redaction...',
        created_at:       new Date().toISOString(),
        updated_at:       new Date().toISOString(),
      },
    }));

    // Fire worker async
    await lambdaClient.send(new InvokeCommand({
      FunctionName:   WORKER_FN,
      InvocationType: 'Event',
      Payload:        Buffer.from(JSON.stringify({ job_id, doc_id: aws_document_id, doc })),
    }));

    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
      body: JSON.stringify({ job_id, status: 'processing' }),
    };
  } catch (err) {
    console.error('redactDocumentStart error:', err);
    return { statusCode: 500, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: err.message }) };
  }
}

module.exports.redactDocumentStart = validateApiKey(_redactDocumentStart);

// ── WORKER handler ─────────────────────────────────────────────────────────────

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

    // Load PDF and split into single-page PDFs for Claude
    const masterDoc  = await PDFDocument.load(pdfBytes);
    const totalPages = masterDoc.getPageCount();
    const piiByPage  = {};

    const BATCH_SIZE = 10;
    for (let batchStart = 0; batchStart < totalPages; batchStart += BATCH_SIZE) {
      const batchEnd = Math.min(batchStart + BATCH_SIZE, totalPages);
      await updateJob(job_id, {
        progress_message: 'Scanning pages ' + (batchStart + 1) + '-' + batchEnd + ' of ' + totalPages + '...',
        updated_at: new Date().toISOString(),
      });

      // Build all single-page PDFs for this batch
      const batchIndices = [];
      for (let i = batchStart; i < batchEnd; i++) batchIndices.push(i);

      const batchPromises = batchIndices.map(async function(pageIdx) {
        const singleDoc = await PDFDocument.create();
        const [copiedPage] = await singleDoc.copyPages(masterDoc, [pageIdx]);
        singleDoc.addPage(copiedPage);
        const singlePageBytes = Buffer.from(await singleDoc.save());
        const page = masterDoc.getPages()[pageIdx];
        const { width, height } = page.getSize();
        const boxes = await detectPiiOnPage(singlePageBytes, width, height, knownPiiValues);
        console.log('[REDACT] page ' + pageIdx + ' (' + Math.round(width) + 'x' + Math.round(height) + ' pts) boxes:', boxes.length, boxes.length ? JSON.stringify(boxes) : '');
        return { pageIdx, boxes };
      });

      const batchResults = await Promise.all(batchPromises);
      for (const result of batchResults) {
        if (result.boxes && result.boxes.length) {
          piiByPage[String(result.pageIdx)] = result.boxes;
        }
      }
    }

    const totalRedactions    = Object.values(piiByPage).reduce(function(s, b) { return s + b.length; }, 0);
    const totalPagesAffected = Object.keys(piiByPage).length;

    await updateJob(job_id, {
      progress_message: 'Applying ' + totalRedactions + ' redaction(s) across ' + totalPagesAffected + ' page(s)...',
      updated_at: new Date().toISOString(),
    });

    const redactedBytes = await applyRedactions(pdfBytes, piiByPage);

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

    // Update DynamoDB document record with redacted file info
    await dynamo.send(new UpdateCommand({
      TableName: DOCS_TABLE,
      Key: { aws_document_id: doc_id },
      UpdateExpression: 'SET redacted_file_key = :rk, redacted_filename = :rf, has_redacted_version = :t, updated_at = :ua',
      ExpressionAttributeValues: {
        ':rk': redactedKey,
        ':rf': redactedName,
        ':t':  true,
        ':ua': new Date().toISOString(),
      },
    }));

    await updateJob(job_id, {
      status:           'complete',
      progress_message: 'Redaction complete. ' + totalRedactions + ' item(s) redacted across ' + totalPagesAffected + ' page(s).',
      redacted_file_key: redactedKey,
      redacted_filename: redactedName,
      completed_at:     new Date().toISOString(),
      updated_at:       new Date().toISOString(),
    });

    console.log('[REDACT] Complete — job:', job_id, 'pages affected:', totalPagesAffected, 'total boxes:', totalRedactions);

  } catch (err) {
    console.error('[REDACT] Worker error:', err);
    await updateJob(job_id, {
      status:           'error',
      progress_message: 'Redaction failed: ' + err.message,
      updated_at:       new Date().toISOString(),
    }).catch(function() {});
  }
};

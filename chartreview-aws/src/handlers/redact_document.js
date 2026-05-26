'use strict';

const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { DynamoDBClient }                               = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { BedrockRuntimeClient, InvokeModelCommand }     = require('@aws-sdk/client-bedrock-runtime');
const { LambdaClient, InvokeCommand }                  = require('@aws-sdk/client-lambda');
const { PDFDocument, rgb }                             = require('pdf-lib');
const { validateApiKey }                               = require('../middleware/auth');

const REGION      = process.env.AWS_REGION    || 'us-east-1';
const BUCKET      = process.env.S3_BUCKET     || 'chartreview-documents-prod';
const DOCS_TABLE  = process.env.DOCS_TABLE    || 'chartreview-documents-prod';
const JOBS_TABLE  = process.env.JOBS_TABLE    || 'chartreview-jobs-prod';
const MODEL_ID    = process.env.MODEL_ID      || 'us.anthropic.claude-sonnet-4-6';
const WORKER_FN   = process.env.REDACT_WORKER_FUNCTION_NAME || 'chartreview-pro-prod-redactDocumentWorker';
const CHUNK_FN    = process.env.REDACT_CHUNK_FUNCTION || 'chartreview-pro-prod-redactDocumentChunkWorker';
const PAGES_PER_CHUNK = 20;

const s3      = new S3Client({ region: REGION });
const dynamo  = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const bedrock = new BedrockRuntimeClient({ region: REGION });
const lambda  = new LambdaClient({ region: REGION });

// ── Helpers ─────────────────────────────────────────────────────────────────

async function getS3Bytes(key) {
  const resp = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const chunks = [];
  for await (const chunk of resp.Body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function updateJob(job_id, patch) {
  const sets  = Object.keys(patch).map(function(k, i) { return '#f' + i + ' = :v' + i; });
  const names = {};
  const vals  = {};
  Object.keys(patch).forEach(function(k, i) { names['#f' + i] = k; vals[':v' + i] = patch[k]; });
  await dynamo.send(new UpdateCommand({
    TableName: JOBS_TABLE,
    Key: { job_id },
    UpdateExpression: 'SET ' + sets.join(', '),
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: vals,
  }));
}

async function fetchExtractedText(doc_id) {
  try {
    const key  = 'orgs/' + doc_id.split('/')[1] + '/documents/' + doc_id + '/textract_blocks.json';
    const data = await getS3Bytes(key);
    const blocks = JSON.parse(data.toString('utf8'));
    return blocks.filter(function(b) { return b.BlockType === 'LINE'; }).map(function(b) { return b.Text || ''; }).join('\n');
  } catch (e) {
    try {
      const docResp = await dynamo.send(new GetCommand({ TableName: DOCS_TABLE, Key: { aws_document_id: doc_id } }));
      return (docResp.Item && docResp.Item.extracted_text) || '';
    } catch (e2) { return ''; }
  }
}

function extractKnownPiiValues(text) {
  if (!text) return [];
  const values = new Set();

  const nameMatch = text.match(/(?:Patient(?:'s)?\s+Name|PATIENT\s+NAME|Name)[:\s]+([A-Z][A-Za-z\-]+(?:\s+[A-Z][A-Za-z\-]+){1,4})/);
  if (nameMatch) { values.add(nameMatch[1].trim()); }

  const nameMatch2 = text.match(/^([A-Z]{2,}[A-Z\-]+,\s*[A-Z]{2,}(?:\s+[A-Z])?)\s*$/m);
  if (nameMatch2) { values.add(nameMatch2[1].trim()); }

  const nameMatch3 = text.match(/(?:RE:|Patient:)\s+([A-Z][a-z]+(?:\s+[A-Z]\.?\s+)?[A-Z][a-z\-]+(?:\s+[A-Z][a-z\-]+)?)/);
  if (nameMatch3) { values.add(nameMatch3[1].trim()); }

  const dobPatterns = [
    /(?:DOB|Date\s+of\s+Birth|Birth\s+Date|BIRTH\s+DATE)[:\s]+(\d{1,2}\/\d{1,2}\/\d{2,4})/i,
    /(?:DOB|Date\s+of\s+Birth)[:\s]+(\d{2}\/\d{2}\/\d{2})/i,
  ];
  for (const pat of dobPatterns) {
    const m = text.match(pat);
    if (m) { values.add(m[1].trim()); break; }
  }

  const mrnPatterns = [
    /(?:MRN|MR#|MRN#|Medical\s+Record)[:\s#]+([A-Z0-9]{4,12})/i,
    /(?:Unit\s*(?:No|Number|#)|UNIT\s*(?:NO|NUMBER|#))[:\s]+([A-Z0-9]{4,12})/i,
    /(?:Account\s*(?:No|Number|#)|ACCT\s*(?:NO|#))[:\s]+([A-Z0-9]{6,14})/i,
  ];
  for (const pat of mrnPatterns) {
    const m = text.match(pat);
    if (m) values.add(m[1].trim());
  }

  const claimPatterns = [
    /(?:Claim\s*(?:No|Number|#)|CLAIM)[:\s]+([A-Z0-9\-]{5,20})/i,
    /(?:Insurance\s*(?:ID|Number)|Policy\s*(?:No|Number))[:\s]+([A-Z0-9\-]{5,20})/i,
  ];
  for (const pat of claimPatterns) {
    const m = text.match(pat);
    if (m) values.add(m[1].trim());
  }

  return Array.from(values).filter(function(v) { return v && v.length > 2; });
}

// ── Claude PII detection for a single page ──────────────────────────────────

async function detectPiiOnPage(singlePagePdfBytes, pageWidth, pageHeight, knownPiiValues) {
  const piiList  = knownPiiValues.length
    ? 'Confirmed PII values to find:\n' + knownPiiValues.map(function(v) { return '- "' + v + '"'; }).join('\n')
    : 'No confirmed PII values provided — use visual judgment.';

  const prompt = 'You are a HIPAA compliance redaction assistant.\n\n' +
    piiList + '\n\n' +
    'This PDF page is ' + Math.round(pageWidth) + ' x ' + Math.round(pageHeight) + ' points.\n' +
    'PDF coordinate origin is BOTTOM-LEFT. Y=0 is the bottom edge, Y=' + Math.round(pageHeight) + ' is the top.\n\n' +
    'Find ALL occurrences of patient PII: name, DOB, SSN, MRN, unit#, account#, address, phone, insurance ID, claim#.\n' +
    'Redact VALUE fields only — not labels like "Patient Name:" or "DOB:".\n' +
    'DO NOT redact: provider names, facility names, service dates, diagnosis codes, clinical content.\n\n' +
    'Return ONLY a JSON array (no preamble, no explanation, no markdown):\n' +
    '[{"label":"description","x":number,"y":number,"width":number,"height":number},...]\n' +
    'Coordinates are in PDF points (bottom-left origin). Return [] if no PII found.';

  const body = JSON.stringify({
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 8192,
    temperature: 0,
    messages: [{
      role: 'user',
      content: [{
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: singlePagePdfBytes.toString('base64') },
      }, {
        type: 'text',
        text: prompt,
      }],
    }],
  });

  const resp    = await bedrock.send(new InvokeModelCommand({ modelId: MODEL_ID, contentType: 'application/json', accept: 'application/json', body }));
  const rawText = JSON.parse(Buffer.from(resp.body).toString('utf8')).content[0].text;

  // Extract JSON array — handles code fences and reasoning preambles
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

// ── Apply redaction boxes to PDF ─────────────────────────────────────────────

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
      const w = Math.min(box.width,  page.getWidth()  - x);
      const h = Math.min(box.height, page.getHeight() - y);
      if (w <= 0 || h <= 0) continue;
      page.drawRectangle({ x, y, width: w, height: h, color: rgb(0, 0, 0) });
    }
  }
  return Buffer.from(await pdfDoc.save());
}

// ── START handler ────────────────────────────────────────────────────────────

async function _redactDocumentStart(event) {
  try {
    const body            = typeof event.body === 'string' ? JSON.parse(event.body) : (event.body || {});
    const aws_document_id = event.pathParameters && event.pathParameters.aws_document_id;
    const org_id          = body.org_id || (event.requestContext && event.requestContext.authorizer && event.requestContext.authorizer.org_id);

    if (!aws_document_id) return { statusCode: 400, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: 'Missing aws_document_id' }) };

    const docResp = await dynamo.send(new GetCommand({ TableName: DOCS_TABLE, Key: { aws_document_id } }));
    const doc     = docResp.Item;
    if (!doc) return { statusCode: 404, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: 'Document not found' }) };

    const job_id = require('crypto').randomUUID();
    await updateJob(job_id, {
      job_id,
      status:           'processing',
      job_type:         'redact',
      org_id:           org_id || doc.org_id,
      doc_id:           aws_document_id,
      progress_message: 'Starting redaction...',
      created_at:       new Date().toISOString(),
      updated_at:       new Date().toISOString(),
    });

    // Fire the coordinator worker asynchronously
    await lambda.send(new InvokeCommand({
      FunctionName:   WORKER_FN,
      InvocationType: 'Event',
      Payload:        Buffer.from(JSON.stringify({ job_id, doc_id: aws_document_id, doc })),
    }));

    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
      body: JSON.stringify({ job_id }),
    };
  } catch (err) {
    console.error('[REDACT] Start error:', err);
    return { statusCode: 500, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: err.message }) };
  }
}

module.exports.redactDocumentStart = validateApiKey(_redactDocumentStart);

// ── COORDINATOR WORKER — fires chunk workers in parallel, merges, applies ────

module.exports.redactDocumentWorker = async function(event) {
  const job_id = event.job_id;
  const doc_id = event.doc_id;
  const doc    = event.doc;

  try {
    await updateJob(job_id, { progress_message: 'Fetching document...', updated_at: new Date().toISOString() });

    const fileKey        = doc.file_key || doc.s3_key;
    const pdfBytes       = await getS3Bytes(fileKey);
    const extractedText  = await fetchExtractedText(doc_id);
    const knownPiiValues = extractKnownPiiValues(extractedText);

    console.log('[REDACT] Known PII values (' + knownPiiValues.length + '):', JSON.stringify(knownPiiValues));

    const masterDoc   = await PDFDocument.load(pdfBytes);
    const totalPages  = masterDoc.getPageCount();
    const numChunks   = Math.ceil(totalPages / PAGES_PER_CHUNK);

    await updateJob(job_id, {
      progress_message: 'Scanning ' + totalPages + ' pages in ' + numChunks + ' parallel chunk(s)...',
      updated_at: new Date().toISOString(),
    });

    // Fire all chunk workers in parallel
    const chunkResults = await Promise.all(
      Array.from({ length: numChunks }, function(_, ci) {
        const startPage = ci * PAGES_PER_CHUNK;
        const endPage   = Math.min(startPage + PAGES_PER_CHUNK, totalPages);
        return lambda.send(new InvokeCommand({
          FunctionName:   CHUNK_FN,
          InvocationType: 'RequestResponse',
          Payload:        Buffer.from(JSON.stringify({
            job_id, doc_id, fileKey, startPage, endPage, totalPages, knownPiiValues, chunkIndex: ci,
          })),
        })).then(function(res) {
          const result = JSON.parse(Buffer.from(res.Payload).toString('utf8'));
          if (result.errorMessage) throw new Error('Chunk ' + ci + ' failed: ' + result.errorMessage);
          return result;
        });
      })
    );

    // Merge piiByPage from all chunks
    const piiByPage = {};
    for (const chunkResult of chunkResults) {
      if (chunkResult.piiByPage) {
        Object.assign(piiByPage, chunkResult.piiByPage);
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
      Bucket: BUCKET, Key: redactedKey, Body: redactedBytes, ContentType: 'application/pdf',
    }));

    await dynamo.send(new UpdateCommand({
      TableName: DOCS_TABLE,
      Key: { aws_document_id: doc_id },
      UpdateExpression: 'SET redacted_file_key = :rk, redacted_filename = :rf, has_redacted_version = :t, updated_at = :ua',
      ExpressionAttributeValues: { ':rk': redactedKey, ':rf': redactedName, ':t': true, ':ua': new Date().toISOString() },
    }));

    await updateJob(job_id, {
      status:            'complete',
      progress_message:  'Redaction complete. ' + totalRedactions + ' item(s) redacted across ' + totalPagesAffected + ' page(s).',
      redacted_file_key: redactedKey,
      redacted_filename: redactedName,
      result: {
        redaction_count: totalRedactions,
        redacted_pages:  totalPagesAffected,
        download_url:    redactedKey,
      },
      completed_at: new Date().toISOString(),
      updated_at:   new Date().toISOString(),
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

// ── CHUNK WORKER — scans startPage..endPage, returns piiByPage ───────────────

module.exports.redactDocumentChunkWorker = async function(event) {
  const { job_id, doc_id, fileKey, startPage, endPage, totalPages, knownPiiValues, chunkIndex } = event;

  try {
    console.log('[REDACT CHUNK ' + chunkIndex + '] pages ' + startPage + '-' + (endPage - 1) + ' of ' + totalPages);

    await updateJob(job_id, {
      progress_message: 'Scanning pages ' + (startPage + 1) + '-' + endPage + ' of ' + totalPages + '...',
      updated_at: new Date().toISOString(),
    });

    const pdfBytes  = await getS3Bytes(fileKey);
    const masterDoc = await PDFDocument.load(pdfBytes);
    const piiByPage = {};

    for (let pageIdx = startPage; pageIdx < endPage; pageIdx++) {
      const singleDoc = await PDFDocument.create();
      const [copiedPage] = await singleDoc.copyPages(masterDoc, [pageIdx]);
      singleDoc.addPage(copiedPage);
      const singlePageBytes = Buffer.from(await singleDoc.save());
      const page = masterDoc.getPages()[pageIdx];
      const { width, height } = page.getSize();

      const boxes = await detectPiiOnPage(singlePageBytes, width, height, knownPiiValues);
      console.log('[REDACT CHUNK ' + chunkIndex + '] page ' + pageIdx + ' (' + Math.round(width) + 'x' + Math.round(height) + ') boxes:', boxes.length, boxes.length ? JSON.stringify(boxes) : '');

      if (boxes && boxes.length) {
        piiByPage[String(pageIdx)] = boxes;
      }
    }

    console.log('[REDACT CHUNK ' + chunkIndex + '] done — ' + Object.keys(piiByPage).length + ' pages with PII');
    return { piiByPage, chunkIndex };

  } catch (err) {
    console.error('[REDACT CHUNK ' + chunkIndex + '] error:', err);
    throw err;
  }
};

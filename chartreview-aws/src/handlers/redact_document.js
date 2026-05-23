// redact_document.js — ChartReview Pro redaction Lambda
// Route: POST /documents/{aws_document_id}/redact
// Worker: redactDocumentWorker (900s, invoked async)

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

const s3      = new S3Client({ region: process.env.AWS_REGION || 'us-east-1', requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' });
const dynamo  = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const bedrock = new BedrockRuntimeClient({ region: 'us-east-1' });
const lambdaClient = new LambdaClient({ region: process.env.AWS_REGION || 'us-east-1' });

const BUCKET     = process.env.S3_BUCKET       || 'chartreview-documents-prod';
const DOCS_TABLE = process.env.DOCUMENTS_TABLE || 'chartreview-documents-prod';
const JOBS_TABLE = process.env.JOBS_TABLE      || 'chartreview-jobs-prod';
const MODEL_ID   = process.env.MODEL_ID        || 'us.anthropic.claude-sonnet-4-6';
const WORKER_FN  = process.env.REDACT_WORKER_FUNCTION_NAME || 'chartreview-pro-prod-redactDocumentWorker';

// ─── helpers ──────────────────────────────────────────────────────────────────

const respond = (statusCode, body) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization,x-api-key,x-org-id',
  },
  body: JSON.stringify(body),
});

async function getS3Bytes(key) {
  const resp = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const chunks = [];
  for await (const chunk of resp.Body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function updateJob(job_id, patch) {
  const keys   = Object.keys(patch);
  const sets   = keys.map((k, i) => ).join(', ');
  const names  = Object.fromEntries(keys.map((k, i) => [, k]));
  const values = Object.fromEntries(Object.values(patch).map((v, i) => [, v]));
  await dynamo.send(new UpdateCommand({
    TableName: JOBS_TABLE, Key: { job_id },
    UpdateExpression: ,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  }));
}

// ─── PII detection via Bedrock (PDF document vision) ─────────────────────────

async function detectPiiInPdf(pdfBytes) {
  const pdfBase64 = pdfBytes.toString('base64');

  const prompt = ;

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
    body,
  }));

  const result = JSON.parse(Buffer.from(resp.body).toString('utf-8'));
  const text = (result.content && result.content[0] && result.content[0].text || '{}').trim();
  const cleaned = text.replace(/^$/, '').trim();

  try {
    return JSON.parse(cleaned);
  } catch (e) {
    console.warn('PII detection parse failed:', text.slice(0, 300));
    return {};
  }
}

// ─── Apply redaction boxes to PDF ─────────────────────────────────────────────

async function applyRedactions(pdfBytes, piiByPage) {
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const pages  = pdfDoc.getPages();

  for (const pageIndexStr of Object.keys(piiByPage)) {
    const pageIndex = parseInt(pageIndexStr, 10);
    const boxes = piiByPage[pageIndexStr];
    if (pageIndex >= pages.length || !boxes || !boxes.length) continue;

    const page = pages[pageIndex];
    const { width, height } = page.getSize();

    for (const box of boxes) {
      const pdfX = box.x * width;
      const pdfY = height - (box.y + box.height) * height;
      const pdfW = box.width  * width;
      const pdfH = box.height * height;
      const pad  = 3;
      page.drawRectangle({
        x:      Math.max(0, pdfX - pad),
        y:      Math.max(0, pdfY - pad),
        width:  Math.min(width,  pdfW + pad * 2),
        height: Math.min(height, pdfH + pad * 2),
        color:  rgb(0, 0, 0),
        opacity: 1,
      });
    }
  }

  return Buffer.from(await pdfDoc.save({ useObjectStreams: false }));
}

// ─── START handler (wrapped with validateApiKey middleware) ────────────────────

const _redactDocumentStart = async (event) => {
  const doc_id = event.pathParameters && event.pathParameters.aws_document_id;
  if (!doc_id) return respond(400, { error: 'Missing document ID' });

  const docRes = await dynamo.send(new GetCommand({ TableName: DOCS_TABLE, Key: { aws_document_id: doc_id } }));
  const doc = docRes.Item;
  if (!doc) return respond(404, { error: 'Document not found' });

  const fileKey = doc.file_key || doc.s3_key;
  if (!fileKey) return respond(400, { error: 'Document has no S3 key' });

  const job_id = randomUUID();
  const now = new Date().toISOString();
  await dynamo.send(new PutCommand({
    TableName: JOBS_TABLE,
    Item: {
      job_id, type: 'redact', status: 'processing',
      doc_id, org_id: doc.org_id,
      created_at: now, updated_at: now,
      progress_message: 'Starting redaction…',
    },
  }));

  await lambdaClient.send(new InvokeCommand({
    FunctionName: WORKER_FN,
    InvocationType: 'Event',
    Payload: Buffer.from(JSON.stringify({ job_id, doc_id, doc })),
  }));

  return respond(200, { job_id, status: 'processing' });
};

module.exports.redactDocumentStart = validateApiKey(_redactDocumentStart);

// ─── WORKER handler (direct Lambda invoke — no HTTP, no auth wrapper) ─────────

module.exports.redactDocumentWorker = async (event) => {
  const { job_id, doc_id, doc } = event;

  try {
    await updateJob(job_id, { progress_message: 'Fetching document from S3…', updated_at: new Date().toISOString() });

    const fileKey  = doc.file_key || doc.s3_key;
    const pdfBytes = await getS3Bytes(fileKey);

    const pdfDoc     = await PDFDocument.load(pdfBytes);
    const totalPages = pdfDoc.getPageCount();
    const CHUNK_SIZE = 20;
    const allPii     = {};

    for (let start = 0; start < totalPages; start += CHUNK_SIZE) {
      const end = Math.min(start + CHUNK_SIZE, totalPages);
      await updateJob(job_id, {
        progress_message: ,
        updated_at: new Date().toISOString(),
      });

      const subDoc = await PDFDocument.create();
      const indices = Array.from({ length: end - start }, (_, i) => start + i);
      const copied  = await subDoc.copyPagesFrom(pdfDoc, indices);
      copied.forEach(p => subDoc.addPage(p));
      const subBytes = Buffer.from(await subDoc.save());

      const chunkPii = await detectPiiInPdf(subBytes);

      for (const chunkPageStr of Object.keys(chunkPii)) {
        const globalPage = start + parseInt(chunkPageStr, 10);
        const boxes = chunkPii[chunkPageStr];
        if (boxes && boxes.length) allPii[String(globalPage)] = boxes;
      }
    }

    const totalRedactions = Object.values(allPii).reduce((s, b) => s + b.length, 0);
    await updateJob(job_id, {
      progress_message: ,
      updated_at: new Date().toISOString(),
    });

    const redactedBytes = await applyRedactions(pdfBytes, allPii);

    // Build redacted S3 key
    const keyParts      = fileKey.split('/');
    const origFilename  = keyParts.pop();
    const baseName      = origFilename.replace(/\.pdf$/i, '');
    const redactedKey   = [...keyParts, ].join('/');
    const redactedName  = ;

    await updateJob(job_id, { progress_message: 'Saving redacted document…', updated_at: new Date().toISOString() });

    await s3.send(new PutObjectCommand({
      Bucket: BUCKET, Key: redactedKey,
      Body: redactedBytes, ContentType: 'application/pdf',
    }));

    const newDocId = randomUUID();
    await dynamo.send(new PutCommand({
      TableName: DOCS_TABLE,
      Item: {
        aws_document_id: newDocId,
        org_id: doc.org_id,
        patient_id: doc.patient_id,
        folder_name: doc.folder_name,
        provider_name: doc.provider_name,
        original_filename: redactedName,
        file_key: redactedKey,
        s3_key: redactedKey,
        is_redacted: true,
        redacted_from: doc_id,
        redaction_count: totalRedactions,
        redacted_pages: Object.keys(allPii).length,
        status: 'processed',
        is_clinical: doc.is_clinical,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    }));

    const downloadUrl = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: BUCKET, Key: redactedKey }),
      { expiresIn: 3600 }
    );

    await updateJob(job_id, {
      status: 'complete',
      progress_message: ,
      result: { new_doc_id: newDocId, download_url: downloadUrl, redaction_count: totalRedactions, redacted_pages: Object.keys(allPii).length },
      updated_at: new Date().toISOString(),
    });

  } catch (err) {
    console.error('Redaction worker error:', err);
    await updateJob(job_id, {
      status: 'error',
      progress_message: ,
      updated_at: new Date().toISOString(),
    });
  }
};

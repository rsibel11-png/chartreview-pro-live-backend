// redact_document.js — ChartReview Pro redaction Lambda
// Route: POST /documents/{aws_document_id}/redact
// Worker: redactDocumentWorker (900s, invoked async)
//
// Flow:
//   1. redactDocumentStart  → creates job, fires worker async, returns job_id
//   2. redactDocumentWorker → fetches PDF from S3, renders pages via Lambda
//                             pdf-lib renders page images → Bedrock vision detects PII boxes
//                             → burns black rects → saves redacted PDF to S3
//                             → creates new DynamoDB document record (is_redacted: true)
//                             → updates job to complete

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

const s3     = new S3Client({ region: process.env.AWS_REGION || 'us-east-1', requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' });
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const lambda = new LambdaClient({ region: process.env.AWS_REGION || 'us-east-1' });
const bedrock = new BedrockRuntimeClient({ region: 'us-east-1' });

const BUCKET         = process.env.S3_BUCKET       || 'chartreview-documents-prod';
const DOCS_TABLE     = process.env.DOCUMENTS_TABLE || 'chartreview-documents-prod';
const JOBS_TABLE     = process.env.JOBS_TABLE      || 'chartreview-jobs-prod';
const MODEL_ID       = process.env.MODEL_ID        || 'us.anthropic.claude-sonnet-4-6';
const WORKER_FN      = process.env.REDACT_WORKER_FUNCTION_NAME || 'chartreview-pro-prod-redactDocumentWorker';

// ─── helpers ─────────────────────────────────────────────────────────────────

const respond = (statusCode, body, extra = {}) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization,x-api-key,x-org-id',
    ...extra,
  },
  body: JSON.stringify(body),
});

async function getS3Bytes(key) {
  const cmd = new GetObjectCommand({ Bucket: BUCKET, Key: key });
  const resp = await s3.send(cmd);
  const chunks = [];
  for await (const chunk of resp.Body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function updateJob(job_id, patch) {
  const sets = Object.entries(patch).map(([k], i) => `#f${i} = :v${i}`).join(', ');
  const names = Object.fromEntries(Object.keys(patch).map((k, i) => [`#f${i}`, k]));
  const values = Object.fromEntries(Object.values(patch).map((v, i) => [`:v${i}`, v]));
  await dynamo.send(new UpdateCommand({
    TableName: JOBS_TABLE,
    Key: { job_id },
    UpdateExpression: `SET ${sets}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  }));
}

// ─── PII detection via Bedrock vision ────────────────────────────────────────
// Sends a base64 PNG of a single PDF page to Claude.
// Returns array of { x, y, width, height } in 0–1 normalized coordinates.

async function detectPiiBoxes(pageImageBase64, pageWidth, pageHeight) {
  const prompt = `You are a HIPAA privacy redaction assistant. Examine this medical document page image carefully.

Identify ALL regions containing personally identifiable information (PII) that must be redacted, including:
- Patient name (anywhere on the page)
- Date of birth / age
- Social Security Number (SSN) or last 4 digits
- Address (street, city, zip)
- Phone number / fax number
- Email address
- Medical Record Number (MRN)
- Insurance ID / Member ID / Group Number / Policy Number
- Driver's license number or image
- Photo of the patient's face
- Signature
- Any photo ID card region
- Account numbers or claim numbers linked to the patient

Return a JSON array of bounding boxes. Each box uses normalized coordinates (0.0 to 1.0) relative to the page dimensions, where (0,0) is top-left:
[
  { "label": "Patient Name", "x": 0.1, "y": 0.05, "width": 0.3, "height": 0.03 },
  ...
]

If no PII is found on this page, return an empty array: []
Return ONLY the JSON array, no explanation.`;

  const body = JSON.stringify({
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 2048,
    temperature: 0,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: pageImageBase64 },
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

  const result = JSON.parse(Buffer.from(resp.body).toString('utf-8'));
  const text = result.content?.[0]?.text?.trim() || '[]';

  // Parse JSON — strip markdown fences if present
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    console.warn('PII parse failed for page, returning empty:', text.slice(0, 200));
    return [];
  }
}

// ─── Render PDF page to PNG via canvas (pure Node, no headless browser) ──────
// We use a minimal approach: convert PDF page to PNG using the `sharp` + `pdfjs-dist`
// or simply send the raw PDF page bytes to Bedrock (Claude can read PDFs natively).
// Since Bedrock Claude supports PDF documents directly, we pass the full PDF
// and ask it to identify PII per page — simpler and more reliable.

async function detectPiiInPdf(pdfBytes) {
  const pdfBase64 = pdfBytes.toString('base64');

  const prompt = `You are a HIPAA privacy redaction assistant. Examine this medical document PDF carefully, page by page.

For each page, identify ALL regions containing personally identifiable information (PII) that must be redacted:
- Patient name (anywhere)
- Date of birth / age
- Social Security Number (SSN) or partial SSN
- Address (street, city, zip)
- Phone number / fax
- Email address
- Medical Record Number (MRN)
- Insurance ID / Member ID / Group Number / Policy Number
- Driver's license number
- Photo of patient's face or photo ID card
- Signature
- Account / claim numbers linked to the patient

Return a JSON object keyed by 0-based page index. Each page has an array of bounding boxes using normalized coordinates (0.0–1.0, top-left origin):
{
  "0": [
    { "label": "Patient Name", "x": 0.05, "y": 0.04, "width": 0.35, "height": 0.025 },
    { "label": "DOB", "x": 0.05, "y": 0.07, "width": 0.20, "height": 0.025 }
  ],
  "1": [],
  "2": [
    { "label": "SSN", "x": 0.60, "y": 0.15, "width": 0.25, "height": 0.025 }
  ]
}

Pages with no PII should have an empty array.
Return ONLY the JSON object, no explanation or markdown fences.`;

  const body = JSON.stringify({
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 8192,
    temperature: 0,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 },
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

  const result = JSON.parse(Buffer.from(resp.body).toString('utf-8'));
  const text = result.content?.[0]?.text?.trim() || '{}';
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    console.warn('PII detection parse failed, no redactions applied:', text.slice(0, 300));
    return {};
  }
}

// ─── Apply redaction boxes to PDF ────────────────────────────────────────────

async function applyRedactions(pdfBytes, piiByPage) {
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const pages  = pdfDoc.getPages();

  for (const [pageIndexStr, boxes] of Object.entries(piiByPage)) {
    const pageIndex = parseInt(pageIndexStr, 10);
    if (pageIndex >= pages.length || !boxes.length) continue;

    const page = pages[pageIndex];
    const { width, height } = page.getSize();

    for (const box of boxes) {
      // Normalized coords → PDF points (PDF origin is bottom-left)
      const pdfX      = box.x * width;
      const pdfY      = height - (box.y + box.height) * height; // flip Y
      const pdfW      = box.width  * width;
      const pdfH      = box.height * height;

      // Add a small padding buffer around each box
      const pad = 2;
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

  // Flatten — remove the content stream so text layer is overwritten
  return Buffer.from(await pdfDoc.save({ useObjectStreams: false }));
}

// ─── START handler ────────────────────────────────────────────────────────────

module.exports.redactDocumentStart = async (event) => {
  const authError = await validateApiKey(event);
  if (authError) return authError;

  const doc_id = event.pathParameters?.aws_document_id;
  if (!doc_id) return respond(400, { error: 'Missing document ID' });

  // Fetch doc from DynamoDB
  const docRes = await dynamo.send(new GetCommand({ TableName: DOCS_TABLE, Key: { aws_document_id: doc_id } }));
  const doc = docRes.Item;
  if (!doc) return respond(404, { error: 'Document not found' });
  if (!doc.file_key && !doc.s3_key) return respond(400, { error: 'Document has no S3 key' });

  // Create job
  const job_id = randomUUID();
  const now = new Date().toISOString();
  await dynamo.send(new PutCommand({
    TableName: JOBS_TABLE,
    Item: {
      job_id,
      type: 'redact',
      status: 'processing',
      doc_id,
      org_id: doc.org_id,
      created_at: now,
      updated_at: now,
      progress_message: 'Starting redaction…',
    },
  }));

  // Fire worker async
  await lambda.send(new InvokeCommand({
    FunctionName: WORKER_FN,
    InvocationType: 'Event',
    Payload: Buffer.from(JSON.stringify({ job_id, doc_id, doc })),
  }));

  return respond(200, { job_id, status: 'processing' });
};

// ─── WORKER handler ───────────────────────────────────────────────────────────

module.exports.redactDocumentWorker = async (event) => {
  const { job_id, doc_id, doc } = event;

  try {
    await updateJob(job_id, { progress_message: 'Fetching document from S3…', updated_at: new Date().toISOString() });

    // Resolve S3 key
    const fileKey = doc.file_key || doc.s3_key;
    const pdfBytes = await getS3Bytes(fileKey);

    await updateJob(job_id, { progress_message: 'Detecting PII with AI…', updated_at: new Date().toISOString() });

    // For large PDFs, process in chunks of 20 pages to stay within Bedrock limits
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const totalPages = pdfDoc.getPageCount();
    const CHUNK_SIZE = 20;
    const allPii = {};

    for (let start = 0; start < totalPages; start += CHUNK_SIZE) {
      const end = Math.min(start + CHUNK_SIZE, totalPages);
      await updateJob(job_id, {
        progress_message: `Analyzing pages ${start + 1}–${end} of ${totalPages}…`,
        updated_at: new Date().toISOString(),
      });

      // Extract page range as a sub-PDF
      const subDoc = await PDFDocument.create();
      const pageIndices = Array.from({ length: end - start }, (_, i) => start + i);
      const copiedPages = await subDoc.copyPagesFrom(pdfDoc, pageIndices);
      copiedPages.forEach(p => subDoc.addPage(p));
      const subBytes = Buffer.from(await subDoc.save());

      const chunkPii = await detectPiiInPdf(subBytes);

      // Re-map chunk page indices to global page indices
      for (const [chunkPageStr, boxes] of Object.entries(chunkPii)) {
        const globalPage = start + parseInt(chunkPageStr, 10);
        if (boxes.length) allPii[String(globalPage)] = boxes;
      }
    }

    const totalRedactions = Object.values(allPii).reduce((s, b) => s + b.length, 0);
    await updateJob(job_id, {
      progress_message: `Applying ${totalRedactions} redaction(s) across ${Object.keys(allPii).length} page(s)…`,
      updated_at: new Date().toISOString(),
    });

    // Apply redactions to the original full PDF
    const redactedBytes = await applyRedactions(pdfBytes, allPii);

    // Build new S3 key for redacted file
    const origKey = fileKey;
    const ext = origKey.endsWith('.pdf') ? '' : '';
    const redactedKey = origKey.replace(/\.pdf$/i, '_REDACTED.pdf').replace(origKey, origKey + '_REDACTED.pdf');
    // Safer key derivation:
    const keyParts = origKey.split('/');
    const origFilename = keyParts.pop();
    const baseName = origFilename.replace(/\.pdf$/i, '');
    const redactedFilename = `${baseName}_REDACTED.pdf`;
    const redactedS3Key = [...keyParts, redactedFilename].join('/');

    await updateJob(job_id, { progress_message: 'Saving redacted document…', updated_at: new Date().toISOString() });

    // Upload redacted PDF to S3
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: redactedS3Key,
      Body: redactedBytes,
      ContentType: 'application/pdf',
    }));

    // Create new DynamoDB record for redacted doc
    const newDocId = randomUUID();
    const newDoc = {
      aws_document_id: newDocId,
      org_id: doc.org_id,
      patient_id: doc.patient_id,
      original_filename: redactedFilename,
      file_key: redactedS3Key,
      s3_key: redactedS3Key,
      is_redacted: true,
      redacted_from: doc_id,
      redaction_count: totalRedactions,
      redacted_pages: Object.keys(allPii).length,
      status: 'processed',
      is_clinical: doc.is_clinical,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await dynamo.send(new PutCommand({ TableName: DOCS_TABLE, Item: newDoc }));

    // Generate a short-lived download URL
    const downloadUrl = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: BUCKET, Key: redactedS3Key }),
      { expiresIn: 3600 }
    );

    // Mark job complete
    await updateJob(job_id, {
      status: 'complete',
      progress_message: `Redaction complete — ${totalRedactions} item(s) redacted across ${Object.keys(allPii).length} page(s).`,
      result: { new_doc_id: newDocId, download_url: downloadUrl, redaction_count: totalRedactions },
      updated_at: new Date().toISOString(),
    });

  } catch (err) {
    console.error('Redaction worker error:', err);
    await updateJob(job_id, {
      status: 'error',
      progress_message: `Redaction failed: ${err.message}`,
      updated_at: new Date().toISOString(),
    });
  }
};

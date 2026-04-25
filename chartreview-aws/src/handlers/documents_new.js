const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand, DeleteCommand, QueryCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { TextractClient, StartDocumentTextDetectionCommand, GetDocumentTextDetectionCommand, DetectDocumentTextCommand } = require('@aws-sdk/client-textract');
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
const { randomUUID } = require('crypto');
const { validateApiKey } = require('./auth');

const client   = new DynamoDBClient({});
const dynamo   = DynamoDBDocumentClient.from(client);
const s3       = new S3Client({ region: process.env.AWS_REGION || 'us-east-1', requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' });
const textract = new TextractClient({ region: process.env.AWS_REGION || 'us-east-1' });
const bedrock  = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'us-east-1' });
const lambda   = new LambdaClient({ region: process.env.AWS_REGION || 'us-east-1' });
const sqs      = new SQSClient({ region: process.env.AWS_REGION || 'us-east-1' });
const PROCESSING_QUEUE_URL = process.env.PROCESSING_QUEUE_URL || null;

const TABLE                = process.env.DOCUMENTS_TABLE;
const SUMMARIES_TABLE      = process.env.SUMMARIES_TABLE;
const BUCKET               = process.env.S3_BUCKET;
const BEDROCK_MODEL        = 'us.anthropic.claude-sonnet-4-6'; // PDF vision requires Sonnet
const WORKER_FUNCTION_NAME = process.env.WORKER_FUNCTION_NAME   || 'chartreview-pro-prod-processWorker';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Version,x-api-key,X-Api-Key,x-org-id,X-Org-Id',
  'Access-Control-Allow-Methods': 'OPTIONS,GET,POST,PUT,DELETE,PATCH',
};

const response = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  body: JSON.stringify(body),
});


// --- CORS PREFLIGHT -----------------------------------------------------------
const optionsHandler = async () => ({
  statusCode: 200,
  headers: CORS_HEADERS,
  body: '',
});

// --- DIRECT UPLOAD ----------------------------------------------------------
const directUploadHandler = async (event) => {
  const orgId = event._orgId;
  if (!orgId) return response(400, { error: 'x-org-id header is required' });

  try {
    var data;
    if (event.isBase64Encoded) {
      var raw = Buffer.from(event.body, 'base64');
      try { data = JSON.parse(raw.toString('utf8')); } catch(e) { data = {}; }
    } else {
      data = JSON.parse(event.body || '{}');
    }

    var file_name    = data.file_name    || 'document.pdf';
    var content_type = data.content_type || 'application/pdf';
    var file_data    = data.file_data;

    if (!file_data) return response(400, { error: 'file_data (base64) is required' });

    var fileBuffer      = Buffer.from(file_data, 'base64');
    var aws_document_id = randomUUID();
    var key             = 'orgs/' + orgId + '/documents/' + aws_document_id + '/' + file_name;
    var now             = new Date().toISOString();

    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: fileBuffer,
      ContentType: content_type,
    }));

    console.log('Uploaded to S3:', key, 'size:', fileBuffer.length, 'org:', orgId);

    var item = {
      aws_document_id,
      org_id: orgId,
      file_name,
      file_key: key,
      content_type,
      status: 'uploaded',
      created_at: now,
      updated_at: now,
    };
    if (data.aws_patient_id) item.aws_patient_id = data.aws_patient_id;
    if (data.patient_name)   item.patient_name   = data.patient_name;
    if (data.title)          item.title          = data.title;
    if (data.category)       item.category       = data.category;
    if (data.case_number)    item.case_number    = data.case_number;
    if (data.folder)         item.folder         = data.folder;

    await dynamo.send(new PutCommand({ TableName: TABLE, Item: item }));
    return response(200, { aws_document_id, file_key: key, status: 'uploaded' });
  } catch (err) {
    console.error('directUpload error:', err);
    return response(500, { error: err.message });
  }
};

// --- GET --------------------------------------------------------------------
const getHandler = async (event) => {
  const orgId = event._orgId;
  if (!orgId) return response(400, { error: 'x-org-id header is required' });

  try {
    const { aws_document_id } = event.pathParameters;
    const result = await dynamo.send(new GetCommand({ TableName: TABLE, Key: { aws_document_id } }));
    if (!result.Item) return response(404, { error: 'Document not found' });
    if (result.Item.org_id && result.Item.org_id !== orgId) return response(403, { error: 'Access denied' });
    return response(200, result.Item);
  } catch (err) {
    return response(500, { error: err.message });
  }
};

// --- GET TEXT ONLY ----------------------------------------------------------
const getTextHandler = async (event) => {
  const orgId = event._orgId;
  if (!orgId) return response(400, { error: 'x-org-id header is required' });
  try {
    const { aws_document_id } = event.pathParameters;
    const result = await dynamo.send(new GetCommand({ TableName: TABLE, Key: { aws_document_id } }));
    if (!result.Item) return response(404, { error: 'Document not found' });
    if (result.Item.org_id && result.Item.org_id !== orgId) return response(403, { error: 'Access denied' });
    return response(200, { aws_document_id, extracted_text: result.Item.extracted_text || '' });
  } catch (err) {
    return response(500, { error: err.message });
  }
};

// --- DELETE -----------------------------------------------------------------
const removeHandler = async (event) => {
  const orgId = event._orgId;
  if (!orgId) return response(400, { error: 'x-org-id header is required' });

  try {
    const { aws_document_id } = event.pathParameters;
    const result = await dynamo.send(new GetCommand({ TableName: TABLE, Key: { aws_document_id } }));
    if (!result.Item) return response(404, { error: 'Document not found' });
    if (result.Item.org_id && result.Item.org_id !== orgId) return response(403, { error: 'Access denied' });

    if (result.Item.file_key) {
      await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: result.Item.file_key })).catch(() => {});
    }
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { aws_document_id } }));
    return response(200, { message: 'Document deleted' });
  } catch (err) {
    return response(500, { error: err.message });
  }
};

// --- DOWNLOAD URL -----------------------------------------------------------
const getDownloadUrlHandler = async (event) => {
  const orgId = event._orgId;
  if (!orgId) return response(400, { error: 'x-org-id header is required' });

  // Helper: given a fileKey, try HeadObject then prefix-list fallback, return signed URL or null
  const resolveSignedUrl = async (fileKey, docId) => {
    // 1. Try exact key
    try {
      await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: fileKey }));
      const cmd = new GetObjectCommand({ Bucket: BUCKET, Key: fileKey });
      return await getSignedUrl(s3, cmd, { expiresIn: 3600 });
    } catch (err) {
      if (err.name !== 'NotFound' && err.name !== 'NoSuchKey' && err.$metadata?.httpStatusCode !== 404) throw err;
    }
    // 2. List objects under the document's own folder
    const prefix = 'orgs/' + orgId + '/documents/' + docId + '/';
    console.log('getDownloadUrl: HeadObject miss, listing', prefix);
    const listResult = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, MaxKeys: 20 }));
    console.log('getDownloadUrl: found', (listResult.Contents || []).length, 'objects under', prefix);
    const found = (listResult.Contents || []).find(obj => obj.Key.endsWith('.pdf'));
    if (found) {
      const cmd = new GetObjectCommand({ Bucket: BUCKET, Key: found.Key });
      return await getSignedUrl(s3, cmd, { expiresIn: 3600 });
    }
    return null;
  };

  try {
    const { aws_document_id } = event.pathParameters;
    const result = await dynamo.send(new GetCommand({ TableName: TABLE, Key: { aws_document_id } }));
    if (!result.Item) return response(404, { error: 'Document not found' });
    if (result.Item.org_id && result.Item.org_id !== orgId) return response(403, { error: 'Access denied' });

    const fileKey = result.Item.file_key;

    // Case 1: record has a file_key (part or single doc)
    if (fileKey) {
      const url = await resolveSignedUrl(fileKey, aws_document_id);
      if (url) return response(200, { download_url: url });
    }

    // Case 2: shell record (no file_key) -- find first part by original_document_id
    console.log('getDownloadUrl: shell record or key miss, scanning for parts of', aws_document_id);
    const partsResult = await dynamo.send(new ScanCommand({
      TableName: TABLE,
      FilterExpression: 'original_document_id = :oid',
      ExpressionAttributeValues: { ':oid': aws_document_id },
    }));
    const parts = (partsResult.Items || []).filter(p => p.file_key);
    parts.sort((a, b) => (a.part_index || 0) - (b.part_index || 0));
    for (const part of parts) {
      const url = await resolveSignedUrl(part.file_key, part.aws_document_id);
      if (url) return response(200, { download_url: url });
    }

    return response(404, { error: 'No file found for document' });
  } catch (err) {
    console.error('getDownloadUrl error:', err);
    return response(500, { error: err.message });
  }
};

module.exports = {
  getDownloadUrl:   validateApiKey(getDownloadUrlHandler),
  update:           validateApiKey(updateHandler),
  process:          validateApiKey(processHandler),
  worker:           mainHandler,
  dlqWorker:        dlqHandler,
  listByPatient:    validateApiKey(listByPatientHandler),
  listAll:          validateApiKey(listAllHandler),
  assessRelevance:  validateApiKey(assessRelevanceHandler),
  reassessDocument: validateApiKey(reassessHandler),
  classifyStart:    validateApiKey(classifyStartHandler),
  classifyWorker:   classifyJobQueueHandler,
  classifyJobWorker: classifyJobWorkerHandler,
  getJob:           validateApiKey(getJobHandler),
  getFullText:      validateApiKey(getTextHandler),
  options:          optionsHandler,
};

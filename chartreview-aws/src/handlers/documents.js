const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, GetCommand, DeleteCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { validateApiKey } = require('./auth');

const client = new DynamoDBClient({});
const dynamo = DynamoDBDocumentClient.from(client);
const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });
const TABLE = process.env.DOCUMENTS_TABLE;
const BUCKET = process.env.S3_BUCKET;

const response = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  body: JSON.stringify(body),
});

const getUploadUrlHandler = async (event) => {
  try {
    const data = JSON.parse(event.body || '{}');
    const aws_document_id = crypto.randomUUID();
    const key = 'documents/' + aws_document_id + '/' + data.file_name;
    const command = new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: data.content_type || 'application/octet-stream' });
    const upload_url = await getSignedUrl(s3, command, { expiresIn: 300 });
    const now = new Date().toISOString();
    const item = {
      aws_document_id,
      aws_patient_id: data.aws_patient_id || null,
      patient_name: data.patient_name || null,
      file_name: data.file_name,
      file_key: key,
      content_type: data.content_type || 'application/octet-stream',
      status: 'uploaded',
      created_at: now,
      updated_at: now
    };
    await dynamo.send(new PutCommand({ TableName: TABLE, Item: item }));
    return response(200, { aws_document_id, upload_url });
  } catch (err) {
    console.error('getUploadUrl error:', err);
    return response(500, { error: err.message || 'Failed to get upload URL' });
  }
};

const getHandler = async (event) => {
  try {
    const { aws_document_id } = event.pathParameters;
    const result = await dynamo.send(new GetCommand({ TableName: TABLE, Key: { aws_document_id } }));
    if (!result.Item) return response(404, { error: 'Document not found' });
    return response(200, result.Item);
  } catch (err) {
    console.error('getDocument error:', err);
    return response(500, { error: err.message || 'Failed to get document' });
  }
};

const removeHandler = async (event) => {
  try {
    const { aws_document_id } = event.pathParameters;
    const result = await dynamo.send(new GetCommand({ TableName: TABLE, Key: { aws_document_id } }));
    if (result.Item && result.Item.file_key) {
      await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: result.Item.file_key }));
    }
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { aws_document_id } }));
    return response(200, { message: 'Document deleted' });
  } catch (err) {
    console.error('deleteDocument error:', err);
    return response(500, { error: err.message || 'Failed to delete document' });
  }
};

const getDownloadUrlHandler = async (event) => {
  try {
    const { aws_document_id } = event.pathParameters;
    const result = await dynamo.send(new GetCommand({ TableName: TABLE, Key: { aws_document_id } }));
    if (!result.Item) return response(404, { error: 'Document not found' });
    const command = new GetObjectCommand({ Bucket: BUCKET, Key: result.Item.file_key });
    const download_url = await getSignedUrl(s3, command, { expiresIn: 300 });
    return response(200, { download_url });
  } catch (err) {
    console.error('getDownloadUrl error:', err);
    return response(500, { error: err.message || 'Failed to get download URL' });
  }
};

const processHandler = async (event) => {
  try {
    const { aws_document_id } = event.pathParameters;
    return response(200, { message: 'Processing started', aws_document_id });
  } catch (err) {
    console.error('processDocument error:', err);
    return response(500, { error: err.message || 'Failed to process document' });
  }
};

const listByPatientHandler = async (event) => {
  try {
    const { aws_patient_id } = event.pathParameters;
    const result = await dynamo.send(new QueryCommand({
      TableName: TABLE,
      IndexName: 'patient-index',
      KeyConditionExpression: 'aws_patient_id = :pid',
      ExpressionAttributeValues: { ':pid': aws_patient_id }
    }));
    return response(200, result.Items || []);
  } catch (err) {
    console.error('listByPatient error:', err);
    return response(500, { error: err.message || 'Failed to list documents' });
  }
};

module.exports = {
  getUploadUrl: validateApiKey(getUploadUrlHandler),
  get: validateApiKey(getHandler),
  remove: validateApiKey(removeHandler),
  getDownloadUrl: validateApiKey(getDownloadUrlHandler),
  process: validateApiKey(processHandler),
  listByPatient: validateApiKey(listByPatientHandler),
};

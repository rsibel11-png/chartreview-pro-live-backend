const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, GetCommand, DeleteCommand, QueryCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { TextractClient, StartDocumentTextDetectionCommand, GetDocumentTextDetectionCommand } = require('@aws-sdk/client-textract');
const { v4: uuidv4 } = require('uuid');
const { validateApiKey } = require('./auth');

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });
const textract = new TextractClient({ region: process.env.AWS_REGION || 'us-east-1' });

const TABLE = process.env.DOCUMENTS_TABLE;
const BUCKET = process.env.S3_BUCKET;

const response = (statusCode, body) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  },
  body: JSON.stringify(body),
});

// POST /documents/upload-url
const getUploadUrlHandler = async (event) => {
  try {
    const data = JSON.parse(event.body || '{}');
    const aws_document_id = uuidv4();
    const s3_key = `documents/${aws_document_id}/${data.file_name}`;
    const now = new Date().toISOString();

    // Create document record in DynamoDB
    await dynamo.send(new PutCommand({
      TableName: TABLE,
      Item: {
        aws_document_id,
        aws_patient_id: data.aws_patient_id,
        s3_key,
        file_name: data.file_name,
        file_type: data.file_type,
        file_size: data.file_size,
        processing_status: 'pending',
        extracted_text: null,
        provider_name: data.provider_name || null,
        document_date: data.document_date || null,
        case_number: data.case_number || null,
        created_at: now,
        updated_at: now,
      },
    }));

    // Generate presigned upload URL (expires in 15 minutes)
    const uploadUrl = await getSignedUrl(
      s3,
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: s3_key,
        ContentType: data.file_type,
      }),
      { expiresIn: 900 }
    );

    return response(200, {
      upload_url: uploadUrl,
      aws_document_id,
      expires_in: 900,
    });
  } catch (err) {
    console.error(err);
    return response(500, { error: 'Failed to generate upload URL' });
  }
};

// GET /documents/{aws_document_id}
const getHandler = async (event) => {
  try {
    const { aws_document_id } = event.pathParameters;
    const result = await dynamo.send(new GetCommand({
      TableName: TABLE,
      Key: { aws_document_id },
    }));

    if (!result.Item) return response(404, { error: 'Document not found' });
    return response(200, result.Item);
  } catch (err) {
    console.error(err);
    return response(500, { error: 'Failed to get document' });
  }
};

// GET /documents/{aws_document_id}/download-url
const getDownloadUrlHandler = async (event) => {
  try {
    const { aws_document_id } = event.pathParameters;

    const result = await dynamo.send(new GetCommand({
      TableName: TABLE,
      Key: { aws_document_id },
    }));

    if (!result.Item) return response(404, { error: 'Document not found' });

    // Presigned download URL — expires in 15 minutes
    const downloadUrl = await getSignedUrl(
      s3,
      new GetObjectCommand({
        Bucket: BUCKET,
        Key: result.Item.s3_key,
      }),
      { expiresIn: 900 }
    );

    return response(200, { download_url: downloadUrl, expires_in: 900 });
  } catch (err) {
    console.error(err);
    return response(500, { error: 'Failed to generate download URL' });
  }
};

// DELETE /documents/{aws_document_id}
const removeHandler = async (event) => {
  try {
    const { aws_document_id } = event.pathParameters;

    const result = await dynamo.send(new GetCommand({
      TableName: TABLE,
      Key: { aws_document_id },
    }));

    if (!result.Item) return response(404, { error: 'Document not found' });

    // Delete from S3
    await s3.send(new DeleteObjectCommand({
      Bucket: BUCKET,
      Key: result.Item.s3_key,
    }));

    // Delete from DynamoDB
    await dynamo.send(new DeleteCommand({
      TableName: TABLE,
      Key: { aws_document_id },
    }));

    return response(204, {});
  } catch (err) {
    console.error(err);
    return response(500, { error: 'Failed to delete document' });
  }
};

// POST /documents/{aws_document_id}/process
const processHandler = async (event) => {
  try {
    const { aws_document_id } = event.pathParameters;

    const result = await dynamo.send(new GetCommand({
      TableName: TABLE,
      Key: { aws_document_id },
    }));

    if (!result.Item) return response(404, { error: 'Document not found' });

    // Start Textract job
    const textractResult = await textract.send(new StartDocumentTextDetectionCommand({
      DocumentLocation: {
        S3Object: {
          Bucket: BUCKET,
          Name: result.Item.s3_key,
        },
      },
    }));

    // Update status and store Textract job ID
    await dynamo.send(new UpdateCommand({
      TableName: TABLE,
      Key: { aws_document_id },
      UpdateExpression: 'SET processing_status = :s, textract_job_id = :j, updated_at = :u',
      ExpressionAttributeValues: {
        ':s': 'processing',
        ':j': textractResult.JobId,
        ':u': new Date().toISOString(),
      },
    }));

    return response(202, { message: 'Processing started', job_id: textractResult.JobId });
  } catch (err) {
    console.error(err);
    return response(500, { error: 'Failed to start processing' });
  }
};

// GET /patients/{aws_patient_id}/documents
const listByPatientHandler = async (event) => {
  try {
    const { aws_patient_id } = event.pathParameters;

    const result = await dynamo.send(new QueryCommand({
      TableName: TABLE,
      IndexName: 'patient-index',
      KeyConditionExpression: 'aws_patient_id = :p',
      ExpressionAttributeValues: { ':p': aws_patient_id },
    }));

    return response(200, result.Items || []);
  } catch (err) {
    console.error(err);
    return response(500, { error: 'Failed to list documents' });
  }
};

module.exports = {
  getUploadUrl: validateApiKey(getUploadUrlHandler),
  get: validateApiKey(getHandler),
  getDownloadUrl: validateApiKey(getDownloadUrlHandler),
  remove: validateApiKey(removeHandler),
  process: validateApiKey(processHandler),
  listByPatient: validateApiKey(listByPatientHandler),
};

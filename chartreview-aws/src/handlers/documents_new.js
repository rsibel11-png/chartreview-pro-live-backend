const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand, DeleteCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { TextractClient, DetectDocumentTextCommand } = require('@aws-sdk/client-textract');
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const { validateApiKey } = require('./auth');

const client = new DynamoDBClient({});
const dynamo = DynamoDBDocumentClient.from(client);
const s3 = new S3Client({
  region: process.env.AWS_REGION || 'us-east-1',
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});
const textract = new TextractClient({ region: process.env.AWS_REGION || 'us-east-1' });
const bedrock = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'us-east-1' });

const TABLE = process.env.DOCUMENTS_TABLE;
const SUMMARIES_TABLE = process.env.SUMMARIES_TABLE;
const BUCKET = process.env.S3_BUCKET;
const BEDROCK_MODEL = 'anthropic.claude-3-haiku-20240307-v1:0';

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
    const contentType = data.content_type || 'application/octet-stream';

    const command = new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      ContentType: contentType,
    });

    const upload_url = await getSignedUrl(s3, command, { expiresIn: 300 });

    const now = new Date().toISOString();
    const item = {
      aws_document_id,
      file_name: data.file_name,
      file_key: key,
      content_type: contentType,
      status: 'uploaded',
      created_at: now,
      updated_at: now,
    };
    if (data.aws_patient_id) item.aws_patient_id = data.aws_patient_id;
    if (data.patient_name) item.patient_name = data.patient_name;
    if (data.title) item.title = data.title;
    if (data.category) item.category = data.category;

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
  const { aws_document_id } = event.pathParameters;
  try {
    // 1. Get document record
    const docResult = await dynamo.send(new GetCommand({ TableName: TABLE, Key: { aws_document_id } }));
    if (!docResult.Item) return response(404, { error: 'Document not found' });
    const doc = docResult.Item;

    // 2. Mark as processing
    await dynamo.send(new UpdateCommand({
      TableName: TABLE,
      Key: { aws_document_id },
      UpdateExpression: 'SET #s = :s, updated_at = :u',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':s': 'processing', ':u': new Date().toISOString() }
    }));

    // 3. Extract text with Textract
    console.log('Running Textract on:', doc.file_key);
    let extractedText = '';
    try {
      const textractResult = await textract.send(new DetectDocumentTextCommand({
        Document: { S3Object: { Bucket: BUCKET, Name: doc.file_key } }
      }));
      extractedText = (textractResult.Blocks || [])
        .filter(b => b.BlockType === 'LINE')
        .map(b => b.Text)
        .join('\n');
      console.log('Extracted', extractedText.length, 'characters');
    } catch (textractErr) {
      console.error('Textract error:', textractErr.message);
      extractedText = '[Text extraction failed: ' + textractErr.message + ']';
    }

    // 4. Generate summary with Bedrock (Claude 3 Haiku)
    console.log('Calling Bedrock for summary...');
    let summaryText = '';
    try {
      const prompt = `You are a medical and legal document analyst. Review the following document text and provide a structured summary including:

1. Document Type (e.g. medical record, lab report, legal filing, etc.)
2. Key Findings or Facts
3. Dates mentioned (if any)
4. Relevant parties (names, roles)
5. Any diagnoses, treatments, or medical conditions mentioned
6. Any legal claims or issues mentioned
7. Overall summary in 2-3 sentences

Document text:
${extractedText.substring(0, 8000)}

Provide a clear, professional summary suitable for medical-legal review.`;

      const bedrockResponse = await bedrock.send(new InvokeModelCommand({
        modelId: BEDROCK_MODEL,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify({
          anthropic_version: 'bedrock-2023-05-31',
          max_tokens: 1024,
          messages: [{ role: 'user', content: prompt }]
        })
      }));

      const bedrockBody = JSON.parse(new TextDecoder().decode(bedrockResponse.body));
      summaryText = bedrockBody.content[0].text;
      console.log('Summary generated, length:', summaryText.length);
    } catch (bedrockErr) {
      console.error('Bedrock error:', bedrockErr.message);
      summaryText = '[AI summary failed: ' + bedrockErr.message + ']';
    }

    // 5. Save summary to Summaries table
    const aws_summary_id = crypto.randomUUID();
    const now = new Date().toISOString();
    await dynamo.send(new PutCommand({
      TableName: SUMMARIES_TABLE,
      Item: {
        aws_summary_id,
        aws_document_id,
        aws_patient_id: doc.aws_patient_id || null,
        patient_name: doc.patient_name || null,
        extracted_text: extractedText,
        summary: summaryText,
        document_title: doc.title || doc.file_name,
        created_at: now,
        updated_at: now,
      }
    }));

    // 6. Mark document as processed
    await dynamo.send(new UpdateCommand({
      TableName: TABLE,
      Key: { aws_document_id },
      UpdateExpression: 'SET #s = :s, aws_summary_id = :sid, updated_at = :u',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':s': 'processed', ':sid': aws_summary_id, ':u': now }
    }));

    return response(200, {
      message: 'Document processed successfully',
      aws_document_id,
      aws_summary_id,
      summary: summaryText
    });

  } catch (err) {
    console.error('processDocument error:', err);
    // Mark as failed
    try {
      await dynamo.send(new UpdateCommand({
        TableName: TABLE,
        Key: { aws_document_id },
        UpdateExpression: 'SET #s = :s, updated_at = :u',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':s': 'failed', ':u': new Date().toISOString() }
      }));
    } catch (_) {}
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

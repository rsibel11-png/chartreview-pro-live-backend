const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand, DeleteCommand, QueryCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { TextractClient, StartDocumentTextDetectionCommand, GetDocumentTextDetectionCommand, DetectDocumentTextCommand } = require('@aws-sdk/client-textract');
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
const { validateApiKey } = require('./auth');

const client   = new DynamoDBClient({});
const dynamo   = DynamoDBDocumentClient.from(client);
const s3       = new S3Client({ region: process.env.AWS_REGION || 'us-east-1', requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' });
const textract = new TextractClient({ region: process.env.AWS_REGION || 'us-east-1' });
const bedrock  = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'us-east-1' });
const lambda   = new LambdaClient({ region: process.env.AWS_REGION || 'us-east-1' });

const TABLE           = process.env.DOCUMENTS_TABLE;
const SUMMARIES_TABLE = process.env.SUMMARIES_TABLE;
const BUCKET          = process.env.S3_BUCKET;
const BEDROCK_MODEL   = 'us.anthropic.claude-3-5-sonnet-20241022-v2:0';
const WORKER_FUNCTION_NAME = process.env.WORKER_FUNCTION_NAME || 'chartreview-pro-prod-processWorker';

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
    const command = new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: contentType });
    const upload_url = await getSignedUrl(s3, command, { expiresIn: 300 });
    const now = new Date().toISOString();
    const item = { aws_document_id, file_name: data.file_name, file_key: key, content_type: contentType, status: 'uploaded', created_at: now, updated_at: now };
    if (data.aws_patient_id) item.aws_patient_id = data.aws_patient_id;
    if (data.patient_name)   item.patient_name   = data.patient_name;
    if (data.title)          item.title          = data.title;
    if (data.category)       item.category       = data.category;
    if (data.case_number)    item.case_number    = data.case_number;
    if (data.folder)         item.folder         = data.folder;
    await dynamo.send(new PutCommand({ TableName: TABLE, Item: item }));
    return response(200, { aws_document_id, upload_url });
  } catch (err) {
    console.error('getUploadUrl error:', err);
    return response(500, { error: err.message });
  }
};

const getHandler = async (event) => {
  try {
    const { aws_document_id } = event.pathParameters;
    const result = await dynamo.send(new GetCommand({ TableName: TABLE, Key: { aws_document_id } }));
    if (!result.Item) return response(404, { error: 'Document not found' });
    return response(200, result.Item);
  } catch (err) {
    return response(500, { error: err.message });
  }
};

const removeHandler = async (event) => {
  try {
    const { aws_document_id } = event.pathParameters;
    const result = await dynamo.send(new GetCommand({ TableName: TABLE, Key: { aws_document_id } }));
    if (result.Item && result.Item.file_key) {
      await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: result.Item.file_key })).catch(function() {});
    }
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { aws_document_id } }));
    return response(200, { message: 'Document deleted' });
  } catch (err) {
    return response(500, { error: err.message });
  }
};

const getDownloadUrlHandler = async (event) => {
  try {
    const { aws_document_id } = event.pathParameters;
    const result = await dynamo.send(new GetCommand({ TableName: TABLE, Key: { aws_document_id } }));
    if (!result.Item) return response(404, { error: 'Document not found' });
    const command = new GetObjectCommand({ Bucket: BUCKET, Key: result.Item.file_key });
    const download_url = await getSignedUrl(s3, command, { expiresIn: 3600 });
    return response(200, { download_url });
  } catch (err) {
    return response(500, { error: err.message });
  }
};

const updateHandler = async (event) => {
  try {
    const { aws_document_id } = event.pathParameters;
    const data = JSON.parse(event.body || '{}');
    const now = new Date().toISOString();
    const sets = ['updated_at = :u'];
    const names = {};
    const vals = { ':u': now };
    if (data.folder !== undefined)       { sets.push('folder = :f');        vals[':f']   = data.folder; }
    if (data.status !== undefined)       { sets.push('#s = :s');            names['#s']  = 'status'; vals[':s'] = data.status; }
    if (data.patient_name !== undefined) { sets.push('patient_name = :pn'); vals[':pn']  = data.patient_name; }
    if (data.category !== undefined)     { sets.push('category = :cat');    vals[':cat'] = data.category; }
    await dynamo.send(new UpdateCommand({
      TableName: TABLE,
      Key: { aws_document_id },
      UpdateExpression: 'SET ' + sets.join(', '),
      ExpressionAttributeNames: Object.keys(names).length ? names : undefined,
      ExpressionAttributeValues: vals,
    }));
    return response(200, { message: 'Document updated' });
  } catch (err) {
    return response(500, { error: err.message });
  }
};

const processHandler = async (event) => {
  var aws_document_id = event.pathParameters.aws_document_id;
  try {
    var docResult = await dynamo.send(new GetCommand({ TableName: TABLE, Key: { aws_document_id: aws_document_id } }));
    if (!docResult.Item) return response(404, { error: 'Document not found' });
    await dynamo.send(new UpdateCommand({
      TableName: TABLE,
      Key: { aws_document_id: aws_document_id },
      UpdateExpression: 'SET #s = :s, updated_at = :u',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':s': 'processing', ':u': new Date().toISOString() },
    }));
    await lambda.send(new InvokeCommand({
      FunctionName: WORKER_FUNCTION_NAME,
      InvocationType: 'Event',
      Payload: JSON.stringify({ __asyncWorker: true, aws_document_id: aws_document_id }),
    }));
    return response(200, { message: 'Processing started', aws_document_id: aws_document_id, status: 'processing' });
  } catch (err) {
    console.error('processHandler error:', err);
    return response(500, { error: err.message });
  }
};

function buildPrompt(extractedText, docPatientName, docCaseNumber) {
  var text = extractedText.substring(0, 12000);
  var intro = 'You are a medical-legal document analyst. Analyze this document text and extract ALL medical encounters, visits, examinations, or entries.';
  var fields = 'For EACH visit/encounter found, extract: visit_date (YYYY-MM-DD), rendering_provider, practice_setting, chief_complaint, hpi_summary (2-4 sentences), physical_exam_findings, imaging_findings, lab_findings, impression_diagnosis, treatment_plan, icd10_codes (array), symptom_progression (improved/same/worse/not_documented), pain_scale (number or not_documented), injury_date (YYYY-MM-DD).';
  var toplevel = 'Also extract: patient_name, case_number, provider_name, document_date (YYYY-MM-DD), page_count.';
  var instruction = 'CRITICAL: Extract EVERY visit as a separate entry. Summarize, do NOT transcribe verbatim. Keep each field concise.';
  var format = '{"patient_name":"","case_number":"","provider_name":"","document_date":"","page_count":1,"visits":[{"visit_date":"","rendering_provider":"","practice_setting":"","chief_complaint":"","hpi_summary":"","physical_exam_findings":"","imaging_findings":"","lab_findings":"","impression_diagnosis":"","treatment_plan":"","icd10_codes":[],"symptom_progression":"not_documented","pain_scale":"not_documented","injury_date":""}]}';
  return intro + '\n\n' + fields + '\n\n' + toplevel + '\n\n' + instruction + '\n\nDocument text:\n' + text + '\n\nRespond ONLY with valid JSON matching this format:\n' + format;
}

const processWorker = async (aws_document_id) => {
  console.log('processWorker started for', aws_document_id);
  try {
    var docResult = await dynamo.send(new GetCommand({ TableName: TABLE, Key: { aws_document_id: aws_document_id } }));
    if (!docResult.Item) { console.error('Document not found:', aws_document_id); return; }
    var doc = docResult.Item;

    var extractedText = '';
    try {
      var isPdf = (doc.content_type || '').toLowerCase().includes('pdf') ||
                  (doc.file_key || '').toLowerCase().endsWith('.pdf');

      if (isPdf) {
        // Async multi-page PDF extraction
        var startResult = await textract.send(new StartDocumentTextDetectionCommand({
          DocumentLocation: { S3Object: { Bucket: BUCKET, Name: doc.file_key } }
        }));
        var jobId = startResult.JobId;
        console.log('Textract async job started:', jobId);

        // Poll until complete (max 25 attempts x 3s = 75s)
        var jobStatus = 'IN_PROGRESS';
        var allBlocks = [];
        for (var attempt = 0; attempt < 25 && jobStatus === 'IN_PROGRESS'; attempt++) {
          await new Promise(function(r) { setTimeout(r, 3000); });
          var pollResult = await textract.send(new GetDocumentTextDetectionCommand({ JobId: jobId }));
          jobStatus = pollResult.JobStatus;
          if (pollResult.Blocks) allBlocks = allBlocks.concat(pollResult.Blocks);
          // Handle pagination
          var nextToken = pollResult.NextToken;
          while (nextToken) {
            var pageResult = await textract.send(new GetDocumentTextDetectionCommand({ JobId: jobId, NextToken: nextToken }));
            if (pageResult.Blocks) allBlocks = allBlocks.concat(pageResult.Blocks);
            nextToken = pageResult.NextToken;
          }
          console.log('Textract job status:', jobStatus, 'attempt:', attempt + 1);
        }

        if (jobStatus === 'SUCCEEDED') {
          extractedText = allBlocks
            .filter(function(b) { return b.BlockType === 'LINE'; })
            .map(function(b) { return b.Text; })
            .join('\n');
          console.log('Textract async extracted', extractedText.length, 'chars');
        } else {
          extractedText = '[Textract failed: job status ' + jobStatus + ']';
        }
      } else {
        // Sync extraction for images
        var textractResult = await textract.send(new DetectDocumentTextCommand({
          Document: { S3Object: { Bucket: BUCKET, Name: doc.file_key } }
        }));
        extractedText = (textractResult.Blocks || [])
          .filter(function(b) { return b.BlockType === 'LINE'; })
          .map(function(b) { return b.Text; })
          .join('\n');
        console.log('Textract sync extracted', extractedText.length, 'chars');
      }
    } catch (err) {
      console.error('Textract error:', err.message);
      extractedText = '[Textract failed: ' + err.message + ']';
    }

    var visits = [];
    var patient_name  = doc.patient_name || '';
    var case_number   = doc.case_number  || '';
    var provider_name = '';
    var document_date = '';
    var page_count    = 1;
    var summaryText   = '';

    try {
      var prompt = buildPrompt(extractedText, patient_name, case_number);

      var bedrockResponse = await bedrock.send(new InvokeModelCommand({
        modelId: BEDROCK_MODEL,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify({
          anthropic_version: 'bedrock-2023-05-31',
          max_tokens: 4096,
          messages: [{ role: 'user', content: prompt }]
        })
      }));

      var bedrockBody = JSON.parse(new TextDecoder().decode(bedrockResponse.body));
      var rawText = bedrockBody.content[0].text.trim();
      console.log('Claude response length:', rawText.length);

      var jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        var parsed = JSON.parse(jsonMatch[0]);
        visits        = parsed.visits        || [];
        patient_name  = parsed.patient_name  || patient_name;
        case_number   = parsed.case_number   || case_number;
        provider_name = parsed.provider_name || '';
        document_date = parsed.document_date || '';
        page_count    = parsed.page_count    || 1;
        summaryText   = rawText;
        console.log('Extracted', visits.length, 'visits');
      }
    } catch (err) {
      console.error('Bedrock error:', err.message);
      summaryText = '[AI failed: ' + err.message + ']';
    }

    var aws_summary_id = crypto.randomUUID();
    var now = new Date().toISOString();

    await dynamo.send(new PutCommand({
      TableName: SUMMARIES_TABLE,
      Item: {
        aws_summary_id:  aws_summary_id,
        aws_document_id: aws_document_id,
        aws_patient_id:  doc.aws_patient_id || null,
        patient_name:    patient_name || doc.patient_name || null,
        case_number:     case_number  || doc.case_number  || null,
        provider_name:   provider_name,
        document_date:   document_date,
        extracted_text:  extractedText.substring(0, 50000),
        visits:          visits,
        summary:         summaryText,
        document_title:  doc.title || doc.file_name,
        status:          'completed',
        created_at:      now,
        updated_at:      now,
      }
    }));

    await dynamo.send(new UpdateCommand({
      TableName: TABLE,
      Key: { aws_document_id: aws_document_id },
      UpdateExpression: 'SET #s = :s, aws_summary_id = :sid, patient_name = :pn, provider_name = :prov, document_date = :dd, page_count = :pc, updated_at = :u',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':s':    'processed',
        ':sid':  aws_summary_id,
        ':pn':   patient_name  || doc.patient_name || null,
        ':prov': provider_name || null,
        ':dd':   document_date || null,
        ':pc':   page_count,
        ':u':    now,
      }
    }));

    console.log('processWorker completed for', aws_document_id);
  } catch (err) {
    console.error('processWorker fatal error:', err);
    try {
      await dynamo.send(new UpdateCommand({
        TableName: TABLE,
        Key: { aws_document_id: aws_document_id },
        UpdateExpression: 'SET #s = :s, updated_at = :u',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':s': 'failed', ':u': new Date().toISOString() }
      }));
    } catch (e) {}
  }
};

const listByPatientHandler = async (event) => {
  try {
    var aws_patient_id = event.pathParameters.aws_patient_id;
    var result = await dynamo.send(new QueryCommand({
      TableName: TABLE,
      IndexName: 'patient-index',
      KeyConditionExpression: 'aws_patient_id = :pid',
      ExpressionAttributeValues: { ':pid': aws_patient_id }
    }));
    return response(200, result.Items || []);
  } catch (err) {
    return response(500, { error: err.message });
  }
};

const mainHandler = async (event) => {
  if (event.__asyncWorker) {
    await processWorker(event.aws_document_id);
    return;
  }
};

const listAllHandler = async (event) => {
  try {
    const result = await dynamo.send(new ScanCommand({ TableName: TABLE }));
    return response(200, result.Items || []);
  } catch (err) {
    return response(500, { error: err.message });
  }
};

module.exports = {
  getUploadUrl:   validateApiKey(getUploadUrlHandler),
  get:            validateApiKey(getHandler),
  remove:         validateApiKey(removeHandler),
  getDownloadUrl: validateApiKey(getDownloadUrlHandler),
  update:         validateApiKey(updateHandler),
  process:        validateApiKey(processHandler),
  worker:         mainHandler,
  listByPatient:  validateApiKey(listByPatientHandler),
  listAll:         validateApiKey(listAllHandler),
};

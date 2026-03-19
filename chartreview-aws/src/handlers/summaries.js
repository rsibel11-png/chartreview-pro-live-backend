const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand, DeleteCommand, QueryCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');
const { validateApiKey } = require('./auth');

const client = new DynamoDBClient({});
const dynamo = DynamoDBDocumentClient.from(client);
const TABLE  = process.env.SUMMARIES_TABLE;

const response = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  body: JSON.stringify(body),
});

// ─── Create ───────────────────────────────────────────────────────────────────
const createHandler = async (event) => {
  try {
    const data = JSON.parse(event.body || '{}');
    const aws_summary_id = crypto.randomUUID();
    const now = new Date().toISOString();
    const item = {
      aws_summary_id,
      created_at: now,
      updated_at: now,
      status: data.status || 'draft',
    };
    if (data.aws_patient_id)  item.aws_patient_id  = data.aws_patient_id;
    if (data.patient_name)    item.patient_name    = data.patient_name;
    if (data.case_number)     item.case_number     = data.case_number;
    if (data.visits)          item.visits          = data.visits;
    if (data.document_ids)    item.document_ids    = data.document_ids;
    if (data.notes)           item.notes           = data.notes;
    if (data.header_note)     item.header_note     = data.header_note;
    if (data.footer_note)     item.footer_note     = data.footer_note;
    if (data.ime_note)        item.ime_note        = data.ime_note;
    if (data.chart_review_note) item.chart_review_note = data.chart_review_note;
    if (data.discussion_note)   item.discussion_note   = data.discussion_note;
    if (data.physical_examination_note) item.physical_examination_note = data.physical_examination_note;

    await dynamo.send(new PutCommand({ TableName: TABLE, Item: item }));
    return response(201, { aws_summary_id, ...item });
  } catch (err) {
    console.error('createSummary error:', err);
    return response(500, { error: err.message });
  }
};

// ─── Get ──────────────────────────────────────────────────────────────────────
const getHandler = async (event) => {
  try {
    const { aws_summary_id } = event.pathParameters;
    const result = await dynamo.send(new GetCommand({ TableName: TABLE, Key: { aws_summary_id } }));
    if (!result.Item) return response(404, { error: 'Summary not found' });
    return response(200, result.Item);
  } catch (err) {
    return response(500, { error: err.message });
  }
};

// ─── Update ───────────────────────────────────────────────────────────────────
const updateHandler = async (event) => {
  try {
    const { aws_summary_id } = event.pathParameters;
    const data = JSON.parse(event.body || '{}');
    const now = new Date().toISOString();

    // Build dynamic update expression
    const sets   = ['updated_at = :u'];
    const names  = {};
    const vals   = { ':u': now };

    const fields = ['patient_name','case_number','visits','notes','status','header_note','footer_note','ime_note','chart_review_note','discussion_note','physical_examination_note','document_ids'];
    fields.forEach(f => {
      if (data[f] !== undefined) {
        sets.push(`${f} = :${f}`);
        vals[`:${f}`] = data[f];
      }
    });

    await dynamo.send(new UpdateCommand({
      TableName: TABLE,
      Key: { aws_summary_id },
      UpdateExpression: 'SET ' + sets.join(', '),
      ExpressionAttributeValues: vals,
    }));
    return response(200, { message: 'Summary updated', aws_summary_id });
  } catch (err) {
    return response(500, { error: err.message });
  }
};

// ─── Delete ───────────────────────────────────────────────────────────────────
const removeHandler = async (event) => {
  try {
    const { aws_summary_id } = event.pathParameters;
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { aws_summary_id } }));
    return response(200, { message: 'Summary deleted' });
  } catch (err) {
    return response(500, { error: err.message });
  }
};

// ─── List by patient ──────────────────────────────────────────────────────────
const listByPatientHandler = async (event) => {
  try {
    const { aws_patient_id } = event.pathParameters;

    // Try GSI first, fall back to scan
    let items = [];
    try {
      const result = await dynamo.send(new QueryCommand({
        TableName: TABLE,
        IndexName: 'patient-index',
        KeyConditionExpression: 'aws_patient_id = :pid',
        ExpressionAttributeValues: { ':pid': aws_patient_id }
      }));
      items = result.Items || [];
    } catch (gsiErr) {
      // GSI may not exist — fall back to scan
      console.warn('GSI query failed, scanning:', gsiErr.message);
      const result = await dynamo.send(new ScanCommand({
        TableName: TABLE,
        FilterExpression: 'aws_patient_id = :pid',
        ExpressionAttributeValues: { ':pid': aws_patient_id }
      }));
      items = result.Items || [];
    }

    return response(200, { summaries: items });
  } catch (err) {
    return response(500, { error: err.message });
  }
};

// ─── List all (fallback) ──────────────────────────────────────────────────────
const listAllHandler = async (event) => {
  try {
    const result = await dynamo.send(new ScanCommand({ TableName: TABLE }));
    return response(200, { summaries: result.Items || [] });
  } catch (err) {
    return response(500, { error: err.message });
  }
};

module.exports = {
  create:        validateApiKey(createHandler),
  get:           validateApiKey(getHandler),
  update:        validateApiKey(updateHandler),
  remove:        validateApiKey(removeHandler),
  listByPatient: validateApiKey(listByPatientHandler),
  listAll:       validateApiKey(listAllHandler),
};

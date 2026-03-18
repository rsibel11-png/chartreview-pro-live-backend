const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand, DeleteCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');
const { validateApiKey } = require('./auth');

const client = new DynamoDBClient({});
const dynamo = DynamoDBDocumentClient.from(client);
const TABLE = process.env.PATIENTS_TABLE;

const response = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  body: JSON.stringify(body),
});

const sanitize = (item) => {
  const out = {};
  for (const [k, v] of Object.entries(item)) {
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out;
};

const listHandler = async (event) => {
  try {
    const result = await dynamo.send(new ScanCommand({ TableName: TABLE }));
    const patients = (result.Items || [])
      .map(sanitize)
      .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    return response(200, { patients });
  } catch (err) {
    console.error('listPatients error:', err);
    return response(500, { error: err.message || 'Failed to list patients' });
  }
};

const createHandler = async (event) => {
  try {
    const data = JSON.parse(event.body || '{}');
    const aws_patient_id = crypto.randomUUID();
    const now = new Date().toISOString();
    const item = { aws_patient_id, patient_name: data.patient_name, created_at: now, updated_at: now };
    if (data.date_of_birth) item.date_of_birth = data.date_of_birth;
    if (data.case_number) item.case_number = data.case_number;
    if (data.notes) item.notes = data.notes;
    await dynamo.send(new PutCommand({ TableName: TABLE, Item: item }));
    return response(201, { aws_patient_id });
  } catch (err) {
    console.error('createPatient error:', err);
    return response(500, { error: err.message || 'Failed to create patient' });
  }
};

const getHandler = async (event) => {
  try {
    const { aws_patient_id } = event.pathParameters;
    const result = await dynamo.send(new GetCommand({ TableName: TABLE, Key: { aws_patient_id } }));
    if (!result.Item) return response(404, { error: 'Patient not found' });
    return response(200, sanitize(result.Item));
  } catch (err) {
    console.error('getPatient error:', err);
    return response(500, { error: err.message || 'Failed to get patient' });
  }
};

const updateHandler = async (event) => {
  try {
    const { aws_patient_id } = event.pathParameters;
    const data = JSON.parse(event.body || '{}');
    const now = new Date().toISOString();

    let updateExpr = 'SET patient_name = :n, updated_at = :u';
    const exprVals = { ':n': data.patient_name, ':u': now };

    if (data.date_of_birth) { updateExpr += ', date_of_birth = :d'; exprVals[':d'] = data.date_of_birth; }
    if (data.case_number)   { updateExpr += ', case_number = :c';   exprVals[':c'] = data.case_number; }
    if (data.notes)         { updateExpr += ', notes = :nt';        exprVals[':nt'] = data.notes; }

    await dynamo.send(new UpdateCommand({
      TableName: TABLE,
      Key: { aws_patient_id },
      UpdateExpression: updateExpr,
      ExpressionAttributeValues: exprVals,
    }));
    return response(200, { message: 'Patient updated' });
  } catch (err) {
    console.error('updatePatient error:', err);
    return response(500, { error: err.message || 'Failed to update patient' });
  }
};

const removeHandler = async (event) => {
  try {
    const { aws_patient_id } = event.pathParameters;
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { aws_patient_id } }));
    return response(200, { message: 'Patient deleted' });
  } catch (err) {
    console.error('deletePatient error:', err);
    return response(500, { error: err.message || 'Failed to delete patient' });
  }
};

module.exports = {
  list: validateApiKey(listHandler),
  create: validateApiKey(createHandler),
  get: validateApiKey(getHandler),
  update: validateApiKey(updateHandler),
  remove: validateApiKey(removeHandler),
};

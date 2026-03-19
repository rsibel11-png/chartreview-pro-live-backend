var lib = require('@aws-sdk/lib-dynamodb');
var DynamoDBClient = require('@aws-sdk/client-dynamodb').DynamoDBClient;
var DynamoDBDocumentClient = lib.DynamoDBDocumentClient;
var PutCommand = lib.PutCommand;
var GetCommand = lib.GetCommand;
var UpdateCommand = lib.UpdateCommand;
var DeleteCommand = lib.DeleteCommand;
var ScanCommand = lib.ScanCommand;
var validateApiKey = require('./auth').validateApiKey;
var client = new DynamoDBClient({});
var dynamo = DynamoDBDocumentClient.from(client);
var TABLE = process.env.PATIENTS_TABLE;

function resp(s, b) {
  return { statusCode: s, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(b) };
}

function san(i) {
  var o = {};
  Object.keys(i).forEach(function(k) { if (i[k] != null) o[k] = i[k]; });
  return o;
}

async function debugH(e) {
  return resp(200, { TABLE: TABLE, node: process.version });
}

async function listH(e) {
  try {
    var r = await dynamo.send(new ScanCommand({ TableName: TABLE }));
    return resp(200, { patients: (r.Items || []).map(san) });
  } catch (err) {
    return resp(500, { error: err.message });
  }
}

async function createH(e) {
  try {
    var d = JSON.parse(e.body || '{}');
    var id = require('crypto').randomUUID();
    var now = new Date().toISOString();
    var item = { aws_patient_id: id, patient_name: d.patient_name, created_at: now, updated_at: now };
    if (d.date_of_birth) item.date_of_birth = d.date_of_birth;
    if (d.case_number) item.case_number = d.case_number;
    if (d.notes) item.notes = d.notes;
    await dynamo.send(new PutCommand({ TableName: TABLE, Item: item }));
    return resp(201, { aws_patient_id: id });
  } catch (err) {
    return resp(500, { error: err.message });
  }
}

async function getH(e) {
  try {
    var id = e.pathParameters.aws_patient_id;
    var r = await dynamo.send(new GetCommand({ TableName: TABLE, Key: { aws_patient_id: id } }));
    if (!r.Item) return resp(404, { error: 'Not found' });
    return resp(200, san(r.Item));
  } catch (err) {
    return resp(500, { error: err.message });
  }
}

async function updateH(e) {
  try {
    var id = e.pathParameters.aws_patient_id;
    var d = JSON.parse(e.body || '{}');
    var now = new Date().toISOString();
    var ue = 'SET patient_name=:n,updated_at=:u';
    var ev = { ':n': d.patient_name, ':u': now };
    if (d.date_of_birth) { ue += ',date_of_birth=:d'; ev[':d'] = d.date_of_birth; }
    if (d.case_number) { ue += ',case_number=:c'; ev[':c'] = d.case_number; }
    if (d.notes) { ue += ',notes=:nt'; ev[':nt'] = d.notes; }
    await dynamo.send(new UpdateCommand({ TableName: TABLE, Key: { aws_patient_id: id }, UpdateExpression: ue, ExpressionAttributeValues: ev }));
    return resp(200, { message: 'updated' });
  } catch (err) {
    return resp(500, { error: err.message });
  }
}

async function removeH(e) {
  try {
    var id = e.pathParameters.aws_patient_id;
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { aws_patient_id: id } }));
    return resp(200, { message: 'deleted' });
  } catch (err) {
    return resp(500, { error: err.message });
  }
}

module.exports = {
  debug: debugH,
  list: validateApiKey(listH),
  create: validateApiKey(createH),
  get: validateApiKey(getH),
  update: validateApiKey(updateH),
  remove: validateApiKey(removeH)
};

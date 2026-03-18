const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');
const { validateApiKey } = require('./auth');

const client = new DynamoDBClient({});
const dynamo = DynamoDBDocumentClient.from(client);
const TABLE = process.env.PATIENTS_TABLE;

const response = (statusCode, body) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  },
  body: JSON.stringify(body),
});

// POST /patients
const createHandler = async (event) => {
  try {
    const data = JSON.parse(event.body || '{}');
    const aws_patient_id = crypto.randomUUID();
    const now = new Date().toISOString();

    const item = {
      aws_patient_id,
      patient_name: data.patient_name,
      date_of_birth: data.date_of_birth || null,
      case_number: data.case_number || null,
      notes: data.notes || null,
      created_at: now,
      updated_at: now,
    };

    await dynamo.send(new PutCommand({ TableName: TABLE, Item: item }));
    return response(201, { aws_patient_id });
  } catch (err) {
    console.error(err);
    return response(500, { error: 'Failed to create patient' });
  }
};

// GET /patients/{aws_patient_id}
const getHandler = async (event) => {
  try {
    const { aws_patient_id } = event.pathParameters;
    const result = await dynamo.send(new GetCommand({
      TableName: TABLE,
      Key: { aws_patient_id },
    }));

    if (!result.Item) return response(404, { error: 'Patient not found' });
    return response(200, result.Item);
  } catch (err) {
    console.error(err);
    return response(500, { error: 'Failed to get patient' });
  }
};

// PUT /patients/{aws_patient_id}
const updateHandler = async (event) => {
  try {
    const { aws_patient_id } = event.pathParameters;
    const data = JSON.parse(event.body || '{}');
    const now = new Date().toISOString();

    await dynamo.send(new UpdateCommand({
      TableName: TABLE,
      Key: { aws_patient_id },
      UpdateExpression: 'SET patient_name = :n, date_of_birth = :d, case_number = :c, notes = :nt, updated_at = :u',
      ExpressionAttributeValues: {
        ':n': data.patient_name,
        ':d': data.date_of_birth || null,
        ':c': data.case_number || null,
        ':nt': data.notes || null,
        ':u': now,
      },
    }));

    return response(200, { message: 'Patient updated' });
  } catch (err) {
    console.error(err);
    return response(500, { error: 'Failed to update patient' });
  }
};

// DELETE /patients/{aws_patient_id}
const removeHandler = async (event) => {
  try {
    const { aws_patient_id } = event.pathParameters;
    await dynamo.send(new DeleteCommand({
      TableName: TABLE,
      Key: { aws_patient_id },
    }));
    return response(204, {});
  } catch (err) {
    console.error(err);
    return response(500, { error: 'Failed to delete patient' });
  }
};

module.exports = {
  create: validateApiKey(createHandler),
  get: validateApiKey(getHandler),
  update: validateApiKey(updateHandler),
  remove: validateApiKey(removeHandler),
};

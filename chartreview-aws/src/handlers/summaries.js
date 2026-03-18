const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');
const { validateApiKey } = require('./auth');

const client = new DynamoDBClient({});
const dynamo = DynamoDBDocumentClient.from(client);
const TABLE = process.env.SUMMARIES_TABLE;

const response = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  body: JSON.stringify(body),
});

const createHandler = async (event) => {
  try {
    const data = JSON.parse(event.body || '{}');
    const aws_summary_id = crypto.randomUUID();
    const now = new Date().toISOString();
    const item = {
      aws_summary_id,
      aws_patient_id: data.aws_patient_id || null,
      aws_document_id: data.aws_document_id || null,
      content: data.content || '',
      summary_type: data.summary_type || 'general',
      created_at: now,
      updated_at: now
    };
    await dynamo.send(new PutCommand({ TableName: TABLE, Item: item }));
    return response(201, { aws_summary_id });
  } catch (err) {
    console.error('createSummary error:', err);
    return response(500, { error: err.message || 'Failed to create summary' });
  }
};

const getHandler = async (event) => {
  try {
    const { aws_summary_id } = event.pathParameters;
    const result = await dynamo.send(new GetCommand({ TableName: TABLE, Key: { aws_summary_id } }));
    if (!result.Item) return response(404, { error: 'Summary not found' });
    return response(200, result.Item);
  } catch (err) {
    console.error('getSummary error:', err);
    return response(500, { error: err.message || 'Failed to get summary' });
  }
};

const updateHandler = async (event) => {
  try {
    const { aws_summary_id } = event.pathParameters;
    const data = JSON.parse(event.body || '{}');
    const now = new Date().toISOString();
    await dynamo.send(new UpdateCommand({
      TableName: TABLE,
      Key: { aws_summary_id },
      UpdateExpression: 'SET content = :c, summary_type = :t, updated_at = :u',
      ExpressionAttributeValues: {
        ':c': data.content || '',
        ':t': data.summary_type || 'general',
        ':u': now
      }
    }));
    return response(200, { message: 'Summary updated' });
  } catch (err) {
    console.error('updateSummary error:', err);
    return response(500, { error: err.message || 'Failed to update summary' });
  }
};

const removeHandler = async (event) => {
  try {
    const { aws_summary_id } = event.pathParameters;
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { aws_summary_id } }));
    return response(200, { message: 'Summary deleted' });
  } catch (err) {
    console.error('deleteSummary error:', err);
    return response(500, { error: err.message || 'Failed to delete summary' });
  }
};

module.exports = {
  create: validateApiKey(createHandler),
  get: validateApiKey(getHandler),
  update: validateApiKey(updateHandler),
  remove: validateApiKey(removeHandler),
};

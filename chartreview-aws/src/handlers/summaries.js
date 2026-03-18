const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');
const { validateApiKey } = require('./auth');

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.SUMMARIES_TABLE;

const response = (statusCode, body) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  },
  body: JSON.stringify(body),
});

// POST /summaries
const createHandler = async (event) => {
  try {
    const data = JSON.parse(event.body || '{}');
    const aws_summary_id = crypto.randomUUID();
    const now = new Date().toISOString();

    const item = {
      aws_summary_id,
      aws_patient_id: data.aws_patient_id,
      aws_document_ids: data.aws_document_ids || [],
      visits: data.visits || [],
      summary_content: data.summary_content || null,
      header_note: data.header_note || null,
      footer_note: data.footer_note || null,
      ime_note: data.ime_note || null,
      chart_review_note: data.chart_review_note || null,
      physical_examination_note: data.physical_examination_note || null,
      discussion_note: data.discussion_note || null,
      status: data.status || 'draft',
      created_at: now,
      updated_at: now,
    };

    await dynamo.send(new PutCommand({ TableName: TABLE, Item: item }));
    return response(201, { aws_summary_id });
  } catch (err) {
    console.error(err);
    return response(500, { error: 'Failed to create summary' });
  }
};

// GET /summaries/{aws_summary_id}
const getHandler = async (event) => {
  try {
    const { aws_summary_id } = event.pathParameters;
    const result = await dynamo.send(new GetCommand({
      TableName: TABLE,
      Key: { aws_summary_id },
    }));

    if (!result.Item) return response(404, { error: 'Summary not found' });
    return response(200, result.Item);
  } catch (err) {
    console.error(err);
    return response(500, { error: 'Failed to get summary' });
  }
};

// PUT /summaries/{aws_summary_id}
const updateHandler = async (event) => {
  try {
    const { aws_summary_id } = event.pathParameters;
    const data = JSON.parse(event.body || '{}');
    const now = new Date().toISOString();

    await dynamo.send(new UpdateCommand({
      TableName: TABLE,
      Key: { aws_summary_id },
      UpdateExpression: `SET 
        visits = :v,
        summary_content = :sc,
        header_note = :hn,
        footer_note = :fn,
        ime_note = :in,
        chart_review_note = :cr,
        physical_examination_note = :pe,
        discussion_note = :dn,
        #st = :s,
        updated_at = :u`,
      ExpressionAttributeNames: {
        '#st': 'status',
      },
      ExpressionAttributeValues: {
        ':v': data.visits || [],
        ':sc': data.summary_content || null,
        ':hn': data.header_note || null,
        ':fn': data.footer_note || null,
        ':in': data.ime_note || null,
        ':cr': data.chart_review_note || null,
        ':pe': data.physical_examination_note || null,
        ':dn': data.discussion_note || null,
        ':s': data.status || 'draft',
        ':u': now,
      },
    }));

    return response(200, { message: 'Summary updated' });
  } catch (err) {
    console.error(err);
    return response(500, { error: 'Failed to update summary' });
  }
};

// DELETE /summaries/{aws_summary_id}
const removeHandler = async (event) => {
  try {
    const { aws_summary_id } = event.pathParameters;
    await dynamo.send(new DeleteCommand({
      TableName: TABLE,
      Key: { aws_summary_id },
    }));
    return response(204, {});
  } catch (err) {
    console.error(err);
    return response(500, { error: 'Failed to delete summary' });
  }
};

module.exports = {
  create: validateApiKey(createHandler),
  get: validateApiKey(getHandler),
  update: validateApiKey(updateHandler),
  remove: validateApiKey(removeHandler),
};

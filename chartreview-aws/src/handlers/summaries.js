// Updated: 2026-09-19 -- per-user isolation: summaries now carry org_id (stamped from verified JWT on create); get/update/remove enforce ownership (403 if mismatch, unless admin); listAll/listByPatient filter to the caller's own org (admin sees all, for QC). Previously this table had zero org scoping at all -- any logged-in user could see/edit/delete any summary.
// Updated: 2026-09-21 -- Roman's own admin login was seeing every user's summaries mixed into
// his personal list by default (any test upload from any account showed up in his library).
// Admin default is now scoped to their OWN org, same as everyone else. Cross-org QC access is
// still available but must be requested explicitly via query params on listAll/listByPatient:
//   ?org_id=<id>   -- scope to one specific user's org (existing spot-check use case)
//   ?all=true      -- no org filter at all, every org (for the upcoming admin-wide summary log)
// Non-admin callers are unaffected -- they only ever see their own org, as before.
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
    const orgId = event._orgId;
    if (!orgId) return response(401, { error: 'Unauthorized' });
    const data = JSON.parse(event.body || '{}');
    const aws_summary_id = crypto.randomUUID();
    const now = new Date().toISOString();
    const item = {
      aws_summary_id: data.aws_summary_id || aws_summary_id, // honour frontend-supplied ID
      org_id: orgId,
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
    if (!event._isAdmin && result.Item.org_id && result.Item.org_id !== event._orgId) return response(403, { error: 'Forbidden' });
    return response(200, result.Item);
  } catch (err) {
    return response(500, { error: err.message });
  }
};

// ─── Update ───────────────────────────────────────────────────────────────────
// Updated: 2026-05-01 — alias DynamoDB reserved words in UpdateExpression; add document_id + summary_content fields
const updateHandler = async (event) => {
  try {
    const { aws_summary_id } = event.pathParameters;
    const existing = await dynamo.send(new GetCommand({ TableName: TABLE, Key: { aws_summary_id } }));
    if (!existing.Item) return response(404, { error: 'Summary not found' });
    if (!event._isAdmin && existing.Item.org_id && existing.Item.org_id !== event._orgId) return response(403, { error: 'Forbidden' });

    const data = JSON.parse(event.body || '{}');
    const now = new Date().toISOString();

    // DynamoDB reserved words must use ExpressionAttributeNames aliases
    const RESERVED = new Set(['status', 'name', 'date', 'comment', 'type', 'notes', 'data']);

    const sets  = ['updated_at = :u'];
    const names = {};
    const vals  = { ':u': now };

    const fields = [
      'patient_name','case_number','visits','visit_count','notes','status',
      'header_note','footer_note','ime_note','chart_review_note',
      'discussion_note','physical_examination_note',
      'document_ids','document_id','summary_content','include_document_list',
    ];

    fields.forEach(f => {
      if (data[f] !== undefined) {
        if (RESERVED.has(f)) {
          sets.push(`#${f} = :${f}`);
          names[`#${f}`] = f;
        } else {
          sets.push(`${f} = :${f}`);
        }
        vals[`:${f}`] = data[f];
      }
    });

    const params = {
      TableName: TABLE,
      Key: { aws_summary_id },
      UpdateExpression: 'SET ' + sets.join(', '),
      ExpressionAttributeValues: vals,
    };
    if (Object.keys(names).length > 0) params.ExpressionAttributeNames = names;

    await dynamo.send(new UpdateCommand(params));
    return response(200, { message: 'Summary updated', aws_summary_id });
  } catch (err) {
    console.error('updateSummary error:', err);
    return response(500, { error: err.message });
  }
};

// ─── Delete ───────────────────────────────────────────────────────────────────
const removeHandler = async (event) => {
  try {
    const { aws_summary_id } = event.pathParameters;
    const existing = await dynamo.send(new GetCommand({ TableName: TABLE, Key: { aws_summary_id } }));
    if (!existing.Item) return response(404, { error: 'Summary not found' });
    if (!event._isAdmin && existing.Item.org_id && existing.Item.org_id !== event._orgId) return response(403, { error: 'Forbidden' });

    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { aws_summary_id } }));
    return response(200, { message: 'Summary deleted' });
  } catch (err) {
    return response(500, { error: err.message });
  }
};

// ─── List by patient ──────────────────────────────────────────────────────────
const listByPatientHandler = async (event) => {
  try {
    const orgId = event._orgId;
    if (!orgId) return response(401, { error: 'Unauthorized' });
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

    // Admin default is scoped to their own org (like everyone else). ?org_id=<id> lets an
    // admin spot-check one other user's org; ?all=true removes the filter entirely.
    const qp = event.queryStringParameters || {};
    let scoped;
    if (event._isAdmin && qp.all === 'true') {
      scoped = items;
    } else if (event._isAdmin && qp.org_id) {
      scoped = items.filter(it => it.org_id === qp.org_id);
    } else {
      scoped = items.filter(it => !it.org_id || it.org_id === orgId);
    }
    return response(200, { summaries: scoped });
  } catch (err) {
    return response(500, { error: err.message });
  }
};

// ─── List all (fallback) ──────────────────────────────────────────────────────
const listAllHandler = async (event) => {
  try {
    const orgId = event._orgId;
    if (!orgId) return response(401, { error: 'Unauthorized' });
    console.log('[listAll] TABLE:', TABLE);
    // Paginate through all items -- DynamoDB scan is limited to 1MB per call
    let items = [];
    let lastKey = undefined;
    do {
      const params = { TableName: TABLE };
      if (lastKey) params.ExclusiveStartKey = lastKey;
      const result = await dynamo.send(new ScanCommand(params));
      items = items.concat(result.Items || []);
      lastKey = result.LastEvaluatedKey;
    } while (lastKey);
    console.log('[listAll] got', items.length, 'items (paginated)');
    // Admin default is scoped to their own org (like everyone else). ?org_id=<id> lets an
    // admin spot-check one other user's org; ?all=true removes the filter entirely.
    const qp = event.queryStringParameters || {};
    let scoped;
    if (event._isAdmin && qp.all === 'true') {
      scoped = items;
    } else if (event._isAdmin && qp.org_id) {
      scoped = items.filter(it => it.org_id === qp.org_id);
    } else {
      scoped = items.filter(it => !it.org_id || it.org_id === orgId);
    }
    return response(200, { summaries: scoped });
  } catch (err) {
    console.error('[listAll] ERROR:', err.message, err.stack);
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

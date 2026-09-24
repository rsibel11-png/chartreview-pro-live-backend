// Updated: 2026-09-21 -- admin "Users & Usage" report (getUsersReport, GET
// /admin/users-report): joins the Cognito signup roster (email + account-create date,
// via the new cognito-idp:ListUsers permission -- see serverless.yml) against this table's
// document/page-usage data (grouped by org_id, which equals the Cognito sub for every
// self-service signup) and against chartreview-user-credits-prod (page_credits > 0 = has
// ever purchased). No new table, no new logging -- pure read-only combination of data that
// already exists. est_revenue_at_avg_rate_usd is pages * an assumed $/page rate, an indirect
// ROI-on-ad-spend proxy Roman asked for -- not actual Stripe revenue.
// Updated: 2026-09-19 -- per-user data isolation: org_id checks now bypass for admin (event._isAdmin, set in auth.js from verified custom:role claim). listAllHandler/listByPatientHandler skip the org filter for admin (optional ?org_id= query param scopes to one user for QC review). Error messages no longer reference the removed x-org-id header. No other flow touched.
// Updated: 2026-09-21 -- Roman's admin login was seeing every user's test uploads mixed into his
// own Library by default. Admin default is now scoped to their OWN org, same as everyone else.
// ?org_id=<id> still works for spot-checking one specific user. New: ?all=true removes the org
// filter entirely (for the upcoming admin-wide log) -- previously that was the *default* for
// admin with no params at all, which is what caused the clutter. Non-admin callers unaffected.
// Updated: 2026-09-21 -- the ?all=true admin path (used by the new admin-wide document log page)
// now resolves each unique org_id to the owning user's email via Cognito AdminGetUser, so the
// page can show a real email instead of an opaque Cognito sub. Requires the CognitoAdminGetUser
// IAM policy on this Lambda's role (added directly, see chat 2026-09-21) and the new
// @aws-sdk/client-cognito-identity-provider dependency. Only runs for admin+?all=true -- the
// default (own-org) and ?org_id= paths are untouched and never call Cognito.
// Updated: 2026-09-20 -- per-document cost calculator: prices each Assess Relevance call (processWorker inline path + the manual assessRelevanceHandler) and each Classify call (runBedrockClassify/saveClassificationToDoc), persisting processing_usage/processing_cost_usd and classify_usage/classify_cost_usd onto the document record using real Bedrock token counts at Sonnet's per-token rate. Pure observability -- no other flow touched.
// Updated: 2026-09-16 — PT/OT index v2: pt_visits entries now carry a "type" field (initial evaluation | progress note | treatment note | discharge summary) so the generateSummary coordinator can protect evals and discharge summaries from consolidation. Additive — no other handler or flow touched.
// Updated: 2026-09-16 — PT/OT index: vision pre-pass (assess + classify) now extracts pt_visits (PT/OT/hand-therapy encounters with local page numbers + dates), persisted as pt_index. Used by generateSummary coordinator for PT/OT pre-consolidation (first+last per facility group). max_tokens 4096→8192 on the 3 vision calls to fit pt_visits arrays. Additive — no other handler or flow touched.
// Updated: 2026-09-15 — PATCH whitelist: added emr_flagged_pages / emr_platform / emr_assessed_at (EMR Detector result persistence). Additive only — no other handler or flow touched.
// Updated: 2026-05-16 — improved CLASSIFY_PROMPT: physician-narrative bar, hospital admin/nursing/order page exclusions
// Updated: 2026-09-23 -- ToS acceptance gate: new acceptTerms handler (POST /users/accept-terms)
// records each new user's Terms of Service acceptance (email verified via Cognito JWT, timestamp,
// ToS version string) onto their existing USER_CREDITS_TABLE record, keyed by user_email. Frontend
// (Login.tsx) calls GET /stripe/credits first on every post-verify signup so that record already
// exists with its default free-page grant before this UpdateCommand adds the tos_accepted_at /
// tos_version fields -- this ordering is required so we never race stripe.js's ensureUserRecord's
// "create with defaults only if item doesn't exist yet" check. No other flow touched.
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand, DeleteCommand, QueryCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { TextractClient, StartDocumentTextDetectionCommand, GetDocumentTextDetectionCommand, DetectDocumentTextCommand } = require('@aws-sdk/client-textract');
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
const { CognitoIdentityProviderClient, AdminGetUserCommand, ListUsersCommand } = require('@aws-sdk/client-cognito-identity-provider');
const { randomUUID } = require('crypto');
const { validateApiKey } = require('./auth');

const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID || 'us-east-1_HGvNxEFP6';
const cognito = new CognitoIdentityProviderClient({});

// Resolves a list of Cognito sub values (org_id) to their email attribute, one lookup per
// unique sub. Failures for an individual sub are swallowed (falls back to the raw org_id in
// the caller) so one bad/deleted user account can't break the whole admin list.
async function resolveOrgEmails(orgIds) {
  const unique = Array.from(new Set(orgIds.filter(Boolean)));
  const map = {};
  await Promise.all(unique.map(async (sub) => {
    try {
      const res = await cognito.send(new AdminGetUserCommand({ UserPoolId: USER_POOL_ID, Username: sub }));
      const email = (res.UserAttributes || []).find((a) => a.Name === 'email')?.Value;
      if (email) map[sub] = email;
    } catch (err) {
      console.error('[resolveOrgEmails] could not resolve', sub, '-', err.message);
    }
  }));
  return map;
}

const client   = new DynamoDBClient({});
const dynamo   = DynamoDBDocumentClient.from(client);
const s3       = new S3Client({ region: process.env.AWS_REGION || 'us-east-1', requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' });
const textract = new TextractClient({ region: process.env.AWS_REGION || 'us-east-1' });
const bedrock  = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'us-east-1' });
const lambda   = new LambdaClient({ region: process.env.AWS_REGION || 'us-east-1' });
const sqs      = new SQSClient({ region: process.env.AWS_REGION || 'us-east-1' });
const PROCESSING_QUEUE_URL = process.env.PROCESSING_QUEUE_URL || null;

const TABLE                = process.env.DOCUMENTS_TABLE;
const USER_CREDITS_TABLE   = process.env.USER_CREDITS_TABLE || 'chartreview-user-credits-prod';
const SUMMARIES_TABLE      = process.env.SUMMARIES_TABLE;
const FOLDER_PII_TABLE     = process.env.FOLDER_PII_TABLE || 'chartreview-folder-pii-prod';
const BUCKET               = process.env.S3_BUCKET;
const BEDROCK_MODEL        = 'us.anthropic.claude-sonnet-4-6'; // PDF vision requires Sonnet
const WORKER_FUNCTION_NAME = process.env.WORKER_FUNCTION_NAME   || 'chartreview-pro-prod-processWorker';

// Updated: 2026-09-20 -- per-document cost calculator. Assess Relevance and Classify are each single Bedrock calls (unlike
// generate_summary.js's multi-call coordinator), so no accumulator is needed
// here -- just price the one InvokeModel response and persist it on the doc
// record. Same Sonnet per-token rate used in generate_summary.js.
const SONNET_INPUT_PER_MTOK  = 3.00;
const SONNET_OUTPUT_PER_MTOK = 15.00;
const estimateBedrockCost = (usage) => {
  try {
    if (!usage) return 0;
    const inputTokens  = usage.input_tokens || 0;
    const outputTokens = usage.output_tokens || 0;
    const cost = (inputTokens / 1e6) * SONNET_INPUT_PER_MTOK + (outputTokens / 1e6) * SONNET_OUTPUT_PER_MTOK;
    return Math.round(cost * 10000) / 10000;
  } catch (cErr) {
    return 0;
  }
};

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Version,x-api-key,X-Api-Key,x-org-id,X-Org-Id',
  'Access-Control-Allow-Methods': 'OPTIONS,GET,POST,PUT,DELETE,PATCH',
};

const response = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  body: JSON.stringify(body),
});


// --- CORS PREFLIGHT -----------------------------------------------------------
const optionsHandler = async () => ({
  statusCode: 200,
  headers: CORS_HEADERS,
  body: '',
});

// --- DIRECT UPLOAD ----------------------------------------------------------
const directUploadHandler = async (event) => {
  const orgId = event._orgId;
  if (!orgId) return response(400, { error: 'Could not resolve organization from token' });

  try {
    var data;
    if (event.isBase64Encoded) {
      var raw = Buffer.from(event.body, 'base64');
      try { data = JSON.parse(raw.toString('utf8')); } catch(e) { data = {}; }
    } else {
      data = JSON.parse(event.body || '{}');
    }

    var file_name    = data.file_name    || 'document.pdf';
    var content_type = data.content_type || 'application/pdf';
    var file_data    = data.file_data;

    if (!file_data) return response(400, { error: 'file_data (base64) is required' });

    var fileBuffer      = Buffer.from(file_data, 'base64');
    var aws_document_id = randomUUID();
    var key             = 'orgs/' + orgId + '/documents/' + aws_document_id + '/' + file_name;
    var now             = new Date().toISOString();

    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: fileBuffer,
      ContentType: content_type,
    }));

    console.log('Uploaded to S3:', key, 'size:', fileBuffer.length, 'org:', orgId);

    var item = {
      aws_document_id,
      org_id: orgId,
      file_name,
      file_key: key,
      content_type,
      status: 'uploaded',
      created_at: now,
      updated_at: now,
    };
    if (data.aws_patient_id) item.aws_patient_id = data.aws_patient_id;
    if (data.patient_name)   item.patient_name   = data.patient_name;
    if (data.title)          item.title          = data.title;
    if (data.category)       item.category       = data.category;
    if (data.case_number)    item.case_number    = data.case_number;
    if (data.folder)         item.folder         = data.folder;

    await dynamo.send(new PutCommand({ TableName: TABLE, Item: item }));
    return response(200, { aws_document_id, file_key: key, status: 'uploaded' });
  } catch (err) {
    console.error('directUpload error:', err);
    return response(500, { error: err.message });
  }
};

// --- GET --------------------------------------------------------------------
const getHandler = async (event) => {
  const orgId = event._orgId;
  if (!orgId) return response(400, { error: 'Could not resolve organization from token' });

  try {
    const { aws_document_id } = event.pathParameters;
    const result = await dynamo.send(new GetCommand({ TableName: TABLE, Key: { aws_document_id } }));
    if (!result.Item) return response(404, { error: 'Document not found' });
    if (!event._isAdmin && (result.Item.org_id && result.Item.org_id !== orgId)) return response(403, { error: 'Access denied' });
    return response(200, result.Item);
  } catch (err) {
    return response(500, { error: err.message });
  }
};

// --- GET TEXT ONLY ----------------------------------------------------------
const getTextHandler = async (event) => {
  const orgId = event._orgId;
  if (!orgId) return response(400, { error: 'Could not resolve organization from token' });
  try {
    const { aws_document_id } = event.pathParameters;
    const result = await dynamo.send(new GetCommand({ TableName: TABLE, Key: { aws_document_id } }));
    if (!result.Item) return response(404, { error: 'Document not found' });
    if (!event._isAdmin && (result.Item.org_id && result.Item.org_id !== orgId)) return response(403, { error: 'Access denied' });
    return response(200, { aws_document_id, extracted_text: result.Item.extracted_text || '' });
  } catch (err) {
    return response(500, { error: err.message });
  }
};

// --- DELETE -----------------------------------------------------------------
const removeHandler = async (event) => {
  const orgId = event._orgId;
  if (!orgId) return response(400, { error: 'Could not resolve organization from token' });

  try {
    const { aws_document_id } = event.pathParameters;
    const result = await dynamo.send(new GetCommand({ TableName: TABLE, Key: { aws_document_id } }));
    if (!result.Item) return response(404, { error: 'Document not found' });
    if (!event._isAdmin && (result.Item.org_id && result.Item.org_id !== orgId)) return response(403, { error: 'Access denied' });

    if (result.Item.file_key) {
      await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: result.Item.file_key })).catch(() => {});
    }
    await dynamo.send(new DeleteCommand({ TableName: TABLE, Key: { aws_document_id } }));
    return response(200, { message: 'Document deleted' });
  } catch (err) {
    return response(500, { error: err.message });
  }
};

// --- DOWNLOAD URL -----------------------------------------------------------
const getDownloadUrlHandler = async (event) => {
  const orgId = event._orgId;
  if (!orgId) return response(400, { error: 'Could not resolve organization from token' });

  try {
    const { aws_document_id } = event.pathParameters;
    const result = await dynamo.send(new GetCommand({ TableName: TABLE, Key: { aws_document_id } }));
    if (!result.Item) return response(404, { error: 'Document not found' });
    if (!event._isAdmin && (result.Item.org_id && result.Item.org_id !== orgId)) return response(403, { error: 'Access denied' });

    // Allow explicit key override for CSV/log downloads (must belong to same org path)
    const overrideKey = event.queryStringParameters && event.queryStringParameters.key;
    if (overrideKey) {
      // Security: key must start with orgs/{orgId}/ to prevent access to other orgs
      if (!overrideKey.startsWith(`orgs/${orgId}/`)) return response(403, { error: 'Access denied' });
      const cmd = new GetObjectCommand({ Bucket: BUCKET, Key: overrideKey });
      const download_url = await getSignedUrl(s3, cmd, { expiresIn: 3600 });
      return response(200, { download_url });
    }

    let fileKey = result.Item.file_key;

    // If no file_key at all, try GSI to find a part
    if (!fileKey) {
      console.log('getDownloadUrl: no file_key, resolving via GSI for doc', aws_document_id);
      const partsResult = await dynamo.send(new QueryCommand({
        TableName: TABLE,
        IndexName: 'original_document_id-index',
        KeyConditionExpression: 'original_document_id = :oid',
        ExpressionAttributeValues: { ':oid': aws_document_id },
        Limit: 1,
      }));
      const firstPart = partsResult.Items && partsResult.Items[0];
      if (!firstPart || !firstPart.file_key) return response(404, { error: 'No file found for document' });
      fileKey = firstPart.file_key;
      console.log('getDownloadUrl: resolved to part file_key', fileKey);
    }
    // file_key may be a full orgs/... S3 path -- use it directly

    const command = new GetObjectCommand({ Bucket: BUCKET, Key: fileKey });
    const download_url = await getSignedUrl(s3, command, { expiresIn: 3600 });
    return response(200, { download_url });
  } catch (err) {
    return response(500, { error: err.message });
  }
};

// --- UPDATE -----------------------------------------------------------------
const updateHandler = async (event) => {
  const orgId = event._orgId;
  if (!orgId) return response(400, { error: 'Could not resolve organization from token' });

  try {
    const { aws_document_id } = event.pathParameters;

    const existing = await dynamo.send(new GetCommand({ TableName: TABLE, Key: { aws_document_id } }));
    if (!existing.Item) return response(404, { error: 'Document not found' });
    if (!event._isAdmin && (existing.Item.org_id && existing.Item.org_id !== orgId)) return response(403, { error: 'Access denied' });

    const data = JSON.parse(event.body || '{}');
    const now  = new Date().toISOString();
    const sets = ['updated_at = :u', 'org_id = :orgId'];
    const names = {};
    const vals  = { ':u': now, ':orgId': orgId };

    if (data.folder              !== undefined) { sets.push('folder = :f');              vals[':f']   = data.folder; }
    if (data.status              !== undefined) { sets.push('#s = :s');                  names['#s']  = 'status'; vals[':s'] = data.status; }
    if (data.patient_name        !== undefined) { sets.push('patient_name = :pn');       vals[':pn']  = data.patient_name; }
    if (data.category            !== undefined) { sets.push('category = :cat');          vals[':cat'] = data.category; }
    if (data.is_rejected         !== undefined) { sets.push('is_rejected = :ir');        vals[':ir']  = data.is_rejected; }
    if (data.page_classifications !== undefined) { sets.push('page_classifications = :pc'); vals[':pc'] = data.page_classifications; }
    if (data.rejected_page_count !== undefined) { sets.push('rejected_page_count = :rpc'); vals[':rpc'] = data.rejected_page_count; }
    if (data.clinical_page_count  !== undefined) { sets.push('clinical_page_count = :cpc');  vals[':cpc'] = data.clinical_page_count; }
    if (data.relevance_assessed   !== undefined) { sets.push('relevance_assessed = :ras');   vals[':ras'] = data.relevance_assessed; }
    if (data.low_relevance_pages  !== undefined) { sets.push('low_relevance_pages = :lrp');  vals[':lrp'] = data.low_relevance_pages; }
    // EMR Detector results (2026-09-15) — written by EmrDetector.tsx after a detection run.
    // emr_flagged_pages: array of LOCAL page numbers (1-based, within this part's PDF)
    // classified as EMR printout pages. Consumed by generateSummary coordinator when
    // the user runs a narrative-only summary (pageScope exclusion).
    if (data.emr_flagged_pages !== undefined) { sets.push('emr_flagged_pages = :efp'); vals[':efp'] = data.emr_flagged_pages; }
    // PT/OT index (2026-09-16) — vision pre-pass output. pt_index: array of
    // {date, facility, provider, page_numbers[]} with LOCAL 1-based page numbers.
    // Consumed by generateSummary coordinator for PT/OT pre-consolidation
    // (first + last per facility group when consolidate_pt is active).
    if (data.pt_index !== undefined) { sets.push('pt_index = :pti2'); vals[':pti2'] = data.pt_index; }
    if (data.emr_platform      !== undefined) { sets.push('emr_platform = :epl');      vals[':epl'] = data.emr_platform; }
    if (data.emr_assessed_at   !== undefined) { sets.push('emr_assessed_at = :eat');    vals[':eat'] = data.emr_assessed_at; }


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

// --- PROCESS (kick off async worker) ----------------------------------------
const processHandler = async (event) => {
  const orgId = event._orgId;
  if (!orgId) return response(400, { error: 'Could not resolve organization from token' });

  const aws_document_id = event.pathParameters.aws_document_id;
  try {
    const docResult = await dynamo.send(new GetCommand({ TableName: TABLE, Key: { aws_document_id } }));
    if (!docResult.Item) return response(404, { error: 'Document not found' });
    if (!event._isAdmin && (docResult.Item.org_id && docResult.Item.org_id !== orgId)) return response(403, { error: 'Access denied' });

    await dynamo.send(new UpdateCommand({
      TableName: TABLE,
      Key: { aws_document_id },
      UpdateExpression: 'SET #s = :s, updated_at = :u',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':s': 'processing', ':u': new Date().toISOString() },
    }));

    if (PROCESSING_QUEUE_URL) {
      await sqs.send(new SendMessageCommand({
        QueueUrl: PROCESSING_QUEUE_URL,
        MessageBody: JSON.stringify({ __asyncWorker: true, aws_document_id }),
      }));
    } else {
      let invokeErr = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) await new Promise(r => setTimeout(r, attempt * 3000));
        try {
          await lambda.send(new InvokeCommand({
            FunctionName: WORKER_FUNCTION_NAME,
            InvocationType: 'Event',
            Payload: JSON.stringify({ __asyncWorker: true, aws_document_id }),
          }));
          invokeErr = null;
          break;
        } catch (e) {
          console.warn('Lambda invoke attempt', attempt + 1, 'failed:', e.message);
          invokeErr = e;
        }
      }
      if (invokeErr) {
        await dynamo.send(new UpdateCommand({
          TableName: TABLE,
          Key: { aws_document_id },
          UpdateExpression: 'SET #s = :s, updated_at = :u',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':s': 'pending_upload', ':u': new Date().toISOString() },
        })).catch(() => {});
        return response(500, { error: 'Worker invoke failed after retries: ' + invokeErr.message });
      }
    }

    return response(200, { message: 'Processing started', aws_document_id, status: 'processing' });
  } catch (err) {
    console.error('processHandler error:', err);
    return response(500, { error: err.message });
  }
};

// --- LIST BY PATIENT --------------------------------------------------------
const listByPatientHandler = async (event) => {
  const orgId = event._orgId;
  if (!orgId) return response(400, { error: 'Could not resolve organization from token' });
  // Admin (custom:role=admin) sees across all orgs for QC; optional ?org_id= query param scopes to one specific user's org for review.
  const scopeOrgId = event._isAdmin ? (event.queryStringParameters?.org_id || (event.queryStringParameters?.all === 'true' ? null : orgId)) : orgId;

  try {
    const aws_patient_id = event.pathParameters.aws_patient_id;
    const queryParams = {
      TableName: TABLE,
      IndexName: 'patient-index',
      KeyConditionExpression: 'aws_patient_id = :pid',
      ExpressionAttributeValues: { ':pid': aws_patient_id },
    };
    if (scopeOrgId) {
      queryParams.FilterExpression = 'org_id = :orgId';
      queryParams.ExpressionAttributeValues[':orgId'] = scopeOrgId;
    }
    const result = await dynamo.send(new QueryCommand(queryParams));
    return response(200, result.Items || []);
  } catch (err) {
    return response(500, { error: err.message });
  }
};

// --- LIST ALL (scoped to org) ------------------------------------------------
const listAllHandler = async (event) => {
  const orgId = event._orgId;
  if (!orgId) return response(400, { error: 'Could not resolve organization from token' });
  // Admin (custom:role=admin) sees across all orgs for QC; optional ?org_id= query param scopes to one specific user's org for review.
  const scopeOrgId = event._isAdmin ? (event.queryStringParameters?.org_id || (event.queryStringParameters?.all === 'true' ? null : orgId)) : orgId;

  try {
    let items = [];
    let lastKey = undefined;
    do {
      const scanParams = {
        TableName: TABLE,
        ExclusiveStartKey: lastKey,
      };
      if (scopeOrgId) {
        scanParams.FilterExpression = 'org_id = :orgId';
        scanParams.ExpressionAttributeValues = { ':orgId': scopeOrgId };
      }
      const result = await dynamo.send(new ScanCommand(scanParams));
      items = items.concat(result.Items || []);
      lastKey = result.LastEvaluatedKey;
    } while (lastKey);

    let docs = items
      .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
      .map(d => { const { extracted_text, ...rest } = d; return rest; });
    if (event._isAdmin && event.queryStringParameters?.all === 'true') {
      const emailMap = await resolveOrgEmails(docs.map((d) => d.org_id));
      docs = docs.map((d) => ({ ...d, user_email: emailMap[d.org_id] || d.org_id || 'unknown' }));
    }
    return response(200, docs);
  } catch (err) {
    return response(500, { error: err.message });
  }
};

// --- ADMIN USERS REPORT -------------------------------------------------------
// Added 2026-09-21 -- feeds the admin "Users & Usage" export (AdminSummaryLog.tsx). Three
// read-only sources, no new table/logging:
//   1. Cognito ListUsers -- authoritative signup date + email per account (sub == org_id
//      for every self-service signup, since orgs are auto-provisioned from the sub claim).
//   2. This table, scanned + grouped by org_id -- total pages run + first/last activity date
//      + distinct active days, used as an indirect usage/retention signal.
//   3. chartreview-user-credits-prod, scanned by email -- page_credits > 0 means at least one
//      real purchase (that field is only ever incremented by the Stripe webhook on
//      checkout.session.completed, see stripe.js).
// est_revenue_at_avg_rate_usd = total_pages_run * AVG_PRICE_PER_PAGE -- a rough indirect
// ROI-on-ad-spend proxy, NOT actual billed revenue from Stripe. Deliberately does not surface
// any real dollar amount -- Roman asked to avoid that level of financial specificity.
const AVG_PRICE_PER_PAGE = 0.10; // base bundle tier; adjust here if the assumption changes

async function scanAllPages(tableName, projectionExpression) {
  let items = [];
  let lastKey;
  do {
    const params = { TableName: tableName, ExclusiveStartKey: lastKey };
    if (projectionExpression) params.ProjectionExpression = projectionExpression;
    const result = await dynamo.send(new ScanCommand(params));
    items = items.concat(result.Items || []);
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

const getUsersReportHandler = async (event) => {
  if (!event._isAdmin) return response(403, { error: 'Admin access only' });

  try {
    // 1. Cognito signups (paginated)
    let cogUsers = [];
    let paginationToken;
    do {
      const res = await cognito.send(new ListUsersCommand({
        UserPoolId: USER_POOL_ID,
        PaginationToken: paginationToken,
      }));
      cogUsers = cogUsers.concat(res.Users || []);
      paginationToken = res.PaginationToken;
    } while (paginationToken);

    const users = cogUsers.map((u) => ({
      sub: u.Username,
      email: (u.Attributes || []).find((a) => a.Name === 'email')?.Value || '',
      signup_date: u.UserCreateDate ? new Date(u.UserCreateDate).toISOString() : '',
    }));

    // 2. Document usage grouped by org_id (== sub)
    const docItems = await scanAllPages(TABLE, 'org_id, page_count, created_at');
    const usageByOrg = {};
    for (const d of docItems) {
      if (!d.org_id) continue;
      if (!usageByOrg[d.org_id]) usageByOrg[d.org_id] = { totalPages: 0, dates: [] };
      usageByOrg[d.org_id].totalPages += Number(d.page_count) || 0;
      if (d.created_at) usageByOrg[d.org_id].dates.push(d.created_at);
    }

    // 3. Purchase status, keyed by email
    const creditItems = await scanAllPages(USER_CREDITS_TABLE);
    const creditsByEmail = {};
    for (const c of creditItems) creditsByEmail[c.user_email] = c;

    const rows = users.map((u) => {
      const usage = usageByOrg[u.sub] || { totalPages: 0, dates: [] };
      const dates = usage.dates.slice().sort();
      const credit = creditsByEmail[u.email] || {};
      return {
        email: u.email,
        signup_date: u.signup_date,
        total_pages_run: usage.totalPages,
        first_activity: dates[0] || '',
        last_activity: dates[dates.length - 1] || '',
        distinct_active_days: new Set(dates.map((d) => d.slice(0, 10))).size,
        page_credits_purchased: credit.page_credits || 0,
        became_paying_customer: (credit.page_credits || 0) > 0,
        est_revenue_at_avg_rate_usd: Number((usage.totalPages * AVG_PRICE_PER_PAGE).toFixed(2)),
      };
    });

    return response(200, { users: rows, avg_price_per_page_assumption: AVG_PRICE_PER_PAGE });
  } catch (err) {
    return response(500, { error: err.message });
  }
};

// --- BUILD PROMPT -----------------------------------------------------------
// v26: build extracted text with page boundary markers so VI pre-pass
// can identify which pages each encounter lives on without Bedrock vision.
function buildPagedText(blocks) {
  const lines = (blocks || [])
    .filter(function(b) { return b.BlockType === 'LINE'; })
    .sort(function(a, b) { return (a.Page || 1) - (b.Page || 1); });
  var out = '';
  var currentPage = 0;
  for (var i = 0; i < lines.length; i++) {
    var block = lines[i];
    var p = block.Page || 1;
    if (p !== currentPage) {
      out += '\n--- PAGE ' + p + ' ---\n';
      currentPage = p;
    }
    out += (block.Text || '') + '\n';
  }
  return out.trim();
}

function buildPrompt(extractedText, docPatientName, docCaseNumber, chunkTag) {
  var text      = extractedText;
  var chunkNote = chunkTag ? ' This is ' + chunkTag + ' of a larger document - extract ALL visits present in this section.' : '';
  var intro       = 'You are a medical-legal document analyst. Analyze this document text and extract ALL medical encounters, visits, examinations, or entries.' + chunkNote;
  var fields      = 'For EACH visit/encounter found, extract: visit_date (YYYY-MM-DD), rendering_provider, practice_setting, chief_complaint, hpi_summary (2-4 sentences), physical_exam_findings, imaging_findings, lab_findings, impression_diagnosis, treatment_plan, icd10_codes (array), symptom_progression (improved/same/worse/not_documented), pain_scale (number or not_documented), injury_date (YYYY-MM-DD).';
  var toplevel    = 'Also extract: patient_name, case_number, provider_name, document_date (YYYY-MM-DD), page_count.';
  var instruction = 'CRITICAL RULES: (1) Extract EVERY clinical visit/encounter as a separate entry - do not merge, skip, or omit any. There is no limit on the number of visits. If there are 40 visits, return 40 entries. (2) Summarize, do NOT transcribe verbatim. Keep each field concise. (3) NEVER infer, guess, or hallucinate provider names or facility names - use ONLY names explicitly stated in the document for that specific visit. (4) Do NOT assign a provider to a facility they are not explicitly linked to in the document text for that visit. (5) Emergency Department visits must list the ED facility name and the actual ED provider documented in that visit - not the referring or follow-up physician. (6) If a facility name cannot be determined, use empty string - do not use the appointment type as a location name. (7) If a field is not documented, use empty string or not_documented. (8) For documents with many similar consecutive entries (e.g. PT/OT daily notes), extract each date as its own separate visit entry even if content is repetitive - never merge multiple dates into one entry. (9) IMPORTANT: Visits in the document may NOT be in chronological order. Do not assume date order - extract every visit exactly as it appears regardless of date sequence. (10) Once all visits are extracted, sort the final visits array by visit_date in ascending chronological order (oldest first) before returning the JSON. (11) VISIT DATE RULES: The visit_date must be the actual date of service - the date the patient was seen or treated. Use the SERVICE DATE field if present. Do NOT use print dates, report dates, sign dates, or document generation dates. Use SERVICE DT or REP SRV DT fields when present — these are always the encounter date. Completely ignore any TIME or military time value (e.g. TIME: 1825, REP SRV TM: 1825) when determining the date — medical document dates are always local calendar dates, never UTC-converted. If a document header shows SERVICE DT: 10/01/25 TIME: 1825, the visit_date is 2025-10-01, period. (12) EXCLUDE the following document types entirely - do not create visit entries for them: anesthesia records, perioperative nursing notes, PACU (post-anesthesia care unit) notes, pre-op nursing assessments, workers compensation administrative forms (C-4, C-4AMR, etc.), radiology technician worksheets, and any purely administrative or billing documents. These are supporting paperwork for a primary clinical encounter, not separate visits. (13) FACILITY NAME RULES: Use the full official facility name as it appears in the document header or letterhead (e.g. Centennial Hills Hospital Medical Center, not just CHH or Emergency Department). Do not use document type names (e.g. ED Physician Record, Operative Record) as the facility name.';
  var format      = '{"patient_name":"","case_number":"","provider_name":"","document_date":"","page_count":1,"visits":[{"visit_date":"","rendering_provider":"","practice_setting":"","chief_complaint":"","hpi_summary":"","physical_exam_findings":"","imaging_findings":"","lab_findings":"","impression_diagnosis":"","treatment_plan":"","icd10_codes":[],"symptom_progression":"not_documented","pain_scale":"not_documented","injury_date":""}]}';
  return intro + '\n\n' + fields + '\n\n' + toplevel + '\n\n' + instruction + '\n\nDocument text:\n' + text + '\n\nRespond ONLY with valid JSON matching this format:\n' + format;
}

// --- PROCESS WORKER (async, no HTTP) ----------------------------------------

// ── Facesheet detection & folder-level PII storage ───────────────────────────
// Anchors: these headers appear on hospital admission / ER registration pages
const ADMISSION_ANCHORS = [
  'IN/OUT/ER PATIENT ADMISSION RECORD',
  'ADMISSION RECORD',
  'PATIENT REGISTRATION',
  'REGISTRATION FORM',
  'FACE SHEET',
  'FACESHEET',
  'ER REGISTRATION',
  'EMERGENCY REGISTRATION',
];

// How many labeled PII fields must co-occur within the window to confirm it's a facesheet
const FACESHEET_FIELD_THRESHOLD = 3;
const FACESHEET_FIELD_SIGNALS   = ['NAME:', 'DOB:', 'D.O.B', 'STREET:', 'ADDRESS:', 'PHONE', 'SS#:', 'SSN:', 'DATE OF BIRTH'];

function findFacesheetWindow(text) {
  // Find the earliest admission anchor in the text
  const upper = text.toUpperCase();
  let anchorIdx = -1;
  for (const anchor of ADMISSION_ANCHORS) {
    const idx = upper.indexOf(anchor);
    if (idx >= 0 && (anchorIdx === -1 || idx < anchorIdx)) anchorIdx = idx;
  }
  if (anchorIdx === -1) return null;

  // Grab 2000 chars starting from the anchor (covers the full demographics block)
  const window = text.slice(anchorIdx, anchorIdx + 2000);

  // Confirm enough PII signals are present
  const hits = FACESHEET_FIELD_SIGNALS.filter(sig => window.toUpperCase().includes(sig));
  if (hits.length < FACESHEET_FIELD_THRESHOLD) return null;

  return window;
}

function parsePiiFromWindow(window) {
  const find = (patterns) => {
    for (const p of patterns) {
      const m = p.exec(window);
      if (m && m[1]) return m[1].trim();
    }
    return '';
  };
  const name = find([
    /^NAME:\s*([A-Z][A-Z,'.\- ]{2,40})/m,
    /PATIENT\s*NAME[:\s]+([A-Z][A-Z,'.\- ]{2,40})/i,
    /^Patient[:\s]+([A-Za-z][A-Za-z,'.\- ]{2,40})/m,
  ]);
  const dob = find([
    /DOB[:\s]+([\d]{1,2}\/[\d]{1,2}\/[\d]{2,4})/i,
    /D\.O\.B[.:\s]+([\d]{1,2}\/[\d]{1,2}\/[\d]{2,4})/i,
    /DATE\s+OF\s+BIRTH[:\s]+([\d]{1,2}\/[\d]{1,2}\/[\d]{2,4})/i,
  ]);
  const ssn = find([
    /SS#[:\s]+([Xx0-9-]{7,11})/,
    /SSN[:#\s]+([Xx0-9-]{7,11})/i,
    /(\d{3}-\d{2}-\d{4})/,
  ]);
  const phone = find([
    /PHONE#?[:\s]+([\(\d][\d().\- ]{8,})/i,
    /TELEPHONE[:\s]+([\(\d][\d().\- ]{8,})/i,
  ]);
  const mrn = find([
    /UNIT\s*RCRD\s*#[:\s]+([A-Z0-9]{5,})/i,
    /MRN[:\s]+([A-Z0-9]{5,})/i,
    /ACCOUNT#?\s*([A-Z0-9]{6,})/i,
  ]);
  const streetM = window.match(/STREET[:\s]+([\w][^\n]{5,50})/i)
    || window.match(/ADDRESS[:\s]+([\w][^\n]{5,50})/i)
    || window.match(/(\d{2,5}\s+[A-Z][A-Z .]+(?:AVE|ST|BLVD|DR|RD|LN|WAY|CT|TRAIL|PKWY|CIR|PL|LOOP|RANCH)[A-Z .]*)/i);
  const street = streetM ? streetM[1].trim().replace(/\s+/g, ' ') : '';
  const cszM = window.match(/C\/S\/Z[P]?[:\s]+([A-Z][A-Z ]+),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)/i)
    || window.match(/([A-Z][A-Z ]+),\s*(NV|CA|TX|AZ|FL|NY|IL|WA|CO|GA|NM|UT|ID|OR|MN)\s+(\d{5}(?:-\d{4})?)/);
  const city     = cszM ? cszM[1].trim() : '';
  const stateZip = cszM ? (cszM[2] + ' ' + cszM[3]) : '';
  const spouseM  = window.match(/SPOUSE\s*(?:\/\s*NOK)?[\s\S]{0,15}\n([A-Z][A-Z, ]{3,40})\n/i);
  const spouseRaw = spouseM ? spouseM[1].trim() : '';
  // Reject if it looks like a label phrase (all caps words with no comma, or known non-names)
  const spouse   = (spouseRaw && !(/^(PERSON TO NOTIFY|NEXT OF KIN|NOK|N\/A|NONE|EMERGENCY CONTACT|RELATIONSHIP|NAME)$/i.test(spouseRaw))) ? spouseRaw : '';
  const empM     = window.match(/(?:PATIENT\s+)?EMPLOYER[:\n\s]+([A-Z][A-Z &,.]{3,50})/i);
  const employer = (empM && !/UNEMPLOYED|NONE|N\/A|GUARANTOR|SELF|RETIRED|DISABLED|STUDENT/i.test(empM[1])) ? empM[1].trim() : '';
  // Extract middle name if present in "LAST, FIRST MIDDLE" or "First Middle Last" format
  let middleName = '';
  if (name) {
    // "MOORE, KIMBERLY MARIA" → middle = "MARIA"
    const mLastFirstMid = name.match(/^[A-Z][A-Z'\-\.]+,\s+[A-Z][A-Z'\-\.]+\s+([A-Z][A-Z'\-\.]+)$/i);
    if (mLastFirstMid) middleName = mLastFirstMid[1].trim();
    // "Kimberly Maria Moore" → middle = "Maria" (3 words, middle is word 2)
    const mFirstMidLast = name.match(/^([A-Z][A-Z'\-\.]+)\s+([A-Z][A-Z'\-\.]+)\s+([A-Z][A-Z'\-\.]+)$/i);
    if (mFirstMidLast && !middleName) middleName = mFirstMidLast[2].trim();
  }
  return { patientName: name, middleName, dob, ssn, phone, mrn, street, city, stateZip, spouse, employer };
}

async function detectAndStoreFacesheetPii(extractedText, orgId, folder) {
  if (!folder || !orgId) return; // unfiled docs — no folder to associate with
  try {
    const window = findFacesheetWindow(extractedText || '');
    if (!window) return; // not a facesheet

    const pii = parsePiiFromWindow(window);
    const hasData = Object.values(pii).some(v => v && v.length > 0);
    if (!hasData) return;

    const orgFolder = orgId + '#' + folder.trim();
    const now = new Date().toISOString();

    // Upsert — only overwrite fields that are currently empty
    // Build SET expression dynamically so a richer record from a later part doesn't lose data
    const existing = await dynamo.send(new GetCommand({
      TableName: FOLDER_PII_TABLE,
      Key: { org_folder: orgFolder },
    })).catch(() => ({ Item: null }));

    const base = (existing && existing.Item) ? existing.Item : {};
    const merged = {
      org_folder:   orgFolder,
      org_id:       orgId,
      folder:       folder.trim(),
      updated_at:   now,
      patientName:  pii.patientName  || base.patientName  || '',
      middleName:   pii.middleName   || base.middleName   || '',
      dob:          pii.dob          || base.dob          || '',
      ssn:          pii.ssn          || base.ssn          || '',
      phone:        pii.phone        || base.phone        || '',
      mrn:          pii.mrn          || base.mrn          || '',
      street:       pii.street       || base.street       || '',
      city:         pii.city         || base.city         || '',
      stateZip:     pii.stateZip     || base.stateZip     || '',
      spouse:       pii.spouse       || base.spouse       || '',
      employer:     pii.employer     || base.employer     || '',
    };

    await dynamo.send(new PutCommand({ TableName: FOLDER_PII_TABLE, Item: merged }));
    console.log('detectFacesheet: stored PII for folder', folder, '| name:', merged.patientName, 'dob:', merged.dob);
  } catch (err) {
    console.warn('detectFacesheet: non-fatal error:', err.message);
  }
}

// v28: Textract update no longer overwrites is_rejected/rejection_reason/document_type -- assess pass owns these
// v27: swapped EOL'd claude-3-5-sonnet-v2 -> claude-3-5-haiku-v1 (still active, faster, cheaper)
// v26: improved prompt -- surveillance/photo-only doc rejection added
// v25: added pageOffset param -- offsets low_relevance_pages page numbers
// so Part 2 pages are numbered relative to the full document (e.g. 101-149 not 1-49)
const processWorker = async (aws_document_id, assessOnly = false, pageOffset = 0) => {
  console.log('processWorker started for', aws_document_id, assessOnly ? '(assess-only mode)' : '', pageOffset > 0 ? '(pageOffset=' + pageOffset + ')' : '');
  try {
    var docResult = await dynamo.send(new GetCommand({ TableName: TABLE, Key: { aws_document_id } }));
    if (!docResult.Item) { console.error('Document not found:', aws_document_id); return; }
    var doc   = docResult.Item;
    var orgId = doc.org_id || null;

    // --- Assess relevance FIRST (Claude Vision -- independent of Textract) ---
    try {
      console.log('assessRelevance: starting for', aws_document_id);

      // Text-density check -- if Textract extracted almost no text, this is a photo/image-only PDF.
      // Use chars-per-page as the signal, NOT file size (large files can still be dense clinical records).
      // Threshold: <30 chars/page on average = sparse/photo document.
      const SPARSE_CHARS_PER_PAGE = 30;
      const extractedTextLen = (doc.extracted_text || '').length;
      const docPageCount = doc.page_count || 1;
      const charsPerPage = extractedTextLen / docPageCount;
      // v29: skip sparse check on fresh uploads -- Textract hasn't run yet so extracted_text is empty.
      // Only auto-reject as sparse/image-only if we are in assess-only mode (Textract already ran).
      const shouldCheckSparse = assessOnly || extractedTextLen > 0;
      if (shouldCheckSparse && charsPerPage < SPARSE_CHARS_PER_PAGE && extractedTextLen < 500) {
        console.log('assessRelevance: sparse text (' + charsPerPage.toFixed(1) + ' chars/page, ' + extractedTextLen + ' total) -- auto-marking all pages non-clinical without Bedrock');
        const autoLowPages = Array.from({ length: docPageCount }, (_, i) => ({
          page_number: i + 1 + pageOffset,
          reason: 'photo/image-only page (no extractable text)',
        }));
        await dynamo.send(new UpdateCommand({
          TableName: TABLE,
          Key: { aws_document_id },
          UpdateExpression: `SET #cat = :cat, subcategory = :sub, is_rejected = :rejected,
            rejection_reason = :reason, low_relevance_pages = :lrp, relevance_assessed = :ra, updated_at = :now`,
          ExpressionAttributeNames: { '#cat': 'category' },
          ExpressionAttributeValues: {
            ':cat':      'non_clinical',
            ':sub':      'photo_image_only',
            ':rejected': true,
            ':reason':   'No extractable text (' + charsPerPage.toFixed(1) + ' chars/page) -- likely photo or image-only document',
            ':lrp':      autoLowPages,
            ':ra':       true,
            ':now':      new Date().toISOString(),
          },
        }));
        console.log('assessRelevance: auto-rejected sparse doc', aws_document_id, docPageCount, 'pages marked non-clinical');
        return; // skip Bedrock -- no text to analyze anyway
      }

      // Fetch PDF from S3 and encode as base64 for Bedrock
      const assessS3Object = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: doc.file_key }));
      const assessPdfChunks = [];
      for await (const chunk of assessS3Object.Body) { assessPdfChunks.push(chunk); }
      const assessPdfBuffer = Buffer.concat(assessPdfChunks);
      const assessPdfBase64 = assessPdfBuffer.toString('base64');

      // Bedrock rejects payloads where the base64-encoded PDF exceeds ~10MB.
      // If we hit this, the document passed the text-density check (has real content)
      // but the file is too large to send. Fall through to Bedrock and let it fail
      // naturally -- the outer catch will log it. Do NOT auto-reject clinical-density docs.
      const MAX_BEDROCK_BASE64 = 10 * 1024 * 1024; // 10MB base64
      const assessTooBig = assessPdfBase64.length > MAX_BEDROCK_BASE64;
      if (assessTooBig) {
        console.warn('assessRelevance: base64 payload ' + (assessPdfBase64.length/1024/1024).toFixed(1) + 'MB exceeds Bedrock limit for', aws_document_id, '-- skipping vision assess, Textract will still run');
      }

      const assessPrompt = `Analyze this document VERY CAREFULLY and extract the following information:

PART 1 - DOCUMENT CLASSIFICATION:
1. Document category: Is this a medical or legal document?
2. If medical, what type: doctor_office_notes, independent_medical_examination, hospital_records, radiology_reports, medical_expert_testimony, lab_results, or other?
3. If legal, what type: deposition, legal_correspondence, court_filing, or other?

PART 2 - OVERALL CLINICAL RELEVANCE:
4. Is the ENTIRE document clinically relevant? Mark as relevant ONLY if it contains ACTUAL CLINICAL CONTENT with medical findings, examination results, diagnoses, or treatment notes.

   ALWAYS MARK AS RELEVANT (do not reject):
   - Police accident reports, motor vehicle accident (MVA) reports, or incident reports documenting the mechanism of injury
   - Workers' compensation accident/incident reports
   - Employer incident reports or OSHA reports
   - Any document establishing the cause, date, or mechanism of the claimant's injury

   REJECT (not clinically relevant) if ANY of these apply:
   - Insurance/authorization forms, pre-authorization documents, or EOB statements
   - Fax cover sheets, emails, or transmittal documents
   - Administrative only (scheduling, billing, claims, referral requests without clinical notes)
   - Patient information forms or intake questionnaires without clinical content
   - Appointment confirmations or scheduling records
   - Billing or payment records
   - Documents containing ONLY headers/footers with no substantive clinical information
   - Generic forms or templates without patient-specific clinical data
   - Photo-only documents: surveillance photos, vehicle photos, location/scene photos, photographs of people without clinical context, or any document consisting primarily of photographs with no accompanying medical text, clinical notes, diagnoses, or treatment information
   - Documents where the majority of pages are photographs, screenshots, or images with no readable medical content
   If uncertain whether clinical content is present, lean toward REJECTION.

PART 3 - PAGE-BY-PAGE ANALYSIS (EXTREMELY IMPORTANT - ANALYZE EACH PAGE INDEPENDENTLY):
5. Scan EVERY SINGLE PAGE individually and identify which pages have LOW clinical relevance. TREAT EACH PAGE AS IF IT WERE STANDALONE.

   ALWAYS flag these pages as low relevance:
   - Blank pages or mostly blank pages (>50% whitespace)
   - Pages with only headers, footers, page numbers, or watermarks
   - Table of contents or index pages
   - Fax cover sheets or transmittal pages
   - Administrative forms (patient intake, authorization forms, insurance verification)
   - Billing/insurance pages (EOBs, claim forms, payment information)
   - Pages with only signatures or initials
   - Separator/divider pages with minimal text
   - Marketing or promotional content
   - Form pages with empty fields or placeholder text
   - Pages consisting entirely of photographs, surveillance images, or non-medical imagery with no clinical text
   - Pages that are scanned photos of people, vehicles, locations, or objects without any medical context
   NOTE: Do NOT flag pages from police reports, accident reports, or incident reports -- legally relevant to the case.
   NOTE: Do NOT flag radiology report pages, addendum pages, or continuation pages -- even if brief, they are part of an official medical report and are clinically relevant.
   NOTE: IGNORE sidebars entirely. Sidebars (columns on the left or right containing allergies, medications, surgical history, social history, family history, problem lists) are standard EHR formatting -- do NOT use sidebar content when deciding if a page is low relevance. Evaluate ONLY the main body of the page.
   NOTE: IGNORE headers and footers (clinic name, patient name, date, page number at top/bottom) -- these are standard formatting, not clinical content indicators.
   NOTE: A page is low relevance ONLY if its MAIN BODY contains no substantive clinical content (no visit note, no HPI, no findings, no assessment, no plan, no clinical narrative).

   Return an ARRAY of objects: {page_number: number, reason: "specific description"}
   Only return empty array [] if EVERY page has substantial clinical content in its main body.
   Be aggressive flagging billing, admin, photo, and blank pages -- but never flag a page based on its sidebar or header/footer alone.

PART 4 - METADATA EXTRACTION:
6. Extract patient name if this is a medical document
7. Extract document date (use the EARLIEST visit date if multiple)
8. Extract provider/entity name (use the FIRST provider if multiple)
9. Extract case number if mentioned
10. Count office visits documented in this file
11. Count the EXACT number of pages in this document

CRITICAL: Analyze each page in isolation. A page is ONLY relevant if it contains substantive clinical content ON THAT PAGE ALONE.
RECHECK YOUR ANSWER: If you flagged no pages, verify every single page contains substantive clinical content.

PART 3 - PHYSICAL THERAPY INDEX (used downstream to consolidate PT series):
List EVERY physical therapy (PT), occupational therapy (OT), or hand therapy encounter in this document — including initial evaluations, progress notes, and repetitive dated treatment notes. For EACH encounter record: the exact page numbers it appears on (1-based, counting pages within THIS file), the treatment date in YYYY-MM-DD format (empty string if not legible), the facility name, the treating therapist, and the note TYPE — one of "initial evaluation", "progress note", "treatment note", or "discharge summary". Use "initial evaluation" only for the first comprehensive evaluation of a therapy course, "discharge summary" when the note summarizes the full course of therapy and discharges the patient, "treatment note" for routine daily treatment sessions, and "progress note" for periodic re-assessments. Every dated treatment note is its own entry — NEVER merge multiple dates into one entry. If this document contains no PT/OT/hand therapy encounters, return an empty array.

PART 3 - PHYSICAL THERAPY INDEX (used downstream to consolidate PT series):
List EVERY physical therapy (PT), occupational therapy (OT), or hand therapy encounter in this document — including initial evaluations, progress notes, and repetitive dated treatment notes. For EACH encounter record: the exact page numbers it appears on (1-based, counting pages within THIS file), the treatment date in YYYY-MM-DD format (empty string if not legible), the facility name, the treating therapist, and the note TYPE — one of "initial evaluation", "progress note", "treatment note", or "discharge summary". Use "initial evaluation" only for the first comprehensive evaluation of a therapy course, "discharge summary" when the note summarizes the full course of therapy and discharges the patient, "treatment note" for routine daily treatment sessions, and "progress note" for periodic re-assessments. Every dated treatment note is its own entry — NEVER merge multiple dates into one entry. If this document contains no PT/OT/hand therapy encounters, return an empty array.

Return ONLY a JSON object with these exact fields:
{
  "category": "medical or legal or uncategorized",
  "subcategory": "string",
  "is_relevant_medical_document": true or false,
  "patient_name": "string",
  "document_date": "string",
  "provider_name": "string",
  "case_number": "string",
  "office_visit_count": 0,
  "page_count": 0,
  "rejection_reason": "string",
  "low_relevance_pages": [{"page_number": 1, "reason": "string"}],
  "pt_visits": [{"date": "YYYY-MM-DD", "facility": "string", "provider": "string", "type": "initial evaluation | progress note | treatment note | discharge summary", "page_numbers": [1]}]
}`;

      const assessBedrockPayload = {
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 8192,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: assessPdfBase64 },
            },
            { type: 'text', text: assessPrompt },
          ],
        }],
      };

      if (!assessTooBig) {
      const assessResp = await bedrock.send(new InvokeModelCommand({
        modelId: 'us.anthropic.claude-sonnet-4-6',
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify(assessBedrockPayload),
      }));

      const assessBody = JSON.parse(new TextDecoder().decode(assessResp.body));
      const assessRawText = assessBody.content?.[0]?.text || '';
      const assessUsage = assessBody.usage || null;
      const assessCostUsd = estimateBedrockCost(assessUsage);

      let assessResult = null;
      try {
        const jsonMatch = assessRawText.match(/\{[\s\S]*\}/);
        assessResult = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
      } catch (parseErr) {
        console.warn('assessRelevance: JSON parse error in processWorker:', parseErr.message);
      }

      if (assessResult) {
        // v25: apply pageOffset so Part 2+ low_relevance_pages are numbered
        // relative to the full document, not relative to this part alone.
        // Part 1 (pageOffset=0): page numbers unchanged (1, 2, 3...)
        // Part 2 (pageOffset=100): page 3 -> 103, page 5 -> 105, etc.
        if (pageOffset > 0 && Array.isArray(assessResult.low_relevance_pages) && assessResult.low_relevance_pages.length > 0) {
          assessResult.low_relevance_pages = assessResult.low_relevance_pages.map(p => ({
            ...p,
            page_number: (p.page_number || 0) + pageOffset,
          }));
          console.log('assessRelevance: applied pageOffset=' + pageOffset + ' to ' + assessResult.low_relevance_pages.length + ' low_relevance_pages');
        }

        const isRejected = assessResult.is_relevant_medical_document === false;
        await dynamo.send(new UpdateCommand({
          TableName: TABLE,
          Key: { aws_document_id },
          UpdateExpression: `SET #cat = :cat, subcategory = :sub, is_rejected = :rejected,
            rejection_reason = :reason, document_date = :ddate,
            provider_name = :provider, office_visit_count = :ovc,
            page_count = :pc, low_relevance_pages = :lrp, relevance_assessed = :ra,
            pt_index = :pti, processing_usage = :pu, processing_cost_usd = :pcost, updated_at = :now`,
          ExpressionAttributeNames: { '#cat': 'category' },
          ExpressionAttributeValues: {
            ':cat':      assessResult.category || 'uncategorized',
            ':sub':      assessResult.subcategory || 'other',
            ':rejected': isRejected,
            ':reason':   isRejected ? (assessResult.rejection_reason || 'Not clinically relevant') : '',
            ':provider': assessResult.provider_name || '',
            ':ddate':    assessResult.document_date || '',
            ':ovc':      assessResult.office_visit_count || 0,
            ':pc':       assessResult.page_count || doc.page_count || 0,
            ':lrp':      assessResult.low_relevance_pages || [],
            // pt_index: PT/OT encounters with LOCAL page numbers (1-based within this
            // part's PDF) — deliberately NOT pageOffset-adjusted; generateSummary
            // coordinator consumes them per-part for PT/OT pre-consolidation.
            ':pti':      assessResult.pt_visits || [],
            // Updated: 2026-09-20 -- per-document cost calculator.
            ':pu':       assessUsage || {},
            ':pcost':    assessCostUsd,
            ':ra':       true,
            ':now':      new Date().toISOString(),
          },
        }));
        console.log('assessRelevance: saved for', aws_document_id,
          '| relevant:', assessResult.is_relevant_medical_document,
          '| low_pages:', (assessResult.low_relevance_pages || []).length,
          '| page_count:', assessResult.page_count,
          '| pageOffset:', pageOffset);
      } else {
        console.warn('assessRelevance: no parseable result for', aws_document_id, '-- skipping save');
      }
      } // end !assessTooBig
    } catch (assessErr) {
      console.warn('assessRelevance in processWorker failed (non-fatal):', assessErr.message);
    }
    // -----------------------------------------------------------------------

    if (!assessOnly) {

    var extractedText = '';
    var textract_page_count = null;
    try {
      var isPdf = (doc.content_type || '').toLowerCase().includes('pdf') ||
                  (doc.file_key || '').toLowerCase().endsWith('.pdf');

      if (isPdf) {
        var startResult = await textract.send(new StartDocumentTextDetectionCommand({
          DocumentLocation: { S3Object: { Bucket: BUCKET, Name: doc.file_key } }
        }));
        var jobId = startResult.JobId;
        console.log('Textract async job started:', jobId);

        var jobStatus = 'IN_PROGRESS';
        var allBlocks = [];
        for (var attempt = 0; attempt < 60 && jobStatus === 'IN_PROGRESS'; attempt++) {
          await new Promise(function(r) { setTimeout(r, 4000); });
          var pollResult = await textract.send(new GetDocumentTextDetectionCommand({ JobId: jobId }));
          jobStatus = pollResult.JobStatus;
          if (pollResult.Blocks) allBlocks = allBlocks.concat(pollResult.Blocks);
          var nextToken = pollResult.NextToken;
          while (nextToken) {
            var pageResult = await textract.send(new GetDocumentTextDetectionCommand({ JobId: jobId, NextToken: nextToken }));
            if (pageResult.Blocks) allBlocks = allBlocks.concat(pageResult.Blocks);
            nextToken = pageResult.NextToken;
          }
          console.log('Textract poll attempt', attempt + 1, 'status:', jobStatus, 'blocks:', allBlocks.length);
        }

        if (jobStatus === 'SUCCEEDED') {
          extractedText = buildPagedText(allBlocks);
          textract_page_count = allBlocks.filter(function(b) { return b.BlockType === 'PAGE'; }).length || null;
          // Save compact word-geometry blocks to S3 for precise redaction
          try {
            var wordBlocks = allBlocks
              .filter(function(b) { return b.BlockType === 'WORD' && b.Geometry && b.Geometry.BoundingBox; })
              .map(function(b) {
                return {
                  t: b.Text || '',
                  p: b.Page || 1,
                  l: b.Geometry.BoundingBox.Left,
                  tp: b.Geometry.BoundingBox.Top,
                  w: b.Geometry.BoundingBox.Width,
                  h: b.Geometry.BoundingBox.Height,
                  hw: b.TextType === 'HANDWRITING' ? 1 : 0,
                };
              });
            var blocksKey = (doc.file_key || '').replace(/\/[^\/]+$/, '') + '/textract_blocks.json';
            await s3.send(new PutObjectCommand({
              Bucket: BUCKET,
              Key: blocksKey,
              Body: JSON.stringify(wordBlocks),
              ContentType: 'application/json',
            }));
            console.log('Saved', wordBlocks.length, 'word blocks to', blocksKey);
          } catch (blockSaveErr) {
            console.warn('Could not save textract blocks (non-fatal):', blockSaveErr.message);
          }
        } else {
          extractedText = '[Textract job status: ' + jobStatus + ']';
        }
      } else {
        var textractResult = await textract.send(new DetectDocumentTextCommand({
          Document: { S3Object: { Bucket: BUCKET, Name: doc.file_key } }
        }));
        extractedText = buildPagedText(textractResult.Blocks || []);
        textract_page_count = (textractResult.Blocks || []).filter(function(b) { return b.BlockType === 'PAGE'; }).length || null;
      }
    } catch (err) {
      console.error('Textract error:', err.message);
      extractedText = '[Textract failed: ' + err.message + ']';
    }

    var page_count = textract_page_count || doc.page_count || Math.ceil(extractedText.length / 3000) || 1;
    var now = new Date().toISOString();
    console.log('Extracted text length:', extractedText.length, 'page_count:', page_count);

    // v28: do NOT write is_rejected/rejection_reason/document_type here -- assess pass owns those fields
    await dynamo.send(new UpdateCommand({
      TableName: TABLE,
      Key: { aws_document_id },
      UpdateExpression: 'SET #s = :s, extracted_text = :et, page_count = :pc, updated_at = :u',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':s':   'processed',
        ':et':  extractedText.substring(0, 380000),
        ':pc':  page_count,
        ':u':   now,
      },
    }));

    } // end if(!assessOnly)

    // Detect facesheet and store PII at folder level (non-blocking, non-fatal)
    if (!assessOnly && doc.folder) {
      await detectAndStoreFacesheetPii(extractedText, orgId, doc.folder);
    }

    console.log('processWorker completed for', aws_document_id);

  } catch (err) {
    console.error('processWorker fatal error:', err);
    try {
      await dynamo.send(new UpdateCommand({
        TableName: TABLE,
        Key: { aws_document_id },
        UpdateExpression: 'SET #s = :s, updated_at = :u',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':s': 'failed', ':u': new Date().toISOString() }
      }));
    } catch (e) {}
  }
};

// --- WORKER ENTRY -----------------------------------------------------------
// v25: extracts page_offset from SQS/Lambda payload and passes to processWorker
const mainHandler = async (event) => {
  let parsed = event;
  if (Buffer.isBuffer(event)) {
    try { parsed = JSON.parse(event.toString('utf8')); } catch(e) {}
  } else if (typeof event === 'string') {
    try { parsed = JSON.parse(event); } catch(e) {}
  } else if (event.body && typeof event.body === 'string') {
    try { parsed = JSON.parse(event.body); } catch(e) {}
  }

  console.log('mainHandler received event keys:', Object.keys(parsed || {}));

  // SQS event format
  if (event.Records && event.Records[0] && event.Records[0].body) {
    const sqsMsg = JSON.parse(event.Records[0].body);
    if (sqsMsg.__asyncWorker) {
      // v25: pass page_offset through to processWorker
      await processWorker(sqsMsg.aws_document_id, sqsMsg.__assessOnly === true, sqsMsg.page_offset || 0);
      return;
    }
  }

  // Direct Lambda invoke format (legacy fallback)
  if (parsed.__asyncWorker) {
    // v25: pass page_offset through to processWorker
    await processWorker(parsed.aws_document_id, parsed.__assessOnly === true, parsed.page_offset || 0);
    return;
  }
  console.warn('mainHandler: no __asyncWorker flag found, event was:', JSON.stringify(parsed).substring(0, 200));
};

// --- DLQ Handler ------------------------------------------------------------
const dlqHandler = async (event) => {
  console.log('dlqHandler triggered with', (event.Records || []).length, 'DLQ messages');
  for (const record of (event.Records || [])) {
    let aws_document_id = null;
    let failureReason = 'Processing failed after maximum retries';
    try {
      const body = JSON.parse(record.body || '{}');
      aws_document_id = body.aws_document_id || null;
      if (!aws_document_id && body.body) {
        const inner = JSON.parse(body.body);
        aws_document_id = inner.aws_document_id || null;
      }
    } catch (e) {
      console.error('dlqHandler: failed to parse record body:', e.message);
    }

    if (!aws_document_id) {
      console.error('dlqHandler: no aws_document_id found in DLQ message:', record.body);
      continue;
    }

    console.log('dlqHandler: marking document as failed:', aws_document_id);
    try {
      await dynamo.send(new UpdateCommand({
        TableName: TABLE,
        Key: { aws_document_id },
        UpdateExpression: 'SET #s = :s, failure_reason = :fr, updated_at = :u',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: {
          ':s': 'failed',
          ':fr': failureReason,
          ':u': new Date().toISOString(),
        },
      }));
      console.log('dlqHandler: marked', aws_document_id, 'as failed');
    } catch (err) {
      console.error('dlqHandler: DynamoDB update failed for', aws_document_id, err.message);
    }
  }
};

// --- ASSESS RELEVANCE (synchronous HTTP endpoint) ---------------------------
const assessRelevanceHandler = async (event) => {
  const orgId = event._orgId;
  if (!orgId) return response(400, { error: 'Could not resolve organization from token' });

  const aws_document_id = event.pathParameters?.aws_document_id;
  if (!aws_document_id) return response(400, { error: 'Document ID required' });

  try {
    const docResult = await dynamo.send(new GetCommand({ TableName: TABLE, Key: { aws_document_id } }));
    const doc = docResult.Item;
    if (!doc) return response(404, { error: 'Document not found' });
    if (!event._isAdmin && (doc.org_id !== orgId)) return response(403, { error: 'Forbidden' });
    if (!doc.file_key) return response(400, { error: 'Document has no file_key' });

    // Fetch PDF from S3 and encode as base64 for Bedrock
    const s3Object = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: doc.file_key }));
    const pdfChunks = [];
    for await (const chunk of s3Object.Body) { pdfChunks.push(chunk); }
    const pdfBase64 = Buffer.concat(pdfChunks).toString('base64');

    const prompt = `Analyze this document VERY CAREFULLY and extract the following information:

PART 1 - DOCUMENT CLASSIFICATION:
1. Document category: Is this a medical or legal document?
2. If medical, what type: doctor_office_notes, independent_medical_examination, hospital_records, radiology_reports, medical_expert_testimony, lab_results, or other?
3. If legal, what type: deposition, legal_correspondence, court_filing, or other?

PART 2 - OVERALL CLINICAL RELEVANCE:
4. Is the ENTIRE document clinically relevant? Mark as relevant ONLY if it contains ACTUAL CLINICAL CONTENT with medical findings, examination results, diagnoses, or treatment notes.

   ALWAYS MARK AS RELEVANT (do not reject):
   - Police accident reports, motor vehicle accident (MVA) reports, or incident reports documenting the mechanism of injury
   - Workers' compensation accident/incident reports
   - Employer incident reports or OSHA reports
   - Any document establishing the cause, date, or mechanism of the claimant's injury

   REJECT (not clinically relevant) if ANY of these apply:
   - Insurance/authorization forms, pre-authorization documents, or EOB statements
   - Fax cover sheets, emails, or transmittal documents
   - Administrative only (scheduling, billing, claims, referral requests without clinical notes)
   - Patient information forms or intake questionnaires without clinical content
   - Appointment confirmations or scheduling records
   - Billing or payment records
   - Documents containing ONLY headers/footers with no substantive clinical information
   - Generic forms or templates without patient-specific clinical data
   - Photo-only documents: surveillance photos, vehicle photos, location/scene photos, photographs of people without clinical context, or any document consisting primarily of photographs with no accompanying medical text, clinical notes, diagnoses, or treatment information
   - Documents where the majority of pages are photographs, screenshots, or images with no readable medical content
   If uncertain whether clinical content is present, lean toward REJECTION.

PART 3 - PAGE-BY-PAGE ANALYSIS (EXTREMELY IMPORTANT - ANALYZE EACH PAGE INDEPENDENTLY):
5. Scan EVERY SINGLE PAGE individually and identify which pages have LOW clinical relevance. TREAT EACH PAGE AS IF IT WERE STANDALONE - do not assume a page is relevant just because surrounding pages are clinical.

   ALWAYS flag these pages as low relevance:
   - Cover pages (first page with document title, clinic letterhead, etc.) - ALWAYS flag first pages that are primarily header/title
   - Blank pages or mostly blank pages (>50% whitespace)
   - Pages with only headers, footers, page numbers, or watermarks
   - Table of contents or index pages
   - Fax cover sheets or transmittal pages
   - Administrative forms (patient intake, authorization forms, insurance verification)
   - Billing/insurance pages (EOBs, claim forms, payment information)
   - Pages with only signatures or initials
   - Separator/divider pages with minimal text
   - Pages that are mostly whitespace with minimal text
   - Marketing or promotional content
   - Form pages with empty fields or placeholder text
   - Pages consisting entirely of photographs, surveillance images, or non-medical imagery with no clinical text
   - Pages that are scanned photos of people, vehicles, locations, or objects without any medical context
   NOTE: Do NOT flag pages from police reports, accident reports, or incident reports as low relevance -- these are legally relevant to the case.
   NOTE: IGNORE sidebars entirely. Sidebars (columns on the left or right containing allergies, medications, surgical history, social history, family history, problem lists) are standard EHR formatting -- do NOT use sidebar content when deciding if a page is low relevance. Evaluate ONLY the main body of the page.
   NOTE: Headers and footers (clinic name, patient name, date, page number at the top or bottom of a page) are also standard formatting -- ignore them when evaluating clinical content.
   NOTE: A page is low relevance ONLY if its MAIN BODY contains no substantive clinical content (no visit note, no HPI, no findings, no assessment, no plan, no clinical narrative).

   Return an ARRAY of objects with format: {page_number: number, reason: "specific description"}
   Only return an empty array [] if EVERY page has substantial clinical content in its main body.
   Be aggressive flagging billing, admin, photo, and blank pages -- but never flag a page based on its sidebar or header/footer alone.

PART 4 - METADATA EXTRACTION:
6. Extract patient name if this is a medical document
7. Extract document date if available (use the EARLIEST visit date if multiple office visits are present)
8. Extract provider/entity name (use the FIRST provider if multiple are listed)
9. Extract case number if mentioned
10. Count how many office visits are documented in this file
11. Count the EXACT number of pages in this document

CRITICAL: Analyze each page in isolation. A page is ONLY relevant if it contains substantive clinical content ON THAT PAGE ALONE.
RECHECK YOUR ANSWER: If you flagged no pages, verify every single page contains substantive clinical content.

Return ONLY a JSON object with these exact fields:
{
  "category": "medical or legal or uncategorized",
  "subcategory": "string",
  "is_relevant_medical_document": true or false,
  "patient_name": "string",
  "document_date": "string",
  "provider_name": "string",
  "case_number": "string",
  "office_visit_count": 0,
  "page_count": 0,
  "rejection_reason": "string",
  "low_relevance_pages": [{"page_number": 1, "reason": "string"}],
  "pt_visits": [{"date": "YYYY-MM-DD", "facility": "string", "provider": "string", "type": "initial evaluation | progress note | treatment note | discharge summary", "page_numbers": [1]}]
}`;

    const bedrockPayload = {
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 8192,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 },
          },
          { type: 'text', text: prompt },
        ],
      }],
    };

    const bedrockResp = await bedrock.send(new InvokeModelCommand({
      modelId: 'us.anthropic.claude-sonnet-4-6',
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify(bedrockPayload),
    }));

    const bedrockBody = JSON.parse(new TextDecoder().decode(bedrockResp.body));
    const rawText = bedrockBody.content?.[0]?.text || '';
    console.log('assessRelevance raw response (first 500):', rawText.substring(0, 500));
    const arhUsage = bedrockBody.usage || null;
    const arhCostUsd = estimateBedrockCost(arhUsage);

    let result = null;
    try {
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      result = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
    } catch (parseErr) {
      console.error('assessRelevance: JSON parse error', parseErr.message);
    }

    if (!result) {
      return response(500, { error: 'Failed to parse Bedrock response', raw: rawText.substring(0, 500) });
    }

    const isRejected = result.is_relevant_medical_document === false;
    await dynamo.send(new UpdateCommand({
      TableName: TABLE,
      Key: { aws_document_id },
      UpdateExpression: `SET #cat = :cat, subcategory = :sub, is_rejected = :rejected,
        rejection_reason = :reason, patient_name = :pname, document_date = :ddate,
        provider_name = :provider, case_number = :casenum, office_visit_count = :ovc,
        page_count = :pc, low_relevance_pages = :lrp, relevance_assessed = :ra,
        pt_index = :pti, processing_usage = :pu, processing_cost_usd = :pcost, updated_at = :now`,
      ExpressionAttributeNames: { '#cat': 'category' },
      ExpressionAttributeValues: {
        ':cat':      result.category || 'uncategorized',
        ':sub':      result.subcategory || 'other',
        ':rejected': isRejected,
        ':reason':   isRejected ? (result.rejection_reason || 'Not clinically relevant') : '',
        ':pname':    result.patient_name || doc.patient_name || '',
        ':provider': result.provider_name || '',
        ':ddate':    result.document_date || '',
        ':casenum':  result.case_number || '',
        ':ovc':      result.office_visit_count || 0,
        ':pc':       result.page_count || doc.page_count || 0,
        ':lrp':      result.low_relevance_pages || [],
        ':pti':      result.pt_visits || [],
        // Updated: 2026-09-20 -- per-document cost calculator.
        ':pu':       arhUsage || {},
        ':pcost':    arhCostUsd,
        ':ra':       true,
        ':now':      new Date().toISOString(),
      },
    }));

    return response(200, { ...result, aws_document_id, is_rejected: isRejected });

  } catch (err) {
    console.error('assessRelevanceHandler error:', err);
    return response(500, { error: err.message });
  }
};

// --- REASSESS (async trigger) -----------------------------------------------
// v25: reads page_offset from request body, forwards to processWorker via SQS/Lambda
const reassessHandler = async (event) => {
  try {
    const aws_document_id = event.pathParameters?.aws_document_id;
    if (!aws_document_id) return response(400, { error: 'aws_document_id required' });

    const orgId = event._orgId;
    if (!orgId) return response(400, { error: 'Could not resolve organization from token' });

    const docResult = await dynamo.send(new GetCommand({ TableName: TABLE, Key: { aws_document_id } }));
    if (!docResult.Item) return response(404, { error: 'Document not found' });
    if (!event._isAdmin && (docResult.Item.org_id && docResult.Item.org_id !== orgId)) return response(403, { error: 'Forbidden' });

    // v25: read page_offset from request body (sent by Library v24 per-part)
    const requestBody = JSON.parse(event.body || '{}');
    const page_offset = typeof requestBody.page_offset === 'number' ? requestBody.page_offset : 0;
    console.log('reassessHandler: aws_document_id=' + aws_document_id + ' page_offset=' + page_offset);

    // Clear relevance_assessed so processWorker re-runs the assess block
    await dynamo.send(new UpdateCommand({
      TableName: TABLE,
      Key: { aws_document_id },
      UpdateExpression: 'SET relevance_assessed = :ra, updated_at = :now',
      ExpressionAttributeValues: { ':ra': false, ':now': new Date().toISOString() },
    }));

    // Fire processWorker async with page_offset included in payload
    if (PROCESSING_QUEUE_URL) {
      await sqs.send(new SendMessageCommand({
        QueueUrl: PROCESSING_QUEUE_URL,
        MessageBody: JSON.stringify({ __asyncWorker: true, __assessOnly: true, aws_document_id, page_offset }),
      }));
    } else {
      await lambda.send(new InvokeCommand({
        FunctionName: WORKER_FUNCTION_NAME,
        InvocationType: 'Event',
        Payload: JSON.stringify({ __asyncWorker: true, __assessOnly: true, aws_document_id, page_offset }),
      }));
    }

    return response(202, { message: 'Reassessment queued', aws_document_id, page_offset });
  } catch (err) {
    console.error('reassessHandler error:', err);
    return response(500, { error: err.message });
  }
};


// ---------------------------------------------------------------------------
// Project Gamma -- Phase 1: Async Classification via Jobs table
// ---------------------------------------------------------------------------
// Replaces the synchronous /assess-relevance endpoint (504s on large files)
// with a fire-and-poll pattern:
//   1. POST /documents/{id}/classify/start  -> { job_id }
//   2. classifyJobWorker Lambda does Bedrock Vision pass (no 29s timeout)
//   3. GET /jobs/{job_id}                  -> { status, result }
// ---------------------------------------------------------------------------

const JOBS_TABLE = process.env.JOBS_TABLE || 'chartreview-jobs-prod';

// --- SHARED: Bedrock classification prompt (used by both sync + async paths) ---
const CLASSIFY_PROMPT = `Analyze this document VERY CAREFULLY and extract the following information:

PART 1 - DOCUMENT CLASSIFICATION:
1. Document category: Is this a medical or legal document?
2. If medical, what type: doctor_office_notes, independent_medical_examination, hospital_records, radiology_reports, medical_expert_testimony, lab_results, or other?
3. If legal, what type: deposition, legal_correspondence, court_filing, or other?

PART 2 - OVERALL CLINICAL RELEVANCE:
4. Is the ENTIRE document clinically relevant? Mark as relevant ONLY if it contains ACTUAL CLINICAL CONTENT with medical findings, examination results, diagnoses, or treatment notes.

   ALWAYS MARK AS RELEVANT (do not reject):
   - Police/accident/MVA/incident reports, EMT/EMS/paramedic reports, workers comp accident reports -- these establish mechanism of injury and are legally required.

   REJECT (not clinically relevant) if ANY of these apply:
   - Insurance/auth forms, EOBs, fax cover sheets, emails, billing, scheduling, patient intake forms without clinical content
   - Photo-only documents (surveillance, vehicle, scene photos with no medical text)
   - Hospital/rehab nursing-admin records: MAR grids, nursing flowsheets, vital sign grids, ADL logs, wound care checklists, dietary records, pharmacy printouts (AbacusRX etc.), Documentation Survey Report forms, resident activity logs, staffing tables, facility photo ID pages -- REJECT these even if mixed with some clinical pages, UNLESS a physician order or physician progress note is embedded on that specific page.
   - Hospital order/workflow pages: order tracking logs, discharge request orders, medication order audit trails, order action/discontinue/acknowledgment records, nursing order review logs -- these are administrative workflow records with no clinical findings even if signed by a physician.
   - Medical records transmittal cover pages, law firm records request letters, HIPAA authorization forms, affidavits of custodian of records, consent-to-release forms.
   - Billing/charge summary pages: itemized charges, insurance payment summaries, statement of charges, account balance pages.
   - Generic patient education handout pages (standardized printouts like "Broken Foot care", "Care after receiving medication in the ER" -- these are not written by the treating provider and contain no clinical findings).
   - Conditions of Admission forms, financial responsibility forms, patient rights documents, consent-to-treat signature pages.
   If uncertain, lean toward REJECTION.

PART 3 - PAGE-BY-PAGE ANALYSIS (EXTREMELY IMPORTANT - ANALYZE EACH PAGE INDEPENDENTLY):
5. Scan EVERY SINGLE PAGE individually. Flag pages with LOW clinical relevance. TREAT EACH PAGE AS STANDALONE.

   A page is clinically relevant ONLY if it contains a NARRATIVE CLINICAL ENCOUNTER -- meaning a physician, PA, NP, or radiologist has written an assessment, HPI, examination finding, diagnosis, treatment plan, operative note, or radiology interpretation for this patient. Pages that merely document what was ordered, administered, or tracked without a clinical narrative are NOT clinically relevant.

   Always flag as low relevance:
   - Cover/title pages, blank pages, headers/footers only, TOC, fax cover sheets, admin forms, billing pages, signature-only pages, separator pages, photo pages (surveillance, vehicles, people without clinical context)
   - MAR/pharmacy grid pages, nursing flowsheet pages, vital sign grid pages, ADL log pages, Documentation Survey Report pages, any page that is primarily a table of checkmarks/initials/codes with no physician narrative
   - Hospital order/workflow pages: order tracking logs, discharge request orders, medication order audit trails, order action/discontinue/acknowledgment records, ADT admission blocks, admission level-of-care order sets (e.g. "ADT2 triggered protocol orders"), protocol order bundles (VTE prophylaxis, oxygen management, electrolyte replacement, fall precautions) -- these are administrative workflow records even if a physician name appears on them
   - Nursing-only entries: nursing assessments, nursing APRN medication order entries, IV insertion records, nursing reassessment flowsheets, intake/output logs -- flag UNLESS a physician or PA has authored a clinical narrative on the same page
   - Case management / social work / discharge planning pages: case management evaluations, discharge planning notes, social work assessments, payer authorization pages, disposition planning records
   - Inpatient medication reconciliation pages, pharmacy medication lists, prescription printouts, medication fill records
   - Patient safety checklists: fall risk screens, VTE risk assessments, pressure ulcer screens, pain assessment grids, patient safety parameter checklists with no physician narrative
   - Medical records transmittal pages, law firm letters, HIPAA auth forms, affidavits, consent-to-release pages, Conditions of Admission pages
   - Generic patient education handout pages (standardized printouts not authored by the treating provider)
   - Billing charge pages, account balance pages, insurance payment summary pages
   - Inpatient discharge order pages and discharge instruction printouts WITHOUT a physician discharge summary narrative (a discharge summary WITH assessment/plan IS clinical; a discharge order form is not)

   ALWAYS KEEP as clinically relevant (do NOT flag):
   - Physician, PA, or NP office visit notes with HPI, exam, assessment, and plan
   - Emergency department provider notes (attending MD/PA/NP narrative -- not nursing triage forms)
   - Hospital attending physician progress notes, admission H&P, consult notes
   - Operative reports and pre/post-operative notes authored by a surgeon
   - Radiology reports authored by a radiologist (including addendum and attestation pages that are part of the report)
   - Discharge summaries with a physician narrative (assessment, hospital course, discharge plan)
   - Physical therapy and occupational therapy initial evaluations, progress notes, and discharge summaries
   - Independent medical examination reports
   - Laboratory result pages showing actual test values
   - Police/accident/EMT/EMS reports

   NOTE: A page with BOTH a nursing entry AND a physician entry -- keep it (clinical wins).
   NOTE: If uncertain whether an entry is a physician narrative vs. a nursing/admin entry, look for: does it contain HPI, assessment, differential diagnosis, or treatment plan language? If yes, keep it.

   Return an ARRAY: {page_number: number, reason: "specific description"}
   Only return [] if EVERY page has a substantive clinical narrative. Be VERY aggressive flagging administrative and nursing-only pages.

PART 4 - METADATA EXTRACTION:
6. Patient name (if medical document)
7. Document date (earliest visit date if multiple)
8. Provider/entity name (first provider if multiple)
9. Case number if mentioned
10. Count of office visits in this file
11. EXACT page count

CRITICAL: Each page is ONLY relevant if it contains a substantive clinical narrative authored by a treating provider (physician, PA, NP, radiologist, or therapist). Nursing entries, order sets, protocol bundles, and administrative workflow pages are NOT clinical even if they contain medical terminology.
RECHECK: If you flagged fewer than 10% of pages in a hospital record, re-examine every page -- hospital records almost always contain large sections of nursing/admin/order pages that should be flagged.

PART 3 - PHYSICAL THERAPY INDEX (used downstream to consolidate PT series):
List EVERY physical therapy (PT), occupational therapy (OT), or hand therapy encounter in this document — including initial evaluations, progress notes, and repetitive dated treatment notes. For EACH encounter record: the exact page numbers it appears on (1-based, counting pages within THIS file), the treatment date in YYYY-MM-DD format (empty string if not legible), the facility name, the treating therapist, and the note TYPE — one of "initial evaluation", "progress note", "treatment note", or "discharge summary". Use "initial evaluation" only for the first comprehensive evaluation of a therapy course, "discharge summary" when the note summarizes the full course of therapy and discharges the patient, "treatment note" for routine daily treatment sessions, and "progress note" for periodic re-assessments. Every dated treatment note is its own entry — NEVER merge multiple dates into one entry. If this document contains no PT/OT/hand therapy encounters, return an empty array.

Return ONLY a JSON object:
{
  "category": "medical or legal or uncategorized",
  "subcategory": "string",
  "is_relevant_medical_document": true or false,
  "patient_name": "string",
  "document_date": "string",
  "provider_name": "string",
  "case_number": "string",
  "office_visit_count": 0,
  "page_count": 0,
  "rejection_reason": "string",
  "low_relevance_pages": [{"page_number": 1, "reason": "string"}],
  "pt_visits": [{"date": "YYYY-MM-DD", "facility": "string", "provider": "string", "type": "initial evaluation | progress note | treatment note | discharge summary", "page_numbers": [1]}]
}`;

// --- Shared: run Bedrock classification on a PDF buffer ----------------------
// Returns parsed result object or throws.
const runBedrockClassify = async (pdfBase64, aws_document_id) => {
  console.log('runBedrockClassify: PDF size ' + (pdfBase64.length/1024/1024).toFixed(1) + 'MB for', aws_document_id);
  const payload = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 8192,
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
        { type: 'text', text: CLASSIFY_PROMPT },
      ],
    }],
  };
  const resp = await bedrock.send(new InvokeModelCommand({
    modelId: 'us.anthropic.claude-sonnet-4-6',
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify(payload),
  }));
  const body = JSON.parse(new TextDecoder().decode(resp.body));
  const rawText = body.content?.[0]?.text || '';
  const match = rawText.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON in Bedrock response: ' + rawText.substring(0, 300));
  const parsed = JSON.parse(match[0]);
  // Updated: 2026-09-20 -- per-document cost calculator. Carry the
  // raw Bedrock usage back to the caller so saveClassificationToDoc can price
  // and persist it; stripped by the caller before classifyResult is used
  // for anything else.
  parsed._usage = body.usage || null;
  return parsed;
};

// --- Shared: write classification result to documents table ------------------
const saveClassificationToDoc = async (aws_document_id, result, doc, pageOffset = 0) => {
  if (pageOffset > 0 && Array.isArray(result.low_relevance_pages) && result.low_relevance_pages.length > 0) {
    result.low_relevance_pages = result.low_relevance_pages.map(p => ({
      ...p, page_number: (p.page_number || 0) + pageOffset,
    }));
  }
  const isRejected = result.is_relevant_medical_document === false;
  // Updated: 2026-09-20 -- per-document cost calculator.
  const classifyUsage = result._usage || null;
  const classifyCostUsd = estimateBedrockCost(classifyUsage);
  await dynamo.send(new UpdateCommand({
    TableName: TABLE,
    Key: { aws_document_id },
    UpdateExpression: `SET #cat = :cat, subcategory = :sub, is_rejected = :rejected,
      rejection_reason = :reason, patient_name = :pname, document_date = :ddate,
      provider_name = :provider, case_number = :casenum, office_visit_count = :ovc,
      page_count = :pc, low_relevance_pages = :lrp, relevance_assessed = :ra,
      pt_index = :pti, classify_usage = :cu, classify_cost_usd = :ccost, updated_at = :now`,
    ExpressionAttributeNames: { '#cat': 'category' },
    ExpressionAttributeValues: {
      ':cat':      result.category || 'uncategorized',
      ':sub':      result.subcategory || 'other',
      ':rejected': isRejected,
      ':reason':   isRejected ? (result.rejection_reason || 'Not clinically relevant') : '',
      ':pname':    result.patient_name || (doc && doc.patient_name) || '',
      ':provider': result.provider_name || '',
      ':ddate':    result.document_date || '',
      ':casenum':  result.case_number || '',
      ':ovc':      result.office_visit_count || 0,
      ':pc':       result.page_count || (doc && doc.page_count) || 0,
      ':lrp':      result.low_relevance_pages || [],
      ':pti':      result.pt_visits || [],
      ':cu':       classifyUsage || {},
      ':ccost':    classifyCostUsd,
      ':ra':       true,
      ':now':      new Date().toISOString(),
    },
  }));
  return isRejected;
};

// --- GET JOB ----------------------------------------------------------------
const getJobHandler = async (event) => {
  const orgId = event._orgId;
  if (!orgId) return response(400, { error: 'Could not resolve organization from token' });
  const job_id = event.pathParameters?.job_id;
  if (!job_id) return response(400, { error: 'job_id required' });
  try {
    const result = await dynamo.send(new GetCommand({ TableName: JOBS_TABLE, Key: { job_id } }));
    if (!result.Item) return response(404, { error: 'Job not found' });
    if (!event._isAdmin && (result.Item.org_id !== orgId)) return response(403, { error: 'Forbidden' });
    return response(200, result.Item);
  } catch (err) {
    console.error('getJobHandler error:', err);
    return response(500, { error: err.message });
  }
};

// --- CLASSIFY START (async) -------------------------------------------------
// POST /documents/{aws_document_id}/classify/start
// Clears old classification state, writes a pending job, fires classifyWorker async.
const classifyStartHandler = async (event) => {
  const orgId = event._orgId;
  if (!orgId) return response(400, { error: 'Could not resolve organization from token' });
  const aws_document_id = event.pathParameters?.aws_document_id;
  if (!aws_document_id) return response(400, { error: 'aws_document_id required' });

  try {
    const docResult = await dynamo.send(new GetCommand({ TableName: TABLE, Key: { aws_document_id } }));
    if (!docResult.Item) return response(404, { error: 'Document not found' });
    if (!event._isAdmin && (docResult.Item.org_id && docResult.Item.org_id !== orgId)) return response(403, { error: 'Forbidden' });

    const requestBody = JSON.parse(event.body || '{}');
    const page_offset = typeof requestBody.page_offset === 'number' ? requestBody.page_offset : 0;

    // Write job record
    const job_id = randomUUID();
    const now = new Date().toISOString();
    await dynamo.send(new PutCommand({
      TableName: JOBS_TABLE,
      Item: {
        job_id,
        job_type: 'classify',
        aws_document_id,
        org_id: orgId,
        page_offset,
        status: 'pending',
        created_at: now,
        updated_at: now,
      },
    }));

    // Clear relevance_assessed so UI knows it is being re-processed
    await dynamo.send(new UpdateCommand({
      TableName: TABLE,
      Key: { aws_document_id },
      UpdateExpression: 'SET relevance_assessed = :ra, updated_at = :now',
      ExpressionAttributeValues: { ':ra': false, ':now': now },
    }));

    // Fire classifyWorker async
    const workerPayload = JSON.stringify({ __classifyJob: true, job_id, aws_document_id, org_id: orgId, page_offset });
    if (process.env.CLASSIFY_QUEUE_URL) {
      await sqs.send(new SendMessageCommand({
        QueueUrl: process.env.CLASSIFY_QUEUE_URL,
        MessageBody: workerPayload,
      }));
      console.log('classifyStart: queued via SQS job_id=' + job_id);
    } else {
      await lambda.send(new InvokeCommand({
        FunctionName: process.env.CLASSIFY_WORKER_FUNCTION_NAME || 'chartreview-pro-prod-classifyJobWorker',
        InvocationType: 'Event',
        Payload: workerPayload,
      }));
      console.log('classifyStart: invoked Lambda directly job_id=' + job_id);
    }

    return response(202, { job_id, status: 'pending', aws_document_id });
  } catch (err) {
    console.error('classifyStartHandler error:', err);
    return response(500, { error: err.message });
  }
};

// --- CLASSIFY JOB WORKER (async, no HTTP timeout) ---------------------------
// Triggered by SQS classifyJobQueue or direct Lambda invoke.
// Does the full Bedrock Vision classification pass and writes results.
const classifyJobWorker = async (job_id, aws_document_id, org_id, page_offset = 0) => {
  console.log('classifyJobWorker started: job_id=' + job_id + ' doc=' + aws_document_id + ' pageOffset=' + page_offset);
  const now = () => new Date().toISOString();

  // Mark job running
  await dynamo.send(new UpdateCommand({
    TableName: JOBS_TABLE,
    Key: { job_id },
    UpdateExpression: 'SET #s = :s, updated_at = :now',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':s': 'running', ':now': now() },
  }));

  try {
    const docResult = await dynamo.send(new GetCommand({ TableName: TABLE, Key: { aws_document_id } }));
    const doc = docResult.Item;
    if (!doc) throw new Error('Document not found: ' + aws_document_id);

    // Text-density check (same as processWorker)
    const SPARSE_CHARS_PER_PAGE = 30;
    const extractedTextLen = (doc.extracted_text || '').length;
    const docPageCount = doc.page_count || 1;
    const charsPerPage = extractedTextLen / docPageCount;

    let classifyResult;
    if (charsPerPage < SPARSE_CHARS_PER_PAGE && extractedTextLen < 500) {
      console.log('classifyJobWorker: sparse doc, auto-rejecting without Bedrock');
      const autoLowPages = Array.from({ length: docPageCount }, (_, i) => ({
        page_number: i + 1 + page_offset,
        reason: 'photo/image-only page (no extractable text)',
      }));
      classifyResult = {
        category: 'non_clinical',
        subcategory: 'photo_image_only',
        is_relevant_medical_document: false,
        patient_name: doc.patient_name || '',
        document_date: '',
        provider_name: '',
        case_number: '',
        office_visit_count: 0,
        page_count: docPageCount,
        rejection_reason: 'No extractable text (' + charsPerPage.toFixed(1) + ' chars/page) -- likely photo or image-only document',
        low_relevance_pages: autoLowPages,
      };
    } else {
      // Resolve the file_key -- shell records (no file_key) point to parts via original_document_id.
      // Query GSI to find the first part and use its file_key instead.
      let fileKey = doc.file_key;
      let fileDoc = doc;
      if (!fileKey) {
        console.log('classifyJobWorker: no file_key on doc, querying for first part via GSI');
        const partsResult = await dynamo.send(new QueryCommand({
          TableName: TABLE,
          IndexName: 'original_document_id-index',
          KeyConditionExpression: 'original_document_id = :oid',
          ExpressionAttributeValues: { ':oid': aws_document_id },
          Limit: 1,
        }));
        const firstPart = partsResult.Items && partsResult.Items[0];
        if (!firstPart || !firstPart.file_key) throw new Error('classify job failed: shell has no file_key and no parts found');
        fileKey = firstPart.file_key;
        fileDoc = firstPart;
        console.log('classifyJobWorker: resolved to part file_key=' + fileKey);
      }

      // Fetch PDF from S3 -- try primary bucket first, fall back to legacy bucket
      const CLASSIFY_FALLBACK_BUCKET = 'chartreview-pro-files-prod';
      let pdfBase64;
      for (const bucket of [...new Set([BUCKET, CLASSIFY_FALLBACK_BUCKET])]) {
        try {
          console.log('classifyJobWorker: fetching from bucket=' + bucket + ' key=' + fileKey);
          const s3Object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: fileKey }));
          const chunks = [];
          for await (const chunk of s3Object.Body) { chunks.push(chunk); }
          pdfBase64 = Buffer.concat(chunks).toString('base64');
          console.log('classifyJobWorker: fetched PDF from bucket=' + bucket);
          break;
        } catch (s3Err) {
          if (s3Err.name === 'NoSuchKey' || s3Err.$metadata?.httpStatusCode === 404) {
            console.log('classifyJobWorker: key not found in bucket=' + bucket + ', trying next');
            continue;
          }
          throw s3Err;
        }
      }
      if (!pdfBase64) throw new Error('classify job failed: The specified key does not exist in any bucket. key=' + fileKey);
      classifyResult = await runBedrockClassify(pdfBase64, aws_document_id);
    }

    // Save classification to documents table
    const isRejected = await saveClassificationToDoc(aws_document_id, classifyResult, doc, page_offset);

    // Mark job complete with result summary
    await dynamo.send(new UpdateCommand({
      TableName: JOBS_TABLE,
      Key: { job_id },
      UpdateExpression: 'SET #s = :s, #r = :r, updated_at = :now',
      ExpressionAttributeNames: { '#s': 'status', '#r': 'result' },
      ExpressionAttributeValues: {
        ':s': 'complete',
        ':r': {
          aws_document_id,
          is_rejected: isRejected,
          category: classifyResult.category,
          subcategory: classifyResult.subcategory,
          page_count: classifyResult.page_count,
          low_relevance_pages: classifyResult.low_relevance_pages || [],
          low_page_count: (classifyResult.low_relevance_pages || []).length,
        },
        ':now': now(),
      },
    }));
    console.log('classifyJobWorker complete: job_id=' + job_id + ' rejected=' + isRejected);

  } catch (err) {
    console.error('classifyJobWorker error:', err);
    await dynamo.send(new UpdateCommand({
      TableName: JOBS_TABLE,
      Key: { job_id },
      UpdateExpression: 'SET #s = :s, error_message = :e, updated_at = :now',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':s': 'failed', ':e': err.message, ':now': now() },
    })).catch(() => {});
  }
};

// --- CLASSIFY JOB QUEUE ENTRY POINT -----------------------------------------
const classifyJobQueueHandler = async (event) => {
  // SQS trigger
  if (event.Records && event.Records[0] && event.Records[0].body) {
    const msg = JSON.parse(event.Records[0].body);
    if (msg.__classifyJob) {
      await classifyJobWorker(msg.job_id, msg.aws_document_id, msg.org_id, msg.page_offset || 0);
      return;
    }
  }
  // Direct Lambda invoke fallback
  if (event.__classifyJob) {
    await classifyJobWorker(event.job_id, event.aws_document_id, event.org_id, event.page_offset || 0);
    return;
  }
  console.warn('classifyJobQueueHandler: no __classifyJob flag in event');
};

// Direct Lambda handler for classifyJobWorker (invoked async by classifyStart)
const classifyJobWorkerHandler = async (event) => {
  // Can be invoked directly with { job_id, aws_document_id, org_id, page_offset }
  // or via the SQS queue body
  let payload = event;
  if (event.__classifyJob) {
    payload = event;
  } else if (event.Records) {
    // SQS path
    payload = JSON.parse(event.Records[0].body);
  }
  await classifyJobWorker(payload.job_id, payload.aws_document_id, payload.org_id, payload.page_offset || 0);
};


// ── GET /folders/:folderName/pii ─────────────────────────────────────────────
// Returns PII stored for a folder (from facesheet detection at upload time).
// Used by Redaction modal to pre-fill patient fields.
const getFolderPiiHandler = async (event) => {
  const orgId = event._orgId;
  const folderName = decodeURIComponent((event.pathParameters || {}).folderName || '');
  if (!folderName) return response(400, { error: 'folderName required' });
  const orgFolder = orgId + '#' + folderName.trim();
  try {
    const result = await dynamo.send(new GetCommand({
      TableName: FOLDER_PII_TABLE,
      Key: { org_folder: orgFolder },
    }));
    if (!result.Item) return response(404, { error: 'No PII found for this folder' });
    const { org_folder, org_id, updated_at, ...pii } = result.Item;
    return response(200, pii);
  } catch (err) {
    console.error('getFolderPii error:', err);
    return response(500, { error: err.message });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// acceptTerms — POST /users/accept-terms
// Records that the currently-authenticated (Cognito JWT-verified) user has accepted the
// Terms of Service. Writes tos_accepted_at / tos_version onto their USER_CREDITS_TABLE record
// (same table stripe.js already keys by user_email) via UpdateCommand, which only touches these
// two attributes -- it never resets page_credits/free_pages_remaining on an existing record.
// ═══════════════════════════════════════════════════════════════════════════════
const acceptTermsHandler = async (event) => {
  const userEmail = event._userEmail;
  if (!userEmail) return response(400, { error: 'Could not resolve user email from token' });

  let version = null;
  try {
    const data = JSON.parse(event.body || '{}');
    version = (data.version || '').trim() || null;
  } catch (err) {
    return response(400, { error: 'Invalid request body' });
  }
  if (!version) return response(400, { error: 'version is required' });

  try {
    await dynamo.send(new UpdateCommand({
      TableName: USER_CREDITS_TABLE,
      Key: { user_email: userEmail },
      UpdateExpression: 'SET tos_accepted_at = :at, tos_version = :v',
      ExpressionAttributeValues: {
        ':at': new Date().toISOString(),
        ':v':  version,
      },
    }));
    return response(200, { success: true });
  } catch (err) {
    console.error('acceptTerms error:', err);
    return response(500, { error: err.message });
  }
};

module.exports = {
  directUpload:   validateApiKey(directUploadHandler),
  getUploadUrl:   validateApiKey(async (event) => {
    const orgId = event._orgId;
    if (!orgId) return response(400, { error: 'Could not resolve organization from token' });
    try {
      const data        = JSON.parse(event.body || '{}');
      const filename    = data.filename     || 'document.pdf';
      const contentType = data.content_type || 'application/pdf';
      const aws_document_id = randomUUID();
      const key = 'orgs/' + orgId + '/documents/' + aws_document_id + '/' + filename;
      const now = new Date().toISOString();

      await dynamo.send(new PutCommand({
        TableName: TABLE,
        Item: {
          aws_document_id,
          org_id:               orgId,
          file_name:            filename,
          file_key:             key,
          content_type:         contentType,
          file_size:            data.file_size            || 0,
          status:               'pending_upload',
          folder:               (data.folder || '').trim() || null,
          parent_filename:      data.parent_filename      || null,
          total_parts:          data.total_parts          || null,
          part_index:           data.part_index      != null ? data.part_index : null,
          original_document_id: data.original_document_id || null,
          page_count:           data.page_count           || null,
          created_at:           now,
          updated_at:           now,
        }
      }));

      // Updated: 2026-09-21 — Bumped from 300s to 1800s. The frontend now lets large PDFs
      // (up to MAX_SPLITTABLE_PDF_MB) through to upload instead of blocking them outright,
      // and a multi-hundred-MB PUT on a slow connection can outlast a 5-minute signature window.
      const uploadUrl = await getSignedUrl(s3, new PutObjectCommand({
        Bucket:      BUCKET,
        Key:         key,
        ContentType: contentType,
      }), { expiresIn: 1800 });

      return response(200, { upload_url: uploadUrl, aws_document_id, file_key: key });
    } catch (err) {
      console.error('getUploadUrl error:', err);
      return response(500, { error: err.message });
    }
  }),
  get:              validateApiKey(getHandler),
  getText:          validateApiKey(getTextHandler),
  remove:           validateApiKey(removeHandler),
  getDownloadUrl:   validateApiKey(getDownloadUrlHandler),
  update:           validateApiKey(updateHandler),
  process:          validateApiKey(processHandler),
  worker:           mainHandler,
  dlqWorker:        dlqHandler,
  listByPatient:    validateApiKey(listByPatientHandler),
  listAll:          validateApiKey(listAllHandler),
  getUsersReport:   validateApiKey(getUsersReportHandler),
  assessRelevance:  validateApiKey(assessRelevanceHandler),
  reassessDocument: validateApiKey(reassessHandler),
  classifyStart:    validateApiKey(classifyStartHandler),
  classifyWorker:   classifyJobQueueHandler,
  classifyJobWorker: classifyJobWorkerHandler,
  getJob:           validateApiKey(getJobHandler),
  getFullText:      validateApiKey(getTextHandler),
  getFolderPii:     validateApiKey(getFolderPiiHandler),
  acceptTerms:      validateApiKey(acceptTermsHandler),
  options:          optionsHandler,
};

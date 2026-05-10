// Updated: 2026-05-10 — restore dual-mode auth (API Gateway Cognito claims for native + API key for v5)
// auth.js - supports both Cognito JWT (chartreview-native-frontend) and API key (v5)
// Cognito claims are checked first; falls back to x-api-key for v5 compatibility

const validateApiKey = (handler) => async (event, context) => {

  // --- PATH 1: Cognito JWT (chartreview-native-frontend) ---
  // API Gateway Cognito authorizer already validated the token.
  // Claims are injected into requestContext.authorizer.claims.
  const claims = event.requestContext?.authorizer?.claims;

  if (claims?.sub) {
    // Cognito auth succeeded — extract org ID from header or body
    let orgId = event.headers?.['x-org-id'] || event.headers?.['X-Org-Id'] || null;

    if (!orgId) {
      try {
        let bodyData;
        if (event.isBase64Encoded && event.body) {
          bodyData = JSON.parse(Buffer.from(event.body, 'base64').toString('utf8'));
        } else if (event.body) {
          bodyData = JSON.parse(event.body);
        }
        if (bodyData?.org_id) orgId = bodyData.org_id;
      } catch (e) { /* ignore */ }
    }

    if (!orgId && event.queryStringParameters?.org_id) {
      orgId = event.queryStringParameters.org_id;
    }

    event._orgId = orgId;
    event._userEmail = claims.email || null;
    event._userSub = claims.sub || null;

    return handler(event, context);
  }

  // --- PATH 2: API Key (v5 / chartreview-pro) ---
  const apiKey = event.headers?.['x-api-key']
    || event.headers?.['X-Api-Key']
    || event.headers?.['X-API-KEY'];

  if (!apiKey || apiKey !== process.env.API_KEY) {
    return {
      statusCode: 401,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Unauthorized' }),
    };
  }

  // Extract org_id from header, body, or query string
  let orgId = event.headers?.['x-org-id'] || event.headers?.['X-Org-Id'] || null;

  if (!orgId) {
    try {
      let bodyData;
      if (event.isBase64Encoded && event.body) {
        bodyData = JSON.parse(Buffer.from(event.body, 'base64').toString('utf8'));
      } else if (event.body) {
        bodyData = JSON.parse(event.body);
      }
      if (bodyData?.org_id) orgId = bodyData.org_id;
    } catch (e) { /* ignore */ }
  }

  if (!orgId && event.queryStringParameters?.org_id) {
    orgId = event.queryStringParameters.org_id;
  }

  event._orgId = orgId;

  return handler(event, context);
};

module.exports = { validateApiKey };

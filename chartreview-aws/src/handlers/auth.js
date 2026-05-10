// Updated: 2026-05-10 — restore dual-mode auth (Cognito JWT for native + API key for v5)
// auth.js - dual-mode authentication
// Native app: Authorization: Bearer <cognito-jwt>
// v5 app:     x-api-key header
// API Gateway authorizationType = NONE for all methods (auth handled here)

const { CognitoJwtVerifier } = require('aws-jwt-verify');

const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID || 'us-east-1_HGvNxEFP6';
const CLIENT_ID = process.env.COGNITO_CLIENT_ID || '12tdr6tcnuvc7kn40ka1vubo6m';
const API_KEY = process.env.API_KEY || 'ChartReview#2026$ProdKey!Rx';

// Create verifier once at cold start (cached)
const verifier = CognitoJwtVerifier.create({
  userPoolId: USER_POOL_ID,
  tokenUse: 'id',
  clientId: CLIENT_ID,
});

const validateApiKey = (handler) => async (event, context) => {
  const authHeader = event.headers?.['authorization'] || event.headers?.['Authorization'];
  const apiKey = event.headers?.['x-api-key'] || event.headers?.['X-Api-Key'];

  // --- PATH 1: Native app — Cognito JWT Bearer token ---
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    try {
      const payload = await verifier.verify(token);
      // Inject identity into event (same shape as before)
      const orgId = event.headers?.['x-org-id'] || event.headers?.['X-Org-Id'] || null;
      event._orgId = orgId;
      event._userEmail = payload.email || null;
      event._userSub = payload.sub || null;
      event._authMode = 'cognito';
      return handler(event, context);
    } catch (err) {
      console.error('Cognito JWT verification failed:', err.message);
      return {
        statusCode: 401,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: 'Unauthorized - invalid token' }),
      };
    }
  }

  // --- PATH 2: v5 app — API key ---
  if (apiKey && apiKey === API_KEY) {
    const orgId = event.headers?.['x-org-id'] || event.headers?.['X-Org-Id'] || null;
    event._orgId = orgId;
    event._authMode = 'apikey';
    return handler(event, context);
  }

  // --- PATH 3: Nothing valid ---
  return {
    statusCode: 401,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify({ error: 'Unauthorized' }),
  };
};

// Alias so all existing handlers work with zero changes
const validateCognito = validateApiKey;

module.exports = { validateApiKey, validateCognito };

// Updated: 2026-09-19 -- SECURITY FIX: replaced unsigned JWT base64-decode with real Cognito signature
// verification (aws-jwt-verify, checks signature against Cognito's JWKS + issuer + audience + expiry).
// org_id is now derived from the verified token's own 'sub' claim (one org per signup) -- no longer
// trusted from the client-supplied x-org-id header, which any caller could set to any value.
// Admin cross-org access (for QC) is granted via the verified custom:role=admin claim, exposed to
// handlers as event._isAdmin. The legacy x-api-key bypass path is removed entirely -- Cognito login
// is now required for every request.
const { CognitoJwtVerifier } = require('aws-jwt-verify');

const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID || 'us-east-1_HGvNxEFP6';
const CLIENT_ID     = process.env.COGNITO_CLIENT_ID     || '12tdr6tcnuvc7kn40ka1vubo6m';

// Verifier is created once per Lambda cold start and caches Cognito's public keys (JWKS) internally.
const verifier = CognitoJwtVerifier.create({
  userPoolId: USER_POOL_ID,
  tokenUse: 'id',
  clientId: CLIENT_ID,
});

const unauthorized = (message) => ({
  statusCode: 401,
  headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  body: JSON.stringify({ error: message }),
});

const validateApiKey = (handler) => async (event, context) => {
  const authHeader = event.headers?.['authorization'] || event.headers?.['Authorization'];

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return unauthorized('Unauthorized - missing bearer token');
  }

  const token = authHeader.slice(7);
  try {
    // Throws if the signature, issuer, audience (client id), or expiry don't check out.
    const payload = await verifier.verify(token);

    event._orgId     = payload.sub;
    event._userEmail = payload.email || null;
    event._userSub    = payload.sub;
    event._isAdmin     = payload['custom:role'] === 'admin';
    event._authMode     = 'cognito';
    return handler(event, context);
  } catch (err) {
    console.error('JWT verification failed:', err.message);
    return unauthorized('Unauthorized - invalid token');
  }
};

const validateCognito = validateApiKey;
module.exports = { validateApiKey, validateCognito };

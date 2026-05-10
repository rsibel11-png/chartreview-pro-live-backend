// Updated: 2026-05-10 — dual-mode auth: Cognito JWT (native) + API key (v5)
// Native: decodes JWT payload (base64) to extract sub/email — no crypto lib needed
// v5:     validates x-api-key header

const validateApiKey = (handler) => async (event, context) => {
  const authHeader = event.headers?.['authorization'] || event.headers?.['Authorization'];
  const apiKey = event.headers?.['x-api-key'] || event.headers?.['X-Api-Key'];

  // --- PATH 1: Native app — Cognito JWT Bearer token ---
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    try {
      // Decode JWT payload (middle segment) — base64url decode, no crypto verification
      const parts = token.split('.');
      if (parts.length !== 3) throw new Error('Invalid JWT structure');
      const payloadJson = Buffer.from(parts[1], 'base64').toString('utf8');
      const payload = JSON.parse(payloadJson);

      if (!payload.sub) throw new Error('No sub in JWT payload');

      // Check token not expired
      if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
        return {
          statusCode: 401,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
          body: JSON.stringify({ error: 'Unauthorized - token expired' }),
        };
      }

      const orgId = event.headers?.['x-org-id'] || event.headers?.['X-Org-Id'] || null;
      event._orgId = orgId;
      event._userEmail = payload.email || null;
      event._userSub = payload.sub;
      event._authMode = 'cognito';
      return handler(event, context);
    } catch (err) {
      console.error('JWT decode failed:', err.message);
      return {
        statusCode: 401,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: 'Unauthorized - invalid token' }),
      };
    }
  }

  // --- PATH 2: v5 app — API key ---
  if (apiKey && apiKey === process.env.API_KEY) {
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

const validateCognito = validateApiKey;
module.exports = { validateApiKey, validateCognito };

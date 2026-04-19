// Middleware: validates x-api-key header on every request
const validateApiKey = (handler) => async (event, context) => {
  const apiKey = event.headers?.['x-api-key'] || event.headers?.['X-Api-Key'];
  
  if (!apiKey || apiKey !== process.env.API_KEY) {
    return {
      statusCode: 401,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Unauthorized' }),
    };
  }

  // Extract org ID from header and inject into event for downstream handlers
  const orgId = event.headers?.['x-org-id'] || event.headers?.['X-Org-Id'] || event.headers?.['X-ORG-ID'];
  event._orgId = orgId || null;

  return handler(event, context);
};

module.exports = { validateApiKey };

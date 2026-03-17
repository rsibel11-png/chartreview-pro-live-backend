// Middleware: validates x-api-key header on every request
const validateApiKey = (handler) => async (event, context) => {
  const apiKey = event.headers?.['x-api-key'] || event.headers?.['X-Api-Key'];
  
  if (!apiKey || apiKey !== process.env.API_KEY) {
    return {
      statusCode: 401,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Unauthorized' }),
    };
  }

  return handler(event, context);
};

module.exports = { validateApiKey };

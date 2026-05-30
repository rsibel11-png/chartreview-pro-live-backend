'use strict';
const { APIGatewayClient, PutIntegrationResponseCommand, CreateDeploymentCommand } = require('@aws-sdk/client-api-gateway');

const client = new APIGatewayClient({ region: 'us-east-1' });

async function run() {
  const API_ID = '1h4kpspbs6';
  const RES_ID = 'uivykb';
  const STAGE  = 'prod';

  console.log('Setting OPTIONS integration response with CORS headers...');
  await client.send(new PutIntegrationResponseCommand({
    restApiId:   API_ID,
    resourceId:  RES_ID,
    httpMethod:  'OPTIONS',
    statusCode:  '200',
    responseParameters: {
      'method.response.header.Access-Control-Allow-Headers': "'Content-Type,Authorization,X-Api-Key,x-api-key,X-Org-Id,x-org-id'",
      'method.response.header.Access-Control-Allow-Methods': "'GET,OPTIONS'",
      'method.response.header.Access-Control-Allow-Origin':  "'*'",
    },
  }));
  console.log('OPTIONS integration response set.');

  console.log('Deploying stage...');
  const dep = await client.send(new CreateDeploymentCommand({
    restApiId: API_ID,
    stageName: STAGE,
  }));
  console.log('Deployed:', dep.id);
}

run().catch(e => { console.error(e); process.exit(1); });

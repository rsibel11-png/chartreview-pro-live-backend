#!/bin/bash
# Patches API Gateway OPTIONS integration responses to include x-org-id in CORS headers
set -e

API_ID="${API_ID:-1h4kpspbs6}"
STAGE="${STAGE:-prod}"
ALLOWED_HEADERS="'Content-Type,X-Amz-Date,Authorization,X-Api-Key,x-api-key,X-Org-Id,x-org-id,X-Amz-Security-Token'"

echo "Fetching API Gateway resources for $API_ID..."
RESOURCE_IDS=$(aws apigateway get-resources --rest-api-id "$API_ID" --query 'items[*].id' --output text)

PATCHED=0
for RESOURCE_ID in $RESOURCE_IDS; do
  # Check if OPTIONS method exists on this resource
  if aws apigateway get-method --rest-api-id "$API_ID" --resource-id "$RESOURCE_ID" --http-method OPTIONS > /dev/null 2>&1; then
    echo "  Patching resource $RESOURCE_ID..."
    aws apigateway update-integration-response \
      --rest-api-id "$API_ID" \
      --resource-id "$RESOURCE_ID" \
      --http-method OPTIONS \
      --status-code 200 \
      --patch-operations "op=replace,path=/responseParameters/method.response.header.Access-Control-Allow-Headers,value=$ALLOWED_HEADERS" \
      > /dev/null 2>&1 && PATCHED=$((PATCHED+1)) || echo "    (skipped - already up to date)"
  fi
done

echo "Patched $PATCHED resources. Deploying to stage $STAGE..."
aws apigateway create-deployment --rest-api-id "$API_ID" --stage-name "$STAGE" > /dev/null
echo "CORS patch complete."

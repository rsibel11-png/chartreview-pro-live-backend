#!/bin/bash
# Post-deploy CORS patch: ensures x-org-id is in Access-Control-Allow-Headers for all OPTIONS integrations

API_ID="1h4kpspbs6"
STAGE="prod"
REGION="us-east-1"
HEADERS="'Content-Type,X-Amz-Date,Authorization,X-Api-Key,x-api-key,X-Org-Id,x-org-id,X-Amz-Security-Token'"

echo "Fetching API Gateway resources..."
RESOURCES=$(aws apigateway get-resources --rest-api-id $API_ID --region $REGION --query 'items[*].id' --output text)

PATCHED=0
for RID in $RESOURCES; do
    HAS_OPTIONS=$(aws apigateway get-method --rest-api-id $API_ID --resource-id $RID --http-method OPTIONS --region $REGION 2>&1)
    if echo "$HAS_OPTIONS" | grep -q "httpMethod"; then
        echo "Patching resource $RID..."
        aws apigateway update-integration-response \
            --rest-api-id $API_ID \
            --resource-id $RID \
            --http-method OPTIONS \
            --status-code 200 \
            --region $REGION \
            --patch-operations "op=replace,path=/responseParameters/method.response.header.Access-Control-Allow-Headers,value=$HEADERS" 2>&1 | head -5
        PATCHED=$((PATCHED + 1))
    fi
done

echo "Patched $PATCHED resources. Creating deployment..."
aws apigateway create-deployment --rest-api-id $API_ID --stage-name $STAGE --region $REGION
echo "CORS patch complete!"

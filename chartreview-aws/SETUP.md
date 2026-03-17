# ChartReview Pro — AWS Backend Setup Guide

## Prerequisites
- Node.js installed
- AWS CLI installed and configured (`aws configure`)
- Serverless Framework installed (`npm install -g serverless`)

---

## Step 1 — Install dependencies
Open a terminal in this folder and run:
```
npm install
```

---

## Step 2 — Set your API key in AWS SSM
This is the secret key Base44 will use to authenticate with your API.
Choose a strong random string (32+ characters) and run:

```
aws ssm put-parameter --name "/chartreview/api-key" --value "YOUR_SECRET_KEY_HERE" --type SecureString --region us-east-1
```

Save this key — you'll need to add it to Base44 as a secret later.

---

## Step 3 — Deploy to AWS
```
npm run deploy
```

This will:
- Create 3 DynamoDB tables (patients, documents, summaries) — all encrypted at rest
- Create an S3 bucket with KMS encryption, versioning, and access logging
- Deploy all Lambda functions
- Set up API Gateway with all routes

Deployment takes about 2-3 minutes.

---

## Step 4 — Note your API URL
After deployment you'll see output like:
```
endpoints:
  POST - https://xxxxxxxxxx.execute-api.us-east-1.amazonaws.com/prod/patients
  GET  - https://xxxxxxxxxx.execute-api.us-east-1.amazonaws.com/prod/patients/{aws_patient_id}
  ...
```

Copy the base URL (e.g. https://xxxxxxxxxx.execute-api.us-east-1.amazonaws.com/prod)
You'll need this for Base44.

---

## Step 5 — Sign AWS BAA (REQUIRED for HIPAA)
1. Log into AWS Console
2. Go to AWS Artifact (search for it)
3. Click "Agreements"
4. Find "AWS Business Associate Addendum"
5. Review and accept it

This MUST be done before storing any real patient data.

---

## Step 6 — Add secrets to Base44
In Base44 (ChartReview Pro app), add two secrets:
- `AWS_API_URL` = your API Gateway base URL
- `AWS_API_KEY` = the key you set in Step 2

---

## Architecture Overview
```
Base44 UI
    ↓ (API calls with x-api-key header)
AWS API Gateway
    ↓
AWS Lambda (Node.js 18)
    ↓              ↓
DynamoDB        S3 Bucket
(PHI metadata)  (document files)
    
All data encrypted at rest (KMS)
All data encrypted in transit (HTTPS)
Access logs enabled
Point-in-time recovery enabled on all tables
```

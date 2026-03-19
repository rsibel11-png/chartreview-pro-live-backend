# ChartReview Pro — HIPAA Data Flow & Compliance Document

**Prepared:** March 18, 2026  
**Application:** ChartReview Pro  
**Architecture:** Hybrid — Base44 (UI) + AWS (PHI Storage)

---

## 1. Overview

ChartReview Pro uses a split architecture specifically designed to ensure that no Protected Health Information (PHI) is stored on the Base44 platform. All PHI — including patient names, dates of birth, case numbers, documents, and summaries — is stored exclusively in the operator's AWS account, which is covered by an active HIPAA Business Associate Agreement (BAA).

---

## 2. Data Classification

| Data Type | Contains PHI? | Where It Lives |
|---|---|---|
| Patient name | YES | AWS DynamoDB |
| Date of birth | YES | AWS DynamoDB |
| Case number | YES | AWS DynamoDB |
| Document files (PDFs, images) | YES | AWS S3 |
| Document metadata (file name, type) | YES | AWS DynamoDB |
| OCR extracted text | YES | AWS DynamoDB |
| Summaries / notes | YES | AWS DynamoDB |
| Notes Macros (templates) | NO | Base44 |
| Breach Notification logs | NO | Base44 |
| Feature Suggestions | NO | Base44 |
| UI state, navigation, app shell | NO | Base44 (in-memory only) |

---

## 3. Document Upload Flow (Step by Step)

```
User Browser
     │
     │  1. User selects file — stays in browser memory only
     │
     ▼
Base44 awsProxy Function (HTTPS)
     │
     │  2. Browser requests a presigned S3 upload URL
     │     Request passes through awsProxy which adds API key
     │     No PHI is logged or stored at this step
     │
     ▼
AWS API Gateway → AWS Lambda (getUploadUrl)
     │
     │  3. Lambda creates a document record in DynamoDB
     │     Generates a presigned S3 URL (valid 5 minutes)
     │     Returns the URL to the browser
     │
     ▼
User Browser
     │
     │  4. Browser uploads file DIRECTLY to S3
     │     Base44 servers are NOT in this path
     │     File goes: Browser → AWS S3 only
     │
     ▼
AWS S3 (Encrypted at rest — AES-256 via KMS)
     │
     │  5. Document stored in private, versioned S3 bucket
     │     Bucket is fully blocked from public access
     │     Access logs written to separate logging bucket
     │
     ▼
AWS Lambda (processDocument) — optional OCR step
     │
     │  6. AWS Textract extracts text from document
     │     Extracted text stored in DynamoDB only
     │     Never sent back to Base44
```

---

## 4. Data Retrieval Flow

When a user views a document:

1. Browser requests a **presigned download URL** via awsProxy → AWS Lambda
2. Lambda generates a time-limited (5-minute) signed S3 URL
3. Browser fetches the file **directly from S3** — Base44 not in the path
4. File is displayed in the browser, never stored on Base44 servers

---

## 5. AWS Infrastructure (HIPAA Controls)

| Control | Implementation |
|---|---|
| BAA | Active — accepted via AWS Artifact |
| Encryption at rest | S3: AES-256 via AWS KMS. DynamoDB: SSE enabled |
| Encryption in transit | HTTPS/TLS on all API calls and S3 transfers |
| Access control | S3 bucket fully private, no public access |
| Audit logging | S3 access logs enabled to dedicated logging bucket |
| Data backup | DynamoDB Point-in-Time Recovery (PITR) enabled |
| Versioning | S3 versioning enabled — deleted files are recoverable |
| Authentication | All Lambda endpoints require x-api-key header |
| Region | us-east-1 (United States) |

---

## 6. Base44 Platform Role

Base44 serves exclusively as the **user interface layer**. It:

- Renders the application UI
- Authenticates users (app-level login)
- Proxies API requests to AWS (adding the API key securely)
- Stores only non-PHI operational data (macros, suggestions, breach logs)

Base44 does **not**:
- Store any patient data
- Store any document files or content
- Log or cache PHI passing through the proxy function
- Have access to AWS S3 or DynamoDB directly

---

## 7. Breach Notification

In the event of a suspected breach:

1. Log it immediately in the ChartReview Pro Breach Notification entity (Base44)
2. Investigate whether the breach originated in AWS (S3/DynamoDB) or the Base44 UI layer
3. If PHI was involved, notify affected individuals within 60 days per HIPAA Breach Notification Rule
4. If breach affects 500+ individuals, notify HHS and prominent media outlets in affected states
5. Document all investigation notes in the Breach Notification record

---

## 8. Key Contacts & Resources

| Item | Value |
|---|---|
| AWS Account BAA | Active via AWS Artifact |
| AWS Region | us-east-1 |
| AWS API Gateway | https://1h4kpspbs6.execute-api.us-east-1.amazonaws.com/prod |
| S3 Bucket | chartreview-pro-files-prod |
| DynamoDB Tables | chartreview-pro-patients-prod, chartreview-pro-documents-prod, chartreview-pro-summaries-prod |
| Base44 App | https://friday-app-3f4e9d76.base44.app |

---

*This document should be retained as part of your HIPAA compliance documentation package.*

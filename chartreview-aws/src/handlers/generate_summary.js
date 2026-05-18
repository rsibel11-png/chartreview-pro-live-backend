// Updated: 2026-05-10 — Ruthless concision pass: tightened persona, HPI 2-3s, exam 3-findings, tx 2-3 items, global no-filler mandate
// Surgical swaps only:
//   1. base44.integrations.Core.InvokeLLM({ file_urls, prompt, response_json_schema })
//      → callBedrock(fileKeys, prompt, schema) via S3 fetch + Bedrock InvokeModelCommand
//   2. awsProxy(`/documents/${id}/download-url`) → resolveFileKey(doc) from DynamoDB
//   3. Wrap generateSummary logic with job tracking (write status to chartreview-jobs-prod)
// All other logic (BATCH_SIZE, VI_CONCURRENCY, runBatch, recovery pass, C-4 pass,
// sanitizeVisits, deduplicateVisits, enforceOneC4, buildPrompt, buildVisitIndexPrompt)
// is identical to v56 MedicalSummaries.jsx.

const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, UpdateCommand, PutCommand } = require('@aws-sdk/lib-dynamodb');
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
const { randomUUID } = require('crypto');
const { PDFDocument } = require('pdf-lib');
const { validateApiKey } = require('./auth');

const s3      = new S3Client({ region: process.env.AWS_REGION || 'us-east-1', requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' });
const dynamo  = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const lambda  = new LambdaClient({ region: process.env.AWS_REGION || 'us-east-1' });

const BUCKET        = process.env.S3_BUCKET            || 'chartreview-documents-prod';
const DOCS_TABLE      = process.env.DOCUMENTS_TABLE       || 'chartreview-documents-prod';
const JOBS_TABLE      = process.env.JOBS_TABLE            || 'chartreview-jobs-prod';
const SUMMARIES_TABLE = process.env.SUMMARIES_TABLE       || 'chartreview-summaries-prod';
const USAGE_TABLE   = process.env.BEDROCK_USAGE_TABLE   || 'chartreview-bedrock-usage';
const WORKER_FN        = process.env.GENERATE_WORKER_FUNCTION_NAME       || 'chartreview-pro-prod-generateSummaryWorker';

// ─── Multi-region Bedrock router ─────────────────────────────────────────────
// Each region has an independent daily token quota. We track usage per region
// in DynamoDB and pick the least-used region at call time.
// Regions are tried in order of ascending tokens_used_today.
const CANDIDATE_REGIONS = [
  // US cross-region profiles — each has its own independent daily quota.
  // The 'us.' prefix profiles route across us-east-1/us-east-2/us-west-2 automatically.
  // eu/ap model IDs differ per region and require separate validation — excluded for now.
  {
    region: 'us-east-1',
    models: ['us.anthropic.claude-sonnet-4-6', 'us.anthropic.claude-3-5-haiku-20241022-v1:0'],
  },
  {
    region: 'us-east-2',
    models: ['us.anthropic.claude-sonnet-4-6', 'us.anthropic.claude-3-5-haiku-20241022-v1:0'],
  },
  {
    region: 'us-west-2',
    models: ['us.anthropic.claude-sonnet-4-6', 'us.anthropic.claude-3-5-haiku-20241022-v1:0'],
  },
];

// Cache Bedrock clients per region (avoid re-creating on every call)
const bedrockClientCache = {};
const getBedrockClient = (region) => {
  if (!bedrockClientCache[region]) {
    bedrockClientCache[region] = new BedrockRuntimeClient({ region });
  }
  return bedrockClientCache[region];
};

// Read token usage for all regions from DynamoDB
const getRegionUsage = async () => {
  const usage = {};
  await Promise.all(CANDIDATE_REGIONS.map(async ({ region }) => {
    try {
      const r = await dynamo.send(new GetCommand({
        TableName: USAGE_TABLE,
        Key: { region_id: region },
      }));
      const item = r.Item;
      if (item) {
        // Check if the record is from today (UTC) — reset if not
        const today = new Date().toISOString().slice(0, 10);
        if (item.date_utc === today) {
          usage[region] = item.tokens_used_today || 0;
        } else {
          usage[region] = 0; // stale record — treat as empty
        }
      } else {
        usage[region] = 0;
      }
    } catch (e) {
      console.warn(`getRegionUsage: failed for ${region}:`, e.message);
      usage[region] = 0;
    }
  }));
  return usage;
};

// Increment token usage counter for a region
const incrementRegionUsage = async (region, tokensUsed) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    await dynamo.send(new UpdateCommand({
      TableName: USAGE_TABLE,
      Key: { region_id: region },
      UpdateExpression: 'SET tokens_used_today = if_not_exists(tokens_used_today, :zero) + :inc, date_utc = :date, last_updated = :now',
      ExpressionAttributeValues: {
        ':inc': tokensUsed,
        ':zero': 0,
        ':date': today,
        ':now': new Date().toISOString(),
      },
    }));
  } catch (e) {
    console.warn(`incrementRegionUsage: failed for ${region}:`, e.message);
    // Non-fatal — don't let usage tracking break the main flow
  }
};

// Mark a region as fully exhausted — sets a very high token count so it's
// deprioritized for the rest of the day across all concurrent jobs
const saturateRegion = async (region) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    await dynamo.send(new UpdateCommand({
      TableName: USAGE_TABLE,
      Key: { region_id: region },
      UpdateExpression: 'SET tokens_used_today = :max, date_utc = :date, last_updated = :now',
      ExpressionAttributeValues: {
        ':max': 999999999,
        ':date': today,
        ':now': new Date().toISOString(),
      },
    }));
    console.log(`saturateRegion: marked ${region} as exhausted for today`);
  } catch (e) {
    console.warn(`saturateRegion: failed for ${region}:`, e.message);
  }
};

// Pick the region with the lowest token usage today.
// Time-of-day heuristic: deprioritize US regions during US business hours (13:00-23:00 UTC = 9am-7pm ET)
const selectBestRegions = (usage) => {
  const hourUtc = new Date().getUTCHours();
  const isUSBusinessHours = hourUtc >= 13 && hourUtc < 23;

  const sorted = [...CANDIDATE_REGIONS].sort((a, b) => {
    let usageA = usage[a.region] || 0;
    let usageB = usage[b.region] || 0;
    // During US business hours, add a penalty to US regions to prefer EU/AP
    if (isUSBusinessHours) {
      if (['us-east-1','us-east-2','us-west-2'].includes(a.region)) usageA += 5_000_000;
      if (['us-east-1','us-east-2','us-west-2'].includes(b.region)) usageB += 5_000_000;
    }
    return usageA - usageB;
  });

  // Filter out regions already saturated (marked exhausted today)
  const available = sorted.filter(r => (usage[r.region] || 0) < 900000000);
  const skipped   = sorted.filter(r => (usage[r.region] || 0) >= 900000000);
  if (skipped.length) console.log(`selectBestRegions: skipping exhausted: ${skipped.map(r => r.region).join(', ')}`);

  console.log(`selectBestRegions: hour=${hourUtc}UTC, isUSBizHours=${isUSBusinessHours}`);
  console.log('selectBestRegions order:', available.map(r => `${r.region}(${usage[r.region]||0})`).join(' → '));
  return available.length ? available : sorted;
};

const httpResponse = (statusCode, body) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,x-api-key,x-org-id',
  },
  body: JSON.stringify(body),
});

// Fetch a PDF from S3 and slice it to only the requested pages (1-based).
// Returns a Buffer of the new mini-PDF. Uses pdf-lib — pure JS, no native deps.
const slicePdfPages = async (fileKey, pages) => {
  const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: fileKey }));
  const chunks = [];
  for await (const chunk of obj.Body) chunks.push(chunk);
  const fullBuffer = Buffer.concat(chunks);

  const srcDoc = await PDFDocument.load(fullBuffer, { ignoreEncryption: true });
  const totalPages = srcDoc.getPageCount();

  // Convert 1-based page numbers to 0-based indices, clamp to valid range
  const indices = [...new Set(pages)]
    .map(p => p - 1)
    .filter(i => i >= 0 && i < totalPages)
    .sort((a, b) => a - b);

  if (!indices.length) {
    console.warn(`slicePdfPages: no valid page indices for ${fileKey}, pages=${pages}`);
    return fullBuffer; // fallback: return full PDF
  }

  const newDoc = await PDFDocument.create();
  const copied = await newDoc.copyPagesFrom(srcDoc, indices);
  copied.forEach(page => newDoc.addPage(page));

  const slicedBytes = await newDoc.save();
  console.log(`slicePdfPages: ${fileKey} sliced to pages [${pages.join(',')}] → ${indices.length} pages, ${slicedBytes.length} bytes`);
  return Buffer.from(slicedBytes);
};

// ─── AWS swap #1: replaces InvokeLLM ─────────────────────────────────────────
// Original: base44.integrations.Core.InvokeLLM({ prompt, file_urls, response_json_schema })
// New: fetch each PDF from S3 as base64, send to Bedrock with same prompt + schema
// regionOrder is optional — if not provided, we fetch usage from DynamoDB and sort
// pageScope: optional array of 1-based page numbers — if provided, slices PDF before sending
const callBedrock = async (fileKeys, prompt, schema, regionOrder, pageScope = null) => {
  // Build content array: one document block per PDF (mirrors file_urls behavior)
  // If pageScope provided, slice each PDF to only those pages before sending —
  // Claude gets a clean mini-PDF with no noise from other encounters.
  const contentBlocks = [];
  for (const fileKey of fileKeys) {
    const pdfBuffer = pageScope && pageScope.length > 0
      ? await slicePdfPages(fileKey, pageScope)
      : await (async () => {
          const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: fileKey }));
          const chunks = [];
          for await (const chunk of obj.Body) chunks.push(chunk);
          return Buffer.concat(chunks);
        })();
    const pdfBase64 = pdfBuffer.toString('base64');
    contentBlocks.push({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 },
    });
  }
  contentBlocks.push({ type: 'text', text: prompt });

  const bedrockPayload = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 8000,
    system: NARRATIVE_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: contentBlocks }],
    tools: [{
      name: 'structured_output',
      description: 'Return structured data',
      input_schema: schema,
    }],
    tool_choice: { type: 'tool', name: 'structured_output' },
  };

  // Use provided region order, or fetch fresh usage and sort
  const orderedRegions = regionOrder || selectBestRegions(await getRegionUsage());

  let lastErr;
  for (const candidate of orderedRegions) {
    const { region, models } = candidate;
    for (const modelId of models) {
      try {
        console.log(`callBedrock: trying region=${region} model=${modelId}`);
        const client = getBedrockClient(region);
        const cmd = new InvokeModelCommand({
          modelId,
          contentType: 'application/json',
          accept: 'application/json',
          body: JSON.stringify(bedrockPayload),
        });
        const res = await client.send(cmd);
        const parsed = JSON.parse(Buffer.from(res.body).toString('utf-8'));
        const toolUse = parsed.content?.find(b => b.type === 'tool_use');
        if (!toolUse) throw new Error('Bedrock returned no tool_use block');
        console.log(`callBedrock: success region=${region} model=${modelId}`);
        console.log('callBedrock input keys: ' + Object.keys(toolUse.input || {}).join(','));
        // Increment usage counter (estimate ~5000 tokens per call)
        await incrementRegionUsage(region, 5000);
        return toolUse.input;
      } catch (err) {
        const isThrottle = err.message?.includes('Too many tokens') ||
                           err.name === 'ThrottlingException' ||
                           err.$metadata?.httpStatusCode === 429;
        const isTooLong = err.message?.includes('Input is too long');
        console.warn(`callBedrock: region=${region} model=${modelId} failed — ${err.message}`);
        lastErr = err;
        if (isTooLong) throw err;    // oversized doc — no point trying other models/regions
        if (!isThrottle) throw err;  // non-throttle errors: don't try other models
        // throttled: try next model in this region, then next region
      }
    }
    // All models in this region were throttled — mark it saturated so future calls skip it
    if (lastErr) {
      const isRegionThrottled = lastErr.message?.includes('Too many tokens') ||
                                lastErr.name === 'ThrottlingException' ||
                                lastErr.$metadata?.httpStatusCode === 429;
      if (isRegionThrottled) await saturateRegion(region);
    }
  }
  throw lastErr; // all regions + models exhausted
};

// Text-only Bedrock call — no PDF, just a plain text prompt.
// Used by VI pre-pass to read extracted_text from DynamoDB (free, no vision tokens).
const callBedrockText = async (textContent, prompt, schema, regionOrder) => {
  const bedrockPayload = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 8000,
    system: NARRATIVE_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: [
      { type: 'text', text: `DOCUMENT TEXT:\n\`\`\`\n${textContent}\n\`\`\`` },
      { type: 'text', text: prompt },
    ]}],
    tools: [{
      name: 'structured_output',
      description: 'Return structured data',
      input_schema: schema,
    }],
    tool_choice: { type: 'tool', name: 'structured_output' },
  };

  const orderedRegions = regionOrder || selectBestRegions(await getRegionUsage());
  let lastErr;
  for (const candidate of orderedRegions) {
    const { region, models } = candidate;
    for (const modelId of models) {
      try {
        console.log(`callBedrockText: trying region=${region} model=${modelId}`);
        const client = getBedrockClient(region);
        const cmd = new InvokeModelCommand({
          modelId,
          contentType: 'application/json',
          accept: 'application/json',
          body: JSON.stringify(bedrockPayload),
        });
        const res = await client.send(cmd);
        const parsed = JSON.parse(Buffer.from(res.body).toString('utf-8'));
        const toolUse = parsed.content?.find(b => b.type === 'tool_use');
        if (!toolUse) throw new Error('Bedrock returned no tool_use block');
        console.log(`callBedrockText: success region=${region} model=${modelId}`);
        await incrementRegionUsage(region, 2000); // text-only calls are cheaper
        return toolUse.input;
      } catch (err) {
        const isThrottle = err.message?.includes('Too many tokens') ||
                           err.name === 'ThrottlingException' ||
                           err.$metadata?.httpStatusCode === 429;
        console.warn(`callBedrockText: region=${region} model=${modelId} failed — ${err.message}`);
        lastErr = err;
        if (!isThrottle) throw err;
      }
    }
    if (lastErr) {
      const isThrottled = lastErr.message?.includes('Too many tokens') ||
                          lastErr.name === 'ThrottlingException' ||
                          lastErr.$metadata?.httpStatusCode === 429;
      if (isThrottled) await saturateRegion(region);
    }
  }
  throw lastErr;
};

// Pre-fetch region order once per job to avoid N DynamoDB reads per batch
const getRegionOrder = async () => {
  const usage = await getRegionUsage();
  return selectBestRegions(usage);
};

// ─── AWS swap #2: replaces awsProxy(/documents/${id}/download-url) ────────────
// Original: awsProxy(`/documents/${id}/download-url`) → { download_url }
// New: look up DynamoDB record → return file_key for S3 fetch
const resolveFileKey = (doc) => {
  if (doc.file_key) return doc.file_key;
  if (doc.org_id && doc.aws_document_id && doc.file_name) {
    return `orgs/${doc.org_id}/documents/${doc.aws_document_id}/${doc.file_name}`;
  }
  return null;
};

// ─── Fetch all doc records from DynamoDB for given IDs ───────────────────────
const fetchDocRecords = async (docIds) => {
  const records = [];
  for (const id of docIds) {
    const r = await dynamo.send(new GetCommand({ TableName: DOCS_TABLE, Key: { aws_document_id: id } }));
    if (r.Item) records.push(r.Item);
    else console.warn(`fetchDocRecords: not found: ${id}`);
  }
  return records;
};

// ─── Job status helpers ───────────────────────────────────────────────────────
const markJobFailed = async (job_id, msg) => {
  await dynamo.send(new UpdateCommand({
    TableName: JOBS_TABLE, Key: { job_id },
    UpdateExpression: 'SET #s = :s, error_message = :e, updated_at = :now',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':s': 'failed', ':e': msg, ':now': new Date().toISOString() },
  }));
};

const markJobComplete = async (job_id, result) => {
  await dynamo.send(new UpdateCommand({
    TableName: JOBS_TABLE, Key: { job_id },
    UpdateExpression: 'SET #s = :s, #res = :r, updated_at = :now',
    ExpressionAttributeNames: { '#s': 'status', '#res': 'result' },
    ExpressionAttributeValues: { ':s': 'complete', ':r': result, ':now': new Date().toISOString() },
  }));
};

const setJobStatus = async (job_id, status_msg) => {
  try {
    await dynamo.send(new UpdateCommand({
      TableName: JOBS_TABLE, Key: { job_id },
      UpdateExpression: 'SET status_msg = :m, updated_at = :now',
      ExpressionAttributeValues: { ':m': status_msg, ':now': new Date().toISOString() },
    }));
  } catch (e) {
    console.warn('setJobStatus failed:', e.message);
  }
};

// ─── Ported verbatim from v56 MedicalSummaries.jsx ───────────────────────────

// ─── Original app logic (verbatim from chartreview-pro) + Claude 4.x brevity constraints ──

// Normalize provider name for dedup: strips credentials, punctuation,
// and sorts name tokens so "Chan, Holman MD" == "Holman Chan, MD"
// ─── sanitizeNarrativeVisits ──────────────────────────────────────────────────
// Lightweight cleaner for raw LLM narrative output from chunkWorker.
// Only cleans narrative fields — structural fields are NOT present yet at this stage.
// Full structural merge (mergeStructuredWithNarrative) runs in the coordinator
// where extracted_text is available.
const sanitizeNarrativeVisits = (visits) => {
  const narrativeFields = ['hpi_summary','chief_complaint','physical_exam_findings',
                           'imaging_findings','treatment_plan','pain_scale'];
  const validProgressions = ['improved','same','worse','not_documented'];
  return (visits || []).filter(v => v && typeof v === 'object').map(v => {
    const clean = { ...v };
    narrativeFields.forEach(f => {
      if (clean[f] === null || clean[f] === undefined) clean[f] = '';
      else if (typeof clean[f] !== 'string') clean[f] = String(clean[f]);
    });
    if (!validProgressions.includes(clean.symptom_progression)) {
      clean.symptom_progression = 'not_documented';
    }
    if (typeof clean.encounter_index !== 'number') {
      clean.encounter_index = null;
    }
    // Drop entries that are explicitly admin-only based on any hint the LLM returns
    // (shouldn't happen since we told it not to, but safety net)
    return clean;
  });
};


// ─── extractStructuredFields ──────────────────────────────────────────────────
// Pure regex extraction of deterministic fields from raw Textract extracted_text.
// No LLM involved. Called per-encounter in the coordinator BEFORE Bedrock fires.
// Returns: { date, diagnosis, icd10 }
//   date      — YYYY-MM-DD string, or null if no labeled field found
//   diagnosis — plain text string, or null if not found
//   icd10     — array of ICD-10 code strings (may be empty)
//
// Fallback hierarchy:
//   date: labeled EMR field (SERVICE DT etc.) > null (VI pre-pass date used instead)
//   diagnosis: labeled section header > null (LLM not used as fallback for diagnosis)
//
// Risk 2 mitigation: multi-line diagnosis captured (up to 5 continuation lines).
// Risk 3 mitigation: extra patterns for C-4 forms, radiology IMPRESSION.

const LABELED_DATE_PATTERNS = [
  /SERVICE\s*DT\s*[:\-]?\s*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i,
  /ADMIT\s*(?:DATE|DT)\s*[:\-]?\s*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i,
  /TRIAGE\s*(?:DATE|DT)\s*[:\-]?\s*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i,
  /DATE\s*OF\s*SERVICE\s*[:\-]?\s*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i,
  /ENCOUNTER\s*DATE\s*[:\-]?\s*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i,
  /REP\s*SRV\s*DT\s*[:\-]?\s*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i,
  /VISIT\s*DATE\s*[:\-]?\s*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i,
];

// Diagnosis patterns: capture label + multi-line content (stop at next section header
// or blank line). Risk 2 + 3 mitigation.
const DIAGNOSIS_PATTERNS = [
  /(?:^|\n)[ \t]*(?:FINAL\s+)?DIAGNOSIS(?:\s*(?:OR NATURE OF ILLNESS\/INJURY)?)?\s*[:\-]\s*([\s\S]+?)(?=\n[ \t]*[A-Z][A-Z ]{2,}[:\-]|\n\n|$)/im,
  /(?:^|\n)[ \t]*ASSESSMENT(?:\s*AND\s*PLAN)?\s*[:\-]\s*([\s\S]+?)(?=\n[ \t]*[A-Z][A-Z ]{2,}[:\-]|\n\n|$)/im,
  /(?:^|\n)[ \t]*IMPRESSION\s*[:\-]\s*([\s\S]+?)(?=\n[ \t]*[A-Z][A-Z ]{2,}[:\-]|\n\n|$)/im,
  /(?:^|\n)[ \t]*CLINICAL\s*IMPRESSION\s*[:\-]\s*([\s\S]+?)(?=\n[ \t]*[A-Z][A-Z ]{2,}[:\-]|\n\n|$)/im,
  /(?:^|\n)[ \t]*RADIOLOGIC\s*(?:IMPRESSION|DIAGNOSIS)\s*[:\-]\s*([\s\S]+?)(?=\n[ \t]*[A-Z][A-Z ]{2,}[:\-]|\n\n|$)/im,
];

const parseDateString = (raw) => {
  if (!raw) return null;
  const s = raw.trim();
  const m1 = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (m1) {
    let [, mm, dd, yy] = m1;
    let year = parseInt(yy, 10);
    if (year < 100) year += 2000;
    const month = parseInt(mm, 10);
    const day   = parseInt(dd, 10);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
  }
  return null;
};

const extractStructuredFields = (rawText, providerHint) => {
  if (!rawText || typeof rawText !== 'string') return {};

  // ── DATE ──────────────────────────────────────────────────────────────────
  // Anchor to provider name if available; otherwise scan first 3000 chars
  let searchWindow = rawText.slice(0, 3000);
  if (providerHint) {
    const lastName = (providerHint.split(/[,\s]+/)[0] || '').replace(/[^a-zA-Z]/g, '');
    if (lastName.length > 2) {
      const idx = rawText.search(new RegExp(lastName, 'i'));
      if (idx !== -1) {
        const start = Math.max(0, idx - 2000);
        const end   = Math.min(rawText.length, idx + 1000);
        searchWindow = rawText.slice(start, end);
      }
    }
  }

  let extractedDate = null;
  for (const pattern of LABELED_DATE_PATTERNS) {
    const m = searchWindow.match(pattern);
    if (m && m[1]) {
      const parsed = parseDateString(m[1]);
      if (parsed) {
        // Take the EARLIEST labeled date found — handles multi-date headers
        if (!extractedDate || parsed < extractedDate) {
          extractedDate = parsed;
        }
      }
    }
  }

  // ── DIAGNOSIS ─────────────────────────────────────────────────────────────
  // Scan full text — diagnosis section can appear anywhere in the document
  let extractedDiagnosis = null;
  let extractedIcd10 = [];

  for (const pattern of DIAGNOSIS_PATTERNS) {
    const m = rawText.match(pattern);
    if (m && m[1]) {
      // Clean multi-line: collapse whitespace, trim, cap at 400 chars
      const diagText = m[1].replace(/\s+/g, ' ').trim().slice(0, 400);
      if (diagText.length > 2) {
        extractedDiagnosis = diagText;
        // ICD-10 codes: scan the diagnosis block ± surrounding context
        const diagIdx = rawText.indexOf(m[1]);
        const diagWindow = rawText.slice(Math.max(0, diagIdx - 50), diagIdx + m[1].length + 200);
        const icdPat = /\b([A-TV-Z][0-9][0-9A-Z](?:\.[0-9A-Z]{1,4})?)\b/g;
        const icdMatches = [];
        let icdM;
        while ((icdM = icdPat.exec(diagWindow)) !== null) {
          icdMatches.push(icdM[1]);
        }
        extractedIcd10 = [...new Set(icdMatches)];
        break; // use first matching pattern
      }
    }
  }

  return {
    date:      extractedDate,       // YYYY-MM-DD string or null
    diagnosis: extractedDiagnosis,  // string or null
    icd10:     extractedIcd10,      // string[] (may be empty)
  };
};

// ─── mergeStructuredWithNarrative ─────────────────────────────────────────────
// Assembles the final visit record by bolting deterministic fields (from
// encounter_index + extractStructuredFields) on top of LLM narrative output.
// LLM output cannot override date, provider, facility, diagnosis, or ICD-10.
//
// Risk 5 mitigation: encounter_id matching is defensive — falls back to
// position-based matching if encounter_id is missing or out of range.
//
// knownVisit: { date, provider, facility, visit_type, source_doc_id, pages }
// narrativeResult: { encounter_index?, hpi_summary, chief_complaint,
//                    physical_exam_findings, treatment_plan,
//                    symptom_progression, pain_scale, imaging_findings }
// rawText: extracted_text from the source document part (for date/diag extraction)

const mergeStructuredWithNarrative = (knownVisit, narrativeResult, rawText) => {
  // Step 1: Deterministic fields — locked, LLM cannot touch these
  const structured = extractStructuredFields(rawText || '', knownVisit.provider);

  // Date: prefer deterministic regex result; fall back to VI pre-pass date
  const visit_date = structured.date || knownVisit.date || '';
  if (structured.date && structured.date !== knownVisit.date) {
    console.log(`mergeStructured: date corrected ${knownVisit.date} → ${structured.date} (labeled field) [${knownVisit.provider}]`);
  }

  // Provider / facility / visit_type: always from encounter_index (VI pre-pass)
  const rendering_provider = (knownVisit.provider || '').trim();
  const practice_setting   = (knownVisit.facility  || '').trim();
  const visit_type         = (knownVisit.visit_type || '').trim();

  // Diagnosis: from regex extraction; empty string if not found
  // (LLM impression_diagnosis is no longer in the narrative schema)
  const impression_diagnosis = structured.diagnosis || '';
  const icd10_codes          = Array.isArray(structured.icd10) ? structured.icd10 : [];

  // Step 2: Narrative fields from LLM (safe — only narrative content)
  const nr = narrativeResult || {};
  const validProgressions = ['improved', 'same', 'worse', 'not_documented'];
  const symProg = nr.symptom_progression;

  return {
    visit_date,
    rendering_provider,
    practice_setting,
    visit_type,
    chief_complaint:         (nr.chief_complaint         || '').slice(0, 500),
    hpi_summary:             (nr.hpi_summary             || '').slice(0, 2000),
    injury_date:             '',
    pain_scale:              (nr.pain_scale              || '').slice(0, 20),
    symptom_progression:     validProgressions.includes(symProg) ? symProg : 'not_documented',
    physical_exam_findings:  (nr.physical_exam_findings  || '').slice(0, 1000),
    imaging_findings:        (nr.imaging_findings        || '').slice(0, 1000),
    lab_findings:            '',
    impression_diagnosis,
    icd10_codes,
    treatment_plan:          (nr.treatment_plan          || '').slice(0, 1000),
  };
};


const normalizeProviderForDedup = (raw) => {
  return (raw || '')
    .toLowerCase()
    .replace(/\b(md|do|pa-?c?|np|rn|dpt|ot|pt|lcsw|psyd|phd|ms|jr|sr|ii|iii)\b/gi, '')
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .split(' ')
    .filter(t => t.length > 1)   // strip single-letter initials (e.g. "B" middle initial)
    .sort()
    .join(' ').trim();
};

// Normalize practice_setting to a canonical document-type bucket for dedup.
// Handles common variants: "Operative Note - Full" → "operative report",
// "Consultation Report – Sunrise Hospital" → "consultation report", etc.
const normalizeSettingForDedup = (raw) => {
  const s = (raw || '').toLowerCase().replace(/[-–—]/g, ' ').trim();
  if (s.includes('operative note') || s.includes('operative report') || s.includes('op report')) return 'operative report';
  if (s.includes('consultation report') || s.includes('consult report')) return 'consultation report';
  if (s.includes('history & physical') || s.includes('history and physical') || s.includes('h&p') || s.includes('h & p')) return 'history and physical';
  if (s.includes('discharge summary') || s.includes('discharge report') || s.includes('ed discharge')) return 'discharge summary';
  if (s.includes('hospitalist progress') || s.includes('progress note')) return 'progress note';
  if (s.includes('emergency department') || s.includes('emergency provider') || s.includes('ed visit')) return 'emergency department';
  if (s.includes('radiology report') || s.includes('radiology')) return 'radiology report';
  if (s.includes('c-4') || s.includes('c4 ') || s.includes("employee's claim")) return 'c4';
  // For office visits and anything else, use full normalized string so same-date same-provider office visits dedup
  return s.replace(/\s+/g, ' ').trim();
};


// ── Merge same-date ED visits ─────────────────────────────────────────────────
// When multiple providers document the same ED encounter (e.g. attending + PA),
// the model returns separate entries. Merge them: keep the richest content per field.
const mergeEdVisits = (visits) => {
  const edGroups = {};
  const nonEd = [];

  visits.forEach(v => {
    const s = (v.practice_setting || '').toLowerCase();
    const t = (v.visit_type || '').toLowerCase();
    const isED = t.includes('er') || t.includes('emergency') || t.includes('ed') ||
                 s.includes('emergency') || s.includes('emergency department') ||
                 s.includes('emergency provider');
    if (!isED || !v.visit_date) { nonEd.push(v); return; }

    // Group by date + first word of facility (e.g. "Sunrise")
    const facilityWord = (v.practice_setting || '').split(/[\s\-–—,]/)[0].toLowerCase();
    const groupKey = `${v.visit_date}|${facilityWord}`;
    if (!edGroups[groupKey]) edGroups[groupKey] = [];
    edGroups[groupKey].push(v);
  });

  const merged = [];
  Object.values(edGroups).forEach(group => {
    if (group.length === 1) { merged.push(group[0]); return; }

    // Pick the entry with the most content as base
    const base = group.slice().sort((a, b) => {
      const scoreA = ['hpi_summary','treatment_plan','impression_diagnosis','chief_complaint']
        .reduce((s, f) => s + (a[f] || '').length, 0);
      const scoreB = ['hpi_summary','treatment_plan','impression_diagnosis','chief_complaint']
        .reduce((s, f) => s + (b[f] || '').length, 0);
      return scoreB - scoreA;
    })[0];

    // Merge: for each field, keep the longer value
    const result = { ...base };
    const textFields = ['hpi_summary','treatment_plan','impression_diagnosis','chief_complaint','physical_examination','pain_scale'];
    group.forEach(other => {
      if (other === base) return;
      textFields.forEach(f => {
        if ((other[f] || '').length > (result[f] || '').length) result[f] = other[f];
      });
      // Merge providers: combine if different
      const baseProvider = (result.rendering_provider || '').trim();
      const otherProvider = (other.rendering_provider || '').trim();
      if (otherProvider && !baseProvider.includes(otherProvider.split(',')[0])) {
        result.rendering_provider = `${baseProvider} / ${otherProvider}`;
      }
      // Merge ICD codes
      const codes = new Set([...(result.icd10_codes || []), ...(other.icd10_codes || [])]);
      result.icd10_codes = Array.from(codes);
    });

    console.log(`mergeEdVisits: merged ${group.length} ED entries on ${base.visit_date} into one`);
    merged.push(result);
  });

  // Re-sort by date after merge
  return [...nonEd, ...merged].sort((a, b) => (a.visit_date || '').localeCompare(b.visit_date || ''));
};

const deduplicateVisits = (visits) => {
  const visitList = visits || [];

  // Exact dedup: same date + normalized-provider + canonical-setting-type
  const exactKeys = new Set();
  const deduped = visitList.filter((visit) => {
    const dateKey     = (visit.visit_date || '').trim();
    const providerKey = normalizeProviderForDedup(visit.rendering_provider);
    const settingKey  = normalizeSettingForDedup(visit.practice_setting);
    if (!dateKey && !providerKey) return true;
    const key = `${dateKey}|${providerKey}|${settingKey}`;
    if (exactKeys.has(key)) {
      console.log(`deduplicateVisits: dropping duplicate ${dateKey} ${visit.rendering_provider} [${visit.practice_setting}]`);
      return false;
    }
    exactKeys.add(key);
    return true;
  });

  return deduped;
};


// ── ED visit date corrector ───────────────────────────────────────────────────
// Hospital ED notes are often signed the following day. The model uses the header
// (signature) date. This function scans the treatment_plan for medication
// administration timestamps and uses the earliest one if it precedes the visit date.
// Example: note signed 10/02, meds show "(10/01 1937)" → corrected to 2025-10-01.

const sanitizeVisits = (visits, patientName) => {
  const stringFields = ['visit_date','rendering_provider','practice_setting','chief_complaint','hpi_summary','injury_date','pain_scale','symptom_progression','physical_exam_findings','imaging_findings','lab_findings','impression_diagnosis','treatment_plan'];
  const validProgressions = ['improved','same','worse','not_documented'];
  return (visits || []).map(visit => {
    const clean = { ...visit };
    stringFields.forEach(field => {
      const val = clean[field];
      if (val === null || val === undefined || val === false) clean[field] = '';
      else if (typeof val === 'object') clean[field] = JSON.stringify(val);
      else if (typeof val !== 'string') clean[field] = String(val);
    });
    if (!Array.isArray(clean.icd10_codes)) clean.icd10_codes = [];
    if (!validProgressions.includes(clean.symptom_progression)) clean.symptom_progression = 'not_documented';
    const patientLower = patientName?.toLowerCase();
    if (clean.practice_setting && patientLower && clean.practice_setting.toLowerCase().includes(patientLower)) {
      clean.practice_setting = '';
    }
    return clean;
  }).filter(visit => {
    // Code-level safety net: drop non-clinical document types even if the model extracted them
    const setting = (visit.practice_setting || '').toLowerCase();
    const provider = (visit.rendering_provider || '').toLowerCase();
    const isPPR = setting.includes("physician's progress report") ||
                  setting.includes("physicians progress report") ||
                  setting.includes("physician progress report") ||
                  setting === 'ppr';
    const isCodingSummary = setting.includes('coding summary') ||
                            setting.includes('coding abstract') ||
                            provider.includes('abstractor') ||
                            provider.includes('cacuser') ||
                            provider.includes('coder:');
    // C-4 forms are ALWAYS clinical — exempt before any other check
    const isC4 = setting.includes('c-4') || setting.includes('c4 ') ||
                 setting.includes("workers' compensation report") ||
                 (visit.visit_type || '').toLowerCase().includes('c-4');
    const isAdminOnly = !isC4 && (
                        setting.includes('appointment reminder') ||
                        setting.includes('face sheet') ||
                        setting.includes('authorization request') ||
                        setting.includes('fax cover') ||
                        setting.includes('authorization for operative') ||
                        setting.includes('consent for') ||
                        setting.includes('surgical consent') ||
                        setting.includes('informed consent'));
    const skip = !isC4 && (isPPR || isCodingSummary || isAdminOnly);
    if (skip) console.log(`sanitizeVisits: dropping non-clinical entry [${visit.practice_setting}] (${visit.visit_date} ${visit.rendering_provider})`);
    return !skip;
  });
};

const enforceOneC4 = (visitList) => {
  const c4s = visitList.filter(v => (v.practice_setting || '').toLowerCase().includes('c-4'));
  if (c4s.length <= 1) return visitList;
  const sorted = [...c4s].sort((a, b) => (a.visit_date || '').localeCompare(b.visit_date || ''));
  const keepId = sorted[0];
  return visitList.filter(v => {
    if ((v.practice_setting || '').toLowerCase().includes('c-4')) return v === keepId;
    return true;
  });
};


// ── Forensic analyst system prompt ───────────────────────────────────────────
// Injected as the Bedrock `system` field on every extraction call.
// This sets Claude's operating mode before it reads a single word of document content.
const NARRATIVE_SYSTEM_PROMPT = `You are a medical narrative summarizer working on legal-quality medical record summaries. Your work product is read by attorneys in workers' compensation and personal injury proceedings.

Your sole task is to extract the narrative clinical content from each document — what the clinician observed, what the patient reported, and what was done. Nothing else.

Absolute rules:
1. Extract ONLY from the document you are currently reading. Never borrow language from adjacent or same-date documents.
2. Do not infer. If a field is not documented, return an empty string.
3. Do not include dates, provider names, diagnoses, ICD codes, or facility names in any narrative field — those are handled separately.
4. Be ruthlessly concise. Every word must earn its place. No filler, no restatement of headers.
5. If a document is a PPR, Coding Summary, Consent Form, or Appointment Reminder — return no entry for it.`;



// ─── buildNarrativePrompt ─────────────────────────────────────────────────────
// Replaces buildPrompt. Asks LLM ONLY for narrative content.
// Structural fields (date, provider, facility, diagnosis, ICD-10) are excluded —
// they are extracted deterministically by extractStructuredFields() and locked
// from encounter_index before the LLM is ever invoked.
const buildNarrativePrompt = (chunkLabel, knownVisits) => {
  const visits = Array.isArray(knownVisits) ? knownVisits : [];
  const multiDocNote = visits.length > 0
    ? `You are analyzing ${visits.length} clinical encounter(s)${chunkLabel ? ' ' + chunkLabel : ''}. Extract narrative content for EACH encounter separately.`
    : `You are analyzing one or more clinical documents${chunkLabel ? ' ' + chunkLabel : ''}. Extract narrative content for each encounter found.`;

  // For page-scoped batches (single encounter), we include a simple encounter label
  // so the LLM knows what document type it is reading (helps with C-4 / Radiology rules)
  // but does NOT reveal date, provider, or diagnosis.
  const encounterHints = visits.length > 0
    ? `\n\nDOCUMENT TYPE HINTS (to guide extraction rules — do not echo these back):\n` +
      visits.map((v, i) =>
        `Encounter ${i + 1}: [${v.visit_type || 'Clinical Note'}]`
      ).join('\n')
    : '';

  return `${multiDocNote}

WHAT YOU EXTRACT (narrative content only):
For each clinical encounter in the document(s), return:
1. hpi_summary — History of Present Illness as documented in THIS document only. Patient-reported symptoms, onset, mechanism, and progression. 2-3 sentences max. Do NOT include dates, provider names, or diagnoses.
2. chief_complaint — One sentence. Stated reason for the visit or document purpose.
3. physical_exam_findings — Key pertinent POSITIVE findings from the physical exam documented in THIS document. Abnormal findings only. 3 findings max. For operative notes: intraoperative findings. Empty string if no exam.
4. treatment_plan — Interventions performed or prescribed, medications (name + dose), activity restrictions, follow-up. 2-4 items. From THIS document only.
5. symptom_progression — One of exactly: "improved", "same", "worse", "not_documented"
6. pain_scale — Numeric pain score if documented (e.g. "7/10"). Empty string if not documented.
7. imaging_findings — Imaging performed or interpreted IN THIS document only. Empty string if none.

WHAT YOU DO NOT RETURN (handled deterministically — omit these fields entirely):
- visit_date
- rendering_provider
- practice_setting
- impression_diagnosis
- icd10_codes
- injury_date
- lab_findings

ABSOLUTE RULES:
- Each document is a bounded unit. Extract ONLY from the document you are currently reading.
- Do NOT import language from adjacent, co-occurring, or same-date documents.
- Do NOT include provider names, dates, or diagnoses anywhere in your narrative fields.
- A Consultation Report and an Operative Report on the same date are TWO separate documents — extract each independently as its own encounter entry.
- If information is not documented, return empty string "".

DOCUMENT-TYPE EXTRACTION RULES:
- PPR (Physician's Progress Report) — skip entirely, return no entry.
- Coding Summary / Billing Abstract — skip entirely, return no entry.
- Consent / Authorization Forms — skip entirely, return no entry.
- Appointment Reminders / Face Sheets — skip entirely, return no entry.
- C-4 Workers' Compensation Form — return entry with ALL narrative fields as empty strings.
- Radiology Report — hpi_summary: clinical indication only. imaging_findings: radiologist findings + impression. treatment_plan: empty.
- Police Report — hpi_summary: incident narrative. physical_exam_findings: officer scene observations. treatment_plan: emergency services dispatched.
- Ambulance/EMS Report — hpi_summary: scene description and patient condition. physical_exam_findings: vitals + neuro status. treatment_plan: interventions during transport.
${encounterHints}

DOCUMENT TEXT:
\`\`\`
{DOCUMENT_TEXT}
\`\`\`

Return JSON: { "visits": [ { "encounter_index": 1, "hpi_summary": "", "chief_complaint": "", "physical_exam_findings": "", "treatment_plan": "", "symptom_progression": "not_documented", "pain_scale": "", "imaging_findings": "" } ] }`;
};



const buildVisitIndexPrompt = () => {
  return `You are reviewing medical-legal documents. Your ONLY task is to extract a complete list of every clinical encounter date, provider name, and facility/location.

For each clinical encounter found, extract:
1. date - the date of service (YYYY-MM-DD format). For ED/hospital visits use the encounter START date — NOT the electronic signature date.
   PRIORITY ORDER for ED date (use the earliest you can find):
   a) Explicit fields: "Admit Date", "Triage Date", "Date of Service", "SERVICE DT", "Encounter Date" in the document header or vitals block
   b) Medication administration timestamps in the body (e.g. "Morphine 4mg IV (10/01 1937)" — this tells you the patient was present on 10/01)
   c) Nursing assessment timestamps (e.g. "VS at 2145 on 10/01")
   d) LAST resort: document header date (which is often the physician signature date, not the encounter start)
   EXAMPLE: Note header says "10/02/2025" but treatment plan shows "Morphine 4mg IV (10/01 1937)" → use 2025-10-01.
   A note signed 10/02 for a visit starting 10/01 → use 2025-10-01.
2. provider - the treating provider's name and credentials (e.g. "Arthur J. Taylor, MD")
3. facility - the facility or practice name (e.g. "Nevada Orthopedic & Spine Center", "Centennial Hills Hospital Emergency Department", "Dignity Health Physical Therapy")
4. visit_type - a brief label: "Office Visit", "ER Visit", "Surgery", "Physical Therapy", "Radiology", "C-4 Form", "IME", "Chiropractic", etc.

RULES:
- Include EVERY encounter -- office visits, ER, surgery, PT/OT, radiology, C-4 forms, IMEs, ambulance, etc.
- Each unique date + provider combination is a separate entry.
- Do NOT include administrative documents (therapy orders, authorization requests, appointment reminders, fax covers). ALWAYS include radiology visits (MRI, X-ray, CT, bone scan, etc.) -- these are clinical encounters.
- CRITICAL: The HPI section often mentions the date of injury -- this is NOT the visit date. The visit date is ALWAYS in the document header or vitals table.
- Do NOT include the date of injury as a visit date unless confirmed by a document header on that exact date.
- CRITICAL: If a date cannot be determined for an encounter, return an empty string "" for the date field. NEVER use placeholder text like "<UNKNOWN>", "unknown", "N/A", or any non-date string. The date field must be either a valid YYYY-MM-DD string or an empty string "".
- Keep it fast and simple -- no clinical content needed, just date/provider/facility/type.
- If a date appears in a document header but no provider is identifiable, still include the entry with provider as "Not Documented".
- For each encounter, return the pages field: a list of 1-based page numbers where that encounter's content appears. The document text contains explicit page boundary markers in the format '--- PAGE N ---'. Use these markers to determine which page numbers each encounter spans (e.g. a consult note that begins after '--- PAGE 12 ---' and ends before '--- PAGE 15 ---' → pages: [12,13,14]). If you cannot determine exact pages, return an empty array [].

HOSPITAL RADIOLOGY REPORTS — CRITICAL:
Large hospital records often contain embedded radiology reports formatted with a header block like:
  "[FACILITY] ER RADIOLOGY" / "PROCEDURE:" / "DATE:" / "FINDINGS:" / "IMPRESSION:" / "Electronically signed by: [Name] MD"
Each such report is a SEPARATE clinical encounter, even if its findings are also mentioned inside the ED note or H&P.
- Identify each radiology report by its own header (facility name, exam type, date, radiologist signature).
- The signing radiologist is the rendering_provider — NOT the ordering physician.
- The exam DATE field (e.g. "DATE: 10/1/2025 10:00 PM CDT") is the visit date for that report.
- Create one entry per report, per radiologist. If one radiologist reads the elbow XR and another reads the wrist XR on the same day, that is TWO separate entries.
- Do NOT collapse multiple radiology reports into the ED visit entry. They are independent encounters.

Return all entries in the visits array.`;
};

// ═══════════════════════════════════════════════════════════════════════════════
// GENERATE SUMMARY — CONCURRENT CHUNK ARCHITECTURE
// Updated: 2026-05-03
//
// Architecture:
//   generateSummaryWorker (coordinator):
//     1. Fetches doc records + builds allParts
//     2. Runs VI pre-pass (VI_CONCURRENCY=4) to build knownVisits checklist
//     3. Builds batches (BATCH_SIZE=1), splits into CHUNK_SIZE=20 slices
//     4. Fires all chunk-worker Lambdas simultaneously (Event invocation)
//     5. Polls DynamoDB for all chunk sub-jobs to complete (or fail)
//     6. Merges all partial visits, runs recovery pass, deduplicates
//     7. Marks parent job complete
//
//   generateSummaryChunkWorker:
//     - Receives { job_id, chunk_job_id, batches (serialized), knownVisits,
//                  patientName, totalBatches, chunkIndex }
//     - Runs BATCH_CONCURRENCY=4 over its slice of batches
//     - Writes partial visits + status to chunk sub-job record
//     - Marks chunk sub-job complete or failed
//
// Why: Lambda hard limit is 900s (15 min). 90 batches × ~10s each = 900s exactly.
// With 5 concurrent chunks of 20, each chunk finishes in ~2-3 min, well under limit.
// ═══════════════════════════════════════════════════════════════════════════════

const CHUNK_SIZE        = 20;   // batches per chunk worker
const BATCH_SIZE        = 1;    // docs per batch (isolated Bedrock call)
const BATCH_CONCURRENCY = 4;    // concurrent batches within a chunk
const CHUNK_FN          = process.env.GENERATE_CHUNK_WORKER_FUNCTION_NAME || 'chartreview-pro-prod-generateSummaryChunkWorker';

// ── generateSummaryChunkWorker ────────────────────────────────────────────────
// Processes a slice of batches, writes partial results to its chunk sub-job.

// ─── generateSummaryStart — receives API call, creates job, fires worker async ─
const generateSummaryStartHandler = async (event) => {
  const body = typeof event.body === 'string' ? JSON.parse(event.body) : (event.body || {});
  const { doc_ids, patient_name = '' } = body;
  const org_id = event._orgId || body.org_id || '';

  if (!doc_ids?.length) return httpResponse(400, { error: 'doc_ids required' });

  const job_id = randomUUID();
  await dynamo.send(new UpdateCommand({
    TableName: JOBS_TABLE, Key: { job_id },
    UpdateExpression: 'SET #s = :s, created_at = :now, updated_at = :now, job_type = :t, org_id = :oid',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':s': 'running', ':now': new Date().toISOString(), ':t': 'generate_summary', ':oid': org_id },
  }));

  // Fire the coordinator worker asynchronously
  await lambda.send(new InvokeCommand({
    FunctionName: WORKER_FN,
    InvocationType: 'Event',
    Payload: Buffer.from(JSON.stringify({ job_id, doc_ids, patient_name, org_id })),
  }));

  console.log(`generateSummaryStart: job_id=${job_id} docs=${doc_ids.length}`);
  return httpResponse(200, { job_id });
};

const generateSummaryChunkWorker = async (event) => {
  const {
    job_id,         // parent job (for status messages)
    chunk_job_id,   // this chunk's sub-job record
    batches,        // array of batch arrays (each batch = array of part objects)
    knownVisits,    // VI checklist from coordinator
    patientNameHint,
    chunkIndex,
    totalBatches,   // total across ALL chunks (for display)
    batchOffset,    // index of first batch in this chunk (for display)
  } = event;

  console.log(`chunkWorker[${chunkIndex}] start: ${batches.length} batches, chunk_job_id=${chunk_job_id}`);

  // Pre-fetch region order once for this chunk worker (avoids DynamoDB read per batch)
  const regionOrder = await getRegionOrder();
  console.log(`chunkWorker[${chunkIndex}] regionOrder: ${regionOrder.map(r => r.region).join(' → ')}`);

  const chunkVisits = [];
  let patientName   = patientNameHint || '';
  let caseNumber    = '';

  const fullSchema = {
    type: 'object',
    properties: {
      visits: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            encounter_index:       { type: 'integer' },
            chief_complaint:       { type: 'string' },
            hpi_summary:           { type: 'string' },
            pain_scale:            { type: 'string' },
            symptom_progression:   { type: 'string', enum: ['improved', 'same', 'worse', 'not_documented'] },
            physical_exam_findings:{ type: 'string' },
            imaging_findings:      { type: 'string' },
            treatment_plan:        { type: 'string' },
          },
        },
      },
    },
  };

  const simplifiedSchema = {
    type: 'object',
    properties: {
      visits: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            encounter_index:  { type: 'integer' },
            hpi_summary:      { type: 'string' },
            treatment_plan:   { type: 'string' },
          },
        },
      },
    },
  };

  const runBatch = async (batch, batchIndex, knownVisitsChecklist = [], pageScope = null) => {
    const fileKeys = batch.map(p => p.file_key).filter(Boolean);
    if (!fileKeys.length) {
      console.warn(`Chunk[${chunkIndex}] Batch ${batchIndex + 1}: no valid file keys, skipping`);
      return null;
    }
    const globalBatchNum = batchOffset + batchIndex + 1;
    const batchLabel = totalBatches > 1 ? ` [Batch ${globalBatchNum} of ${totalBatches}]` : '';
    // Add ±1 page buffer so we don't miss content at encounter edges
    const scopeWithBuffer = pageScope && pageScope.length > 0
      ? [...new Set(pageScope.flatMap(p => [p - 1, p, p + 1]).filter(p => p > 0))].sort((a, b) => a - b)
      : null;
    if (scopeWithBuffer) console.log(`Chunk[${chunkIndex}] Batch ${batchIndex + 1}: page scope [${scopeWithBuffer.join(',')}]`);
    try {
      const result = await callBedrock(fileKeys, buildNarrativePrompt(batchLabel, knownVisitsChecklist), fullSchema, regionOrder, scopeWithBuffer);
      return result;
    } catch (err) {
      console.warn(`Chunk[${chunkIndex}] Batch ${batchIndex + 1}: JSON error, retrying with simplified schema...`, err.message);
      try {
        const result = await callBedrock(fileKeys, buildNarrativePrompt(batchLabel, knownVisitsChecklist), simplifiedSchema, regionOrder, scopeWithBuffer);
        return result;
      } catch (retryErr) {
        console.error(`Chunk[${chunkIndex}] Batch ${batchIndex + 1}: retry also failed:`, retryErr.message);
        return null;
      }
    }
  };

  try {
    // Process batches BATCH_CONCURRENCY at a time
    for (let i = 0; i < batches.length; i += BATCH_CONCURRENCY) {
      const slice = batches.slice(i, i + BATCH_CONCURRENCY);
      const sliceEnd = Math.min(i + BATCH_CONCURRENCY, batches.length);
      const globalStart = batchOffset + i + 1;
      const globalEnd   = batchOffset + sliceEnd;
      console.log(`Chunk[${chunkIndex}]: processing batches ${globalStart}-${globalEnd} of ${totalBatches}`);

      // Update parent job status so frontend sees progress
      await setJobStatus(job_id, `Analyzing batches ${globalStart}–${globalEnd} of ${totalBatches}...`);

      const results = await Promise.all(
        slice.map((batch, j) => {
          const batchPageScope = batch.length === 1 && batch[0].pageScope ? batch[0].pageScope : null;
          return runBatch(batch, i + j, knownVisits || [], batchPageScope);
        })
      );
      for (const result of results) {
        if (!result) continue;
        if (!patientName && result.patient_name) patientName = result.patient_name;
        if (!caseNumber  && result.case_number)  caseNumber  = result.case_number;
        // Narrative fields only — structural merge happens in coordinator.
        // Tag each narrative result with the knownVisit from this batch
        // so the coordinator can do a direct 1:1 join (no index guessing).
        const batchKnownVisit = (batch[0] && batch[0]._knownVisit) ? batch[0]._knownVisit : null;
        const narrativeVisits = sanitizeNarrativeVisits(result.visits || []).map(nv => ({
          ...nv,
          _knownVisit: batchKnownVisit,    // carries provenance through to coordinator
        }));
        chunkVisits.push(...narrativeVisits);
      }
    }

    console.log(`chunkWorker[${chunkIndex}] complete: ${chunkVisits.length} visits`);

    // Write partial result to chunk sub-job
    await dynamo.send(new UpdateCommand({
      TableName: JOBS_TABLE,
      Key: { job_id: chunk_job_id },
      UpdateExpression: 'SET #s = :s, #res = :r, updated_at = :now',
      ExpressionAttributeNames: { '#s': 'status', '#res': 'result' },
      ExpressionAttributeValues: {
        ':s': 'complete',
        ':r': { visits: chunkVisits, patient_name: patientName, case_number: caseNumber },
        ':now': new Date().toISOString(),
      },
    }));

  } catch (err) {
    console.error(`chunkWorker[${chunkIndex}] fatal:`, err);
    await dynamo.send(new UpdateCommand({
      TableName: JOBS_TABLE,
      Key: { job_id: chunk_job_id },
      UpdateExpression: 'SET #s = :s, error_message = :e, updated_at = :now',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':s': 'failed', ':e': err.message, ':now': new Date().toISOString() },
    }));
  }
};

// ── generateSummaryWorker (coordinator) ──────────────────────────────────────
const generateSummaryWorker = async (event) => {
  const { job_id, doc_ids, patient_name = '', org_id } = event;
  console.log(`generateSummaryWorker (coordinator) start: job_id=${job_id} docs=${doc_ids?.length}`);

  // ── Idempotency guard — Lambda async invocation has at-least-once delivery.
  // If this job_id already has a summary_id stamped on it, a previous invocation
  // already completed successfully. Exit immediately to avoid creating a duplicate.
  try {
    const existingJob = await dynamo.send(new GetCommand({ TableName: JOBS_TABLE, Key: { job_id } }));
    if (existingJob.Item && existingJob.Item.summary_id) {
      console.log(`coordinator: job ${job_id} already has summary_id ${existingJob.Item.summary_id} — duplicate invocation, exiting`);
      return;
    }
  } catch (guardErr) {
    console.warn(`coordinator: idempotency check failed (non-fatal):`, guardErr.message);
    // Continue — better to risk a duplicate than to silently fail
  }

  // Pre-fetch region order once for entire coordinator run
  const regionOrder = await getRegionOrder();
  console.log(`coordinator regionOrder: ${regionOrder.map(r => r.region).join(' → ')}`);

  try {
    // ── 1. Fetch doc records ──────────────────────────────────────────────────
    const docRecords = await fetchDocRecords(doc_ids);
    if (!docRecords.length) { await markJobFailed(job_id, 'No documents found in DynamoDB'); return; }
    console.log(`coordinator: loaded ${docRecords.length} doc records`);

    // ── 2. Build allParts (filter non-clinical) ───────────────────────────────
    const allParts = [];
    for (const doc of docRecords) {
      const partClassif = doc.page_classifications || [];
      const allNonClinical = partClassif.length > 0 && partClassif.every(p => !p.is_clinical && !p.restored);
      if (allNonClinical) {
        console.log(`Skipping fully non-clinical part ${doc.aws_document_id} (${doc.file_name})`);
        continue;
      }
      const fileKey = resolveFileKey(doc);
      if (!fileKey) { console.warn(`No file_key for ${doc.aws_document_id}`); continue; }
      allParts.push({
        id: doc.aws_document_id,
        label: doc.file_name || doc.aws_document_id,
        file_key: fileKey,
        file_size: doc.file_size || 0,
        page_classifications: partClassif,
        extracted_text: doc.extracted_text || '',  // kept for fallback reference
        encounter_index: Array.isArray(doc.encounter_index) ? doc.encounter_index : [],  // from classify VI pre-pass
      });
    }
    if (!allParts.length) { await markJobFailed(job_id, 'All documents are non-clinical'); return; }

    // ── 3. Read encounter_index from DynamoDB (written by classifyJobWorker VI pre-pass) ────
    // No Bedrock call needed here — classify already ran VI pre-pass and stored results.
    // encounter_index = [{ date, provider, facility, visit_type, pages, source_doc_id? }]
    let knownVisits = [];
    let patientName = patient_name;
    let caseNumber  = '';
    try {
      await setJobStatus(job_id, 'Loading pre-pass encounter index...');
      const normalizeDate = (raw) => {
        let d = (raw || '').trim();
        if (!d) return '';
        if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
        const mmddyyyy = d.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
        if (mmddyyyy) return `${mmddyyyy[3]}-${mmddyyyy[1].padStart(2,'0')}-${mmddyyyy[2].padStart(2,'0')}`;
        const parsed = new Date(d);
        return isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10);
      };

      for (const part of allParts) {
        const ei = Array.isArray(part.encounter_index) ? part.encounter_index : [];
        if (ei.length === 0) {
          console.log(`coordinator: part ${part.label} has no encounter_index — will use full-document fallback`);
          continue;
        }
        const partVisits = ei.map(v => ({
          ...v,
          date: normalizeDate(v.date),
          source_doc_id: part.id,
          source_part_label: part.label,
          pages: Array.isArray(v.pages) ? v.pages.filter(p => Number.isInteger(p) && p > 0) : [],
        })).filter(v => v.date);
        knownVisits = knownVisits.concat(partVisits);
        console.log(`coordinator: part ${part.label} -> ${partVisits.length} visits from encounter_index`);
      }


      // Deduplicate by date+provider across all parts
      const viSeen = new Set();
      knownVisits = knownVisits.filter(v => {
        const k = `${v.date}|${(v.provider || '').toLowerCase()}`;
        if (viSeen.has(k)) return false;
        viSeen.add(k); return true;
      });
      // Filter admin visit types
      knownVisits = knownVisits.filter(v =>
        !/admin|fax|authorization|reminder|order/i.test(v.visit_type || '')
      );
      console.log(`coordinator: encounter_index loaded — ${knownVisits.length} unique visits across all parts`);
    } catch (viErr) {
      console.warn('coordinator: encounter_index read failed (non-fatal):', viErr.message);
      knownVisits = [];
    }

    // ── 4. Build encounter-scoped batches using VI page data ─────────────────
    // Each VI visit with page data → its own scoped batch for that doc part.
    // Parts with no VI page data → full-document batch (safe fallback).
    const batches = [];
    for (const part of allParts) {
      const partVisits = knownVisits.filter(v => v.source_doc_id === part.id && Array.isArray(v.pages) && v.pages.length > 0);
      if (partVisits.length > 0) {
        for (const encounter of partVisits) {
          batches.push([{ ...part, pageScope: encounter.pages, _knownVisit: encounter }]);
        }
        console.log(`coordinator: part ${part.label} → ${partVisits.length} encounter-scoped batches`);
      } else {
        // No VI page data — fall back to full-document extraction
        batches.push([{ ...part, pageScope: null, _knownVisit: null }]);
        console.log(`coordinator: part ${part.label} → full-document batch (no VI page data)`);
      }
    }
    const totalBatches = batches.length;
    console.log(`coordinator: ${totalBatches} batches → chunks of ${CHUNK_SIZE}`);
    await setJobStatus(job_id, `Launching ${Math.ceil(totalBatches / CHUNK_SIZE)} parallel workers for ${totalBatches} batches...`);

    // Split into chunks
    const batchChunks = [];
    for (let c = 0; c < totalBatches; c += CHUNK_SIZE) {
      batchChunks.push(batches.slice(c, c + CHUNK_SIZE));
    }
    const numChunks = batchChunks.length;
    console.log(`coordinator: firing ${numChunks} chunk workers`);

    // ── 5. Create chunk sub-jobs + fire all chunk workers simultaneously ─────
    const chunkJobIds = [];
    for (let ci = 0; ci < numChunks; ci++) {
      const chunk_job_id = randomUUID();
      chunkJobIds.push(chunk_job_id);
      // Create sub-job record
      await dynamo.send(new UpdateCommand({
        TableName: JOBS_TABLE,
        Key: { job_id: chunk_job_id },
        UpdateExpression: 'SET #s = :s, created_at = :now, updated_at = :now, job_type = :t, parent_job_id = :p',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: {
          ':s': 'running',
          ':now': new Date().toISOString(),
          ':t': 'generate_summary_chunk',
          ':p': job_id,
        },
      }));
    }

    // Fire all chunk workers simultaneously (Event = async, no wait)
    // Strip extracted_text from batch parts before Lambda invocation —
    // extracted_text can be hundreds of KB per doc and blows the 1MB async payload limit.
    const stripText = (batches) => batches.map(batch =>
      batch.map(({ extracted_text: _et, ...rest }) => rest)
    );
  // Note: _knownVisit is preserved through stripText (it's on the part object
  // and is not extracted_text). It travels with the batch to the chunkWorker.
    await Promise.all(batchChunks.map(async (chunkBatches, ci) => {
      const batchOffset = ci * CHUNK_SIZE;
      await lambda.send(new InvokeCommand({
        FunctionName: CHUNK_FN,
        InvocationType: 'Event',
        Payload: Buffer.from(JSON.stringify({
          job_id,
          chunk_job_id: chunkJobIds[ci],
          batches: stripText(chunkBatches),
          knownVisits,
          patientNameHint: patientName,
          chunkIndex: ci,
          totalBatches,
          batchOffset,
        })),
      }));
      console.log(`coordinator: fired chunk worker ${ci} (batches ${batchOffset + 1}-${batchOffset + chunkBatches.length})`);
    }));

    // ── 6. Poll for all chunks to complete (max 12 min = 720s / 10s intervals) ─
    const MAX_WAIT_MS  = 12 * 60 * 1000;
    const POLL_INTERVAL_MS = 10000;
    const startTime = Date.now();
    let allDone = false;

    while (!allDone && (Date.now() - startTime) < MAX_WAIT_MS) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

      const statusChecks = await Promise.all(chunkJobIds.map(cjid =>
        dynamo.send(new GetCommand({ TableName: JOBS_TABLE, Key: { job_id: cjid } }))
          .then(r => r.Item)
      ));

      const statuses = statusChecks.map(a => a?.status || 'running');
      const doneCount  = statuses.filter(s => s === 'complete' || s === 'failed').length;
      const failCount  = statuses.filter(s => s === 'failed').length;
      console.log(`coordinator poll: ${doneCount}/${numChunks} done (${failCount} failed)`);
      await setJobStatus(job_id, `Processing... ${doneCount} of ${numChunks} workers complete`);

      if (doneCount === numChunks) allDone = true;
    }

    if (!allDone) {
      console.warn('coordinator: timed out waiting for chunk workers — proceeding with available results');
    }

    // ── 7. Collect all chunk results ──────────────────────────────────────────
    let allVisits = [];
    await setJobStatus(job_id, 'Merging results...');

    for (const cjid of chunkJobIds) {
      const r = await dynamo.send(new GetCommand({ TableName: JOBS_TABLE, Key: { job_id: cjid } }));
      const chunkResult = r.Item?.result;
      if (!patientName && chunkResult?.patient_name) patientName = chunkResult.patient_name;
      if (!caseNumber  && chunkResult?.case_number)  caseNumber  = chunkResult.case_number;
      if (Array.isArray(chunkResult?.visits)) {
        allVisits = allVisits.concat(chunkResult.visits);
        console.log(`coordinator: merged ${chunkResult.visits.length} visits from chunk ${cjid.slice(0,8)}`);
      }
    }

    // ── 8. Structural merge: bolt deterministic fields onto narrative results ────
    // Each narrative visit carries _knownVisit embedded by the chunkWorker —
    // no index math, no position guessing. Direct 1:1 join.
    await setJobStatus(job_id, 'Merging structured fields with narrative...');

    // Build rawText lookup: source_doc_id → extracted_text
    const rawTextByDocId = {};
    for (const part of allParts) {
      rawTextByDocId[part.id] = part.extracted_text || '';
    }

    const mergedVisits = [];
    allVisits.forEach((narrativeVisit, idx) => {
      // _knownVisit is the exact encounter this narrative result came from
      const kv = narrativeVisit._knownVisit || null;

      if (!kv) {
        // Full-document batch with no VI data — no structural anchor available.
        // Keep the raw narrative result; structural fields will be empty.
        // This is the expected behavior for documents without an encounter_index.
        console.warn(`coordinator: no _knownVisit for narrative entry ${idx} — keeping raw narrative`);
        const rawVisit = sanitizeVisits([narrativeVisit], patientName);
        if (rawVisit.length) mergedVisits.push(rawVisit[0]);
        return;
      }

      const rawText = rawTextByDocId[kv.source_doc_id] || '';
      const merged  = mergeStructuredWithNarrative(kv, narrativeVisit, rawText);
      const cleaned = sanitizeVisits([merged], patientName);
      if (cleaned.length) mergedVisits.push(cleaned[0]);
    });

    let allVisits2 = mergedVisits;

    // ── 8b. C-4 backfill — cross-reference same-date office visit ──────────────
    // C-4 forms often have illegible or missing diagnosis fields.
    // The old buildPrompt asked the LLM to cross-reference; now we do it in code.
    // For each C-4 visit with an empty impression_diagnosis, find a same-date
    // non-C-4 visit and copy over the diagnosis + ICD-10 codes.
    mergedVisits.forEach(v => {
      const isC4 = (v.practice_setting || '').toLowerCase().includes('c-4') ||
                   (v.visit_type || '').toLowerCase().includes('c-4');
      if (!isC4) return;
      if (v.impression_diagnosis) return; // already has diagnosis, nothing to do

      // Find a same-date office/clinical visit (not C-4, not radiology)
      const sameDateVisit = mergedVisits.find(other => {
        if (other === v) return false;
        if (!other.visit_date || other.visit_date !== v.visit_date) return false;
        const os = (other.practice_setting || '').toLowerCase();
        const isOtherC4  = os.includes('c-4') || os.includes('c4 ');
        const isRadiology = os.includes('radiology') || os.includes('mri') || os.includes('x-ray');
        return !isOtherC4 && !isRadiology && other.impression_diagnosis;
      });

      if (sameDateVisit) {
        v.impression_diagnosis = sameDateVisit.impression_diagnosis + ' (extrapolated from same-date visit)';
        v.icd10_codes = Array.isArray(sameDateVisit.icd10_codes) ? [...sameDateVisit.icd10_codes] : [];
        if (!v.rendering_provider && sameDateVisit.rendering_provider) {
          v.rendering_provider = sameDateVisit.rendering_provider;
        }
        console.log(`C-4 backfill: ${v.visit_date} — filled from ${sameDateVisit.practice_setting} [${sameDateVisit.rendering_provider}]`);
      }
    });

    // ── 8b. Merge + dedup + sort ──────────────────────────────────────────────
    await setJobStatus(job_id, 'Deduplicating and sorting visits...');
    try {
      allVisits2 = mergeEdVisits(deduplicateVisits(allVisits2));
    } catch (mergeErr) {
      console.error('mergeEdVisits error (non-fatal, falling back to dedup only):', mergeErr.message);
      allVisits2 = deduplicateVisits(allVisits2);
    }
    allVisits = allVisits2;
    allVisits.sort((a, b) => {
      if (!a.visit_date) return 1;
      if (!b.visit_date) return -1;
      const dateDiff = (a.visit_date||'').localeCompare(b.visit_date||'');
      if (dateDiff !== 0) return dateDiff;
      const aIsC4 = (a.practice_setting || '').toLowerCase().includes('c-4');
      const bIsC4 = (b.practice_setting || '').toLowerCase().includes('c-4');
      if (aIsC4 && !bIsC4) return -1;
      if (!aIsC4 && bIsC4) return 1;
      return 0;
    });

    // ── 9. Recovery pass ─────────────────────────────────────────────────────
    if (knownVisits.length > 0) {
      const foundDates   = new Set(allVisits.map(v => (v.visit_date || '').trim()).filter(Boolean));
      const missingVisits = knownVisits.filter(v => v.date && !foundDates.has(v.date));

      if (missingVisits.length > 0) {
        console.log(`Recovery pass: ${missingVisits.length} missing visits:`, missingVisits.map(v => v.date));
        await setJobStatus(job_id, `Recovery pass: searching for ${missingVisits.length} missing visit${missingVisits.length !== 1 ? 's' : ''}...`);

        // Recovery uses narrative schema only — structural fields bolted on after
        const recSchema = {
          type: 'object',
          properties: {
            visits: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  encounter_index:       { type: 'integer' },
                  chief_complaint:       { type: 'string' },
                  hpi_summary:           { type: 'string' },
                  pain_scale:            { type: 'string' },
                  symptom_progression:   { type: 'string', enum: ['improved', 'same', 'worse', 'not_documented'] },
                  physical_exam_findings:{ type: 'string' },
                  imaging_findings:      { type: 'string' },
                  treatment_plan:        { type: 'string' },
                },
              },
            },
          },
        };

        const bySourceDoc = {};
        for (const mv of missingVisits) {
          const srcId = mv.source_doc_id || 'unknown';
          if (!bySourceDoc[srcId]) bySourceDoc[srcId] = [];
          bySourceDoc[srcId].push(mv);
        }
        const recGroups = Object.entries(bySourceDoc);
        const REC_CONCURRENCY = 3;
        for (let rg = 0; rg < recGroups.length; rg += REC_CONCURRENCY) {
          const recChunk = recGroups.slice(rg, rg + REC_CONCURRENCY);
          await Promise.all(recChunk.map(async ([srcDocId, mvGroup]) => {
            const srcPart    = allParts.find(p => p.id === srcDocId);
            const recFileKey = srcPart?.file_key || allParts[0]?.file_key;
            const recRawText = rawTextByDocId[srcDocId] || '';
            if (!recFileKey) return;
            const visitList  = mvGroup.map((v, i) => `${i+1}. [${v.visit_type || 'Clinical Note'}]`).join('\n');
            const recPrompt  = `You are reviewing medical documents. The following clinical encounter(s) are known to exist but were missed in the prior extraction pass:\n\n${visitList}\n\nExtract narrative content only (HPI, exam findings, treatment) for these encounters. Do not extract structural fields (date, provider, diagnosis). Return narrative fields only.`;
            try {
              const recResult = await callBedrock([recFileKey], recPrompt, recSchema, regionOrder);
              if (Array.isArray(recResult.visits) && recResult.visits.length > 0) {
                recResult.visits.forEach((narrativeVisit, ri) => {
                  const kv = mvGroup[ri] || mvGroup[0];
                  const merged  = mergeStructuredWithNarrative(kv, narrativeVisit, recRawText);
                  const cleaned = sanitizeVisits([merged], patientName);
                  if (cleaned.length) {
                    allVisits = allVisits.concat(cleaned);
                    console.log(`Recovery: added visit ${kv.date} ${kv.provider}`);
                  }
                });
              }
            } catch (recErr) {
              console.warn(`Recovery failed for ${srcDocId}:`, recErr.message);
            }
          }));
        }
        try {
          allVisits = mergeEdVisits(deduplicateVisits(allVisits));
        } catch (mergeErr) {
          console.error('mergeEdVisits error (non-fatal):', mergeErr.message);
          allVisits = deduplicateVisits(allVisits);
        }
        allVisits.sort((a, b) => {
          if (!a.visit_date) return 1;
          if (!b.visit_date) return -1;
          return (a.visit_date||'').localeCompare(b.visit_date||'');
        });
      }
    }

    // ── 10. Checklist date correction ─────────────────────────────────────────
    if (knownVisits.length > 0) {
      const checklistDates = new Set(knownVisits.map(v => v.date));
      allVisits = allVisits.map(v => {
        const d = (v.visit_date || '').trim();
        if (!d || checklistDates.has(d)) return v;
        const provider = (v.rendering_provider || '').toLowerCase();
        const facility = (v.practice_setting   || '').toLowerCase();
        let bestMatch = null, bestScore = 0;
        for (const cv of knownVisits) {
          let score = 0;
          const cvProvider = (cv.provider || '').toLowerCase();
          const cvFacility = (cv.facility  || '').toLowerCase();
          for (const w of provider.split(/\s+/).filter(w => w.length > 2)) {
            if (cvProvider.includes(w)) score += 2;
          }
          for (const w of facility.split(/\s+/).filter(w => w.length > 3)) {
            if (cvFacility.includes(w)) score += 1;
          }
          if (score > bestScore) { bestScore = score; bestMatch = cv; }
        }
        if (bestMatch && bestScore > 0) {
          console.log(`CHECKLIST_CORRECT: corrected ${d} -> ${bestMatch.date} (score ${bestScore})`);
          return { ...v, visit_date: bestMatch.date };
        }
        return v;
      });
    }

    console.log(`coordinator complete: ${allVisits.length} visits`);
    if (allVisits.length === 0 && knownVisits.length > 0) {
      console.warn(`coordinator: WARNING — 0 visits despite ${knownVisits.length} VI entries`);
    }

    await setJobStatus(job_id, `Saving ${allVisits.length} visits...`);

    // Save summary record as 'draft' — immediately visible in UI
    const aws_summary_id = require('crypto').randomUUID();
    const org_id = docRecords[0]?.org_id || '';
    await dynamo.send(new PutCommand({
      TableName: SUMMARIES_TABLE,
      Item: {
        aws_summary_id,
        org_id,
        patient_name:  patientName || '',
        case_number:   caseNumber  || '',
        visits:        allVisits,
        doc_count:     docRecords.length,
        visit_count:   allVisits.length,
        status:        'draft',
        created_at:    new Date().toISOString(),
        updated_at:    new Date().toISOString(),
      },
    }));
    console.log(`coordinator: summary saved as draft — aws_summary_id=${aws_summary_id}`);

    // Stamp summary_id onto the job record — idempotency guard for duplicate Lambda invocations
    try {
      await dynamo.send(new UpdateCommand({
        TableName: JOBS_TABLE, Key: { job_id },
        UpdateExpression: 'SET summary_id = :sid, updated_at = :now',
        ExpressionAttributeValues: { ':sid': aws_summary_id, ':now': new Date().toISOString() },
      }));
    } catch (stampErr) {
      console.warn('coordinator: failed to stamp summary_id on job (non-fatal):', stampErr.message);
    }

    await markJobComplete(job_id, {
      patient_name:   patientName || '',
      case_number:    caseNumber  || '',
      visits:         allVisits,
      doc_count:      docRecords.length,
      visit_count:    allVisits.length,
      aws_summary_id,
    });

  } catch (err) {
    console.error('coordinator fatal:', err);
    await markJobFailed(job_id, err.message);
  }
};


// ═══════════════════════════════════════════════════════════════════════════════
// BUILD VISIT INDEX — reuses all existing infrastructure, stops after VI pre-pass
// Updated: 2026-05-16 — buildVisitIndex functions; VI pre-pass runs at classify time and stores encounter_index in DynamoDB
// Updated: 2026-04-28 — replaces standalone build_visit_index.js entirely
// ═══════════════════════════════════════════════════════════════════════════════

const buildVisitIndexWorkerFn = async (event) => {
  const { job_id, doc_ids, org_id, patient_name: inputPatientName = '' } = event;
  console.log(`buildVisitIndexWorker start: job_id=${job_id} docs=${doc_ids?.length}`);

  try {
    await dynamo.send(new UpdateCommand({
      TableName: JOBS_TABLE, Key: { job_id },
      UpdateExpression: 'SET #s = :s, updated_at = :now',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':s': 'running', ':now': new Date().toISOString() },
    }));

    // Fetch doc records — identical to generateSummaryWorker
    const docRecords = await fetchDocRecords(doc_ids);
    if (!docRecords.length) {
      await markJobFailed(job_id, 'No documents found in DynamoDB');
      return;
    }

    // Build allParts — identical to generateSummaryWorker
    const allParts = [];
    for (const doc of docRecords) {
      const partClassif = doc.page_classifications || [];
      const allNonClinical = partClassif.length > 0 && partClassif.every(p => !p.is_clinical && !p.restored);
      if (allNonClinical) { console.log(`Skipping non-clinical ${doc.aws_document_id}`); continue; }
      const fileKey = resolveFileKey(doc);
      if (!fileKey) { console.warn(`No file_key for ${doc.aws_document_id}`); continue; }
      allParts.push({ id: doc.aws_document_id, label: doc.file_name || doc.aws_document_id, file_key: fileKey });
    }

    if (!allParts.length) { await markJobFailed(job_id, 'All documents are non-clinical'); return; }

    // VI pre-pass — identical to generateSummaryWorker
    const VI_CONCURRENCY = 4;
    const viSchema = {
      type: 'object',
      properties: {
        patient_name: { type: 'string' },
        visits: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              date: { type: 'string' },
              provider: { type: 'string' },
              facility: { type: 'string' },
              visit_type: { type: 'string' },
            },
          },
        },
      },
    };

    // Pre-fetch region order once for VI worker
    const regionOrder = await getRegionOrder();
    console.log(`VI worker regionOrder: ${regionOrder.map(r => r.region).join(' → ')}`);

    const viResults = new Array(allParts.length).fill(null);
    let extractedPatientName = inputPatientName || '';
    for (let vi = 0; vi < allParts.length; vi += VI_CONCURRENCY) {
      const viChunk = allParts.slice(vi, vi + VI_CONCURRENCY);
      await Promise.all(viChunk.map(async (viPart, chunkIdx) => {
        const partIdx = vi + chunkIdx;
        try {
          const viResult = await callBedrock([viPart.file_key], buildVisitIndexPrompt(), viSchema, regionOrder);
          if (Array.isArray(viResult.visits)) {
            viResults[partIdx] = viResult.visits.filter(v => v.date && /^\d{4}-\d{2}-\d{2}$/.test(v.date));
          }
          if (viResult.patient_name && !extractedPatientName) extractedPatientName = viResult.patient_name;
          console.log(`VI: ${viPart.label} -> ${(viResults[partIdx] || []).length} visits`);
        } catch (e) {
          console.warn(`VI failed for ${viPart.id}: ${e.message}`);
        }
      }));
    }

    let knownVisits = [];
    for (const tagged of viResults) { if (tagged) knownVisits = knownVisits.concat(tagged); }

    // Deduplicate
    const viSeen = new Set();
    knownVisits = knownVisits.filter(v => {
      const k = `${v.date}|${(v.provider || '').toLowerCase()}`;
      if (viSeen.has(k)) return false;
      viSeen.add(k); return true;
    });
    knownVisits = knownVisits.filter(v => !/admin|fax|authorization|reminder|order/i.test(v.visit_type || ''));
    knownVisits.sort((a, b) => (a.date || '').localeCompare(b.date || ''));

    console.log(`buildVisitIndexWorker complete: ${knownVisits.length} visits`);

    // Write result — same pattern as markJobComplete
    await dynamo.send(new UpdateCommand({
      TableName: JOBS_TABLE, Key: { job_id },
      UpdateExpression: 'SET #s = :s, #res = :r, updated_at = :now',
      ExpressionAttributeNames: { '#s': 'status', '#res': 'result' },
      ExpressionAttributeValues: { ':s': 'complete', ':r': { known_visits: knownVisits, patient_name: extractedPatientName || inputPatientName || '' }, ':now': new Date().toISOString() },
    }));

  } catch (err) {
    console.error('buildVisitIndexWorker error:', err);
    await markJobFailed(job_id, err.message);
  }
};

const buildVisitIndexStartHandler = async (event) => {
  const body = typeof event.body === 'string' ? JSON.parse(event.body) : (event.body || {});
  const { doc_ids, patient_name: bodyPatientName = '' } = body;
  const org_id = event._orgId || body.org_id || '';

  if (!doc_ids?.length) return httpResponse(400, { error: 'doc_ids required' });

  const job_id = randomUUID();
  await dynamo.send(new UpdateCommand({
    TableName: JOBS_TABLE, Key: { job_id },
    UpdateExpression: 'SET #s = :s, created_at = :now, updated_at = :now, job_type = :t, org_id = :oid',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':s': 'pending', ':now': new Date().toISOString(), ':t': 'visit_index', ':oid': org_id },
  }));

  // Invoke worker asynchronously — reuses the same generateSummaryWorker Lambda function pattern
  await lambda.send(new InvokeCommand({
    FunctionName: process.env.VI_WORKER_FUNCTION_NAME || 'chartreview-pro-prod-buildVisitIndexWorker',
    InvocationType: 'Event',
    Payload: Buffer.from(JSON.stringify({ job_id, doc_ids, org_id, patient_name: bodyPatientName })),
  }));

  console.log(`buildVisitIndexStart: job_id=${job_id} docs=${doc_ids.length}`);
  return httpResponse(200, { job_id });
};

module.exports = {
  generateSummaryStart:       validateApiKey(generateSummaryStartHandler),
  generateSummaryWorker:      generateSummaryWorker,
  generateSummaryChunkWorker: generateSummaryChunkWorker,
  buildVisitIndexStart:       validateApiKey(buildVisitIndexStartHandler),
  buildVisitIndexWorker:      buildVisitIndexWorkerFn,
};



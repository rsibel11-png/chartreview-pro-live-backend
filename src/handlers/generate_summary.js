// Updated: 2026-06-14 — fix: fire verify worker async (InvocationType: Event) — do not await inline; prevents 900s timeout on large cases
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
const VERIFY_FN        = process.env.VERIFY_WORKER_FUNCTION_NAME         || 'chartreview-pro-prod-verifySummaryWorker';

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
    system: EXTRACTION_SYSTEM_PROMPT,
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
    system: EXTRACTION_SYSTEM_PROMPT,
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


// correctEdVisitDates removed — replaced by step 3b service-date scan

const sanitizeVisits = (visits, patientName) => {
  const stringFields = ['visit_date','rendering_provider','practice_setting','chief_complaint','hpi_summary','injury_date','pain_scale','symptom_progression','physical_exam_findings','imaging_findings','lab_findings','impression_diagnosis','treatment_plan','patient_name_on_doc'];
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

    // Scrub military-time-as-year artifacts: model sometimes writes "10/08/2033" when
    // source has date "10/08" and military time "2033". Fix by replacing any date with
    // year > 2030 in narrative fields with the correct visit year (or strip the year).
    const visitYear = clean.visit_date ? clean.visit_date.slice(0, 4) : null;
    if (visitYear) {
      const badYearRe = /(\d{1,2}\/\d{1,2}\/)(20[3-9]\d|2[1-9]\d{2})/g;
      const narrativeFields = ['hpi_summary','treatment_plan','physical_exam_findings','imaging_findings','impression_diagnosis','chief_complaint'];
      narrativeFields.forEach(field => {
        if (clean[field]) {
          clean[field] = clean[field].replace(badYearRe, (match, datePart, badYear) => {
            // Replace bad year with correct visit year
            return datePart + visitYear;
          });
        }
      });
    }

    const patientLower = patientName?.toLowerCase();
    if (clean.practice_setting && patientLower && clean.practice_setting.toLowerCase().includes(patientLower)) {
      clean.practice_setting = '';
    }
    // Ensure possible_different_patient is a boolean
    clean.possible_different_patient = clean.possible_different_patient === true || clean.possible_different_patient === 'true';
    // Code-level name check: compare patient_name_on_doc against primary patientName
    if (patientName && clean.patient_name_on_doc) {
      if (!isSamePatient(patientName, clean.patient_name_on_doc)) {
        clean.possible_different_patient = true;
        console.log('sanitizeVisits: name mismatch flagged — primary="' + patientName + '" doc="' + clean.patient_name_on_doc + '" (' + clean.visit_date + ' ' + clean.rendering_provider + ')');
      }
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
const EXTRACTION_SYSTEM_PROMPT = `You are a forensic medical document analyst specializing in workers' compensation and personal injury litigation. Your work product is read by attorneys and used in legal proceedings — precision and fidelity to the source document are paramount.

Your operating principles:
1. DOCUMENT BOUNDARIES ARE ABSOLUTE. Each document in a medical record is a discrete, bounded unit. You extract information from the document you are currently reading — never from an adjacent, co-occurring, or same-date document. If you find yourself writing language that does not appear in the specific document you are extracting, stop and delete it.
2. YOU DO NOT INFER. You report only what is explicitly written. If a field is not documented, return an empty string. A missing value is always better than a hallucinated one.
3. YOU DO NOT MERGE. Two documents on the same date from the same provider are two documents. A consultation note and an operative note are different documents. A History & Physical and a Discharge Summary are different documents. You extract each separately, completely, and independently.
4. YOU ARE CONSERVATIVE WITH CLINICAL LANGUAGE. Do not paraphrase in ways that change meaning. Do not upgrade or downgrade clinical severity. Report findings as documented.
5. YOU SELF-CHECK FOR BLEED. Before finalizing any visit entry, ask yourself: "Does any language in this entry come from a document other than the one I am currently extracting?" If yes, remove it.`;

const buildPrompt = (rawChunkText, docCount, chunkLabel = '', knownVisitsChecklist = [], skipPages = []) => {
  const chunkText = String(rawChunkText || '').replace(/`/g, "'").split('${').join('(');
  const multiDocNote = docCount > 1
    ? `CRITICAL: You are analyzing a batch of documents (part of a larger set of ${docCount} total). These may be parts of a single medical record split across multiple files, or related records for the same patient. You MUST extract entries from ALL documents/files and combine them into a single comprehensive summary. Do not stop after the first document.`
    : '';
  // pageScopeNote removed — PDF is now pre-sliced to the relevant pages before
  // being sent to Claude, so no page-focus instruction is needed in the prompt.
  const checklistSection = knownVisitsChecklist.length > 0
    ? `\n\nKNOWN VISITS CHECKLIST (from pre-pass — ensure ALL are represented in your output):\n` +
      knownVisitsChecklist.map(v => `- ${v.date} | ${v.provider || 'Unknown'} | ${v.facility || ''} | ${v.visit_type || ''}`).join('\n') +
      `\n\nCRITICAL: Every entry in the checklist above MUST appear in your output visits array. This includes Radiology entries — even if the same imaging findings appear inside an ED note or H&P, the radiologist's report is a SEPARATE encounter and must be extracted as its own entry. If you cannot find clinical detail for a checklist entry, still include it with date, provider, and facility populated. Do NOT omit any checklist entry.`
    : '';
  const skipPagesSection = skipPages.length > 0
    ? `\n\nSKIP THESE PAGES (non-clinical/administrative, confirmed by pre-classification — do not extract visits from pages: ${skipPages.join(', ')})`
    : '';

  return `Your task: analyze these medical document(s) and extract every clinical encounter into a structured JSON array. Be ruthlessly concise — every word must earn its place.
${multiDocNote}

DOCUMENT TYPE HANDLING:
You may encounter different types of documents. Handle each type as follows:

A) OFFICE VISIT / CLINICAL NOTES (standard patient visit records):
    Extract each visit as a separate entry with all standard fields.
    CRITICAL: Always extract and include the actual practice setting/facility name from the document. Do NOT default to generic "office visit" or leave practice_setting empty.
    Examples of what to extract:
    - If document says "Smith Family Medical Group", use "Smith Family Medical Group" as practice_setting
    - If from "XYZ Orthopedic Associates", use "XYZ Orthopedic Associates" 
    - If from "Community Hospital Emergency Department", use "Community Hospital Emergency Department"
    - For ED notes: ALWAYS use "[Hospital Name] - Emergency Department" or "[Hospital Name] Emergency Department" — NEVER just "Emergency Department" alone
    - NEVER label as simply "Office Visit" or "Clinic" — always include the specific facility/provider name from the document header, letterhead, or provider information section

B) EXPERT MEDICAL REPORTS / INDEPENDENT MEDICAL EXAMINATIONS (IME) / CHART REVIEWS / CONSULTATIONS / RADIOLOGY REPORTS:
   Use the EXACT document type as labeled in the document itself. Do NOT relabel or generalize — use the specific type stated. Examples:
   - If the document says "Independent Medical Examination" or "IME" → practice_setting: "Independent Medical Examination"
   - If the document says "Consultation Report" or "Consultative Evaluation" → practice_setting: "[Facility Name] - Consultation Report" if part of a hospital record, or "Consultation Report" if standalone
   - If the document says "Chart Review" or "Record Review" → practice_setting: "Chart Review"
   - If the document says "Radiology Report", "MRI Report", "X-Ray Report", "CT Report" → practice_setting: "[Facility Name] - Radiology Report" if part of a hospital record, or "Radiology Report" if standalone
   - If the document says "Narrative Report" or "Narrative Summary" → practice_setting: "Narrative Report"
   - If the document says "Agreed Medical Examination" or "AME" → practice_setting: "Agreed Medical Examination"
   - If the document says "Qualified Medical Evaluation" or "QME" → practice_setting: "Qualified Medical Evaluation"
   - If the document says "Operative Report" or "Operative Note" and it is part of a hospital record → practice_setting: "[Facility Name] - Operative Report"
   - If the document says "History & Physical" or "H&P" and it is part of a hospital record → practice_setting: "[Facility Name] - History & Physical"
   - If the document says "Discharge Summary" and it is part of a hospital record → practice_setting: "[Facility Name] - Discharge Summary"
   - If none of the above apply, use the most accurate label based on what is stated in the document header or title
   NEVER default to "Independent Medical Examination" unless those exact words (or "IME") appear in the document.
   FACILITY NAME RULE: When a document is embedded within a hospital or medical center record (i.e., the record originates from a named hospital/facility), always prepend the facility name: "[Facility Name] - [Document Type]". Extract the facility name from the document header, letterhead, or routing stamp. Example: "Sunrise Hospital and Medical Center - Consultation Report", "Spring Valley Hospital - Operative Report", "Sunrise Hospital and Medical Center - Radiology Report".
   For all of these types:
   - rendering_provider: the expert/reviewing physician's name
   - chief_complaint: the stated purpose of the report
   - hpi_summary: the expert's review of history and background as summarized in the report
   - physical_exam_findings: examination findings if the expert physically examined the patient, otherwise leave empty
   - impression_diagnosis: the expert's opinions, conclusions, and diagnoses
   - treatment_plan: the expert's recommendations or causation opinions
   - imaging_findings: any imaging reviewed or interpreted by the expert
   - visit_date: the date the report was authored or the examination was performed

C) POLICE REPORTS:
   Treat as a single entry with:
   - rendering_provider: the reporting officer's name and badge number if available
   - practice_setting: "Police Report"
   - chief_complaint: the incident type (e.g., "Motor Vehicle Collision", "Incident Report")
   - hpi_summary: narrative description of the incident — how it occurred, parties involved, witness statements, road/weather conditions, and any citations issued. Summarize concisely.
   - physical_exam_findings: any observations about injuries noted by the officer at the scene
   - impression_diagnosis: officer's conclusions, fault determination, or citations issued
   - treatment_plan: any emergency services dispatched or recommended at scene
   - visit_date: the date of the incident or report

D) AMBULANCE / EMS REPORTS (pre-hospital care records):
   Treat as a single entry with:
   - rendering_provider: the paramedic/EMT name or unit number
   - practice_setting: "Ambulance / EMS Report"
   - chief_complaint: the patient's chief complaint at the scene
   - hpi_summary: mechanism of injury, scene description, patient condition on arrival, and patient's reported symptoms. Summarize concisely.
   - physical_exam_findings: vital signs (BP, HR, RR, O2 sat, GCS), physical findings, and neurological status at scene
   - impression_diagnosis: EMS impression/working diagnosis
   - treatment_plan: treatment administered on scene and during transport (IV, medications, immobilization, oxygen, etc.), and destination facility
   - visit_date: the date of the incident/transport

E) C-4 FORMS (Workers' Compensation Board Doctor's Report / WCB Form C-4):
    IDENTIFICATION: Treat as a C-4 if the document contains ANY of the following: "Form C-4", "C-4", "Workers' Compensation Board", "WCB Report", "EMPLOYEE'S CLAIM FOR COMPENSATION", or "Doctor's Report of Initial Examination". These forms are often partially illegible or printed as scanned images — extract what you can. Do NOT label regular office visit notes as C-4 unless one of the above identifiers is present.

    For ACTUAL C-4 forms only:
    - rendering_provider: the treating physician's name (look for signature block or printed name at bottom of form)
    - practice_setting: "C-4 Workers' Compensation Report"
    - impression_diagnosis: diagnosis only — ICD codes if present, otherwise the written diagnosis
    - visit_date: the date the form was completed or the examination date — this is CRITICAL to extract even if the rest of the form is illegible
    - hpi_summary: leave empty
    - chief_complaint: leave empty
    - physical_exam_findings: leave empty
    - treatment_plan: leave empty
    - CROSS-REFERENCE: If the C-4 date matches an office visit in the same document set, use that visit's rendering provider and/or diagnosis to fill in any illegible C-4 fields. Explicitly note when extrapolated (e.g., "Extrapolated from same-date office visit").
    - ORDERING: The C-4 entry must use the same visit_date as the corresponding office visit so it appears together in chronological order. In the visits array, place the C-4 entry BEFORE the regular office visit entry of the same date.

SAME-DATE DOCUMENT ISOLATION — ABSOLUTE RULE:
A single calendar date can contain MULTIPLE DISTINCT DOCUMENTS that are each their own separate clinical encounter:
- A Consultation Report and an Operative Report on the same date are TWO separate visits.
- A History & Physical (H&P) and a Discharge Summary on the same date are TWO separate visits.
- A Hospitalist Progress Note and a Surgical Operative Note on the same date are TWO separate visits.
- A Radiology Report and the ED note that references it on the same date are TWO separate visits.
EACH DOCUMENT TYPE IS ITS OWN ENTRY. Do NOT collapse them because they share a date.
The practice_setting for each entry MUST reflect the actual document type:
  - "Consultation Report" (NOT "Office Visit") for consult letters
  - "Operative Report" (NOT "Office Visit") for surgical operative notes
  - "History & Physical" for inpatient H&P documents
  - "Discharge Summary" or "Discharge Report" for discharge documents
  - "Hospitalist Progress Note" for inpatient progress notes
  - "[Full Hospital Name] - Emergency Department" for ED visit notes — ALWAYS include the specific hospital name from the document (e.g. "Sunrise Hospital and Medical Center - Emergency Department", "Centennial Hills Hospital Emergency Department"). NEVER just "Emergency Department" alone.
  - "Radiology Report" for radiologist-signed imaging reports

CONTENT ISOLATION — ABSOLUTE RULE:
When extracting any single visit/document, you MUST use ONLY the content within that specific document.
- A Consultation Report's HPI must come ONLY from the consultation document — NOT from the operative note, NOT from the ED note, NOT from any other same-date document.
- An Operative Report's HPI must come ONLY from the operative note itself.
- A Discharge Summary must come ONLY from the discharge document.
- NEVER borrow, import, or infer content from a different document even if it is the same date and same provider.
- If the consult note HPI is brief, keep it brief — do NOT pad it with content from the operative report.
- Each document stands alone. Extract only what is written in that document. Period.

DOCUMENT TYPE RECOGNITION — SAME PROVIDER, SAME DATE:
If the same provider has both a Consultation Report and an Operative Report on the same date:
- The Consultation Report entry: use the consult document's own HPI, exam findings, and plan — typically the pre-operative evaluation and clinical reasoning.
- The Operative Report entry: use the operative note's own content — procedure performed, surgical technique, intraoperative findings, post-op disposition.
- These are NOT duplicates. They document different clinical activities that happened to occur on the same day.

PHYSICIAN'S PROGRESS REPORT (PPR) — SKIP ENTIRELY:
In workers' compensation cases, providers routinely generate a Physician's Progress Report (PPR) — a standard pre-printed WC form. The PPR always accompanies a separately dictated/typed office note from the same provider on the same date. The dictated note contains ALL the same clinical information, written more completely.
RULE: If you identify a document as a Physician's Progress Report or PPR form (typically identified by the "PHYSICIAN'S PROGRESS REPORT" header, structured checkboxes for disability status and restrictions, and a pre-printed form layout), do NOT extract it as a visit entry. Skip it. The dictated note for that date captures the clinical encounter.

CRITICAL: If the document(s) contain MULTIPLE visits or encounters, you MUST extract each as a separate entry in the visits array.

CRITICAL DATE AND TIMELINE ACCURACY:
- Pay EXTREME attention to dates mentioned in the documents
- Multiple visits can occur at the SAME LOCATION on DIFFERENT DATES — treat each as a separate visit
- Match ALL findings, exams, and imaging to the CORRECT visit date they were documented on
- NEVER include information from a future visit in an earlier visit
- NEVER reference events that have not occurred yet chronologically
- Double-check that all information in a visit entry actually occurred on or before that visit date

For EACH entry found, extract the following:

IMPORTANT: Summarize and condense — do NOT transcribe. Extract only the most relevant clinical information.

1. Visit date — BE PRECISE, this is critical for timeline accuracy
   - For ED/hospital visits: use the date the encounter BEGAN, NOT the date the note was electronically signed or finalized.
   - Priority order for ED visit date (highest to lowest):
     (a) Explicit admit/triage labels: "Admit:", "Admit Date:", "SERVICE DT:", "Date of Service:", "Triage Date:", "Visit Date:" — use the date in these fields.
     (b) Document header date / signature date — use ONLY if no explicit admit/triage label exists.
2. Rendering provider name — the physician/provider who authored THIS document
3. Practice/setting — use the EXACT document type label (see SAME-DATE DOCUMENT ISOLATION above)
4. Chief complaint — brief statement of visit or document purpose

5. History of Present Illness (HPI) — SUMMARIZE CONCISELY, FROM THIS DOCUMENT ONLY:
   - Key presenting symptoms and onset AS DOCUMENTED IN THIS SPECIFIC DOCUMENT
   - Injury date if applicable (only on first visit) — VERIFY injury date is BEFORE or ON the visit date
   - Pain scale where provided
   - Mechanism of injury (brief, first visit only)
   - Whether symptoms are improved, same, or worse
   - CRITICAL: Only use content from THIS document. Do NOT import language from a same-date consult, operative note, ED note, or any other document.
   - Keep to 2-3 sentences maximum. Distill only what is clinically material.

6. Physical Examination Findings — SUMMARIZE KEY PERTINENT POSITIVES ONLY, FROM THIS DOCUMENT:
   - ONLY findings documented in THIS specific document
   - Abnormal findings only — omit normal/unremarkable results
   - 3 key findings maximum
   - For operative notes: intraoperative findings, not pre-op exam
   - For consultation notes: the consulting physician's own exam findings only

7. Imaging findings — ONLY if performed or interpreted in THIS document. Do NOT re-report imaging from a co-occurring radiology report.
8. Lab findings — return empty string always. Laboratory panels are captured separately and are not needed in the summary.
9. Impression/diagnosis — from THIS document's own conclusions. ICD-10 codes inline in parentheses.
10. Treatment Plan — CONCISE, 2-4 items max:
   - Interventions performed or prescribed IN THIS document
   - Medications (name, dose).
   - Activity restrictions
   - Follow-up plan

Be RUTHLESSLY CONCISE. Every field reads like a tight medical-legal summary. No filler. No restating headers.

CRITICAL FORMATTING RULES:
- Every field must be a plain text string. NEVER return null, arrays, or objects for text fields.
- If information is not available for a field, return an empty string "".
- The icd10_codes field must always be an array of strings (can be empty []).
- visit_date MUST be in YYYY-MM-DD format always (e.g. 2026-01-20). Never return any other date format.
- ICD codes must ALWAYS appear inline in parentheses at the end of impression_diagnosis only — NEVER as a numbered list, NEVER on separate lines.

CRITICAL EXTRACTION RULES:
(1) Extract EVERY clinical encounter — office visits, ER visits, surgical reports, radiology reports, IMEs, C-4 forms, ambulance reports, police reports. Do NOT skip any.
(1a) HOSPITAL-EMBEDDED RADIOLOGY REPORTS: Large hospital records contain individual radiology reports with their own header block (facility, exam type, date, findings, impression, radiologist signature). Each is a SEPARATE clinical encounter — extract it as its own entry. The radiologist who signed it is the rendering_provider. Do NOT collapse into the ED note. If the knownVisitsChecklist includes a radiologist entry, you MUST produce a separate entry for that radiologist.
(2) For EVERY non-PT visit, you MUST populate hpi_summary, impression_diagnosis, and treatment_plan if that information exists in THIS document.
(3) NEVER return a visit with all content fields empty unless it is truly just a C-4 form with no clinical notes.
(4) NEVER hallucinate — only use information explicitly written in THIS document.
(5) Every field must be a plain text string. NEVER return null, arrays, or objects for text fields.
(6) If information is truly not available, return an empty string "".
(7) The icd10_codes field must always be an array of strings (can be empty []).
(8) PHYSICAL/OCCUPATIONAL THERAPY VISITS: Extract EVERY individual PT/OT session as its own separate record. Each visit date = one record.
(9) For PT visits: practice_setting should be the full facility name. Do NOT abbreviate to "PT" or "Physical Therapy". Consistent naming is critical.
(10) LABORATORY REPORTS: Do NOT extract a standalone laboratory report as a visit. Lab panels are not clinical encounters. If you see a document that is solely a laboratory result printout (CBC, BMP, CMP, urinalysis panels, etc.), skip it entirely — do not produce a visit entry for it.
(11) PHYSICIAN'S PROGRESS REPORTS (PPR): Do NOT extract a Physician's Progress Report as a visit. These are pre-printed workers' comp forms with checkboxes and structured fields. They are always paired with a dictated office note from the same provider/date that contains all the same information. Skip the PPR form; keep the dictated note.
(12) CONSENT FORMS / AUTHORIZATION FORMS: Do NOT extract surgical consent forms, "Authorization for Operative and Other Procedure(s)" documents, or any other consent signature pages as visits. These are administrative paperwork — the clinical content (the surgery itself) is captured in the Operative Report. Identifiable by headers like "Authorization for Operative and Other Procedures", "Informed Consent", "Surgical Consent Form".
(13-admin) APPOINTMENT REMINDERS / FACE SHEETS: Do NOT extract appointment reminder slips, return visit scheduling notices, demographic face sheets, or authorization request forms as visits. These contain no clinical encounter content.
(13) CODING SUMMARIES / BILLING ABSTRACTS: Do NOT extract hospital coding summaries, DRG abstracts, or billing abstraction records as visits. These are administrative billing documents generated by coders (not clinicians) and contain no independent clinical encounter content. Identifiable by headers like "Coding Summary", "Discharge Abstract", "DRG Assignment", or provider listed as "Coder", "Abstractor", or a system name like "Cacuser".

Return ALL entries found across ALL documents as separate entries in the visits array.
For each visit, if you can see the patient name on that document, fill patient_name_on_doc with it. If the name might belong to a different patient, set possible_different_patient to true.

Also extract:
- Patient name (should be consistent across documents)
- Case number (should be consistent across documents)

${chunkText ? `DOCUMENT TEXT:\n\`\`\`\n${chunkText}\n\`\`\`` : ''}
${checklistSection}
${skipPagesSection}`;
};


const buildVisitIndexPrompt = () => {
  return `You are reviewing medical-legal documents. Your ONLY task is to extract a complete list of every clinical encounter date, provider name, and facility/location.

For each clinical encounter found, extract:
1. date - the date of service (YYYY-MM-DD format). For ED/hospital visits use the encounter START date — NOT the electronic signature date.
   PRIORITY ORDER for ED/hospital date (use the FIRST matching rule):
   a) "SERVICE DT", "REP SRV DT", "Triage Date", "Date of Service", "Encounter Date" on the PROVIDER'S OWN PAGE — this is always the encounter date
   b) LAST resort: global document header date
   CRITICAL — DO NOT USE THESE AS VISIT DATES:
   - "ADM DT" / "Admission Date" — this is the hospital admission date, NOT the encounter date for individual provider notes
   - "DISCH DT" / "Discharge Date" — this is the discharge date, not the encounter date
   - Electronic signature date or "Signed:" date — this is when the note was finalized, not when the visit occurred
   EXAMPLE: Document header shows "ADM DT: 10/02/25" but Dr. Tall's note on page 5 shows "SERVICE DT: 10/01/25" → use 2025-10-01 for Dr. Tall's visit.
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
      patient_name: { type: 'string' },
      case_number:  { type: 'string' },
      visits: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            visit_date:            { type: 'string' },
            rendering_provider:    { type: 'string' },
            practice_setting:      { type: 'string' },
            chief_complaint:       { type: 'string' },
            hpi_summary:           { type: 'string' },
            injury_date:           { type: 'string' },
            pain_scale:            { type: 'string' },
            symptom_progression:   { type: 'string', enum: ['improved', 'same', 'worse', 'not_documented'] },
            physical_exam_findings:{ type: 'string' },
            imaging_findings:      { type: 'string' },
            lab_findings:          { type: 'string' },
            impression_diagnosis:  { type: 'string' },
            icd10_codes:           { type: 'array', items: { type: 'string' } },
            treatment_plan:        { type: 'string' },
            patient_name_on_doc:   { type: 'string', description: 'Patient name exactly as it appears on THIS document (from header/letterhead/footer). Empty if not visible.' },
            possible_different_patient: { type: 'boolean', description: 'Set true if the patient name on this document might belong to a different patient. When in doubt, set true.' },
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
            visit_date:           { type: 'string' },
            rendering_provider:   { type: 'string' },
            practice_setting:     { type: 'string' },
            hpi_summary:          { type: 'string' },
            impression_diagnosis: { type: 'string' },
            treatment_plan:       { type: 'string' },
            patient_name_on_doc:   { type: 'string' },
            possible_different_patient: { type: 'boolean' },
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
      const result = await callBedrock(fileKeys, buildPrompt('', 1, batchLabel, knownVisitsChecklist), fullSchema, regionOrder, scopeWithBuffer);
      return result;
    } catch (err) {
      console.warn(`Chunk[${chunkIndex}] Batch ${batchIndex + 1}: JSON error, retrying with simplified schema...`, err.message);
      try {
        const result = await callBedrock(fileKeys, buildPrompt('', 1, batchLabel, knownVisitsChecklist), simplifiedSchema, regionOrder, scopeWithBuffer);
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
        const clean = sanitizeVisits(result.visits || [], patientName);
        chunkVisits.push(...clean);
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

    // ── 3. VI pre-pass (fresh — runs per-coordinator, not from stale classify data) ──
    let knownVisits = [];
    let patientName = patient_name;
    let caseNumber  = '';
    try {
      await setJobStatus(job_id, 'Building visit checklist (pre-pass)...');
      const VI_CONCURRENCY = 4;
      const viResults = new Array(allParts.length).fill(null);
      const viSchema = {
        type: 'object',
        properties: {
          patient_name: { type: 'string' },
          visits: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                date:             { type: 'string' },
                provider:         { type: 'string' },
                facility:         { type: 'string' },
                visit_type:       { type: 'string' },
                source_doc_id:    { type: 'string' },
                source_part_label:{ type: 'string' },
                pages:            { type: 'array', items: { type: 'integer' }, description: 'Page numbers (1-based) where this encounter appears' },
              },
            },
          },
        },
      };
      for (let vi = 0; vi < allParts.length; vi += VI_CONCURRENCY) {
        const viChunk = allParts.slice(vi, vi + VI_CONCURRENCY);
        await Promise.all(viChunk.map(async (viPart, chunkIdx) => {
          const partIdx = vi + chunkIdx;
          try {
            const hasText = viPart.extracted_text && viPart.extracted_text.length > 200;
            const viResult = hasText
              ? await callBedrockText(viPart.extracted_text, buildVisitIndexPrompt(), viSchema, regionOrder)
              : await callBedrock([viPart.file_key], buildVisitIndexPrompt(), viSchema, regionOrder);
            console.log(`VI: ${viPart.label} using ${hasText ? 'Textract text' : 'PDF vision'} (${(viPart.extracted_text || '').length} chars)`);
            if (Array.isArray(viResult.visits)) {
              viResults[partIdx] = viResult.visits
                .map(v => {
                  let d = (v.date || '').trim();
                  if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) {
                    const mmddyyyy = d.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
                    if (mmddyyyy) d = `${mmddyyyy[3]}-${mmddyyyy[1].padStart(2,'0')}-${mmddyyyy[2].padStart(2,'0')}`;
                    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
                      const parsed = new Date(d);
                      d = isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10);
                    }
                  }
                  const pages = Array.isArray(v.pages) ? v.pages.filter(p => Number.isInteger(p) && p > 0) : [];
                  return { ...v, date: d, source_doc_id: viPart.id, source_part_label: viPart.label, pages };
                })
                .filter(v => v.date);
            }
            console.log(`VI: ${viPart.label} -> ${(viResults[partIdx] || []).length} visits`);
          } catch (e) {
            console.warn(`VI pre-pass failed for ${viPart.id}: ${e.message}`);
          }
        }));
      }
      for (const tagged of viResults) {
        if (tagged) knownVisits = knownVisits.concat(tagged);
      }
      const viSeen = new Set();
      knownVisits = knownVisits.filter(v => {
        const k = `${v.date}|${(v.provider || '').toLowerCase()}`;
        if (viSeen.has(k)) return false;
        viSeen.add(k); return true;
      });
      knownVisits = knownVisits.filter(v =>
        !/admin|fax|authorization|reminder|order/i.test(v.visit_type || '')
      );
      console.log(`VI pre-pass complete: ${knownVisits.length} unique visits`);
    } catch (viErr) {
      console.warn('VI pre-pass failed (non-fatal):', viErr.message);
      knownVisits = [];
    }
    // ── 3b. Service-date correction pass (free — regex on extracted_text) ─────
    // The VI pre-pass sometimes returns ADM DT or signature date instead of
    // SERVICE DT for hospital provider notes. Scan extracted_text around each
    // provider's name for SERVICE DT / REP SRV DT / TRIAGE DATE and override
    // if a different (earlier) date is found. No Bedrock call — pure regex.
    const SERVICE_DATE_RE = /(?:SERVICE\s+DT|REP\s+SRV\s+DT|TRIAGE\s+DATE?|DATE\s+OF\s+SERVICE)[:\s]+([0-9]{1,2}\/[0-9]{1,2}\/[0-9]{2,4})/i;
    const parseMDY = (s) => {
      const m = s.match(/^([0-9]{1,2})\/([0-9]{1,2})\/([0-9]{2,4})$/);
      if (!m) return null;
      let yr = parseInt(m[3], 10);
      if (yr < 100) yr += 2000;
      const mo = m[1].padStart(2, '0');
      const dy = m[2].padStart(2, '0');
      return `${yr}-${mo}-${dy}`;
    };
    knownVisits = knownVisits.map(v => {
      const srcPart = allParts.find(p => p.id === v.source_doc_id);
      if (!srcPart || !srcPart.extracted_text) return v;
      const text = srcPart.extracted_text;
      // Anchor search on provider last name (first token before comma or space)
      // Anchor on PAGE marker for this visit's first page if available,
      // else fall back to first lastName occurrence. Prevents wrong SERVICE DT
      // match when multiple providers appear in same multi-page document.
      let anchorIdx = -1;
      if (Array.isArray(v.pages) && v.pages.length > 0) {
        const pageMarker = '--- PAGE ' + v.pages[0] + ' ---';
        anchorIdx = text.indexOf(pageMarker);
      }
      if (anchorIdx < 0) {
        const lastName = (v.provider || '').split(/[,\s]/)[0].trim();
        if (!lastName || lastName.length < 3) return v;
        anchorIdx = text.indexOf(lastName);
      }
      if (anchorIdx < 0) return v;
      // Scan 500 chars before + 6000 after anchor (covers multi-page notes)
      const window = text.slice(Math.max(0, anchorIdx - 500), anchorIdx + 6000);
      const match = window.match(SERVICE_DATE_RE);
      if (!match) return v;
      const corrected = parseMDY(match[1]);
      if (!corrected || corrected === v.date) return v;
      // Only override if corrected date is within 7 days of original (sanity check)
      const origMs = new Date(v.date).getTime();
      const corrMs = new Date(corrected).getTime();
      const diffDays = Math.abs(origMs - corrMs) / 86400000;
      if (diffDays > 7) return v;
      console.log(`coordinator: service-date correction ${v.provider} ${v.date} → ${corrected} (SERVICE DT found in extracted_text)`);
      return { ...v, date: corrected };
    });

    // ── 4. Build encounter-scoped batches using VI page data ─────────────────
    // Each VI visit with page data → its own scoped batch for that doc part.
    // Parts with no VI page data → full-document batch (safe fallback).
    const batches = [];
    for (const part of allParts) {
      const partVisits = knownVisits.filter(v => v.source_doc_id === part.id && Array.isArray(v.pages) && v.pages.length > 0);
      if (partVisits.length > 0) {
        for (const encounter of partVisits) {
          batches.push([{ ...part, pageScope: encounter.pages }]);
        }
        console.log(`coordinator: part ${part.label} → ${partVisits.length} encounter-scoped batches`);
      } else {
        // No VI page data — fall back to full-document extraction
        batches.push([{ ...part, pageScope: null }]);
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

    // ── 8. Merge + dedup + sort ───────────────────────────────────────────────
    await setJobStatus(job_id, 'Merging and deduplicating visits...');
    try {
      allVisits = mergeEdVisits(deduplicateVisits(allVisits));
    } catch (mergeErr) {
      console.error('mergeEdVisits error (non-fatal, falling back to dedup only):', mergeErr.message);
      allVisits = deduplicateVisits(allVisits);
    }
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

    // ── 9. Recovery pass (same as before) ────────────────────────────────────
    if (knownVisits.length > 0) {
      const foundDates   = new Set(allVisits.map(v => (v.visit_date || '').trim()).filter(Boolean));
      const missingVisits = knownVisits.filter(v => v.date && !foundDates.has(v.date));

      if (missingVisits.length > 0) {
        console.log(`Recovery pass: ${missingVisits.length} missing visits:`, missingVisits.map(v => v.date));
        await setJobStatus(job_id, `Recovery pass: searching for ${missingVisits.length} missing visit${missingVisits.length !== 1 ? 's' : ''}...`);
        const recSchema = {
          type: 'object',
          properties: {
            visits: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  visit_date:             { type: 'string' },
                  rendering_provider:     { type: 'string' },
                  practice_setting:       { type: 'string' },
                  chief_complaint:        { type: 'string' },
                  hpi_summary:            { type: 'string' },
                  injury_date:            { type: 'string' },
                  pain_scale:             { type: 'string' },
                  symptom_progression:    { type: 'string', enum: ['improved', 'same', 'worse', 'not_documented'] },
                  physical_exam_findings: { type: 'string' },
                  imaging_findings:       { type: 'string' },
                  lab_findings:           { type: 'string' },
                  impression_diagnosis:   { type: 'string' },
                  icd10_codes:            { type: 'array', items: { type: 'string' } },
                  treatment_plan:         { type: 'string' },
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
            if (!recFileKey) return;
            const visitList  = mvGroup.map(v => `- ${v.date} | ${v.provider || 'Unknown'} | ${v.facility || ''}`).join('\n');
            const recPrompt  = `You are reviewing medical-legal documents. A specific clinical visit is known to exist in these records but was missed in the prior extraction pass.\n\nTARGET VISIT${mvGroup.length > 1 ? 'S' : ''}:\n${visitList}\n\nYour task: Find the above visit${mvGroup.length > 1 ? 's' : ''} in the provided document and extract full clinical details for ${mvGroup.length > 1 ? 'each one' : 'it'}. If you cannot find it, return an empty visits array. Do not extract any other visits.`;
            try {
              const recResult = await callBedrock([recFileKey], recPrompt, recSchema, regionOrder);
              if (Array.isArray(recResult.visits) && recResult.visits.length > 0) {
                const recClean = sanitizeVisits(recResult.visits || [], patientName);
                allVisits = allVisits.concat(recClean);
                console.log(`Recovery: recovered ${recClean.length} visit(s) from ${srcDocId}`);
              }
            } catch (recErr) {
              console.warn(`Recovery failed for ${srcDocId}:`, recErr.message);
            }
          }));
        }
        try {
      allVisits = mergeEdVisits(deduplicateVisits(allVisits));
    } catch (mergeErr) {
      console.error('mergeEdVisits error (non-fatal, falling back to dedup only):', mergeErr.message);
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

    // ── Trigger verify worker (async, non-blocking) ───────────────────────────
    try {
      await lambda.send(new InvokeCommand({
        FunctionName:   VERIFY_FN,
        InvocationType: 'Event',
        Payload: Buffer.from(JSON.stringify({
          job_id,
          aws_summary_id,
          doc_ids,
          org_id: docRecords[0] && docRecords[0].org_id ? docRecords[0].org_id : '',
        })),
      }));
      console.log(`coordinator: verify worker triggered async for summary ${aws_summary_id}`);
    } catch (verifyErr) {
      console.warn('coordinator: failed to trigger verify worker (non-fatal):', verifyErr.message);
    }

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

// ═══════════════════════════════════════════════════════════════════════════════
// VERIFY SUMMARY WORKER
// ═══════════════════════════════════════════════════════════════════════════════

// ── Helpers ──────────────────────────────────────────────────────────────────
const normalizeDate = (raw) => {
  const d = (raw || '').trim();
  if (!d) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  const m = d.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`;
  const parsed = new Date(d);
  return isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10);
};

const normalizeProvider = (name) => {
  return (name || '')
    .replace(/\b(M\.?D\.?|D\.?O\.?|PA-?C?|NP|RN|DO|MD|PA|FACS|FACP|DPM|DDS|PhD)\b\.?/gi, '')
    .replace(/[^a-zA-Z0-9\s]/g, '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ');
};

// ── Fetch PDF bytes from S3 ───────────────────────────────────────────────────
const fetchPdfBytes = async (fileKey) => {
  const resp = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: fileKey }));
  const chunks = [];
  for await (const chunk of resp.Body) chunks.push(chunk);
  return Buffer.concat(chunks);
};

// ── Bedrock call (PDF-bytes, light VI schema) ─────────────────────────────────
const VI_LIGHT_SCHEMA = {
  type: 'object',
  properties: {
    patient_name: { type: 'string' },
    visits: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          date:       { type: 'string', description: 'YYYY-MM-DD — use SERVICE DATE or encounter start, NOT signature/discharge date' },
          provider:   { type: 'string', description: 'Full name with credentials as written' },
          facility:   { type: 'string' },
          visit_type: { type: 'string' },
          pages:      { type: 'array', items: { type: 'number' } },
        },
        required: ['date', 'provider'],
      },
    },
  },
};

const VI_PROMPT = `You are a medical record analyst performing a CENSUS PASS — identifying every distinct clinical encounter in this document.

For each encounter return:
- date: exact encounter date YYYY-MM-DD. Use SERVICE DT, REP SRV DT, or Triage Date when present — NOT ADM DT, DISCH DT, or physician signature date.
- provider: full name exactly as written, including credentials
- facility: treating facility name
- visit_type: Emergency Department | Consultation Report | Operative Report | Radiology Report | History & Physical | Discharge Summary | Office Visit | Physical Therapy | C-4 Form
- pages: page numbers in this PDF where the encounter appears

INCLUDE: ED notes, consultation reports, operative reports, radiology reports, office visits, H&P notes, discharge summaries, C-4/Workers Comp forms.
EXCLUDE: nursing flowsheets, MAR, anesthesia records, coding summaries, consent forms, lab printouts, appointment reminders, PPRs, PACU records, pre-op checklists.`;

const callBedrockVI = async (fileKey) => {
  const pdfBytes = await fetchPdfBytes(fileKey);
  const b64 = pdfBytes.toString('base64');

  const client = getBedrockClient();
  const body = JSON.stringify({
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 4096,
    temperature: 0,
    tools: [{
      name:        'record_visits',
      description: 'Record the list of clinical encounters found in this document',
      input_schema: VI_LIGHT_SCHEMA,
    }],
    tool_choice: { type: 'tool', name: 'record_visits' },
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } },
        { type: 'text', text: VI_PROMPT },
      ],
    }],
  });

  const resp = await client.send(new InvokeModelCommand({
    modelId:     MODEL_ID,
    contentType: 'application/json',
    accept:      'application/json',
    body,
  }));
  const parsed = JSON.parse(Buffer.from(resp.body).toString());
  const toolUse = parsed.content && parsed.content.find(b => b.type === 'tool_use');
  return toolUse ? toolUse.input : { visits: [] };
};

// ── SERVICE DT regex correction ───────────────────────────────────────────────
const SERVICE_DATE_RE = /(?:SERVICE\s+DT|REP\s+SRV\s+DT|TRIAGE\s+DATE?|DATE\s+OF\s+SERVICE)[:\s]+([0-9]{1,2}\/[0-9]{1,2}\/[0-9]{2,4})/i;

const parseMDY = (s) => {
  const m = s.match(/^([0-9]{1,2})\/([0-9]{1,2})\/([0-9]{2,4})$/);
  if (!m) return null;
  let yr = parseInt(m[3], 10);
  if (yr < 100) yr += 2000;
  return `${yr}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`;
};

// Given a visit from the pre-pass (with pages[]) and the part's extracted_text,
// scan for an authoritative SERVICE DT near the encounter's page anchor.
const findServiceDate = (visit, extractedText) => {
  if (!extractedText) return null;
  let anchorIdx = -1;

  // Prefer PAGE marker anchor (most accurate)
  if (Array.isArray(visit.pages) && visit.pages.length > 0) {
    const marker = '--- PAGE ' + visit.pages[0] + ' ---';
    anchorIdx = extractedText.indexOf(marker);
  }
  // Fall back to provider last name
  if (anchorIdx < 0) {
    const lastName = (visit.provider || '').split(/[,\s]/)[0].trim();
    if (lastName && lastName.length >= 3) {
      anchorIdx = extractedText.indexOf(lastName);
    }
  }
  if (anchorIdx < 0) return null;

  const window = extractedText.slice(Math.max(0, anchorIdx - 500), anchorIdx + 6000);
  const match  = window.match(SERVICE_DATE_RE);
  if (!match) return null;

  const corrected = parseMDY(match[1]);
  if (!corrected) return null;

  // Sanity: within 7 days of VI-reported date
  const origMs = new Date(visit.date).getTime();
  const corrMs = new Date(corrected).getTime();
  if (isNaN(origMs) || isNaN(corrMs)) return null;
  const diffDays = Math.abs(origMs - corrMs) / 86400000;
  if (diffDays > 7) return null;

  return corrected !== visit.date ? corrected : null;
};

// ── Main handler ──────────────────────────────────────────────────────────────
// ── Shared verify logic (called inline by coordinator AND by Lambda entrypoint) ──
const runVerifyInline = async ({ job_id, aws_summary_id, doc_ids, org_id }) => {
  console.log(`runVerifyInline start: job_id=${job_id} summary=${aws_summary_id}`);


  try {
    // 1. Load the saved summary
    const summaryResp = await dynamo.send(new GetCommand({
      TableName: SUMMARIES_TABLE,
      Key: { aws_summary_id },
    }));
    const summary = summaryResp.Item;
    if (!summary) throw new Error(`Summary not found: ${aws_summary_id}`);
    const summaryVisits = Array.isArray(summary.visits) ? summary.visits : [];

    // 2. Load document parts (need file_key + extracted_text)
    const docRecords = [];
    for (const doc_id of (doc_ids || [])) {
      const r = await dynamo.send(new GetCommand({
        TableName: DOCS_TABLE,
        Key: { aws_document_id: doc_id },
      }));
      if (r.Item) docRecords.push(r.Item);
    }
    const allParts = docRecords.filter(d => d.status === 'processed' || d.extracted_text);

    // 3. Run VI pre-pass on each part
    const viVisits = [];
    for (const part of allParts) {
      if (!part.file_key) continue;
      try {
        const result = await callBedrockVI(part.file_key);
        if (Array.isArray(result.visits)) {
          result.visits
            .map(v => ({ ...v, date: normalizeDate(v.date), _part: part }))
            .filter(v => v.date)
            .forEach(v => viVisits.push(v));
        }
        console.log(`verify: VI pre-pass ${part.label || part.aws_document_id} → ${(result.visits||[]).length} visits`);
      } catch (e) {
        console.warn(`verify: VI pre-pass failed for part ${part.aws_document_id}: ${e.message}`);
      }
    }

    // Dedup VI visits
    const viSeen = new Set();
    const uniqueViVisits = viVisits.filter(v => {
      const k = `${v.date}|${normalizeProvider(v.provider)}`;
      if (viSeen.has(k)) return false;
      viSeen.add(k); return true;
    });

    // 4. Apply SERVICE DT corrections to VI visits
    const dateCorrections = [];
    for (const v of uniqueViVisits) {
      const corrected = findServiceDate(v, v._part && v._part.extracted_text);
      if (corrected) {
        dateCorrections.push({
          provider:      v.provider,
          original_date: v.date,
          corrected_date: corrected,
          method:        'SERVICE_DT_regex',
        });
        v.date = corrected; // update in place for downstream diff
      }
    }

    // 5. Diff: find visits in VI not present in summary (by date+provider+visit_type key)
    const summaryKeys = new Set(
      summaryVisits.map(v => `${normalizeDate(v.date)}|${normalizeProvider(v.provider || v.provider_name)}`)
    );
    // Also build a provider+visit_type → VI date map for targeted date correction below
    const viDateByProviderType = {};
    for (const v of uniqueViVisits) {
      const k = `${normalizeProvider(v.provider)}|${(v.visit_type || '').toLowerCase()}`;
      viDateByProviderType[k] = v.date;
    }
    const missingVisits = uniqueViVisits.filter(v => {
      const k = `${v.date}|${normalizeProvider(v.provider)}`;
      return !summaryKeys.has(k);
    }).map(v => ({ date: v.date, provider: v.provider, visit_type: v.visit_type }));

    // 6. Apply date corrections to summary visits
    // Strategy A: SERVICE DT regex corrections (from findServiceDate)
    // Strategy B: VI pre-pass date override — if VI says provider X had visit_type Y on date Z
    //             but summary has same provider+visit_type on a different date, correct it
    let correctedCount = 0;
    const correctedVisits = summaryVisits.map(sv => {
      const svProvKey = normalizeProvider(sv.provider || sv.provider_name || '');
      const svType    = (sv.practice_setting || sv.visit_type || '').toLowerCase();

      // Strategy A: regex correction — match on provider+visit_type to avoid hitting C-4 instead of ED note
      const regexCorrection = dateCorrections.find(c => {
        if (normalizeProvider(c.provider) !== svProvKey) return false;
        // If visit_type available on correction, require it to match
        if (c.visit_type && !svType.includes((c.visit_type || '').toLowerCase().split(/\s+/)[0])) return false;
        return true;
      });
      if (regexCorrection) {
        correctedCount++;
        console.log(`verify [regex]: correcting ${sv.provider} (${svType}) ${sv.date} → ${regexCorrection.corrected_date}`);
        return { ...sv, date: regexCorrection.corrected_date };
      }

      // Strategy B: VI pre-pass direct date comparison
      // Try exact visit_type match first, then fuzzy
      let viDate = null;
      const exactKey = `${svProvKey}|${svType}`;
      if (viDateByProviderType[exactKey]) {
        viDate = viDateByProviderType[exactKey];
      } else {
        // Fuzzy: find VI visit for same provider where visit_type words overlap
        const svTypeWords = svType.split(/\s+/).filter(w => w.length > 3);
        for (const [k, d] of Object.entries(viDateByProviderType)) {
          if (!k.startsWith(svProvKey + '|')) continue;
          const viTypeWords = k.split('|')[1].split(/\s+/);
          const overlap = svTypeWords.filter(w => viTypeWords.some(vw => vw.includes(w) || w.includes(vw)));
          if (overlap.length > 0) { viDate = d; break; }
        }
      }

      if (viDate && viDate !== normalizeDate(sv.date)) {
        // Sanity: only correct if within 7 days
        const origMs = new Date(normalizeDate(sv.date)).getTime();
        const corrMs = new Date(viDate).getTime();
        if (!isNaN(origMs) && !isNaN(corrMs) && Math.abs(origMs - corrMs) / 86400000 <= 7) {
          correctedCount++;
          const origFmt = normalizeDate(sv.date);
          console.log(`verify [VI diff]: correcting ${sv.provider} (${svType}) ${origFmt} → ${viDate}`);
          dateCorrections.push({
            provider:       sv.provider || sv.provider_name || '',
            original_date:  origFmt,
            corrected_date: viDate,
            method:         'VI_prepass_diff',
          });
          return { ...sv, date: viDate };
        }
      }

      return sv;
    });

    // 7. Re-sort corrected visits chronologically (proper date comparison)
    const finalVisits = correctedVisits.sort((a, b) => {
      const da = new Date(normalizeDate(a.date) || '1900-01-01').getTime();
      const db = new Date(normalizeDate(b.date) || '1900-01-01').getTime();
      return da - db;
    });

    // 8. Build verification result
    const verification_result = {
      verified_at:     new Date().toISOString(),
      vi_visit_count:  uniqueViVisits.length,
      date_corrections: dateCorrections,
      missing_visits:   missingVisits,
      status: dateCorrections.length > 0 || missingVisits.length > 0
        ? 'verified_with_corrections'
        : 'verified',
    };

    console.log(`verify: complete — ${dateCorrections.length} corrections, ${missingVisits.length} missing`);

    // 9. Write back to summary record
    await dynamo.send(new UpdateCommand({
      TableName: SUMMARIES_TABLE,
      Key: { aws_summary_id },
      UpdateExpression: 'SET visits = :v, visit_count = :vc, verification_result = :vr, #st = :st, updated_at = :now',
      ExpressionAttributeNames: { '#st': 'status' },
      ExpressionAttributeValues: {
        ':v':  finalVisits,
        ':vc': finalVisits.length,
        ':vr': verification_result,
        ':st': verification_result.status,
        ':now': new Date().toISOString(),
      },
    }));

    // 10. Update job status
    await dynamo.send(new UpdateCommand({
      TableName: JOBS_TABLE,
      Key: { job_id },
      UpdateExpression: 'SET #s = :s, updated_at = :now',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':s':   verification_result.status,
        ':now': new Date().toISOString(),
      },
    }));

  } catch (err) {
    console.error('verifySummaryWorker fatal:', err);
    // Non-fatal — don't fail the job, just log
    try {
      await dynamo.send(new UpdateCommand({
        TableName: SUMMARIES_TABLE,
        Key: { aws_summary_id },
        UpdateExpression: 'SET verification_result = :vr, updated_at = :now',
        ExpressionAttributeValues: {
          ':vr':  { status: 'verify_failed', error: err.message, verified_at: new Date().toISOString() },
          ':now': new Date().toISOString(),
        },
      }));
    } catch (_) {}
  }
};



module.exports = {
  generateSummaryStart:       validateApiKey(generateSummaryStartHandler),
  generateSummaryWorker:      generateSummaryWorker,
  generateSummaryChunkWorker: generateSummaryChunkWorker,
  buildVisitIndexStart:       validateApiKey(buildVisitIndexStartHandler),
  buildVisitIndexWorker:      buildVisitIndexWorkerFn,
  verifySummaryWorker:        async (event) => {
    const { job_id, aws_summary_id, doc_ids, org_id } = event;
    await runVerifyInline({ job_id, aws_summary_id, doc_ids, org_id });
  },
};

// ── Patient name comparison (post-processing only) ───────────────────────────
// Updated: 2026-07-21 — surgical add: patient name tagging without prompt rewrite

// Normalize patient name for comparison: uppercase, strip credentials/punctuation,
// strip middle initials, sort tokens so "GARCIA PEREZ, MARIA" == "Maria D Garcia"
const normalizePatientName = (raw) => {
  return (raw || '')
    .replace(/\b(MD|DO|JR|SR|II|III)\b/gi, '')
    .replace(/[^a-zA-Z\s]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(t => t.length > 1)
    .map(t => t.toLowerCase())
    .sort()
    .join(' ');
};

// Check if two patient names likely refer to the same person.
const isSamePatient = (name1, name2) => {
  const n1 = normalizePatientName(name1);
  const n2 = normalizePatientName(name2);
  if (!n1 || !n2) return true;
  if (n1 === n2) return true;
  const t1 = new Set(n1.split(' '));
  const t2 = new Set(n2.split(' '));
  const smaller = t1.size <= t2.size ? t1 : t2;
  const larger  = t1.size <= t2.size ? t2 : t1;
  let matches = 0;
  for (const t of smaller) { if (larger.has(t)) matches++; }
  return matches === smaller.size && smaller.size >= 2;
};

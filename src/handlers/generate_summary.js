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
const POLISH_WORKER_FN = process.env.POLISH_WORKER_FUNCTION_NAME        || 'chartreview-pro-prod-generateSummaryPolishWorker';

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

// ─── AWS swap #1: replaces InvokeLLM ─────────────────────────────────────────
// Original: base44.integrations.Core.InvokeLLM({ prompt, file_urls, response_json_schema })
// New: fetch each PDF from S3 as base64, send to Bedrock with same prompt + schema
// regionOrder is optional — if not provided, we fetch usage from DynamoDB and sort
const callBedrock = async (fileKeys, prompt, schema, regionOrder) => {
  // Build content array: one document block per PDF (mirrors file_urls behavior)
  const contentBlocks = [];
  for (const fileKey of fileKeys) {
    const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: fileKey }));
    const chunks = [];
    for await (const chunk of obj.Body) chunks.push(chunk);
    const pdfBase64 = Buffer.concat(chunks).toString('base64');
    contentBlocks.push({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 },
    });
  }
  contentBlocks.push({ type: 'text', text: prompt });

  const bedrockPayload = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 8000,
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

const toTitleCase = (str) => {
  if (!str) return str;
  const allCaps = str === str.toUpperCase() && /[A-Z]{2}/.test(str);
  if (!allCaps) return str;
  const credentialsPattern = /\b(MD|DO|PA|NP|RN|PT|OT|DC|DPT|LCSW|PhD|DDS|DMD|CRNA|CNS|APRN|EMT|RPA|MPH|MBA|JD|Esq|Jr|Sr|II|III|IV)\b/gi;
  const credentialMatches = {};
  str.replace(credentialsPattern, (m) => { credentialMatches[m.toUpperCase()] = m; });
  return str.replace(/\b\w+/g, (word) => {
    const upper = word.toUpperCase();
    if (credentialMatches[upper]) return credentialMatches[upper];
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  });
};


// ─── Original app logic (verbatim from chartreview-pro) + Claude 4.x brevity constraints ──

const normalizeProviderForDedup = (name) => {
  let n = (name || '')
    .toLowerCase()
    .replace(/\s*[\(\[].*?[\)\]]\s*/g, ' ')
    .replace(/\s*[-\u2013]\s*(henderson|las vegas|northwest|nw|summerlin|north|south|east|west|lake mead|blue diamond|rainbow|sahara|flamingo|tropicana|boulder|aliante|centennial|sunrise|green valley|anthem)\b.*/i, '');
  n = n.replace(/\b(md|do|pa|np|aprn|rn|pt|dpt|ot|otd|dc|phd|psyd|lcsw|mft|pa-c)\b/gi, '')
       .replace(/[,.]/g, ' ').replace(/\s+/g, ' ').trim();
  return n.split(' ').filter(Boolean).sort().join(' ');
};

const mergeVisitPair = (acc, cur) => {
  const longer = (a, b) => ((a||'').length >= (b||'').length ? a : b);
  const mergeList = (a, b) => {
    const aArr = Array.isArray(a) ? a : [];
    const bArr = Array.isArray(b) ? b : [];
    const seen = new Set(aArr.map(s => (s||'').toLowerCase().trim()));
    const merged = [...aArr];
    for (const item of bArr) {
      if (!seen.has((item||'').toLowerCase().trim())) merged.push(item);
    }
    return merged;
  };
  return {
    ...acc,
    hpi_summary:            longer(acc.hpi_summary, cur.hpi_summary),
    physical_exam_findings: longer(acc.physical_exam_findings, cur.physical_exam_findings),
    treatment_plan:         longer(acc.treatment_plan, cur.treatment_plan),
    impression_diagnosis:   longer(acc.impression_diagnosis, cur.impression_diagnosis),
    imaging_findings:       longer(acc.imaging_findings, cur.imaging_findings),
    chief_complaint:        longer(acc.chief_complaint, cur.chief_complaint),
    icd10_codes:            mergeList(acc.icd10_codes, cur.icd10_codes),
  };
};

// Updated: 2026-05-13 — upgraded to merge-based dedup (keeps longest narrative per field)
const deduplicateVisits = (visits) => {
  const visitList = visits || [];
  const groups = new Map();
  const order  = [];

  for (const visit of visitList) {
    const dateKey     = (visit.visit_date || '').trim();
    const providerKey = normalizeProviderForDedup(visit.rendering_provider);
    if (!dateKey && !providerKey) {
      const uid = `__nokey_${Math.random()}`;
      groups.set(uid, [visit]);
      order.push(uid);
      continue;
    }
    const setting         = (visit.practice_setting || '').toLowerCase();
    const isOpReport      = /operative report|surgical report|operation report/i.test(setting);
    const isDischargeNote = /discharge\s+(report|summary|note)|progress\s+note.*discharge/i.test(setting);
    const typeKey = isOpReport ? '__op__' : (isDischargeNote ? '__discharge__' : '');
    const key = typeKey ? `${dateKey}|${providerKey}|${typeKey}` : `${dateKey}|${providerKey}`;
    if (!groups.has(key)) { groups.set(key, []); order.push(key); }
    groups.get(key).push(visit);
  }

  return order.map(key => groups.get(key).reduce((acc, cur) => mergeVisitPair(acc, cur)));
};

// Updated: 2026-05-13 — added EXCLUDED_PATTERNS to filter periop/admin visits before save
// Updated: 2026-05-13 — added EXCLUDED_PATTERNS to filter periop/admin visits before save
const EXCLUDED_PATTERNS = [
  /pacu/i,
  /post.?anesthesia/i,
  /anesthesia/i,
  /pre.?op(?!erative\s+report)/i,
  /preoperative(?!\s+report)/i,
  /perioperative/i,
  /nursing\s+(document|record)/i,
  /surgical\s+case\s+record/i,
  /admission\s+orders/i,
  /inpatient\s+admission/i,
  /inpatient\s+pharmacy/i,
  /pharmacy\s*(\/?\s*orders)?/i,
  /inpatient\s+(pain\s+management|medicine)(?!.*progress|.*discharge|.*consult)/i,
  /\bcorrespondence\b/i,
  /claims?\s+(specialist|adjuster|manager|administrator)/i,
  /utilization\s+review/i,
  // Attending countersignature pages — "Operative Note" labels are EMR co-sign artifacts,
  // not separate clinical encounters. The real surgical record is "Operative Report".
  /\boperative\s+note\b(?!.*report)/i,
];

const isExcludedVisit = (visit) => {
  const setting   = (visit.practice_setting || '').toLowerCase();
  const diagnosis = (visit.impression_diagnosis || '').toLowerCase();
  const hpi       = (visit.hpi_summary || '').toLowerCase();
  const isWorkersComp = setting.includes('c-4') || setting.includes('workers') || setting.includes('wcb')
    || /\bform c-4\b|workers.{0,10}compensation|wcb report/i.test(diagnosis)
    || /\bform c-4\b|workers.{0,10}compensation|wcb report/i.test(hpi);
  if (isWorkersComp) return false;
  const combined = `${visit.practice_setting || ''} ${visit.rendering_provider || ''} ${visit.chief_complaint || ''}`;
  return EXCLUDED_PATTERNS.some(rx => rx.test(combined));
};

const stripLabFindings = (visit) => {
  const setting = (visit.practice_setting || '').toLowerCase();
  const isLabReport = /\blab\b|patholog|microbio|blood\s+work|\bCBC\b|\bCMP\b|culture/i.test(setting);
  if (isLabReport) return visit;
  return { ...visit, lab_findings: '' };
};

const sanitizeVisits = (visits, patientName) => {
  const stringFields = ['visit_date','rendering_provider','practice_setting','chief_complaint','hpi_summary','injury_date','pain_scale','symptom_progression','physical_exam_findings','imaging_findings','lab_findings','impression_diagnosis','treatment_plan'];
  const validProgressions = ['improved','same','worse','not_documented'];
  return (visits || [])
    .filter(visit => !isExcludedVisit(visit))
    .map(visit => {
      const clean = { ...stripLabFindings(visit) };
      stringFields.forEach(field => {
        const val = clean[field];
        if (val === null || val === undefined || val === false) clean[field] = '';
        else if (typeof val === 'object') clean[field] = JSON.stringify(val);
        else if (typeof val !== 'string') clean[field] = String(val);
      });
      if (!Array.isArray(clean.icd10_codes)) clean.icd10_codes = [];
      if (!validProgressions.includes(clean.symptom_progression)) clean.symptom_progression = 'not_documented';
      // Strip any LLM-generated meta-commentary about data sources
      const metaPattern = /\s*[\(\[]\s*(Extrapolated|Cross-referenced|Inferred|Derived|Based on|from same[- ]date[^)\]]*)[^\)\]]*[\)\]]\.?/gi;
      const textFieldsToStrip = ['hpi_summary','diagnosis_codes','impression_diagnosis','treatment_plan','chief_complaint','imaging_findings'];
      textFieldsToStrip.forEach(f => {
        if (clean[f] && typeof clean[f] === 'string') {
          clean[f] = clean[f].replace(metaPattern, '').trim();
        }
      });
      const patientLower = patientName?.toLowerCase();
      if (clean.practice_setting && patientLower && clean.practice_setting.toLowerCase().includes(patientLower)) {
        clean.practice_setting = '';
      }
      return clean;
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

const buildPrompt = (rawChunkText, docCount, chunkLabel = '', knownVisitsChecklist = [], skipPages = [], ptSessionContext = '') => {
  const chunkText = String(rawChunkText || '').replace(/`/g, "'").split('${').join('(');
  const multiDocNote = docCount > 1
    ? `CRITICAL: You are analyzing a batch of documents (part of a larger set of ${docCount} total). These may be parts of a single medical record split across multiple files, or related records for the same patient. You MUST extract entries from ALL documents/files and combine them into a single comprehensive summary. Do not stop after the first document.`
    : '';
  const checklistSection = knownVisitsChecklist.length > 0
    ? `\n\nKNOWN VISITS CHECKLIST (from pre-pass — ensure ALL are represented in your output):\n` +
      knownVisitsChecklist.map(v => `- ${v.date} | ${v.provider || 'Unknown'} | ${v.facility || ''} | ${v.visit_type || ''}`).join('\n') +
      `\n\nCRITICAL: Every date in the checklist above MUST appear in your output visits array — including PT/OT therapy sessions. If you cannot find detail for a visit, still include it with the date and provider populated.`
    : '';
  const skipPagesSection = skipPages.length > 0
    ? `\n\nSKIP THESE PAGES (non-clinical/administrative, confirmed by pre-classification — do not extract visits from pages: ${skipPages.join(', ')})`
    : '';

  return `You are a medical-legal document analyst. Be ruthlessly concise. Eliminate all filler. Mirror the brevity of a high-quality medical-legal summary — every word must earn its place. Analyze these ${docCount} medical document(s)${chunkLabel} and extract ALL entries (office visits, expert reports, IME reports, chart reviews, etc.) across ALL documents.
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
    - NEVER label as simply "Office Visit" or "Clinic" — always include the specific facility/provider name from the document header, letterhead, or provider information section

B) EXPERT MEDICAL REPORTS / INDEPENDENT MEDICAL EXAMINATIONS (IME) / CHART REVIEWS / CONSULTATIONS / RADIOLOGY REPORTS:
   Use the EXACT document type as labeled in the document itself. Do NOT relabel or generalize — use the specific type stated. Examples:
   - If the document says "Independent Medical Examination" or "IME" → practice_setting: "Independent Medical Examination"
   - If the document says "Consultation Report" or "Consultative Evaluation" → practice_setting: "Consultation Report"
   - If the document says "Chart Review" or "Record Review" → practice_setting: "Chart Review"
   - If the document says "Radiology Report", "MRI Report", "X-Ray Report", "CT Report" → practice_setting: "Radiology Report" (or the specific modality, e.g., "MRI Report")
   - If the document says "Narrative Report" or "Narrative Summary" → practice_setting: "Narrative Report"
   - If the document says "Agreed Medical Examination" or "AME" → practice_setting: "Agreed Medical Examination"
   - If the document says "Qualified Medical Evaluation" or "QME" → practice_setting: "Qualified Medical Evaluation"
   - If none of the above apply, use the most accurate label based on what is stated in the document header or title
   NEVER default to "Independent Medical Examination" unless those exact words (or "IME") appear in the document.
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
    STRICT IDENTIFICATION: Only treat as a C-4 if the document EXPLICITLY shows the official WCB Form C-4 header, title block, or reference number (e.g., "Form C-4", "Workers' Compensation Board", "WCB Report"). Do NOT label regular office visits or injury reports as C-4 unless the actual form is present.

    For ACTUAL C-4 forms only:
    - rendering_provider: the treating physician's name (look for signature block or printed name at bottom of form)
    - practice_setting: "C-4 Workers' Compensation Report"
    - impression_diagnosis: diagnosis only — ICD codes if present, otherwise the written diagnosis
    - visit_date: the date the form was completed or the examination date — this is CRITICAL to extract even if the rest of the form is illegible
    - hpi_summary: leave empty
    - chief_complaint: leave empty
    - physical_exam_findings: leave empty
    - treatment_plan: leave empty
    - rendering_provider: Extract only what is legibly printed or signed on the C-4 form itself. If illegible or absent, leave rendering_provider as null or empty string — do NOT note that it was extrapolated or cross-referenced.
    - diagnosis_codes / diagnosis: Extract what is readable from the C-4 form. If illegible, leave blank — do NOT add language about the source of the information.
    - ORDERING: The C-4 entry must use the same visit_date as the corresponding office visit so it appears together in chronological order. In the visits array, place the C-4 entry BEFORE the regular office visit entry of the same date.

DEDUPLICATION RULE - Physician Progress Reports vs. Office Visits:
If the same date has BOTH a physician progress report AND an office visit from the SAME provider, IGNORE the physician progress report and ONLY include the office visit. The office visit record contains the actual clinical information, while the progress report is typically a summary/administrative document.

CRITICAL: If the document(s) contain MULTIPLE office visits or patient encounters, you MUST extract each visit separately as individual entries in the visits array.

CRITICAL DATE AND TIMELINE ACCURACY:
- Pay EXTREME attention to dates mentioned in the documents
- Multiple visits can occur at the SAME LOCATION on DIFFERENT DATES - treat each as a separate visit
- Match ALL findings, exams, and imaging to the CORRECT visit date they were documented on
- NEVER include information from a future visit in an earlier visit
- NEVER reference events (like accidents or injuries) that haven't occurred yet chronologically
- If a location appears multiple times with different dates, create separate visit entries for each date
- Double-check that all information in a visit entry actually occurred on or before that visit date

For EACH entry found across ALL documents, extract the following information:

IMPORTANT: Summarize and condense information - do NOT simply transcribe. Extract only the most relevant and pertinent information.

1. Visit date (if mentioned) - BE PRECISE, this is critical for timeline accuracy
2. Rendering provider name - extract the doctor's name only, not the patient name
3. Practice/setting - for expert reports use "Medical Expert Report", "Independent Medical Examination", or "Chart Review" as appropriate
4. Chief complaint - brief statement of visit purpose or report purpose

5. History of Present Illness (HPI) - SUMMARIZE CONCISELY:
   - Key presenting symptoms and their onset
   - Injury date if applicable (only on first visit) - VERIFY this injury date is BEFORE or ON the visit date
   - Pain scale where provided (e.g., "7/10")
   - Mechanism of injury (brief)
   - Whether symptoms are improved, the same, or worse from prior examinations
   - Relevant past medical history only if directly related
   - For expert reports: summarize the expert's review of the history
   - Keep this section focused and concise, 2-3 sentences maximum. No filler phrases, no restating the obvious. Distill only what is clinically material.
   - DO NOT mention future events or injuries

6. Physical Examination Findings - SUMMARIZE KEY PERTINENT POSITIVES ONLY:
   - ONLY include findings documented on THIS specific visit/report date
   - Pain (location, severity) - only mention if significant
   - Loss of motion/range of motion limitations with specific measurements
   - Deformity, scar formation - only if present
   - Neurological findings (numbness, tingling, burning) - only if present
   - Swelling, tenderness - only if notable
   - Do NOT list normal findings
   - Keep concise, bullet-point style, 3 key findings maximum. Abnormal findings only — omit all normal/unremarkable results.
   - For expert reports with no physical exam: leave empty

7. Imaging findings (X-ray, MRI, CT scans) - include EXACTLY as written, do NOT summarize these, ONLY if performed or reviewed on THIS visit/report date
8. Lab findings (bloodwork panels) - ONLY include if labs were actually performed on THIS visit date, otherwise return empty string
9. Impression/diagnosis - for expert reports include expert opinions, causation analysis, and conclusions with ICD-10 codes where applicable
10. Treatment Plan / Recommendations - SUMMARIZE CONCISELY (2-3 items max, no elaboration):
   - Main treatment interventions prescribed or performed
   - Medications prescribed (name, dosage if stated)
   - For expert reports: expert's recommendations, causation opinions, prognosis
   - Activity restrictions if any
   - Follow-up timeline
   - Keep to 2-4 key points, omit routine instructions

Be thorough but RUTHLESSLY CONCISE. Every field should read like a tight, professional medical-legal summary — not a transcription. Omit anything a reviewing attorney already knows or can infer. No filler. No restating headers as content.

CRITICAL FORMATTING RULES:
- Every field must be a plain text string. NEVER return null, arrays, or objects for text fields.
- If information is not available for a field, return an empty string "".
- The icd10_codes field must always be an array of strings (can be empty []).
- visit_date MUST be in YYYY-MM-DD format always (e.g. 2026-01-20). Never return any other date format.
- ICD codes must ALWAYS appear inline in parentheses at the end of impression_diagnosis only — NEVER as a numbered list, NEVER on separate lines.

CRITICAL EXTRACTION RULES:
(1) Extract EVERY clinical encounter — office visits, ER visits, surgical reports, radiology reports, IMEs, C-4 forms, ambulance reports, police reports. Do NOT skip any.
(2) For EVERY non-PT visit, you MUST populate hpi_summary, impression_diagnosis, and treatment_plan if that information exists anywhere in the text for that encounter. A visit with only date/provider and empty content fields is almost always an error — go back and fill it in.
(3) NEVER return a visit with all content fields empty unless it is truly just a C-4 form with no clinical notes.
(4) NEVER hallucinate — only use information explicitly in the text.
(4a) STRICT DOCUMENT ISOLATION: Each visit entry must ONLY contain information explicitly written in THAT provider's document. Do NOT carry over, infer, or borrow content from other documents in the batch — even if those documents describe the same patient encounter. If a field says "see patient's chart", "see above", "per nursing notes", or similar deferral language, return an EMPTY STRING for that field. Do NOT fill it in from another document.
(5) Every field must be a plain text string. NEVER return null, arrays, or objects for text fields.
(6) If information is truly not available, return an empty string "".
(7) The icd10_codes field must always be an array of strings (can be empty []).
(8) PHYSICAL/OCCUPATIONAL THERAPY VISITS: Extract EVERY individual PT/OT session as its own separate record. Do NOT collapse multiple PT sessions into one. Do NOT summarize a series of visits as a single entry. Each visit date = one record. PT notes are often brief one-liners (date, therapist initials, modalities, exercise sets) -- each one is a separate visit and must be extracted individually. If a page contains 10 PT visit dates, return 10 separate visit records.
(9) For PT visits: practice_setting should be the full facility name (e.g. "Dignity Health Physical Therapy", "Nevada Rehabilitation Institute"). Do NOT abbreviate to just "PT" or "Physical Therapy". Consistent facility naming across all records is critical.

Return ALL entries found across ALL documents as separate entries in the visits array.

Also extract:
- Patient name (should be consistent across documents)
- Case number (should be consistent across documents)

${chunkText ? `DOCUMENT TEXT:\n\`\`\`\n${chunkText}\n\`\`\`` : ''}
${checklistSection}
${skipPagesSection}${ptSessionContext ? '\n\nPT SESSION CONTEXT: ' + ptSessionContext + '. Begin the hpi_summary for this PT entry with \'Visit X of Y at [Facility]\' (use the actual numbers/facility from context).' : ''}`;
};


const buildVisitIndexPrompt = () => {
  return `You are reviewing medical-legal documents. Your ONLY task is to extract a complete list of every clinical encounter date, provider name, and facility/location.

For each clinical encounter found, extract:
1. date - the date of service (YYYY-MM-DD format). PRIMARY SOURCE: the document header or note title (e.g. "Visit Note - November 7, 2022" → 2022-11-07). The vitals table Date column also confirms the visit date. NEVER use the injury date or any date mentioned inside the HPI narrative as the visit date.
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
  const { doc_ids, patient_name = '', include_all_pt = false } = body;
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
    Payload: Buffer.from(JSON.stringify({ job_id, doc_ids, patient_name, org_id, include_all_pt })),
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
          },
        },
      },
    },
  };

  const runBatch = async (batch, batchIndex, knownVisitsChecklist = []) => {
    const fileKeys = batch.map(p => p.file_key).filter(Boolean);
    if (!fileKeys.length) {
      console.warn(`Chunk[${chunkIndex}] Batch ${batchIndex + 1}: no valid file keys, skipping`);
      return null;
    }
    const globalBatchNum = batchOffset + batchIndex + 1;
    const batchLabel = totalBatches > 1 ? ` [Batch ${globalBatchNum} of ${totalBatches}]` : '';
    try {
      const ptCtx = batch.length === 1 ? (batch[0].pt_session_context || '') : '';
      const result = await callBedrock(fileKeys, buildPrompt(knownVisitsChecklist, batchLabel, '', [], [], ptCtx), fullSchema, regionOrder);
      return result;
    } catch (err) {
      console.warn(`Chunk[${chunkIndex}] Batch ${batchIndex + 1}: JSON error, retrying with simplified schema...`, err.message);
      try {
        const result = await callBedrock(fileKeys, buildPrompt(knownVisitsChecklist, batchLabel, '', [], [], ptCtx), simplifiedSchema, regionOrder);
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
        slice.map((batch, j) => runBatch(batch, i + j, knownVisits || []))
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
  const { job_id, doc_ids, patient_name = '', org_id, include_all_pt = false } = event;
  console.log(`generateSummaryWorker (coordinator) start: job_id=${job_id} docs=${doc_ids?.length}`);

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
      });
    }
    if (!allParts.length) { await markJobFailed(job_id, 'All documents are non-clinical'); return; }

    // ── 3. VI pre-pass (VI_CONCURRENCY=4) ────────────────────────────────────
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
            const viResult = await callBedrock([viPart.file_key], buildVisitIndexPrompt(), viSchema, regionOrder);
            if (Array.isArray(viResult.visits)) {
              viResults[partIdx] = viResult.visits
                .map(v => {
                  // Normalize date to YYYY-MM-DD — try common formats before discarding
                  let d = (v.date || '').trim();
                  if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) {
                    // Try MM/DD/YYYY
                    const mmddyyyy = d.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
                    if (mmddyyyy) d = `${mmddyyyy[3]}-${mmddyyyy[1].padStart(2,'0')}-${mmddyyyy[2].padStart(2,'0')}`;
                    // Try Month DD, YYYY (e.g. "July 16, 2024")
                    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
                      const parsed = new Date(d);
                      if (!isNaN(parsed.getTime())) {
                        d = parsed.toISOString().slice(0, 10);
                      } else {
                        d = ''; // truly unparseable — drop date but keep visit
                      }
                    }
                  }
                  return { ...v, date: d, source_doc_id: viPart.id, source_part_label: viPart.label };
                })
                .filter(v => v.date); // only keep visits with a resolved date
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
      // Deduplicate by date+provider
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
      console.log(`VI pre-pass complete: ${knownVisits.length} unique visits`);
    } catch (viErr) {
      console.warn('VI pre-pass failed (non-fatal):', viErr.message);
      knownVisits = [];
    }

    // ── 3b. PT session pre-filter (default: first + last per facility only) ───
    // Approach: work directly from allParts. For each part, determine if it is a
    // "pure PT" part by checking that every knownVisit sourced from it is a PT visit.
    // Group pure-PT parts by normalized facility, sort by earliest PT visit date,
    // then exclude middle parts (keep first + last). Mixed parts are always kept.
    const ptContextMap = {}; // part.id -> "Visit X of Y at Facility"
    if (!include_all_pt) {
      try {
        const isPtVisit = (v) => {
          const vtype = v.visit_type || '';
          const prov  = v.provider  || '';
          const fac   = v.facility  || '';
          if (/physical therapy|physiotherapy|rehabilitation|rehab|hand therapy|occupational therapy/i.test(vtype)) return true;
          if (/\b(PT|PTA|DPT|OT|COTA|CLT)\b/.test(prov) && !/\b(MD|DO|PA|NP|FNP|APRN|DC|DMD|DPM)\b/.test(prov)) return true;
          if (/\btherapy\b|\brehabilitation\b/i.test(fac) && !/pain management|spine|orthopedic|medical center|hospital/i.test(fac)) return true;
          return false;
        };
        // normFacility: strip location/branch suffixes so that
        // "Dignity Health Physical Therapy - Blue Diamond" and
        // "Dignity Health Physical Therapy" group together.
        // Strips anything after " - ", " – ", " (", or common suffix words.
        const normFacility = (f) => (f || '')
          .toLowerCase()
          .trim()
          .replace(/\s*[-–—]\s*(blue diamond|lake mead|nw|ne|se|sw|north|south|east|west|suite|ste|bldg|building|floor|fl|\d+).*$/i, '')
          .replace(/\s*[-–—]\s*[a-z0-9 ]{1,30}$/i, '') // strip any remaining " - location" suffix
          .replace(/\s*\(.*?\)\s*$/, '')              // strip trailing parentheticals
          .replace(/\s+/g, ' ')
          .trim();

        // Map: part.id -> visits from that part
        const visitsByPartId = {};
        for (const v of knownVisits) {
          const pid = v.source_doc_id;
          if (!pid) continue;
          if (!visitsByPartId[pid]) visitsByPartId[pid] = [];
          visitsByPartId[pid].push(v);
        }

        // For parts with NO knownVisits entry (VI pre-pass missed it or date was empty),
        // we cannot safely classify them — keep them always.
        const isPurePtPart = (partId) => {
          const visits = visitsByPartId[partId];
          if (!visits || visits.length === 0) return false; // unknown — keep safe
          return visits.every(isPtVisit);
        };

        // Group pure-PT parts by normalized facility
        // Key: normalizedFacility -> array of { partId, earliestDate, facilityDisplay }
        const ptFacilityGroups = {};
        for (const part of allParts) {
          if (!isPurePtPart(part.id)) continue;
          const visits = visitsByPartId[part.id];
          const repVisit = visits[0];
          const facilityKey = normFacility(repVisit.facility || repVisit.provider || 'pt');
          const facilityDisplay = repVisit.facility || 'Physical Therapy';
          const earliestDate = visits.map(v => v.date || '').sort()[0] || '';
          if (!ptFacilityGroups[facilityKey]) ptFacilityGroups[facilityKey] = { facilityDisplay, parts: [] };
          ptFacilityGroups[facilityKey].parts.push({ partId: part.id, earliestDate });
        }

        const excludedPartIds = new Set();
        for (const [, group] of Object.entries(ptFacilityGroups)) {
          const parts = group.parts.sort((a, b) => a.earliestDate.localeCompare(b.earliestDate));
          if (parts.length <= 2) continue; // only 1-2 PT files — nothing to filter
          const totalParts = parts.length;
          const facilityDisplay = group.facilityDisplay;
          ptContextMap[parts[0].partId]              = `Visit 1 of ${totalParts} at ${facilityDisplay}`;
          ptContextMap[parts[totalParts - 1].partId] = `Visit ${totalParts} of ${totalParts} at ${facilityDisplay}`;
          for (let pi = 1; pi < totalParts - 1; pi++) {
            excludedPartIds.add(parts[pi].partId);
          }
          console.log(`PT pre-filter: ${facilityDisplay} — ${totalParts} pure-PT files, excluding ${totalParts - 2} middle`);
        }

        const beforeCount = allParts.length;
        for (let pi = allParts.length - 1; pi >= 0; pi--) {
          if (excludedPartIds.has(allParts[pi].id)) allParts.splice(pi, 1);
        }
        console.log(`PT pre-filter: ${beforeCount} → ${allParts.length} parts (${beforeCount - allParts.length} excluded)`);
        for (const part of allParts) {
          if (ptContextMap[part.id]) part.pt_session_context = ptContextMap[part.id];
        }
      } catch (ptErr) {
        console.warn('PT pre-filter failed (non-fatal):', ptErr.message);
      }
    }

    // ── 4. Build batches + split into chunks of CHUNK_SIZE ───────────────────
    const batches = [];
    for (let start = 0; start < allParts.length; start += BATCH_SIZE) {
      batches.push(allParts.slice(start, start + BATCH_SIZE));
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
    await Promise.all(batchChunks.map(async (chunkBatches, ci) => {
      const batchOffset = ci * CHUNK_SIZE;
      await lambda.send(new InvokeCommand({
        FunctionName: CHUNK_FN,
        InvocationType: 'Event',
        Payload: Buffer.from(JSON.stringify({
          job_id,
          chunk_job_id: chunkJobIds[ci],
          batches: chunkBatches,
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

// Updated: 2026-05-13 — robust date sort: parse MM/DD/YYYY → YYYY-MM-DD, secondary clinical order
const parseDateSortKey = (d) => {
  if (!d) return '9999-99-99';
  const m = (d || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return d; // fall back to raw string if unexpected format
  return `${m[3]}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`;
};

const CLINICAL_DOC_ORDER = [
  /c-4|workers.*comp/i,
  /emergency\s+department|urgent\s+care/i,
  /history\s*(&|and)\s*physical|\bh&p\b/i,
  /consultation/i,
  /operative\s+report|surgical\s+report/i,
  /progress\s+note|hospitalist/i,
  /discharge/i,
];
const clinicalDocRank = (visit) => {
  const s = (visit.practice_setting || '').toLowerCase();
  for (let i = 0; i < CLINICAL_DOC_ORDER.length; i++) {
    if (CLINICAL_DOC_ORDER[i].test(s)) return i;
  }
  return CLINICAL_DOC_ORDER.length; // unknown doc type goes last
};

const visitSortComparator = (a, b) => {
  const da = parseDateSortKey(a.visit_date);
  const db = parseDateSortKey(b.visit_date);
  if (da < db) return -1;
  if (da > db) return 1;
  // Same date — sort by clinical document type
  return clinicalDocRank(a) - clinicalDocRank(b);
};

    // ── 8. Merge + dedup + sort ───────────────────────────────────────────────
    await setJobStatus(job_id, 'Merging and deduplicating visits...');
    allVisits = deduplicateVisits(allVisits);
    allVisits.sort(visitSortComparator);

    // ── 9. Recovery pass (same as before) ────────────────────────────────────
    if (knownVisits.length > 0) {
      const foundDates = new Set(allVisits.map(v => (v.visit_date || '').trim()).filter(Boolean));
      // For C-4 forms: check that a C-4 actually exists on that date, not just any visit
      const hasC4OnDate = (date) => allVisits.some(v =>
        (v.visit_date || '').trim() === date &&
        /c-4|workers.{0,10}comp|wcb/i.test(v.practice_setting || '')
      );
      const missingVisits = knownVisits.filter(v => {
        if (!v.date) return false;
        // C-4 forms: missing if no C-4 visit exists on that date (even if other visits do)
        if (/c-4\s*form|c4\s*form|workers.{0,10}comp/i.test(v.visit_type || '')) {
          return !hasC4OnDate(v.date);
        }
        return !foundDates.has(v.date);
      });

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
                const recClean = sanitizeVisits(recResult.visits, patientName);
                allVisits = allVisits.concat(recClean);
                console.log(`Recovery: recovered ${recClean.length} visit(s) from ${srcDocId}`);
              }
            } catch (recErr) {
              console.warn(`Recovery failed for ${srcDocId}:`, recErr.message);
            }
          }));
        }
        allVisits = deduplicateVisits(allVisits);
        allVisits.sort((a, b) => {
          if (!a.visit_date) return 1;
          if (!b.visit_date) return -1;
          return (a.visit_date||'').localeCompare(b.visit_date||'');
        });

        // C-4 rescue: if knownVisits has a C-4 but allVisits still has none, do a targeted pass
        const knownC4 = knownVisits.find(v => /c-4\s*form|c4\s*form|workers.{0,10}comp/i.test(v.visit_type || ''));
        const hasC4Now = allVisits.some(v => /c-4|workers.{0,10}comp|wcb/i.test(v.practice_setting || ''));
        if (knownC4 && !hasC4Now) {
          try {
            console.log('C-4 rescue: no C-4 in output, running targeted C-4 extraction');
            const c4Part = allParts.find(p => p.id === knownC4.source_doc_id) || allParts[0];
            if (c4Part?.file_key) {
              const c4Prompt = `You are extracting a C-4 Workers' Compensation form from a medical document.
Find the WCB Form C-4 (Workers' Compensation Board Doctor's Report) in this document.
Extract it as a single visit with:
- visit_date: the date on the form (YYYY-MM-DD)
- rendering_provider: the physician's name from the signature block
- practice_setting: "C-4 Workers' Compensation Report"
- impression_diagnosis: the diagnosis listed (ICD codes if present)
- treatment_plan: any treatment or work restrictions noted
- hpi_summary: empty string
- chief_complaint: empty string
- physical_exam_findings: empty string
Return the result in a visits array. If no C-4 form is found, return an empty visits array.`;
              const c4Schema = { type: 'object', properties: { visits: { type: 'array', items: { type: 'object', properties: {
                visit_date: { type: 'string' }, rendering_provider: { type: 'string' },
                practice_setting: { type: 'string' }, impression_diagnosis: { type: 'string' },
                treatment_plan: { type: 'string' }, hpi_summary: { type: 'string' },
                chief_complaint: { type: 'string' }, physical_exam_findings: { type: 'string' },
                imaging_findings: { type: 'string' }, lab_findings: { type: 'string' },
                icd10_codes: { type: 'array', items: { type: 'string' } },
                symptom_progression: { type: 'string', enum: ['improved','same','worse','not_documented'] },
              }}}}}};
              const c4Result = await callBedrock([c4Part.file_key], c4Prompt, c4Schema, regionOrder);
              if (Array.isArray(c4Result.visits) && c4Result.visits.length > 0) {
                const c4Clean = sanitizeVisits(c4Result.visits, patientName);
                allVisits = allVisits.concat(c4Clean);
                allVisits = deduplicateVisits(allVisits);
                console.log(`C-4 rescue: recovered ${c4Clean.length} C-4 visit(s)`);
              }
            }
          } catch (c4Err) {
            console.warn('C-4 rescue failed (non-fatal):', c4Err.message);
          }
        }
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

    // Save summary record with status 'polishing' — hidden from UI until polish pass completes
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
        status:        'polishing',
        created_at:    new Date().toISOString(),
        updated_at:    new Date().toISOString(),
      },
    }));
    console.log(`coordinator: summary saved as 'polishing' — aws_summary_id=${aws_summary_id}`);

    // Fire polish worker async — coordinator does NOT wait
    try {
      await lambda.send(new InvokeCommand({
        FunctionName:   POLISH_WORKER_FN,
        InvocationType: 'Event',
        Payload:        Buffer.from(JSON.stringify({ aws_summary_id, org_id })),
      }));
      console.log(`coordinator: polish worker invoked for ${aws_summary_id}`);
    } catch (invokeErr) {
      // If invoke fails, flip status to draft so card still appears
      console.error('coordinator: polish invoke failed — marking draft directly', invokeErr.message);
      await dynamo.send(new UpdateCommand({
        TableName: SUMMARIES_TABLE, Key: { aws_summary_id },
        UpdateExpression: 'SET #s = :s, updated_at = :now',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':s': 'draft', ':now': new Date().toISOString() },
      }));
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



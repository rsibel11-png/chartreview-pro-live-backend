// Updated: 2026-09-20 (v5) -- Reinstated the automatic inline VI pre-pass removed 2026-08-31 (commit f0c5e0ab). Any part still missing encounter_index now gets one lightweight Bedrock checklist call (date/provider/facility/visit_type -- deliberately NO pages field, unlike the pre-removal version). Checklist-only by design: no pages means the batching decision later in the coordinator never treats these as page-scoped, so full-document/windowed batching stays exactly as-is -- this restores disambiguation ("5 same-date radiology reports = 5 checklist entries, extract separately") and missing-visit recovery without reintroducing the fine-grained per-encounter batching that produced thin/boilerplate Hillock notes on ZSolis (2026-09-15). In-memory only for this run, never persisted to DynamoDB (per the 2026-08-30 no-cache-contamination decision). Root cause: JBeck (Beck, Jack M.) got 11 correct radiology-split visits on one live run and only 8 (5 reports collapsed into 1) on another, both using identical code and identical full-document-fallback batching -- confirmed via CloudWatch this was Claude's own run-to-run variance on an ambiguous case with no VI checklist to anchor it, not a code regression.
// Updated: 2026-09-20 (v4) -- patient_name majority vote (dev): fixes name-spelling instability across runs (e.g. reported "Belk"/"Berk"/"Beck" from the same document set). Root cause: patient_name was decided by whichever batch happened to return first (a race), with no cross-checking -- so a handwritten/ambiguous field (a C-4 claim form) could win over a clear typed spelling elsewhere. Fix: every batch's guess is now collected (not just the first), and the coordinator picks the most common spelling via pickPatientName() once all chunks report in; an explicit user-supplied patient_name at job start still always wins outright. Also added one prompt-level instruction telling the extraction model to prefer a typed/printed spelling over a handwritten one when both appear in the same batch.\n// Updated: 2026-09-20 (v3) -- Cost calculator now covers the WHOLE pipeline: pulls each doc's processing_cost_usd (Assess Relevance) and classify_cost_usd (Classify), persisted by documents_new.js, and adds them to this run's own RUN_USAGE-based summary-generation cost. Persists the breakdown (upload_classify_cost_usd, summary_generation_cost_usd) plus the true total (estimated_cost_usd) and cost_per_page. Verify's write-back recomputes the same way on its superset usage.\n// Updated: 2026-09-20 (v2) -- Per-document cost calculator: threads each generateSummaryChunkWorker's real Bedrock usage back into the coordinator's RUN_USAGE (previously lost -- chunk workers run in separate Lambda invocations), seeds verify's usage from the saved summary so recovery calls add on top instead of replacing, and persists total_pages / estimated_cost_usd / cost_per_page onto the summary record using Sonnet's real per-token Bedrock pricing. Pure observability -- does not change extraction logic, batching, or any LLM prompt.\n// Updated: 2026-09-20 -- Automatic EMR/administrative-printout exclusion: EMR_MARKERS + classifyEmrPage + detectEmrPrintoutPages (ported verbatim from the former frontend EmrDetector) now run INLINE in the coordinator on every summary generation run, unconditionally -- no exclude_emr flag gate, no user-facing toggle, no separate detector step, zero extra LLM cost (pure deterministic regex over part.extracted_text). Library and document display are untouched -- this only affects which pages the summary-generation LLM batches see. Persisted part.emr_flagged_pages (legacy manual detector runs) is used only as a fallback when extracted_text is unavailable.\n// Updated: 2026-09-19 -- per-user isolation: generateSummaryStart / buildVisitIndexStart now verify every doc_id in the request actually belongs to the caller's org (event._orgId, from verified JWT) before starting a job; admin (event._isAdmin) bypasses. Client-supplied body.org_id is no longer trusted except for admin QC override. No other flow touched.
// Updated: 2026-09-16 — PT/OT consolidation v2.1: (a) normFacilityPt strips parentheticals/commas/slashes FIRST then dash-suffixes (incl. - Las Vegas), so all address + naming variants form ONE group; (b) same-date dedup is per normalized PROVIDER — billing-sheet "Unknown (billed as ...)" entries never outrank named notes; (c) initial evaluations and discharge summaries (pt_index "type") are never consolidated away; (d) runBatch subtracts ptExclude pages AFTER the ±1 encounter-edge buffer so excluded PT pages can never be resurrected. Additive to the v1 consolidation block; no other stage touched.
// Updated: 2026-09-16 — PT/OT consolidation v2: (a) normFacilityPt strips comma-addresses and collapses ALL whitespace so "ATI Physical Therapy, 7301..." and "Mountain View"/"Mountainview" variants merge into one group; (b) same-date multi-part duplicate copies deduped (richest kept, other copies' pages excluded); (c) initial evaluations and discharge summaries (pt_index "type") are never consolidated away; (d) runBatch subtracts ptExclude pages AFTER the ±1 encounter-edge buffer so excluded PT pages can never be resurrected. Additive to the v1 consolidation block; no other stage touched.
// Updated: 2026-09-15 — Radiology exam disambiguation in deduplicateVisits (ZSolis
// Gardner case). Root cause: the dedup key was date+provider+setting-BUCKET, and
// "radiology report" is one bucket regardless of what was imaged — so same-day,
// same-reading-radiologist studies of DIFFERENT body parts (ankle vs femur) or at
// DIFFERENT exam times (pre-reduction vs post-reduction) collapsed into one merged,
// content-contaminated entry (a "post-reduction" entry that showed pre-reduction
// fracture findings; the femur film disappeared entirely). Fix: for radiology-report-
// bucket visits only, extend the dedup key with a body-part token (parsed from
// imaging_findings/hpi/chief_complaint/treatment_plan) and an exam-phase/time token
// (explicit pre-reduction/post-reduction language, else a literal clock time if the
// documentation states one). Two radiology entries only collapse when BOTH the body
// part AND the phase/time signal agree (or neither is present at all, preserving the
// old behavior for genuine same-report duplicate extractions). This does not touch
// non-radiology dedup — same-day judgment-call duplicates elsewhere remain the user's
// call per standing instruction.
// Updated: 2026-09-15 — Conservative dedup hardening + billing-statement visit veto
// (post-narrative-only validation): (1) mergeEdVisits now groups ED entries by date +
// FULL normalized facility string instead of its first word — "Mountain View Hospital"
// vs "Mountainview Hospital" spelling variants previously split one ED encounter into
// two entries; (2) normalizeSettingForDedup fallback strips non-alphanumerics so
// punctuation/space variants of the same facility dedup; (3) sanitizeVisits vetoes
// visit entries minted from billing statements (setting markers, or all narrative
// fields empty after the billing scrub) — C-4 exempt; (4) prompt rule 6 extended:
// a billing statement is not an encounter — never create a visit entry from it.
// Same-day duplicate JUDGMENT CALLS remain for the user — only unambiguous duplicates
// (same date + same provider + same facility modulo spelling) auto-merge.
// Updated: 2026-09-12 — Async verify handoff (900s coordinator timeout fix): coordinator now fires
// verifySummaryWorker via async Event invoke after markJobComplete instead of running verify inline
// (chunks consume ~9+ of the coordinator's 15 min on large corpora, so inline verify was TASK-killed
// mid-loop and recovery never ran). Verify worker VI pre-pass parallelized (concurrency 4).
// Updated: 2026-09-12 — Keep-richest dedup fix (ZSolis/Hillock): deduplicateVisits now keeps the
// entry with the most clinical content per date+provider+setting key instead of the first arrival,
// merging longer field values from dropped duplicates (billing-stub entries from clinic charge
// statements previously out-raced the real History & Physical notes in batch order).
// Also fixed mergeEdVisits wrong field name: 'physical_examination' → 'physical_exam_findings'.
// Updated: 2026-09-15 — EMR narrative-only runs: generateSummaryStart accepts
// exclude_emr flag (job record + worker payload); coordinator subtracts each
// part's saved emr_flagged_pages (EMR Detector output, local page numbers) from
// encounter-scoped batches and the full-doc fallback (union with pleading-paper
// exclusion). Summary record gains narrative_only flag. Baseline runs
// (exclude_emr absent/false) are byte-identical in behavior to before.
// Updated: 2026-09-15 — Per-run Bedrock usage capture: callBedrock/callBedrockText
// now record ACTUAL input/output tokens from each Bedrock response into RUN_USAGE
// (reset per coordinator run, persisted on the summary record 'usage' field at draft
// save and verify write-back). runBatch tracks pages_sent per attempt. Enables
// real cost comparison of whole-doc baseline vs EMR-narrative-only runs. No changes
// to extraction prompts, batch building, or visit logic — capture only.
// Updated: 2026-09-07 — Pleading-paper page exclusion (2-step): detect numbered pleading paper per page via Textract text (sequential margin numbers >= 25, step 1) AND confirm no EMR print-header signature (step 2 veto). Exclude those pages from LLM input at batch build. Legal-only parts skipped entirely; medical records attached inside discovery docs are kept page-by-page.
// Updated: 2026-09-07 — Encounter-level cleanup: (a) discharge documents now date to the DISCHARGE date (DATE/REP SRV DT/DISCH), never the ADMIT date — fixes 03/15-labeled discharge summary that is actually the 03/19 discharge; (b) nursing Clinical Documentation Records (per-shift assessments), implant/vendor supply logs, and discharge medication lists excluded in extraction prompt, VI census prompt, AND deterministic sanitizeVisits drop layer.
// Updated: 2026-09-07 — Junk-class cleanup pass 2: (a) case management / discharge planning notes, expert reports, and care-coordination-only calls excluded in prompt rules (11j)-(11l) AND deterministic sanitizeVisits drops (clinical-content calls kept via marker check); (b) court case number harvested from extracted_text at coordinator (pleading captions no longer reach the LLM).
// Updated: 2026-09-07 — Resident/cosign merge: a resident-authored note cosigned by an attending is ONE encounter. New mergeResidentCosignVisits pass merges attending-solo duplicates of resident notes (same date + facility + matching cosigning attending), absorbing richest content per field. Prompt rule (14) added: co-signature/attestation is never a separate visit.
// Updated: 2026-08-30 — Restored to 24ea835 baseline + max_tokens 64k (known-good direct-deployed fix)
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

// ─── Per-run Bedrock usage capture (2026-09-15) ──────────────────────────────
// Captures ACTUAL input/output token counts from every Bedrock response so runs
// can be cost-compared (e.g., whole-document baseline vs EMR-narrative-only).
// resetRunUsage() is called at coordinator start; the accumulated totals are
// persisted on the summary record (usage field) at draft save and at verify
// write-back (superset — verify's own calls included). Non-fatal by design:
// usage tracking must never break the main flow.
const RUN_USAGE = {
  calls: 0, vision_calls: 0, text_calls: 0,
  vision_input_tokens: 0, text_input_tokens: 0, output_tokens: 0,
  pages_sent: 0, models: {},
};
const resetRunUsage = () => {
  RUN_USAGE.calls = 0; RUN_USAGE.vision_calls = 0; RUN_USAGE.text_calls = 0;
  RUN_USAGE.vision_input_tokens = 0; RUN_USAGE.text_input_tokens = 0;
  RUN_USAGE.output_tokens = 0; RUN_USAGE.pages_sent = 0; RUN_USAGE.models = {};
};
const recordUsage = (kind, modelId, usage) => {
  try {
    if (!usage) return;
    RUN_USAGE.calls++;
    if (kind === 'vision') {
      RUN_USAGE.vision_calls++;
      RUN_USAGE.vision_input_tokens += usage.input_tokens || 0;
    } else {
      RUN_USAGE.text_calls++;
      RUN_USAGE.text_input_tokens += usage.input_tokens || 0;
    }
    RUN_USAGE.output_tokens += usage.output_tokens || 0;
    RUN_USAGE.models[modelId] = (RUN_USAGE.models[modelId] || 0) + 1;
  } catch (uErr) { /* non-fatal */ }
};

// Merge a chunk worker's (or a prior run's) usage totals into this process's
// RUN_USAGE. Used to (a) fold each chunk worker's Bedrock usage back into the
// coordinator's total (chunk workers run in separate Lambda invocations and
// their usage would otherwise be lost), and (b) seed verify's RUN_USAGE from
// the already-saved summary so its write-back is a superset, not a replacement.
// Guarded — usage threading must never break the main extraction flow.
const mergeRunUsage = (u) => {
  try {
    if (!u || typeof u !== 'object') return;
    RUN_USAGE.calls += u.calls || 0;
    RUN_USAGE.vision_calls += u.vision_calls || 0;
    RUN_USAGE.text_calls += u.text_calls || 0;
    RUN_USAGE.vision_input_tokens += u.vision_input_tokens || 0;
    RUN_USAGE.text_input_tokens += u.text_input_tokens || 0;
    RUN_USAGE.output_tokens += u.output_tokens || 0;
    RUN_USAGE.pages_sent += u.pages_sent || 0;
    const models = u.models || {};
    for (const m of Object.keys(models)) {
      RUN_USAGE.models[m] = (RUN_USAGE.models[m] || 0) + (models[m] || 0);
    }
  } catch (muErr) { /* non-fatal */ }
};

// Updated: 2026-09-20 -- per-document cost calculator. Bedrock/Claude Sonnet
// pricing (the only model actually in production use for classify + summary
// generation as of this date -- Haiku was A/B tested twice and rejected both
// times on accuracy grounds; see saved decisions). RUN_USAGE tracks call
// counts per model but not per-model token splits, so this blends all tokens
// at the Sonnet rate -- accurate as long as Sonnet remains the only model in
// use. If a second model is ever mixed in, RUN_USAGE would need a token
// breakdown per model to price this precisely.
const SONNET_INPUT_PER_MTOK  = 3.00;
const SONNET_OUTPUT_PER_MTOK = 15.00;
const computeUsageCost = (usage) => {
  try {
    if (!usage) return { estimated_cost_usd: 0 };
    const inputTokens  = (usage.vision_input_tokens || 0) + (usage.text_input_tokens || 0);
    const outputTokens = usage.output_tokens || 0;
    const cost = (inputTokens / 1e6) * SONNET_INPUT_PER_MTOK + (outputTokens / 1e6) * SONNET_OUTPUT_PER_MTOK;
    return { estimated_cost_usd: Math.round(cost * 10000) / 10000 };
  } catch (cErr) {
    return { estimated_cost_usd: 0 };
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
  const copied = await newDoc.copyPages(srcDoc, indices);
  copied.forEach(page => newDoc.addPage(page));

  const slicedBytes = await newDoc.save();
  console.log(`slicePdfPages: ${fileKey} sliced to pages [${pages.join(',')}] → ${indices.length} pages, ${slicedBytes.length} bytes`);
  return Buffer.from(slicedBytes);
};

// ─── Pleading-paper page detection (2026-09-07) ───────────────────────────────
// Numbered pleading paper (CA CRC 2.100 / NV district courts / most federal
// courts) = court-filing format: sequential line numbers 1-28 down the left
// margin, on every legal filing (pleadings, discovery responses, motions).
// It never appears in medical records. Detected from the Textract page text:
// standalone integer lines forming a long sequential run.
// Validated on the full Wheat corpus (2026-09-07): every legal filing page
// runs exactly 28 (one 36-line template); the worst clinical pages — MEDITECH
// pharmacy audit trails, which are numbered event logs — max out at 23. The
// margin column in pleading paper ALWAYS spans the full 1-28 template, while
// numbered clinical lists stop where the list ends. Threshold 25 sits 2 above
// the worst clinical page and 3 below nominal pleading. Pages that don't reach
// it are ALWAYS sent to Bedrock (fail-safe direction: an undetected legal page
// only costs tokens, never drops content).
const PLEADING_MIN_SEQ = 25;

// Second-step verification (2026-09-07): a page carrying an EMR print-header
// signature is NEVER excluded, even if its margin-number run crosses the
// pleading threshold. EMR export headers (MEDITECH RUN DATE blocks, Epic,
// Cerner, etc.) appear only on medical-system pages — pleading filings never
// print them. This veto can only KEEP a page (fail-safe), never drop one:
// clinical numbered lists that happen to cross the threshold are protected
// structurally. A vetoed pleading page is merely sent to Bedrock (token cost).
// Note: headerless clinical continuation sheets are unaffected — the veto
// guards against exclusion, it never triggers one.
const EMR_PRINT_HEADER_RE = /RUN\s+DATE\s*:|MEDITECH|RUN\s+TIME|EPIC\b|CERNER|ALLSCRIPTS|MYCHART|E\.?C\.?W\.?\b|NEXTGEN\b|ATHENAHEALTH/i;

const pleadingSeqRun = (pageText) => {
  let seqRun = 0;
  let expect = 1;
  for (const rawLine of pageText.split('\n')) {
    const t = rawLine.trim();
    if (/^\d{1,2}$/.test(t)) {
      const n = parseInt(t, 10);
      if (n === expect) { seqRun += 1; expect += 1; }
    }
  }
  return seqRun;
};

// Returns a Set of 1-based page numbers (within this part) that exhibit
// pleading-paper formatting. Empty set if extracted_text is unavailable.
const detectPleadingPages = (extractedText) => {
  const out = new Set();
  if (!extractedText || typeof extractedText !== 'string') return out;
  const pages = extractedText.split('--- PAGE ');
  for (let i = 1; i < pages.length; i++) {
    // strip the leading "N ---" page marker remnant
    const body = pages[i].replace(/^\s*\d+\s*---/, '');
    if (pleadingSeqRun(body) >= PLEADING_MIN_SEQ && !EMR_PRINT_HEADER_RE.test(body)) out.add(i);
  }
  return out;
};

// All 1-based pages of a part (1..partPageCount) minus pleading pages.
// Only called when partPageCount > 0.
const keptPagesOf = (pleadingPages, partPageCount) => {
  const kept = [];
  for (let p = 1; p <= partPageCount; p++) {
    if (!pleadingPages.has(p)) kept.push(p);
  }
  return kept;
};

// ── EMR printout detection (inlined engine — automatic, 2026-09-20) ──────────
// Ported VERBATIM from the frontend detector (chartreview-native-frontend
// src/utils/emrDetector.ts). Computes EMR/administrative printout page flags
// LIVE from part.extracted_text at summary-generation time — no separate
// detector run, no user-facing toggle, no LLM cost (pure deterministic regex).
// NOTE: extracted_text is used ONLY for page-flagging. LLM input remains the
// raw S3 PDF (Rule 9). Page split convention: processWorker writes Textract
// text with "--- PAGE N ---" markers; 1-based pages map 1:1 to PDF pages.
// A marker is 'strong' (classifies a page alone) or 'medium' (needs 2+ hits).
const EMR_MARKERS = [
  // ── Meditech IDEV order/pharmacy dumps ──────────────────────────────────────
  { label: 'MEDITECH FACILITY header',   platform: 'meditech', strength: 'strong', re: /meditech\s+facility/i },
  { label: 'IDEV report header',         platform: 'meditech', strength: 'strong', re: /idev/i },
  { label: "Order's Audit Trail",         platform: 'meditech', strength: 'strong', re: /order's\s+audit\s+trail/i },
  { label: 'Order ENTER in POM',          platform: 'meditech', strength: 'strong', re: /order\s+enter\s+in\s+pom/i },
  { label: 'Order from set:',             platform: 'meditech', strength: 'strong', re: /order\s+from\s+set:/i },
  { label: 'Rx Indication',              platform: 'meditech', strength: 'strong', re: /rx\s+indication/i },
  { label: 'Sig Lv provider field',      platform: 'meditech', strength: 'strong', re: /sig\s+lv/i },
  { label: 'NUR.PHYS order category',    platform: 'meditech', strength: 'strong', re: /nur\.phys/i },
  { label: 'Order Details prompt',        platform: 'meditech', strength: 'strong', re: /press\s+\*enter\*\s+for\s+order\s+details/i },
  { label: 'Order grid (Pri/Qty/Ord)',   platform: 'generic',  strength: 'strong', re: /pri\s+qty\s+ord/i },
  { label: 'Category/Procedure grid',     platform: 'generic',  strength: 'strong', re: /category\s+procedure\s+name/i },
  // ── Epic order/MAR printouts ────────────────────────────────────────────────
  { label: 'Medication Administration Record', platform: 'epic', strength: 'strong', re: /medication\s+administration\s+record/i },
  { label: 'Orders & Results grid',      platform: 'epic',     strength: 'strong', re: /\borders?\s*&\s*results\b/i },
  { label: 'Epic Hyperspace header',    platform: 'epic',      strength: 'strong', re: /epic\s*®\s*(hyperspace|care\s+everywhere)/i },
  // ── Cerner ──────────────────────────────────────────────────────────────────
  { label: 'PowerOrders',                platform: 'cerner', strength: 'strong', re: /powerorders?/i },
  { label: 'PowerForm',                  platform: 'cerner', strength: 'strong', re: /powerform/i },
  { label: 'MPages',                     platform: 'cerner', strength: 'strong', re: /\bmpages?\b/i },
  // ── Generic order-entry boilerplate ────────────────────────────────────────
  { label: 'Order acknowledged',         platform: 'generic', strength: 'strong', re: /order\s+acknowledged/i },
  { label: 'Order source: EPOM',         platform: 'generic', strength: 'strong', re: /order\s+source:\s*epom/i },
  // ── Nursing flowsheet / Clinical Documentation Record ──────────────────────
  { label: 'Clinical Documentation Record', platform: 'meditech', strength: 'strong', re: /clinical\s+documentation\s+record/i },
  { label: 'Patient Care *LIVE* header',  platform: 'meditech', strength: 'strong', re: /patient\s+care\s*\*live\*/i },
  { label: 'Diagnosis/Problem/Outcome/Intervention grid', platform: 'meditech', strength: 'strong', re: /diagnos[ie]s\/problem\/outcome\/intervention/i },
  // ── Discharge instructions provided to patient ──────────────────────────────
  { label: 'Discharge Instructions (patient-facing)', platform: 'generic', strength: 'strong', re: /discharge\s+instructions\b/i },
  { label: 'After Visit Summary',        platform: 'epic',    strength: 'strong', re: /after\s+visit\s+summary/i },
  { label: 'Patient Discharge Instructions header', platform: 'generic', strength: 'strong', re: /instructions\s+(for|to)\s+(the\s+)?patient/i },
  // ── ER patient-education discharge packet (ExitCare/Krames-style boilerplate) ─
  { label: 'Patient Visit Information header', platform: 'generic', strength: 'strong', re: /patient\s+visit\s+information/i },
  { label: '"Comfortable as possible" canned phrase', platform: 'generic', strength: 'strong', re: /comfortable\s+as\s+possible/i },
  { label: 'Diagnosis and Treatment Reviewed',  platform: 'generic', strength: 'strong', re: /diagnosis\s+and\s+treatment\s+reviewed/i },
  { label: 'Patient Instructions Reviewed',      platform: 'generic', strength: 'strong', re: /patient\s+instructions\s+reviewed/i },
  { label: 'Danger signs at home',               platform: 'generic', strength: 'strong', re: /danger\s+signs?\s+at\s+home/i },
  { label: 'Go to the ER if / nearest ER',        platform: 'generic', strength: 'strong', re: /go\s+to\s+the\s+(nearest\s+)?(er|emergency\s+room)\s+if/i },
  // MEDIUM: generic patient-education Q&A headers — need 2+
  { label: 'How is this diagnosed?',             platform: 'generic', strength: 'medium', re: /how\s+is\s+this\s+diagnosed/i },
  { label: 'How is this treated?',                platform: 'generic', strength: 'medium', re: /how\s+is\s+this\s+treated/i },
  { label: 'What are the symptoms of this condition?', platform: 'generic', strength: 'medium', re: /what\s+are\s+the\s+symptoms\s+of\s+this\s+condition/i },
  { label: 'What increases my risk of complications?', platform: 'generic', strength: 'medium', re: /increases?\s+my\s+risk\s+of\s+complications/i },
  { label: 'What are the causes?',                platform: 'generic', strength: 'medium', re: /what\s+are\s+the\s+causes\?/i },
  { label: 'What increases the risk?',            platform: 'generic', strength: 'medium', re: /what\s+increases\s+the\s+risk\?/i },
  { label: 'What are the signs or symptoms?',     platform: 'generic', strength: 'medium', re: /what\s+are\s+the\s+signs?\s+or\s+symptoms/i },
  { label: 'Follow these instructions at home',   platform: 'generic', strength: 'medium', re: /follow\s+these\s+instructions\s+at\s+home/i },
  { label: 'Follow these Precautions',            platform: 'generic', strength: 'medium', re: /follow\s+these\s+precautions/i },
  { label: 'Patient Signature Page',              platform: 'generic', strength: 'strong', re: /patient\s+signature\s+page/i },
  { label: 'Managing pain, stiffness, and swelling', platform: 'generic', strength: 'strong', re: /managing\s+pain,?\s+stiffness,?\s+and\s+swelling/i },
  { label: 'CareNow marketing tagline',           platform: 'generic', strength: 'strong', re: /the\s+convenience\s+you\s+need,?\s+the\s+care\s+you\s+deserve/i },
  { label: 'Removable splint or boot instructions', platform: 'generic', strength: 'medium', re: /removable\s+splint\s+or\s+boot/i },
  { label: 'Skin/toenails turn blue or gray (danger sign)', platform: 'generic', strength: 'medium', re: /turn(s)?\s+blue\s+or\s+gray/i },
  { label: 'Krames/ExitCare "not intended" disclaimer', platform: 'generic', strength: 'strong', re: /this\s+information\s+is\s+not\s+(intended|meant)/i },
  { label: 'Take this sheet with you (AVS handout)', platform: 'generic', strength: 'strong', re: /take\s+this\s+sheet\s+with\s+you/i },
  { label: 'Studies Done in the Emergency Department', platform: 'generic', strength: 'medium', re: /studies\s+done\s+in\s+the\s+emergency\s+department/i },
  // ── Meditech MAR / medication-discharge narrative (timestamped entries) ────
  { label: 'Admin Criterion Entered',    platform: 'meditech', strength: 'strong', re: /admin\s+criterion\s+entered/i },
  { label: 'Pharmacy Edit or Verification', platform: 'meditech', strength: 'strong', re: /pharmacy\s+edit\s+or\s+verification/i },
  { label: 'Nurse Acknowledged Order',   platform: 'meditech', strength: 'strong', re: /nurse\s+acknowledged\s+order/i },
  { label: 'File Document by:',          platform: 'meditech', strength: 'strong', re: /file\s+document\s+by:/i },
  { label: 'Medication Discharge Summary', platform: 'meditech', strength: 'strong', re: /medication\s+discharge\s+summary/i },
  // ── MEDIUM: EMR dump boilerplate — need 2+ distinct hits ────────────────────
  { label: 'RUN DATE',                   platform: 'generic',  strength: 'medium', re: /run\s+date/i },
  { label: 'RUN TIME',                   platform: 'generic',  strength: 'medium', re: /run\s+time/i },
  { label: 'RUN USER',                   platform: 'generic',  strength: 'medium', re: /run\s+user/i },
  { label: 'Order Date grid',            platform: 'generic',  strength: 'medium', re: /order\s+date:\s*\d/i },
  { label: 'Order Number/Date grid',     platform: 'generic',  strength: 'medium', re: /order\s+number\s+date/i },
  { label: 'Costign/cosign required field', platform: 'meditech', strength: 'medium', re: /cos[t]?ign\s+required/i },
  { label: 'RX # dispensing number',     platform: 'meditech', strength: 'medium', re: /\brx\s*#:\s*\d/i },
  { label: 'Electronically signed stamp', platform: 'generic', strength: 'medium', re: /electronically\s+signed\s+by\s+.*\s+on\s+\d{2}\/\d{2}\/\d{2}\s+at\s+\d{4}/i },
];

// Classify a single page's text.
const classifyEmrPage = (pageText) => {
  if (!pageText) return { flagged: false, platform: '', matched: [] };
  const matched = EMR_MARKERS.filter(m => m.re.test(pageText));
  const strong = matched.filter(m => m.strength === 'strong');
  const medium = matched.filter(m => m.strength === 'medium');
  const flagged = strong.length > 0 || medium.length >= 2;
  const platform = strong.length > 0 ? strong[0].platform : (flagged ? 'generic' : '');
  return { flagged, platform, matched };
};

// Split extracted text on processWorker page markers; return flagged 1-based page numbers.
const detectEmrPrintoutPages = (extractedText) => {
  const flaggedPages = [];
  if (!extractedText || typeof extractedText !== 'string') return flaggedPages;
  const chunks = extractedText.split('--- PAGE ');
  for (let i = 1; i < chunks.length; i++) {
    const body = chunks[i].replace(/^\s*\d+\s*---/, '');
    if (classifyEmrPage(body).flagged) flaggedPages.push(i);
  }
  return flaggedPages;
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
    max_tokens: 64000,
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
        // Capture ACTUAL token usage for run cost reporting
        recordUsage('vision', modelId, parsed && parsed.usage);
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
        // Capture ACTUAL token usage for run cost reporting
        recordUsage('text', modelId, parsed && parsed.usage);
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
  // Updated: 2026-09-15 — strip ALL non-alphanumerics so punctuation/space variants of
  // the same facility ("Mountain View" vs "Mountainview") collapse to one dedup key.
  // Only reaches this fallback for non-bucketed settings; bucketed types are unchanged.
  return s.replace(/[^a-z0-9]/g, '');
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

    // Updated: 2026-09-15 — group by date + FULL facility string, lowercased with all
    // non-alphanumerics removed. The old first-word key failed on spelling variants:
    // "Mountain View Hospital - ED" keyed on "mountain" while "Mountainview Hospital -
    // ED" keyed on "mountainview", so the same ED encounter stayed as two entries.
    const facilityNorm = (v.practice_setting || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const groupKey = `${v.visit_date}|${facilityNorm}`;
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
    // Updated: 2026-09-12 — fixed wrong field name ('physical_examination' is not a schema field; exam findings were never merged across ED entries)
    const textFields = ['hpi_summary','treatment_plan','impression_diagnosis','chief_complaint','physical_exam_findings','pain_scale'];
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

  // Updated: 2026-09-12 — KEEP THE RICHEST ENTRY, NOT THE FIRST (ZSolis/Hillock fix).
  // Root cause: for the same date+provider+setting, an entry extracted from a clinic
  // charge-statement (billing stub) arrived in an earlier batch than the real
  // History & Physical note; first-wins dedup silently discarded the rich clinical
  // note (wound exam, radiograph review, Keflex course all lost — logged as
  // "dropping duplicate 2023-09-26 Ronald W. Hillock, MD"). New behavior: per key,
  // the entry with the most clinical content is the base, and longer field values
  // are merged in from every dropped duplicate (same strategy as mergeEdVisits).
  // The merged result is emitted at the FIRST occurrence's position, so output
  // ordering is unchanged. Cross-date merging is still impossible — the key
  // includes the date, so brief same-provider follow-ups on different dates are
  // never merged (standing requirement, 2026-07-27).

  const CONTENT_FIELDS = ['hpi_summary','chief_complaint','impression_diagnosis','treatment_plan','physical_exam_findings','imaging_findings','lab_findings','symptom_progression','pain_scale','injury_date'];
  const contentScore = (v) => CONTENT_FIELDS.reduce((s, f) => s + ((v && v[f]) ? String(v[f]).length : 0), 0);

  // Updated: 2026-09-15 — radiology exam disambiguator + shared key builder.
  // A body part or explicit exam-phase/time signal, when present, is added to the
  // dedup key so distinct radiology studies never collapse just because they share
  // a date and reading radiologist. Returns '' (no extra signal) when neither is
  // found, which preserves prior behavior for true duplicate extractions.
  const BODY_PART_TERMS = ['ankle','femur','tibia','fibula','tibia/fibula','knee','patella','hip','pelvis','wrist','forearm','radius','ulna','elbow','humerus','shoulder','clavicle','scapula','hand','finger','thumb','foot','toe','calcaneus','chest','ribs','rib','abdomen','cervical spine','thoracic spine','lumbar spine','spine','skull','head','facial','sacrum','coccyx'];
  const radiologyExamSignature = (visit) => {
    const text = [visit.imaging_findings, visit.hpi_summary, visit.chief_complaint, visit.treatment_plan]
      .filter(Boolean).join(' ').toLowerCase();
    if (!text) return '';
    let bodyPart = '';
    let bestIdx = Infinity;
    BODY_PART_TERMS.forEach((term) => {
      const idx = text.indexOf(term);
      if (idx !== -1 && idx < bestIdx) { bestIdx = idx; bodyPart = term; }
    });
    let phase = '';
    if (/post[\s-]?reduction/.test(text)) phase = 'post';
    else if (/pre[\s-]?reduction/.test(text)) phase = 'pre';
    else {
      const timeMatch = text.match(/\b(\d{1,2}):(\d{2})\s*(am|pm)?\b/);
      if (timeMatch) phase = `${timeMatch[1]}:${timeMatch[2]}${timeMatch[3] || ''}`;
    }
    if (!bodyPart && !phase) return '';
    return `${bodyPart}::${phase}`;
  };

  const computeDedupKey = (visit) => {
    const dateKey     = (visit.visit_date || '').trim();
    const providerKey = normalizeProviderForDedup(visit.rendering_provider);
    const settingKey  = normalizeSettingForDedup(visit.practice_setting);
    if (!dateKey && !providerKey) return null; // passthrough — never grouped
    let key = `${dateKey}|${providerKey}|${settingKey}`;
    if (settingKey === 'radiology report') {
      const sig = radiologyExamSignature(visit);
      if (sig) key += `|${sig}`;
    }
    return key;
  };

  // Group by exact key, preserving first-occurrence order
  const groups = new Map();
  const keyOrder = [];
  visitList.forEach((visit) => {
    const key = computeDedupKey(visit);
    if (key === null) return; // passthrough handled at emit time
    if (!groups.has(key)) { groups.set(key, []); keyOrder.push(key); }
    groups.get(key).push(visit);
  });

  // Pre-compute the merged (richest) result per multi-entry key
  const mergedByKey = new Map();
  keyOrder.forEach((key) => {
    const group = groups.get(key);
    if (group.length === 1) return; // single entry — no merge needed
    // Stable sort: highest content score wins; ties keep first-occurrence order
    const base = group.slice().sort((a, b) => contentScore(b) - contentScore(a))[0];
    const result = { ...base };
    group.forEach((other) => {
      if (other === base) return;
      CONTENT_FIELDS.forEach((f) => {
        if (String(other[f] || '').length > String(result[f] || '').length) result[f] = other[f];
      });
      const codes = new Set([].concat(result.icd10_codes || []).concat(other.icd10_codes || []));
      result.icd10_codes = Array.from(codes);
    });
    console.log(`deduplicateVisits: merged ${group.length} duplicates [${key}] — kept richest entry (content score ${contentScore(base)})`);
    mergedByKey.set(key, result);
  });

  // Emit in original order: passthrough entries stay in place; the first
  // occurrence of each dedup key carries the merged-richest entry; later
  // duplicates are skipped.
  const emitted = new Set();
  const out = [];
  visitList.forEach((visit) => {
    const key = computeDedupKey(visit);
    if (key === null) { out.push(visit); return; }
    if (emitted.has(key)) return;
    emitted.add(key);
    out.push(mergedByKey.get(key) || visit);
  });
  return out;
};;


// correctEdVisitDates removed — replaced by step 3b service-date scan

// ── Merge resident-note / attending-duplicate pairs ──────────────────────────
// A resident-authored note co-signed by an attending is ONE encounter. The LLM
// sometimes emits TWO entries for it: one "[Resident] (Resident); Cosigned
// [Attending]" and a second "[Attending]" solo entry from the same note's
// attestation/addendum. Merge them: keep the resident entry, absorb richer
// content from the attending duplicate, drop the duplicate. (2026-09-07)
const _lastNameOfProvider = (raw) => {
  const s = (raw || '').trim();
  if (!s) return '';
  const comma = s.split(',')[0].trim();
  const parts = comma.split(/\s+/);
  return (parts.length > 1 ? parts[parts.length - 1] : comma).replace(/[^A-Za-z'-]/g, '').toLowerCase();
};

const mergeResidentCosignVisits = (visits) => {
  const visitList = visits || [];
  if (!Array.isArray(visitList)) return visitList;
  const RESIDENT_RE = /resident|fellow/i;
  const COSIGN_RE = /co-?sign(?:ed|ature)?\s*(?:by)?\s*([A-Za-z'-]+)/i;
  const dropIdx = new Set();
  const contentFields = ['hpi_summary','chief_complaint','impression_diagnosis','treatment_plan','physical_exam_findings','imaging_findings','lab_findings','symptom_progression','pain_scale','injury_date'];

  for (let i = 0; i < visitList.length; i++) {
    const a = visitList[i];
    if (dropIdx.has(i)) continue;
    const aProv = a.rendering_provider || '';
    if (!RESIDENT_RE.test(aProv)) continue;
    const m = COSIGN_RE.exec(aProv) || COSIGN_RE.exec(a.hpi_summary || '');
    if (!m) continue;
    const attLast = m[1].replace(/[^A-Za-z'-]/g, '').toLowerCase();
    if (!attLast) continue;
    for (let j = 0; j < visitList.length; j++) {
      if (i === j || dropIdx.has(j)) continue;
      const b = visitList[j];
      if ((b.visit_date || '') !== (a.visit_date || '')) continue;
      if (normalizeSettingForDedup(b.practice_setting) !== normalizeSettingForDedup(a.practice_setting)) continue;
      const bProv = b.rendering_provider || '';
      if (RESIDENT_RE.test(bProv)) continue; // resident entries never merge into each other
      if (_lastNameOfProvider(bProv) !== attLast) continue; // must be the same attending
      // Absorb richer content from the attending duplicate into the resident entry
      for (const f of contentFields) {
        const aVal = (a[f] || '').trim();
        const bVal = (b[f] || '').trim();
        if (!aVal && bVal) a[f] = bVal;
      }
      dropIdx.add(j);
      console.log(`mergeResidentCosign: dropped attending duplicate [${bProv}] (${b.visit_date || ''}) — same note as resident entry [${aProv}]`);
    }
  }
  return visitList.filter((_, idx) => !dropIdx.has(idx));
};

// Updated: 2026-09-12 — Billing-content contamination scrub (ZSolis/Hillock case).
// The LLM sometimes grafts CPT codes and copay/dollar figures from billing ledgers
// that share the same 50-page part with a clinic note (e.g. "Right ankle 2 views
// (CPT 73600)..." or "Self-pay co-pay $5.00."). Extraction prompt rule 6 now bans
// this at the source; this deterministic net catches anything that slips through:
// (a) strip inline CPT/HCPCS references, (b) drop sentences that are purely
// financial. If a field was ONLY billing content it becomes empty.
const BILLING_CPT_RE = /\(?\s*(?:CPT|HCPCS)\s*(?:code)?\s*[:#]?\s*[A-Za-z]?\d{4,5}[A-Za-z]{0,2}\s*\)?/gi;
const BILLING_SENTENCE_RE = /(?:\$\s*\d[\d,]*(?:\.\d{2})?|\b(?:co-?pay|self-?pay|deductible|coinsurance|balance due|past due|remit payment)\b)/i;
const stripBillingContamination = (text) => {
  if (!text) return text;
  let out = String(text).replace(BILLING_CPT_RE, ' ');
  out = out.replace(/\s*:\s*([A-Za-z])/g, ': $1'); // tidy " :" left by CPT removal
  out = out.replace(/\s{2,}/g, ' ').trim();
  const parts = out.split(/(?<=[.!?])\s+/);
  const kept = parts.filter((p) => !BILLING_SENTENCE_RE.test(p));
  if (!kept.length) return ''; // entire field was billing content
  out = kept.join(' ').trim();
  out = out.replace(/\s+([,;])\s*$/, '$1').replace(/\s*,\s*$/, '').replace(/\s*\.\s*$/, '.').trim();
  return out;
};

// Updated: 2026-09-20 -- patient-name majority vote. inputName (explicit
// user-supplied patient_name at job start) always wins outright if present.
// Otherwise, tally every candidate string collected across all batches/chunks
// (case/punctuation/whitespace-normalized for grouping) and return the most
// frequent group's most common exact-cased variant. Ties break on the longer
// normalized key (a more complete name beats a shorter partial match).
const pickPatientName = (inputName, candidates) => {
  const trimmedInput = (inputName || '').trim();
  if (trimmedInput) return trimmedInput;
  const clean = (candidates || []).map(c => (c || '').trim()).filter(Boolean);
  if (!clean.length) return '';
  const groups = {};
  for (const raw of clean) {
    const normKey = raw.toLowerCase().replace(/[.,]/g, '').replace(/\s+/g, ' ').trim();
    if (!normKey) continue;
    if (!groups[normKey]) groups[normKey] = { count: 0, variants: {} };
    groups[normKey].count++;
    groups[normKey].variants[raw] = (groups[normKey].variants[raw] || 0) + 1;
  }
  let bestKey = null, bestGroup = null;
  for (const [key, g] of Object.entries(groups)) {
    if (!bestGroup || g.count > bestGroup.count || (g.count === bestGroup.count && key.length > bestKey.length)) {
      bestKey = key; bestGroup = g;
    }
  }
  if (!bestGroup) return clean[0] || '';
  let bestVariant = null, bestVariantCount = -1;
  for (const [variant, count] of Object.entries(bestGroup.variants)) {
    if (count > bestVariantCount || (count === bestVariantCount && variant.length > (bestVariant || '').length)) {
      bestVariant = variant; bestVariantCount = count;
    }
  }
  return bestVariant || clean[0] || '';
};

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
    // Updated: 2026-09-16 — normalize US-format dates (M/D/YYYY) to ISO (YYYY-MM-DD)
    // early in sanitize. Bedrock occasionally returns MM/DD/YYYY despite the prompt's
    // YYYY-MM-DD requirement; mixed formats defeat dedup (same visit stored as
    // '09/17/2025' vs '2025-09-17' never merges, breaking same-date pairing and C-4
    // cross-referencing) and break the visitYear slice below.
    const normalizeDateField = (val) => {
      if (!val) return val;
      const m = String(val).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (!m) return val;
      return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
    };
    clean.visit_date = normalizeDateField(clean.visit_date);
    clean.injury_date = normalizeDateField(clean.injury_date);

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

    // Updated: 2026-09-12 — apply billing-content scrub to all narrative fields
    ['hpi_summary','treatment_plan','physical_exam_findings','imaging_findings','impression_diagnosis','chief_complaint'].forEach((field) => {
      if (clean[field]) clean[field] = stripBillingContamination(clean[field]);
    });

    const patientLower = patientName?.toLowerCase();
    if (clean.practice_setting && patientLower && clean.practice_setting.toLowerCase().includes(patientLower)) {
      clean.practice_setting = '';
    }

    // Updated: 2026-08-31 — strip street address from practice_setting.
    // The LLM sometimes pulls the full letterhead address (e.g. "Hand Center of
    // Nevada - 8585 S Eastern Ave") instead of just the facility name. Strip any
    // trailing "<number> <street words> <street-type>" segment, with its leading
    // separator (dash/comma), plus any trailing suite/city/state/zip that follows it.
    // Only matches when a digit + street-type keyword is present — leaves non-address
    // suffixes like "- Independent Medical Examination" or "- DHPT Sahara" untouched.
    if (clean.practice_setting) {
      const streetTypeRe = /\b(Ave|Avenue|St|Street|Blvd|Boulevard|Dr|Drive|Rd|Road|Way|Ln|Lane|Ct|Court|Pl|Place|Pkwy|Parkway|Hwy|Highway|Cir|Circle|Ter|Terrace)\b/i;
      const addressStripRe = /\s*[-–,]?\s*\d+[\d\s.,'#A-Za-z]*?\b(?:Ave|Avenue|St|Street|Blvd|Boulevard|Dr|Drive|Rd|Road|Way|Ln|Lane|Ct|Court|Pl|Place|Pkwy|Parkway|Hwy|Highway|Cir|Circle|Ter|Terrace)\.?\s*(?:,?\s*(?:Suite|Ste|#)\s*\w+)?\s*(?:,\s*[A-Za-z\s]+,?\s*[A-Z]{2}\s*\d{5}(?:-\d{4})?)?\s*$/i;
      if (streetTypeRe.test(clean.practice_setting) && addressStripRe.test(clean.practice_setting)) {
        const before = clean.practice_setting;
        clean.practice_setting = clean.practice_setting.replace(addressStripRe, '').trim();
        if (before !== clean.practice_setting) {
          console.log('sanitizeVisits: stripped street address from practice_setting [' + before + '] -> [' + clean.practice_setting + ']');
        }
      }
    }

    return clean;
  }).filter(visit => {
    // Updated: 2026-08-31 — admin check moved BEFORE SOAP rescue
    // Code-level safety net: drop non-clinical document types even if the model extracted them
    const setting = (visit.practice_setting || '').toLowerCase();
    const provider = (visit.rendering_provider || '').toLowerCase();
    const hpi = (visit.hpi_summary || '').toLowerCase();

    // Updated: 2026-08-31 — content-based override: a Work Status Form mislabeled
    // as "C-4" by the LLM (e.g. "Form C-4" boilerplate bleeding from an adjacent
    // page/footer) must NOT get the C-4 exemption. A genuine C-4 documents
    // claim/injury/employer details; a Work Status Form is short MMI/return-to-work
    // checkbox language. Content wins over whatever label the LLM assigned.
    const diagnosisTextC4 = (visit.impression_diagnosis || '').toLowerCase();
    const treatmentTextC4 = (visit.treatment_plan || '').toLowerCase();
    const combinedTextC4 = hpi + ' ' + diagnosisTextC4 + ' ' + treatmentTextC4;
    const hasWorkStatusTemplateC4 =
      (combinedTextC4.includes('not at maximum medical improvement') ||
       combinedTextC4.includes('maximum medical improvement')) &&
      (combinedTextC4.includes('unable to work') ||
       combinedTextC4.includes('next appointment') ||
       combinedTextC4.includes('follow-up appointment') ||
       combinedTextC4.includes('return to work'));
    const hasGenuineC4Markers =
      combinedTextC4.includes("employee's claim for compensation") ||
      combinedTextC4.includes('report of initial treatment') ||
      combinedTextC4.includes('claim number') ||
      combinedTextC4.includes('date of injury') ||
      combinedTextC4.includes('sustained an injury') ||
      combinedTextC4.includes('average weekly wage') ||
      combinedTextC4.includes('employer');
    const isMislabeledWorkStatus = hasWorkStatusTemplateC4 && !hasGenuineC4Markers;
    if (isMislabeledWorkStatus) {
      console.log('sanitizeVisits: C-4 label override — content matches Work Status Form template, not a genuine C-4 (' + (visit.visit_date || '') + ' ' + (visit.rendering_provider || '') + ')');
    }

    // C-4 forms are ALWAYS clinical — exempt before any other check
    // (unless content-based check above determined this is a mislabeled Work Status Form)
    const isC4 = !isMislabeledWorkStatus && (setting.includes('c-4') || setting.includes('c4 ') ||
                 setting.includes("workers' compensation report") ||
                 (visit.visit_type || '').toLowerCase().includes('c-4'));

    // ── Admin document detection (runs BEFORE SOAP rescue) ───────────────
    // Admin forms often contain narrative text (HPI about what's being authorized,
    // treatment plans listing what's requested) but are NOT clinical encounters.
    // Check admin patterns FIRST so they get filtered even with narrative content.
    const isPPR = setting.includes("physician's progress report") ||
                  setting.includes("physicians progress report") ||
                  setting.includes("physician progress report") ||
                  setting === 'ppr';
    const isCodingSummary = setting.includes('coding summary') ||
                            setting.includes('coding abstract') ||
                            provider.includes('abstractor') ||
                            provider.includes('cacuser') ||
                            provider.includes('coder:');
    const isAdminOnly = !isC4 && (
                        setting.includes('appointment reminder') ||
                        setting.includes('face sheet') ||
                        setting.includes('authorization request') ||
                        setting.includes('surgery authorization') ||
                        setting.includes('surgical authorization') ||
                        setting.includes('authorization for operative') ||
                        setting.includes('consent for') ||
                        setting.includes('surgical consent') ||
                        setting.includes('informed consent') ||
                        setting.includes('fax cover') ||
                        setting.includes('work status form') ||
                        setting.includes('work status') ||
                        setting.includes('diagnostic test request') ||
                        setting.includes('appointment rescheduling') ||
                        setting.includes('rescheduling notice') ||
                        setting.includes('written order') ||
                        setting.includes('post-operative written order') ||
                        setting.includes('dvt risk assessment') ||
                        setting.includes('treatment prescription') ||
                        setting.includes('clinical documentation record') ||
                        setting.includes('medication list') ||
                        setting.includes('medication administration') ||
                        setting.includes('implant/vendor') ||
                        setting.includes('implant / vendor') ||
                        setting.includes('brought supplies') ||
                        // Updated: 2026-09-07 — case management / discharge planning notes,
                        // expert reports, and care-coordination-only calls excluded per
                        // encounter-level policy.
                        setting.includes('discharge planning') ||
                        setting.includes('case management') ||
                        /\bexpert\b/i.test(visit.practice_setting || '') ||
                        // Care-coordination-only calls: pure protocol/scheduling logs with
                        // no clinical assessment (call attempts, callbacks, condition-
                        // management protocol follow-ups). A call WITH clinical content
                        // (symptom reports, medication discussion) is KEPT — verified by
                        // the clinical-marker check below. (2026-09-07)
                        ((((visit.chief_complaint || '').toLowerCase()).includes('care coordination') ||
                          hpi.includes('care coordination')) && !isC4 &&
                         !/(reports pain|pain \d|oxycodone|symptom|injury|fracture|wound|swelling|edema|radiograph|x-ray|medication (change|adjust|restart))/.test(hpi)) ||
                        // Also check HPI for admin keywords the LLM put in HPI instead of setting
                        (hpi.includes('authorization request submitted') && !isC4) ||
                        (hpi.includes('assessments completed at') && !isC4) ||
                        (hpi.includes('assessments documented at') && !isC4) ||
                        (hpi.includes('shift assessments') && !isC4) ||
                        (hpi.includes('authorization requested for') && !isC4) ||
                        (hpi.includes('surgery authorization requested') && !isC4) ||
                        (hpi.includes('work status form') && !isC4));

    // Provider = facility detection: admin forms where no real provider signed,
    // the LLM just put the facility name in both fields (e.g. "Hand Center of Nevada")
    const providerEqualsFacility = !isC4 && provider.length > 0 &&
                     provider === setting &&
                     !provider.includes('dr') && !provider.includes('md') &&
                     !provider.includes('do') && !provider.includes('pa') &&
                     !provider.includes('np') && !provider.includes('pt') &&
                     !provider.includes('ot') && !provider.includes('dc') &&
                     !provider.includes('dpt') && !provider.includes('otr');

    // HPI template check: Work Status Forms have a distinctive template pattern
    const isWorkStatusTemplate = !isC4 && (
      (hpi.includes('patient evaluated at') && hpi.includes('not at maximum medical improvement')) ||
      (hpi.includes('patient evaluated') && hpi.includes('status:') && hpi.includes('follow-up appointment')));

    const isAdmin = !isC4 && (isPPR || isCodingSummary || isAdminOnly || isMislabeledWorkStatus || (providerEqualsFacility && isWorkStatusTemplate));

    // Updated: 2026-09-15 — billing-statement visit veto (ZSolis case). Charge statements
    // and remittance pages sometimes mint phantom visit entries (e.g. "Radiology
    // Specialists Ltd - Radiology Report" built from the group's patient statement,
    // "CenterWell / Conviva - Billing Record"). The field-level billing scrub strips
    // CPT/$ content but cannot prevent the ENTRY itself from existing. Veto an entry
    // when (a) its setting names a billing artifact, or (b) every narrative field is
    // empty after the billing scrub (pure billing content, no clinical substance).
    // C-4 forms are exempt — they legitimately contain claim numbers. Judgment-call
    // same-day duplicates are NOT touched here; those stay for the user to decide.
    const isBillingArtifact = !isC4 && (
      /billing record|billing statement|charge statement|account inquiry|itemized bill|statement of account|remittance|explanation of benefits|claim voucher/.test(setting) ||
      (!(visit.hpi_summary || visit.chief_complaint) &&
       !(visit.impression_diagnosis || visit.treatment_plan) &&
       !(visit.physical_exam_findings || visit.imaging_findings) &&
       !(visit.symptom_progression || '')));
    if (isBillingArtifact) {
      console.log('sanitizeVisits: dropping billing-statement entry [' + (visit.practice_setting || '') + '] (' + (visit.visit_date || '') + ' ' + (visit.rendering_provider || '') + ')');
      return false;
    }

    if (isAdmin) {
      const reason = isPPR ? 'PPR' : isCodingSummary ? 'coding summary' :
                     isAdminOnly ? 'admin pattern' : isMislabeledWorkStatus ? 'mislabeled C-4 (actually work status form)' :
                     'provider=facility+work status template';
      console.log('sanitizeVisits: dropping non-clinical entry [' + (visit.practice_setting || '') + '] (' + (visit.visit_date || '') + ' ' + (visit.rendering_provider || '') + ') — reason: ' + reason);
      return false;
    }

    // ── Cross-patient name validation (2026-08-31) ─────────────────────────
    // Sometimes medical records contain misfiled pages from a DIFFERENT patient
    // (e.g. a visit for "Jason Sullivan" mixed into a "Sagrario Concepcion" file).
    // The LLM extracts them as visits because they contain real clinical content.
    // Drop visits whose HPI explicitly names a different patient by full name.
    // Uses the ORIGINAL (non-lowercased) HPI text for proper capitalization matching.
    if (patientName) {
      const rawHpi = visit.hpi_summary || '';
      const patientTokens = patientName.toLowerCase().split(/\s+/).filter(t => t.length > 1);

      // Match "FirstName LastName" at start of HPI or after a sentence boundary,
      // followed by typical clinical intro patterns:
      //   "Jason Sullivan is a 53-year-old..."
      //   "Jason Sullivan, 53-year-old..."
      //   "Jason Sullivan presents for..."
      //   "Jason Sullivan returns for..."
      //   "Jason Sullivan, a 41-year-old..."
      const namePattern = /(?:^|\.\s+)(([A-Z][a-z]+)\s+([A-Z][a-z]+))(?:\s+is\s+a\s+\d|\s*,\s*\d|\s*,\s*a\s+\d|\s+presents|\s+returns)/;
      const nameMatchRaw = rawHpi.match(namePattern);
      if (nameMatchRaw) {
        const foundFirstMatch = nameMatchRaw[2].toLowerCase();
        const foundLastMatch = nameMatchRaw[3].toLowerCase();
        // Patient match if ANY token matches first or last (handles nicknames, maiden names)
        const isPatientName = patientTokens.some(t => t === foundLastMatch || t === foundFirstMatch);
        if (!isPatientName) {
          console.log('sanitizeVisits: cross-patient drop — HPI names [' + foundFirstMatch + ' ' + foundLastMatch + '] but patient is [' + patientName + '] (' + (visit.visit_date || '') + ')');
          return false;
        }
      }
    }

    // ── Structural SOAP test (LLM-label-independent) ─────────────────────
    // Only reached for NON-admin visits. A true PPR / admin form was already filtered above.
    // Any visit with substantive SOAP fields is a real clinical encounter
    // regardless of what the LLM put in practice_setting.
    const soapScore =
      ((visit.hpi_summary            || '').length > 20 ? 1 : 0) +
      ((visit.physical_exam_findings || '').length > 20 ? 1 : 0) +
      ((visit.treatment_plan         || '').length > 20 ? 1 : 0) +
      ((visit.impression_diagnosis   || '').length > 10 ? 1 : 0);
    if (soapScore >= 2) {
      // Has real clinical narrative — keep unconditionally, fix mislabeled setting
      const mislabeled = /physician['s]* progress report|ppr/i.test(visit.practice_setting || '');
      if (mislabeled) {
        console.log('sanitizeVisits: structural rescue — SOAP score ' + soapScore + ', fixing mislabeled setting [' + (visit.practice_setting || '') + '] (' + (visit.visit_date || '') + ' ' + (visit.rendering_provider || '') + ')');
        visit.practice_setting = (visit.practice_setting || '')
          .replace(/physician['s]* progress report/gi, '')
          .replace(/ppr/gi, '')
          .trim()
          .replace(/^[-\u2013\u2014,\s]+|[-\u2013\u2014,\s]+$/g, '')
          .trim() || 'Office Visit';
      }
      return true;
    }

    // Low SOAP score + not admin — keep
    return true;
  });
};

const enforceOneC4 = (visitList) => {
  // Updated: 2026-08-31 — only dedup C-4s on the SAME date, not across all dates
  // A patient can have multiple C-4 forms for different injuries (e.g. initial C-4
  // for wrist injury 2021, subsequent C-4 for thumb surgery 2025). Only dedup
  // when multiple C-4s appear for the exact same visit_date.
  const c4s = visitList.filter(v => (v.practice_setting || '').toLowerCase().includes('c-4'));
  if (c4s.length <= 1) return visitList;

  // Group C-4s by date
  const c4ByDate = {};
  for (const v of c4s) {
    const d = v.visit_date || '';
    if (!c4ByDate[d]) c4ByDate[d] = [];
    c4ByDate[d].push(v);
  }

  // For each date with multiple C-4s, keep only the first (by original order)
  const dropSet = new Set();
  for (const [date, group] of Object.entries(c4ByDate)) {
    if (group.length > 1) {
      console.log(`enforceOneC4: dedup ${group.length} C-4 entries on ${date}, keeping first`);
      for (let i = 1; i < group.length; i++) {
        dropSet.add(group[i]);
      }
    }
  }

  return visitList.filter(v => !dropSet.has(v));
};


// ── Forensic analyst system prompt ───────────────────────────────────────────
// Injected as the Bedrock `system` field on every extraction call.
// This sets Claude's operating mode before it reads a single word of document content.
const EXTRACTION_SYSTEM_PROMPT = `You are a forensic medical document analyst specializing in workers' compensation and personal injury litigation. Your work product is read by attorneys and used in legal proceedings — precision and fidelity to the source document are paramount.

Your operating principles:
1. DOCUMENT BOUNDARIES ARE ABSOLUTE. Each document in a medical record is a discrete, bounded unit. A document means ONE clinical note or report — never a file, never a batch, never a page range. A single PDF file or batch may contain MANY unrelated documents: clinic notes, hospital records, billing ledgers, insurance statements, legal filings. File boundaries and page boundaries are NOT document boundaries — a new document begins wherever a distinct note, report, or statement begins. You extract information from the single document you are currently reading — never from an adjacent, co-occurring, or same-date document elsewhere in the same file or batch. If you find yourself writing language that does not appear in the specific document you are extracting, stop and delete it.
   C-4 EXCEPTION: C-4 forms are often partially illegible scanned images. For C-4 forms ONLY, you MAY cross-reference a same-date office visit from the same document set to fill in illegible fields (provider name, diagnosis, ICD-10 codes). This is the ONLY exception to the document boundary rule.
   C-4 MISLABELING WARNING: A genuine C-4 form is titled "FORM C-4" / "EMPLOYEE'S CLAIM FOR COMPENSATION/REPORT OF INITIAL TREATMENT" and documents claim number, date of injury, employer, and accident description. Some pages carry "Form C-4" boilerplate text in a header/footer (e.g. "Complete and attach Release of Information (Form C-4A)...") even though the page itself is a Work Status Form, Progress Report, or other document. Do NOT set practice_setting to "C-4" or "Workers' Compensation Report" unless the page is ACTUALLY the claim/injury form itself. A page whose content is "not at maximum medical improvement... unable to work [date] to [date]... next appointment [date]" is a Work Status Form — label it as such, never as C-4, even if "Form C-4" boilerplate text appears in a footer.
2. YOU DO NOT INFER. You report only what is explicitly written. If a field is not documented, return an empty string. A missing value is always better than a hallucinated one.
3. YOU DO NOT MERGE. Two documents on the same date from the same provider are two documents. A consultation note and an operative note are different documents. A History & Physical and a Discharge Summary are different documents. You extract each separately, completely, and independently.
4. YOU ARE CONSERVATIVE WITH CLINICAL LANGUAGE. Do not paraphrase in ways that change meaning. Do not upgrade or downgrade clinical severity. Report findings as documented.
5. YOU SELF-CHECK FOR BLEED. Before finalizing any visit entry, ask yourself: "Does any language in this entry come from a document other than the one I am currently extracting?" If yes, remove it.
6. BILLING CONTENT IS NEVER CLINICAL CONTENT. Charge ledgers, claim vouchers, payment postings, remittance advice, and itemized bills describe money, not medicine. CPT/HCPCS codes, charge or payment dollar amounts, copay/self-pay figures, claim or voucher numbers, payor names, and "Your Co-Pay is due at time of service" style boilerplate must NEVER appear in any clinical field — imaging_findings, treatment_plan, hpi_summary, chief_complaint, or any other — even if the billing pages sit in the same file or the same page range as the visit's own note. A CPT code printed in a charge ledger belongs to that ledger's row (its own date of service), never to the note you are extracting. The ONLY cross-document exception remains the C-4 cross-reference described above. A charge statement, itemized bill, account inquiry, remittance advice, EOB, or provider billing statement is NOT an encounter: never create a visit entry from these pages, even if they name a provider and a date of service.`;

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
    - NEVER include the street address, suite number, city, state, or zip code in practice_setting — ONLY the facility/organization name. E.g. if the letterhead reads "Hand Center of Nevada, 8585 S Eastern Ave, Las Vegas, NV 89123", practice_setting should be "Hand Center of Nevada" — NOT "Hand Center of Nevada - 8585 S Eastern Ave" or any variant including the address.

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
    - visit_date: the DATE OF EXAMINATION — the date the form was completed / the provider signed it — this is CRITICAL to extract even if the rest of the form is illegible. Priority order: the form's "DATE OF EXAMINATION" or exam "DATE" field → provider signature date → form completion date. The form's "DATE OF INJURY" field goes in injury_date ONLY — NEVER use the injury date as visit_date. The injury date and the exam date are usually DIFFERENT days on a C-4 (the form documents the initial treatment visit, which may be days after the injury).
    - hpi_summary: leave empty
    - chief_complaint: leave empty
    - physical_exam_findings: leave empty
    - treatment_plan: leave empty
    - CROSS-REFERENCE: This is OPTIONAL and applies ONLY if a genuinely separate, already-documented office visit ALSO exists in the same document set on the C-4's exact date. If such a document exists, you may use its rendering provider and/or diagnosis to fill in illegible C-4 fields, and explicitly note when extrapolated (e.g., "Extrapolated from same-date office visit"). Do NOT invent, synthesize, or backfill a same-date office visit entry that does not exist in the source documents — if the C-4 form is the ONLY document for that date, extract ONLY the C-4 entry and leave any illegible fields as-is (or "illegible").
    - ORDERING: IF a genuinely separate, distinctly-documented office visit ALSO exists for the same date as the C-4 (i.e., the source contains a separate office note, not just the C-4 form itself), place the C-4 entry BEFORE that office visit entry in the visits array. If NO separate office visit document exists for that date, the C-4 is a standalone entry — do NOT create a companion "Office Visit" entry just to pair with it.

SAME-DATE DOCUMENT ISOLATION — ABSOLUTE RULE (C-4 EXCEPTION: see above — C-4 forms may cross-reference same-date office visits for illegible fields):
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

CONTENT ISOLATION — ABSOLUTE RULE (C-4 EXCEPTION: C-4 forms may import provider/diagnosis from same-date office visits):
When extracting any single visit/document, you MUST use ONLY the content within that specific document.
- A Consultation Report's HPI must come ONLY from the consultation document — NOT from the operative note, NOT from the ED note, NOT from any other same-date document.
- An Operative Report's HPI must come ONLY from the operative note itself.
- A Discharge Summary must come ONLY from the discharge document.
- For a Discharge Summary, the Treatment Plan field must contain the DISCHARGE plan — follow-up instructions, discharge medications, return precautions, activity restrictions at discharge. Do NOT use the inpatient admission or treatment orders (IV fluids, admit to medicine, etc.) — those belong to the H&P or ED note, not the discharge summary.
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
RULE: A true PPR is identified by "PHYSICIAN'S PROGRESS REPORT" appearing as the document title at the very top of the page — before any structured patient header — combined with pre-printed checkbox fields for disability status and work restrictions. If a document has a full structured header (facility, patient name, service date, dictating provider) followed by a SOAP-style narrative body (Subjective Complaints / Objective Findings / Assessment / Plan), it is a dictated office note, NOT a PPR — even if the words "Physician Progress Report" appear as a label somewhere inside the notes section body. Extract it as a regular office visit and set practice_setting to the facility name. Do NOT extract it as "Physician Progress Report".

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
   - C-4 EXCEPTION: For C-4 forms only, you may import rendering_provider, impression_diagnosis, and icd10_codes from a same-date office visit when the C-4 form is illegible.
   - Keep to 2-3 sentences maximum. Distill only what is clinically material.

6. Physical Examination Findings — SUMMARIZE KEY PERTINENT POSITIVES ONLY, FROM THIS DOCUMENT:
   - ONLY findings documented in THIS specific document
   - Abnormal findings only — omit normal/unremarkable results
   - 3 key findings maximum
   - EXCLUDE imaging/radiograph interpretation results (e.g., "radiographs show...", "x-ray reveals...", "reduction maintained") even if the source note lists them under its own physical exam section — that content belongs exclusively in imaging_findings (rule 7), never here
   - For operative notes: intraoperative findings, not pre-op exam
   - For consultation notes: the consulting physician's own exam findings only

7. Imaging findings — ONLY if performed or interpreted in THIS document. Capture the RADIOGRAPHIC OBSERVATION itself, as the treating provider describes it — alignment/reduction status, hardware position, healing, displacement, effusion, loss of fixation, etc.
   GOOD example: "Right ankle XR: reduction maintained, no hardware breakage or migration, mortise reestablished."
   BAD example — NEVER do this: "Right ankle X-ray 2 views: displaced trimalleolar fracture of right lower leg, subsequent encounter." That sentence is the ICD-10 diagnosis description, not a radiographic finding, and must NEVER appear in this field — diagnosis language belongs exclusively in impression_diagnosis.
   If the note ONLY states a study was performed/reviewed without describing any observation, write the study name and view count only (e.g., "Right ankle X-ray, 2 views.") — do NOT borrow diagnosis or impression wording to fill this field.
   Do NOT re-report imaging from a co-occurring radiology report. NEVER include CPT/HCPCS codes, charge amounts, or any billing-ledger language.
8. Lab findings — return empty string always. Laboratory panels are captured separately and are not needed in the summary.
9. Impression/diagnosis — from THIS document's own conclusions. ICD-10 codes inline in parentheses.
10. Treatment Plan — CONCISE, 2-4 items max:
   - Interventions performed or prescribed IN THIS document
   - Medications (name, dose).
   - Activity restrictions
   - Follow-up plan
   - NEVER billing content: CPT codes, dollar amounts, copay/self-pay figures, insurance or payment details

Be RUTHLESSLY CONCISE. Every field reads like a tight medical-legal summary. No filler. No restating headers.

CRITICAL FORMATTING RULES:
- Every field must be a plain text string. NEVER return null, arrays, or objects for text fields.
- If information is not available for a field, return an empty string "".
- The icd10_codes field must always be an array of strings (can be empty []).
- visit_date MUST be in YYYY-MM-DD format always (e.g. 2026-01-20). Never return any other date format.
- source_page: the page number WITHIN THIS PDF FILE (not the original larger document — just this file, first page = 1) where this visit's content BEGINS. Count every page of the file you were given, including cover/blank pages. Return it as a plain integer. If a visit's content spans multiple pages, return the page where it starts. This must always be filled in — never leave it blank or 0.

DATE SELECTION RULES:
- DISCHARGE DOCUMENTS ("Discharge Summary", "Discharge Report", "Hospitalist Discharge Summary", "IDEV Discharge Report"): visit_date = the DISCHARGE date. Use the note's own date field in this priority order: DATE: / REP SRV DT: / "DATE OF DISCHARGE" / DISCH / DISCH/DEP. NEVER use the ADMIT, ADM DT, or REG date for a discharge document — a discharge summary is written at the END of the stay and belongs to the discharge date, even though the header also shows the admission date.

- C-4 FORMS: visit_date = the DATE OF EXAMINATION / date the form was completed — NEVER the form's DATE OF INJURY (that goes in injury_date only). The injury date and the exam date are usually different days.
- Consultation notes: prefer DATE OF CONSULTATION / REP SRV DT over general header dates (e.g. ADMIT DT).
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
(11) PHYSICIAN'S PROGRESS REPORTS (PPR): Do NOT extract a true Physician's Progress Report as a visit. A true PPR is a pre-printed workers' comp checkbox form — its title "PHYSICIAN'S PROGRESS REPORT" appears at the very top of the page before any patient header, and it contains checkbox fields for disability status and work restrictions rather than a narrative. If instead the document has a structured patient header (facility, service date, dictating provider) and a full SOAP narrative (Subjective/Objective/Assessment/Plan), it is a dictated office note — extract it normally as a visit, even if the words "Physician Progress Report" appear as a label inside the Notes body. Set practice_setting to the facility name, not to "Physician Progress Report".
(11a) SURGERY AUTHORIZATION REQUESTS: Do NOT extract surgery authorization request forms as visits. These are administrative paperwork submitted to insurance/claims adjusters — identifiable by "Authorization Request", "Surgery Authorization Request", or "Authorization for" in the document header. They describe a planned surgery but contain no examination or clinical encounter. The actual surgery is captured in the Operative Report. SKIP these entirely.
(11b) WORK STATUS FORMS: Do NOT extract Work Status Forms as visits. These are pre-printed WC forms with checkboxes and a brief "not at maximum medical improvement" / "follow-up appointment" template — identifiable by "Work Status Form", "Work Status", or "Work Activity Status" in the header, OR a template HPI pattern like "Patient evaluated at [facility]. Status: not at maximum medical improvement. Follow-up appointment set for [date]." They contain no independent clinical encounter. SKIP these entirely.
(11c) DIAGNOSTIC TEST REQUESTS: Do NOT extract diagnostic test request forms as visits (e.g. "Diagnostic Test Request" ordering NCV/EMG). These are referral orders — the actual diagnostic test results (if performed) are captured in the radiology/neurology report. SKIP these entirely.
(11d) APPOINTMENT RESCHEDULING NOTICES: Do NOT extract appointment rescheduling/reminders as visits. These are administrative scheduling notices. SKIP these entirely.
(11e) WRITTEN ORDERS / POST-OPERATIVE WRITTEN ORDERS: Do NOT extract written orders, post-operative written orders, or DVT risk assessment forms as visits. These are administrative paperwork, not clinical encounters. SKIP these entirely.
(11f) TREATMENT PRESCRIPTIONS: Do NOT extract treatment prescription forms as visits (e.g. Hand therapy prescription listing exercises). These are referral orders — the actual treatment is captured in PT/OT visit notes. SKIP these entirely.
(11g) NURSING CLINICAL DOCUMENTATION RECORDS / PER-SHIFT NURSING NOTES: Do NOT extract nursing shift-assessment documents as visits — identifiable by titles like "Clinical Documentation Record", "CPCS", or by a series of timestamped nursing assessments (e.g. "Assessments completed at 0000, 0400, 0800...", "Shift assessments [date]"). These are nursing documentation of an inpatient stay already captured by the physician documents (H&P, consults, operative reports, hospitalist notes, discharge summary). SKIP these entirely.
(11h) IMPLANT / VENDOR SUPPLY LOGS: Do NOT extract implant or vendor brought-supplies records as visits (e.g. "Implant/Vendor Brought Supplies Record" listing implant part numbers, lot numbers, and expiration dates). Implant details are captured in the Operative Report. SKIP these entirely.
(11i) MEDICATION LISTS: Do NOT extract discharge patient medication lists, medication administration records (MAR), or medication reconciliation printouts as visits. These are medication paperwork — the clinical encounter is captured by the physician documents. SKIP these entirely.
(11j) CASE MANAGEMENT / DISCHARGE PLANNING: Do NOT extract case management reports, discharge planning notes, social work assessments, or insurance verification notes as visits. These are administrative coordination documents. SKIP these entirely.
(11k) EXPERT REPORTS: Do NOT extract expert witness reports, engineering reports, or accident-reconstruction reports (e.g. "Expert Engineering Report" analyzing premises liability) as visits — they are legal case documents, not medical records. SKIP these entirely.
(11l) SCHEDULING-ONLY CALLS: Do NOT extract telephone encounters that are purely care-coordination or scheduling logs (call attempts, callbacks, condition-management protocol follow-ups with no clinical assessment). A telephone call WITH clinical content (symptom reports, medication discussion, clinical advice) IS a valid visit and must be extracted.
(12) CONSENT FORMS / AUTHORIZATION FORMS: Do NOT extract surgical consent forms, "Authorization for Operative and Other Procedure(s)" documents, or any other consent signature pages as visits. These are administrative paperwork — the clinical content (the surgery itself) is captured in the Operative Report. Identifiable by headers like "Authorization for Operative and Other Procedures", "Informed Consent", "Surgical Consent Form".
(13-admin) APPOINTMENT REMINDERS / FACE SHEETS: Do NOT extract appointment reminder slips, return visit scheduling notices, demographic face sheets, or authorization request forms as visits. These contain no clinical encounter content.
(14) RESIDENT NOTES CO-SIGNED BY AN ATTENDING: When a clinical note is authored by a resident (or fellow) and co-signed or attested by an attending physician (identifiable by markers like "Author Type: Resident", "Cosigner: [Attending]", "Attestation signed by [Attending]", or an attending addendum appended to a resident note), extract ONE entry with rendering_provider = "[Resident Author] (Resident), cosigned by [Attending]". The attending's co-signature, attestation, or addendum is NOT a separate clinical encounter — NEVER create a second entry for the attending from the same note.
(13) CODING SUMMARIES / BILLING ABSTRACTS: Do NOT extract hospital coding summaries, DRG abstracts, or billing abstraction records as visits. These are administrative billing documents generated by coders (not clinicians) and contain no independent clinical encounter content. Identifiable by headers like "Coding Summary", "Discharge Abstract", "DRG Assignment", or provider listed as "Coder", "Abstractor", or a system name like "Cacuser".

Return ALL entries found across ALL documents as separate entries in the visits array.

Also extract:
- Patient name (should be consistent across documents). If the patient's name is handwritten in one place (e.g. filled in on a claim form) but appears TYPED or PRINTED elsewhere in this same batch (e.g. a transcription header, insurer letterhead, typed intake form, or dictated note byline), use the typed/printed spelling — handwritten cursive is frequently misread (e.g. l/r/c confusion), typed text is not. Only fall back to your best reading of the handwriting if no typed occurrence of the name exists anywhere in this batch.
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
   CRITICAL — TIME FIELDS: Completely ignore any TIME or military time value (e.g. "TIME: 1825", "REP SRV TM: 1825") when determining the date. Dates in medical documents are always local calendar dates. Never treat a time value as a UTC offset. "SERVICE DT: 10/01/25 TIME: 1825" means the visit date is 10/01/2025 — period.
2. provider - the treating provider's name and credentials (e.g. "Arthur J. Taylor, MD")
3. facility - the facility or practice name (e.g. "Nevada Orthopedic & Spine Center", "Centennial Hills Hospital Emergency Department", "Dignity Health Physical Therapy")
4. visit_type - a brief label: "Office Visit", "ER Visit", "Surgery", "Physical Therapy", "Radiology", "C-4 Form", "IME", "Chiropractic", etc.

RULES:
- Include EVERY encounter -- office visits, ER, surgery, PT/OT, radiology, C-4 forms, IMEs, ambulance, etc.
- Each unique date + provider combination is a separate entry.
- Do NOT include administrative documents (therapy orders, authorization requests, surgery authorization requests, work status forms, diagnostic test requests, appointment reminders/rescheduling, written orders, post-operative written orders, treatment prescriptions, fax covers). ALWAYS include radiology visits (MRI, X-ray, CT, bone scan, etc.) -- these are clinical encounters.
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
  const { doc_ids, patient_name = '', exclude_emr = false, include_all_pt = false } = body;
  const callerOrgId = event._orgId || '';
  const org_id = (event._isAdmin && body.org_id) ? body.org_id : callerOrgId;

  if (!doc_ids?.length) return httpResponse(400, { error: 'doc_ids required' });

  // Ownership check: every doc_id must belong to the caller's org (admin bypasses).
  if (!event._isAdmin) {
    const ownerCheckDocs = await fetchDocRecords(doc_ids);
    const foreignDoc = ownerCheckDocs.find(d => d.org_id && d.org_id !== callerOrgId);
    if (foreignDoc) return httpResponse(403, { error: 'Forbidden: one or more documents do not belong to your account' });
  }

  const job_id = randomUUID();
  await dynamo.send(new UpdateCommand({
    TableName: JOBS_TABLE, Key: { job_id },
    UpdateExpression: 'SET #s = :s, created_at = :now, updated_at = :now, job_type = :t, org_id = :oid, exclude_emr = :eer, include_all_pt = :iapt',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':s': 'running', ':now': new Date().toISOString(), ':t': 'generate_summary', ':oid': org_id, ':eer': !!exclude_emr, ':iapt': !!include_all_pt },
  }));

  // Fire the coordinator worker asynchronously
  await lambda.send(new InvokeCommand({
    FunctionName: WORKER_FN,
    InvocationType: 'Event',
    Payload: Buffer.from(JSON.stringify({ job_id, doc_ids, patient_name, org_id, exclude_emr: !!exclude_emr, include_all_pt: !!include_all_pt })),
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

  // Updated: 2026-09-20 -- reset usage accumulator so this chunk's Bedrock
  // usage isn't polluted by a warm-container leftover from a prior invocation.
  resetRunUsage();

  // Pre-fetch region order once for this chunk worker (avoids DynamoDB read per batch)
  const regionOrder = await getRegionOrder();
  console.log(`chunkWorker[${chunkIndex}] regionOrder: ${regionOrder.map(r => r.region).join(' → ')}`);

  const chunkVisits = [];
  let patientName   = patientNameHint || '';
  let caseNumber    = '';
  // Updated: 2026-09-20 -- patient-name majority vote (fixes name spelling
  // instability across runs, e.g. "Belk"/"Berk"/"Beck" from the same
  // documents). Every batch independently guesses patient_name from
  // whatever it can see; a handwritten field (like a C-4 claim form) can be
  // misread differently batch to batch. Track EVERY non-empty guess here
  // instead of keeping only the first -- the coordinator tallies all
  // chunks' candidates and picks the most common spelling.
  const patientNameCandidates = [];

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
            source_page:           { type: 'integer' },
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
            source_page:          { type: 'integer' },
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
    let scopeWithBuffer = pageScope && pageScope.length > 0
      ? [...new Set(pageScope.flatMap(p => [p - 1, p, p + 1]).filter(p => p > 0))].sort((a, b) => a - b)
      : null;
    // v2 (2026-09-16): PT/OT consolidation — pages the coordinator explicitly dropped
    // are NEVER resurrected by the ±1 buffer. The buffer exists for encounter-edge
    // context, not to undo explicit exclusions.
    const ptExclPages = (batch[0] && Array.isArray(batch[0].ptExclude)) ? new Set(batch[0].ptExclude) : null;
    if (scopeWithBuffer && ptExclPages) {
      const beforeBuf = scopeWithBuffer.length;
      scopeWithBuffer = scopeWithBuffer.filter(p => !ptExclPages.has(p));
      if (beforeBuf !== scopeWithBuffer.length) {
        console.log(`Chunk[${chunkIndex}] Batch ${batchIndex + 1}: ${beforeBuf - scopeWithBuffer.length} PT/OT-excluded pages removed after ±1 buffer`);
      }
    }
    if (scopeWithBuffer) console.log(`Chunk[${chunkIndex}] Batch ${batchIndex + 1}: page scope [${scopeWithBuffer.join(',')}]`);
    // Track pages actually sent (per attempt) for run cost reporting.
    // Full-doc batches (pageScope null) use the part's page_count.
    try {
      const partPages = (batch[0] && batch[0].page_count) || 0;
      RUN_USAGE.pages_sent += (scopeWithBuffer ? scopeWithBuffer.length : partPages);
    } catch (puErr) { /* non-fatal */ }
    // Updated: 2026-09-19 — page citations. The model reports source_page as the
    // LOCAL page number within the PDF it was actually sent (1 = first page of
    // that file). When pageScope/scopeWithBuffer sliced the PDF before sending
    // (slicePdfPages), local page N corresponds to the REAL page scopeWithBuffer[N-1]
    // in the original part; when the whole part was sent (pageScope null), local
    // page N IS the real page. Only attach when this batch is exactly one part —
    // with multiple parts in one Bedrock call the model's page numbering is
    // ambiguous across files, so those visits are left without a citation rather
    // than risk mislabeling.
    const attachSourcePages = (res) => {
      if (!res || !Array.isArray(res.visits) || batch.length !== 1) return res;
      const partId = batch[0] && batch[0].id;
      const partLabel = batch[0] && batch[0].label;
      if (!partId) return res;
      res.visits = res.visits.map((v) => {
        const rawPage = Number(v.source_page);
        let actualPage = null;
        if (Number.isFinite(rawPage) && rawPage >= 1) {
          actualPage = (scopeWithBuffer && scopeWithBuffer.length > 0)
            ? (scopeWithBuffer[rawPage - 1] || null)
            : rawPage;
        }
        return actualPage
          ? { ...v, source_page: actualPage, source_doc_id: partId, source_part_label: partLabel || null }
          : { ...v, source_page: null };
      });
      return res;
    };
    try {
      const result = await callBedrock(fileKeys, buildPrompt('', 1, batchLabel, knownVisitsChecklist), fullSchema, regionOrder, scopeWithBuffer);
      return attachSourcePages(result);
    } catch (err) {
      console.warn(`Chunk[${chunkIndex}] Batch ${batchIndex + 1}: JSON error, retrying with simplified schema...`, err.message);
      try {
        const result = await callBedrock(fileKeys, buildPrompt('', 1, batchLabel, knownVisitsChecklist), simplifiedSchema, regionOrder, scopeWithBuffer);
        return attachSourcePages(result);
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
        if (result.patient_name) patientNameCandidates.push(result.patient_name);
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
        ':r': { visits: chunkVisits, patient_name: patientName, patient_name_candidates: patientNameCandidates, case_number: caseNumber, usage: { ...RUN_USAGE } },
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
  const { job_id, doc_ids, patient_name = '', org_id, exclude_emr = false, include_all_pt = false } = event;
  const consolidate_pt = !include_all_pt;  // UI default: "Include all PT sessions" unchecked = first & last only
  console.log(`generateSummaryWorker (coordinator) start: job_id=${job_id} docs=${doc_ids?.length} [AUTOMATIC NARRATIVE-ONLY: EMR/administrative pages excluded]${consolidate_pt ? ' [PT/OT PRE-CONSOLIDATION: first+last per facility group]' : ' [ALL PT SESSIONS INCLUDED]'}`);

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

  // Reset per-run usage accumulator (cost capture starts fresh for this run)
  resetRunUsage();

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
        page_count: doc.page_count || 0,
        page_classifications: partClassif,
        extracted_text: doc.extracted_text || '',  // kept for fallback reference
        encounter_index: Array.isArray(doc.encounter_index) ? doc.encounter_index : [],  // from classify VI pre-pass
        emr_flagged_pages: Array.isArray(doc.emr_flagged_pages) ? doc.emr_flagged_pages : [],  // from EMR Detector run (local page numbers)
        pt_index: Array.isArray(doc.pt_index) ? doc.pt_index : [],  // from vision pre-pass (PT/OT encounters, local page numbers)
      });
    }
    if (!allParts.length) { await markJobFailed(job_id, 'All documents are non-clinical'); return; }

    // ── 3. Read encounter_index from DynamoDB (written by classifyJobWorker VI pre-pass) ────
    // No Bedrock call needed here — classify already ran VI pre-pass and stored results.
    // encounter_index = [{ date, provider, facility, visit_type, pages, source_doc_id? }]
    let knownVisits = [];
    let patientName = patient_name;
    let caseNumber  = '';

    // ── Court case number harvest (2026-09-07) ────────────────────────────────
    // Pleading-paper legal captions are excluded from LLM input by the pleading
    // filter, so chunk results can no longer supply the court case number.
    // Harvest it directly from Textract extracted_text instead.
    try {
      const CASE_NUM_RE = /\b[A-Z]-\d{2}-\d{5,7}-[A-Z]\b/;
      for (const doc of docRecords) {
        const txt = doc.extracted_text || '';
        if (!txt) continue;
        const m = txt.match(CASE_NUM_RE);
        if (m) {
          caseNumber = m[0];
          console.log('coordinator: harvested court case number ' + caseNumber + ' from ' + doc.file_name);
          break;
        }
      }
    } catch (cnErr) {
      console.warn('coordinator: case number harvest failed (non-fatal):', (cnErr && cnErr.message) || cnErr);
    }
    try {
      await setJobStatus(job_id, 'Loading pre-pass encounter index...');
      const normalizeDate = (raw) => {
        let d = (raw || '').trim();
        if (!d) return '';
        // Strip time component before any parsing to prevent UTC midnight rollover
        // e.g. "2025-10-01T18:25:00" or "10/01/25 1825" → "2025-10-01" / "10/01/25"
        d = d.replace(/[T\s]\d{1,2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/, '').trim();
        d = d.replace(/\s+\d{3,4}$/, '').trim(); // strip bare 4-digit military time e.g. "10/01/25 1825"
        if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
        const mmddyyyy = d.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
        if (mmddyyyy) {
          const yr = mmddyyyy[3].length === 2 ? '20' + mmddyyyy[3] : mmddyyyy[3];
          return `${yr}-${mmddyyyy[1].padStart(2,'0')}-${mmddyyyy[2].padStart(2,'0')}`;
        }
        // Last resort: return empty — never use Date() which applies UTC conversion
        return '';
      };


      // ── 3a. Automatic inline VI pre-pass (reinstated 2026-09-20) ────────────
      // Restores the automatic disambiguation/recovery checklist that was removed
      // 2026-08-31 (commit f0c5e0ab). Any part still missing encounter_index gets
      // one extra lightweight Bedrock call here, building knownVisits purely as a
      // checklist (date/provider/facility/visit_type — NO pages). This is the
      // safe half of the original design: because these entries carry no `pages`,
      // the batching decision below (`partVisits.length > 0` check) never treats
      // them as page-scoped, so full-document/windowed batching is UNCHANGED —
      // this fixes checklist disambiguation (e.g. "5 same-date radiology reports
      // = 5 checklist entries") and missing-visit recovery WITHOUT reintroducing
      // the fine-grained per-encounter batching that degraded Hillock notes on
      // ZSolis (2026-09-15). In-memory only for this run — never persisted to
      // DynamoDB (per the 2026-08-30 decision: no cross-run cache contamination).
      const partsNeedingVI = allParts.filter(p => !Array.isArray(p.encounter_index) || p.encounter_index.length === 0);
      if (partsNeedingVI.length > 0) {
        console.log(`coordinator: ${partsNeedingVI.length} parts missing encounter_index — running inline VI pre-pass (checklist only, no pages)`);
        await setJobStatus(job_id, `Building encounter checklist (${partsNeedingVI.length} document parts)...`);
        const VI_CONCURRENCY_INLINE = 4;
        const inlineViSchema = {
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
        for (let vi = 0; vi < partsNeedingVI.length; vi += VI_CONCURRENCY_INLINE) {
          const chunk = partsNeedingVI.slice(vi, vi + VI_CONCURRENCY_INLINE);
          await Promise.all(chunk.map(async (part) => {
            try {
              const viResult = await callBedrock([part.file_key], buildVisitIndexPrompt(), inlineViSchema, regionOrder);
              const visits = Array.isArray(viResult.visits) ? viResult.visits : [];
              console.log(`coordinator: inline VI pre-pass ${part.label} -> ${visits.length} checklist entries`);
              part.encounter_index = visits;
              if (viResult.patient_name && !patientName) patientName = viResult.patient_name;
            } catch (viErr) {
              console.warn(`coordinator: inline VI pre-pass failed for ${part.label}: ${viErr.message}`);
              part.encounter_index = [];
            }
          }));
        }
      } else {
        console.log('coordinator: all parts have encounter_index — skipping inline VI pre-pass');
      }

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

      // ── Page-header date correction for ED/hospital visits ──────────────────
      // Hospital EMR notes print "Date: MM/DD/YY" in the patient header on every
      // page. The first page carries the encounter date. The electronic signature
      // (only source of "10/02" in Tall's note) is at the very end.
      // Strategy: read the Date: field from the patient header on the first page
      // of the encounter in the raw Textract text. If earlier than stored date, use it.
      knownVisits = knownVisits.map(function(v) {
        var isED = /er visit|emergency|ed visit/i.test(v.visit_type || '') ||
                   /emergency/i.test(v.facility || '');
        if (!isED || !v.date || !Array.isArray(v.pages) || v.pages.length === 0) return v;

        var srcPart = allParts.find(function(p) { return p.id === v.source_doc_id; });
        var rawText = srcPart ? (srcPart.extracted_text || '') : '';
        if (!rawText) return v;

        var cy = parseInt(v.date.split('-')[0], 10);
        var cm = parseInt(v.date.split('-')[1], 10);
        var cd = parseInt(v.date.split('-')[2], 10);
        // Pure string date math — no Date() objects, no UTC
        // storedDate as integer YYYYMMDD for numeric comparison
        var storedInt = cy * 10000 + cm * 100 + cd;
        var earliestCandidate = null;
        var earliestInt = Infinity;

        // Check first 2 pages of encounter
        var pagesToCheck = v.pages.slice(0, 2);
        for (var pi = 0; pi < pagesToCheck.length; pi++) {
          var pageNum = pagesToCheck[pi];
          var markerIdx = rawText.indexOf('--- PAGE ' + pageNum + ' ---');
          if (markerIdx === -1) continue;

          // Grab 500 chars after the page marker (patient header block)
          var block = rawText.slice(markerIdx, markerIdx + 500);

          // Match bare "Date: MM/DD/YY" at line start or after newline
          // Skips "Discharge Date", "Birth Date", "Signed...Date", etc.
          var dateMatch = block.match(/(?:^|\n)Date:\s*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i);
          if (!dateMatch) continue;

          var rawDate = dateMatch[1];
          var dp = rawDate.split(/[\/\-]/);
          if (dp.length < 3) continue;
          var month = parseInt(dp[0], 10);
          var day   = parseInt(dp[1], 10);
          var year  = parseInt(dp[2], 10);
          if (year < 100) year += 2000;
          if (month < 1 || month > 12 || day < 1 || day > 31) continue;

          var candidateInt = year * 10000 + month * 100 + day;
          // Simple day diff approximation (good enough for 1-7 day check)
          var diffDays = storedInt - candidateInt; // YYYYMMDD diff is not exact but fine for small ranges
          // Accept if 1-7 days before stored date (using rough numeric diff)
          if (diffDays >= 1 && diffDays <= 7) {
            if (candidateInt < earliestInt) {
              earliestInt = candidateInt;
              earliestCandidate = year + '-' + String(month).padStart(2,'0') + '-' + String(day).padStart(2,'0');
            }
          }
        }

        if (earliestCandidate) {
          console.log('coordinator: ED page-header date fix ' + v.provider + ' ' + v.date + ' -> ' + earliestCandidate + ' (first-page Date: header, pages checked: ' + pagesToCheck.join(',') + ')');
          return Object.assign({}, v, { date: earliestCandidate });
        }
        return v;
      });

      // Deduplicate by date+provider across all parts
      const viSeen = new Set();
      knownVisits = knownVisits.filter(v => {
        const k = `${v.date}|${(v.provider || '').toLowerCase()}`;
        if (viSeen.has(k)) return false;
        viSeen.add(k); return true;
      });
      // Filter admin visit types
      knownVisits = knownVisits.filter(v =>
        !/admin|fax|authorization|reminder|order|work status|reschedul|diagnostic test request|written order|prescription|dvt/i.test(v.visit_type || '')
      );
      console.log(`coordinator: encounter_index loaded — ${knownVisits.length} unique visits across all parts`);
    } catch (viErr) {
      console.warn('coordinator: encounter_index read failed (non-fatal):', viErr.message);
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
      // Pure string YYYYMMDD numeric diff — no Date() objects
      const origInt = parseInt((v.date || '').replace(/-/g, ''), 10);
      const corrInt = parseInt((corrected || '').replace(/-/g, ''), 10);
      if (isNaN(origInt) || isNaN(corrInt) || Math.abs(origInt - corrInt) > 7) return v;
      console.log(`coordinator: service-date correction ${v.provider} ${v.date} → ${corrected} (SERVICE DT found in extracted_text)`);
      return { ...v, date: corrected };
    });

    // ── 3c. PT/OT pre-consolidation via vision pt_index (2026-09-16) ─────────
    // The vision pre-pass (assessRelevance at processing time, or Re-classify)
    // reads each part's raw PDF as a whole and writes pt_index: one entry per
    // PT/OT/hand-therapy encounter with LOCAL page numbers and dates. Unlike
    // the 50-page extraction windows or 90k-char VI chunks, the vision pass
    // sees a PT series in one piece — so first/last by date are true chronology.
    // Facility groups (across ALL parts) with 3+ dated encounters keep only the
    // first and last; middle encounters' pages are excluded from LLM input
    // entirely and never reach Bedrock. Gated by consolidate_pt = !include_all_pt
    // (UI checkbox "Include all PT sessions" unchecked = consolidate).
    // Fail-safes: parts without pt_index contribute nothing; undated encounters
    // are never dropped (can't be ordered); groups smaller than 3 are untouched.
    const ptExcludedByPart = {};  // doc id -> Set of LOCAL page numbers
    let ptDroppedEncounters = 0;
    if (consolidate_pt) {
      // v2 (2026-09-16): also strip street addresses after a comma and collapse ALL
      // whitespace — vision output varies between "ATI Physical Therapy, 7301 Peak Drive..."
      // (comma form) and "ATI Physical Therapy - 7301 Peak Drive..." (dash form), and
      // "Mountain View Hospital" vs "Mountainview Hospital". Both must form ONE group.
      // v2.1 (2026-09-16): order matters — strip parentheticals, commas, and slashes
      // FIRST, then dash-suffixes, so "ATI Physical Therapy - Las Vegas, NV 89128" and
      // "ATI Physical Therapy / New Century Rehabilitation LLC" and every address
      // variant all normalize to the same group key.
      const normFacilityPt = (f) => String(f || '').toLowerCase().trim()
        .replace(/\s*\(.*?\)\s*$/, '')
        .replace(/\s*,.*$/, '')
        .replace(/\s*\/.*$/i, '')
        .replace(/\s*[-\u2013\u2014]\s*(blue diamond|lake mead|nw|ne|se|sw|north|south|east|west|suite|ste|bldg|building|floor|fl|las vegas|vegas|nv|nevada|henderson|summerlin|\d+).*$/i, '')
        .replace(/\s*[-\u2013\u2014]\s*[a-z0-9 ]{1,30}$/i, '')
        .replace(/\s+/g, '')
        .trim();
      const normDatePt = (d) => {
        const m = String(d || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
        if (!m) return String(d || '').trim();
        return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
      };
      let ptSeenTotal = 0;
      const ptGroups = {};
      for (const part of allParts) {
        const idx = part.pt_index;
        if (!Array.isArray(idx) || idx.length === 0) continue;
        for (const e of idx) {
          if (!e) continue;
          const pages = Array.isArray(e.page_numbers)
            ? e.page_numbers.map(Number).filter(n => !isNaN(n) && n >= 1) : [];
          if (pages.length === 0) continue;
          ptSeenTotal += 1;
          if (!e.date) continue;  // undated encounters can't be ordered — always kept
          const key = normFacilityPt(e.facility || e.provider || 'pt');
          (ptGroups[key] = ptGroups[key] || []).push({ partId: part.id, partLabel: part.label, date: normDatePt(e.date), facility: e.facility || '', provider: e.provider || '', type: String(e.type || ''), pages });
        }
      }
      const richestOfPt = (copies) => copies.reduce((best, c) => (c.pages.length > best.pages.length ? c : best), copies[0]);
      const normProviderPt = (p) => String(p || '').toLowerCase().replace(/[^a-z]/g, '');
      const isUnknownProviderPt = (e) => !e.provider || /unknown|billed as|not documented/i.test(e.provider);
      for (const key of Object.keys(ptGroups)) {
        let g = ptGroups[key];
        // v2.1 (2026-09-16): the same encounter often appears in multiple parts of a
        // litigation package, and billing-sheet lines list the same sessions as
        // "Unknown (billed as ...)" providers. Per DATE within a facility group:
        //  - named-provider entries: one representative per normalized provider
        //    (richest copy — same note duplicated across parts)
        //  - Unknown-provider entries: billing lines — they only represent the date
        //    if NO named entry exists for that date
        // All other copies are excluded so the LLM never sees the same encounter twice.
        const byDate = {};
        for (const e of g) (byDate[e.date] = byDate[e.date] || []).push(e);
        const dateReps = {};
        for (const d of Object.keys(byDate)) {
          const copies = byDate[d];
          const named = copies.filter(c => !isUnknownProviderPt(c));
          const pool = named.length > 0 ? named : copies;
          const byProv = {};
          for (const c of pool) (byProv[normProviderPt(c.provider)] = byProv[normProviderPt(c.provider)] || []).push(c);
          const reps = Object.keys(byProv).map(pk => richestOfPt(byProv[pk]));
          dateReps[d] = reps;
          for (const c of copies) {
            if (reps.includes(c)) continue;
            if (!ptExcludedByPart[c.partId]) ptExcludedByPart[c.partId] = new Set();
            c.pages.forEach(p => ptExcludedByPart[c.partId].add(p));
            ptDroppedEncounters += 1;
            console.log(`coordinator: PT/OT pre-consolidation — dropping duplicate copy of ${c.date} ${c.provider || '(no provider)'} @ ${c.facility || key} [${c.pages.length} pages, part ${c.partLabel}] (same-encounter duplicate in group "${key}")`);
          }
        }
        // v2: representative list, then first+last by date, with eval/discharge protection
        g = Object.keys(dateReps).sort().flatMap(d => dateReps[d]);
        if (g.length < 3) continue;
        g.sort((a, b) => a.date.localeCompare(b.date));
        const keptFirst = g[0];
        const keptLast = g[g.length - 1];
        // v2: initial evaluations and discharge summaries are clinically meaningful —
        // never consolidated away regardless of position in the series
        const isProtectedPt = (e) => /eval|discharge/i.test(e.type || '');
        for (const e of g) {
          if (e.date === keptFirst.date || e.date === keptLast.date || isProtectedPt(e)) continue;
          if (!ptExcludedByPart[e.partId]) ptExcludedByPart[e.partId] = new Set();
          e.pages.forEach(p => ptExcludedByPart[e.partId].add(p));
          ptDroppedEncounters += 1;
          console.log(`coordinator: PT/OT pre-consolidation — dropping ${e.date} ${e.provider || '(no provider)'} @ ${e.facility || key} [${e.pages.length} pages, part ${e.partLabel}] (group "${key}" keeps ${keptFirst.date} + ${keptLast.date})`);
        }
      }
      const droppedPages = Object.keys(ptExcludedByPart).reduce((n, k) => n + ptExcludedByPart[k].size, 0);
      console.log(`coordinator: PT/OT pre-consolidation — ${ptSeenTotal} PT/OT encounters indexed by vision pre-pass, ${ptDroppedEncounters} middle encounters (${droppedPages} pages) excluded from LLM input${ptSeenTotal === 0 ? ' (no pt_index data — run Classify to populate)' : ''}`);
    }

    // ── 4. Build encounter-scoped batches using VI page data ─────────────────
    // Each VI visit with page data → its own scoped batch for that doc part.
    // Parts with no VI page data → full-document batch (safe fallback).
    const batches = [];
    for (const part of allParts) {
      // ── Pleading-paper exclusion (2026-09-07) ──────────────────────────────
      // Legal filings on numbered pleading paper are excluded from LLM input at
      // the page level. Pages without the format are always kept — including
      // medical records attached at the end of a discovery document.
      const pleadingPages = detectPleadingPages(part.extracted_text);
      if (pleadingPages.size > 0) {
        console.log(`coordinator: part ${part.label} — ${pleadingPages.size} of ${part.page_count || '?'} pages exhibit pleading-paper (legal filing) formatting`);
      }

      // ── EMR printout exclusion (2026-09-15) ──────────────────────────────
      // Narrative-only runs subtract pages classified as EMR printouts by the
      // EMR Detector (saved on the part record as emr_flagged_pages — LOCAL
      // 1-based page numbers within this part's PDF). Gated by the run's
      // Updated: 2026-09-20 -- automatic EMR/administrative-printout exclusion.
      // No longer gated behind exclude_emr (there is no user-facing toggle --
      // this runs on every summary generation, live and dev, unconditionally).
      // Live detection (detectEmrPrintoutPages, same regex engine as the former
      // frontend EmrDetector) is computed fresh from the part's extracted_text
      // so this is fully self-contained -- no detector run, no persisted flags,
      // no extra LLM cost required. Persisted part.emr_flagged_pages (from any
      // legacy manual detector run) is used only as a fallback when
      // extracted_text is unavailable.
      const emrPages = new Set();
      {
        let liveFlagged = [];
        if (part.extracted_text) liveFlagged = detectEmrPrintoutPages(part.extracted_text);
        if (liveFlagged.length > 0) {
          liveFlagged.forEach(p => emrPages.add(p));
        } else if (Array.isArray(part.emr_flagged_pages) && part.emr_flagged_pages.length > 0) {
          for (const p of part.emr_flagged_pages) {
            const n = parseInt(p, 10);
            if (!isNaN(n) && n >= 1) emrPages.add(n);
          }
        }
        if (emrPages.size > 0) {
          console.log(`coordinator: part ${part.label} — excluding ${emrPages.size} EMR/administrative printout pages (automatic narrative-only filtering)`);
        }
      }
      const partVisits = knownVisits.filter(v => v.source_doc_id === part.id && Array.isArray(v.pages) && v.pages.length > 0);
      if (partVisits.length > 0) {
        let skippedEncounters = 0;
        for (const encounter of partVisits) {
          const ptExcl = ptExcludedByPart[part.id];
          const scopedPages = encounter.pages.filter(p => !pleadingPages.has(p) && !emrPages.has(p) && !(ptExcl && ptExcl.has(p)));
          if (scopedPages.length === 0) {
            skippedEncounters += 1;
            console.log(`coordinator: part ${part.label} — skipping encounter batch (${(encounter.provider || '?')} ${encounter.date || ''}) — all its pages are pleading-paper legal filings`);
            continue;
          }
          batches.push([{ ...part, pageScope: scopedPages, ptExclude: Array.from(ptExcludedByPart[part.id] || []) }]);
        }
        console.log(`coordinator: part ${part.label} → ${partVisits.length - skippedEncounters} encounter-scoped batches${skippedEncounters > 0 ? ` (${skippedEncounters} skipped as legal-only)` : ''}`);
      } else {
        // No VI page data — fall back to full-document extraction.
        // Bedrock hard limit: 100 pages per PDF. If the part exceeds that,
        // split into sub-100-page window batches so Bedrock never rejects.
        const MAX_BEDROCK_PAGES = 95; // small buffer below 100
        const partPageCount = part.page_count || 0;
        // If page_count is unknown, we cannot map pleading pages to real PDF
        // pages — send the full document unchanged (fail-safe).
        if (partPageCount <= 0) {
          batches.push([{ ...part, pageScope: null }]);
          console.log(`coordinator: part ${part.label} → full-document batch (no page_count, pleading filter bypassed)`);
        } else {
          // Union exclusion: pleading pages + EMR printout pages (narrative-only runs)
          const excludedUnion = new Set(pleadingPages);
          for (const p of emrPages) excludedUnion.add(p);
          if (ptExcludedByPart[part.id]) for (const p of ptExcludedByPart[part.id]) excludedUnion.add(p);
          const keptPages = keptPagesOf(excludedUnion, partPageCount);
          if (keptPages.length === 0) {
            console.log(`coordinator: part ${part.label} — skipping ENTIRE part (${excludedUnion.size} of ${partPageCount} pages fully excluded: ${pleadingPages.size} pleading + ${emrPages.size} EMR, no VI page data)`);
          } else if (partPageCount > MAX_BEDROCK_PAGES) {
            const windows = [];
            for (let i = 0; i < keptPages.length; i += MAX_BEDROCK_PAGES) {
              windows.push(keptPages.slice(i, i + MAX_BEDROCK_PAGES));
            }
            for (const windowPages of windows) {
              batches.push([{ ...part, pageScope: windowPages, ptExclude: Array.from(ptExcludedByPart[part.id] || []) }]);
            }
            console.log(`coordinator: part ${part.label} (${partPageCount} pages, ${excludedUnion.size} excluded: ${pleadingPages.size} pleading + ${emrPages.size} EMR) → ${windows.length} windowed full-doc batches (>100 page limit)`);
          } else if (excludedUnion.size > 0) {
            batches.push([{ ...part, pageScope: keptPages, ptExclude: Array.from(ptExcludedByPart[part.id] || []) }]);
            console.log(`coordinator: part ${part.label} → full-doc batch with ${excludedUnion.size} pages excluded (${pleadingPages.size} pleading + ${emrPages.size} EMR)`);
          } else {
            batches.push([{ ...part, pageScope: null }]);
            console.log(`coordinator: part ${part.label} → full-document batch (no VI page data)`);
          }
        }
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

    // Updated: 2026-09-20 -- collect every chunk's full patient_name candidate
    // list (not just its first guess) so the final name can be a majority
    // vote across the WHOLE run, computed once all chunks are in.
    const patientNameCandidates = [];
    for (const cjid of chunkJobIds) {
      const r = await dynamo.send(new GetCommand({ TableName: JOBS_TABLE, Key: { job_id: cjid } }));
      const chunkResult = r.Item?.result;
      if (!patientName && chunkResult?.patient_name) patientName = chunkResult.patient_name;
      if (Array.isArray(chunkResult?.patient_name_candidates)) {
        patientNameCandidates.push(...chunkResult.patient_name_candidates);
      }
      if (!caseNumber  && chunkResult?.case_number)  caseNumber  = chunkResult.case_number;
      if (Array.isArray(chunkResult?.visits)) {
        allVisits = allVisits.concat(chunkResult.visits);
        console.log(`coordinator: merged ${chunkResult.visits.length} visits from chunk ${cjid.slice(0,8)}`);
      }
      // Fold this chunk's Bedrock usage into the coordinator's running total --
      // extraction calls happen in the chunk worker's own Lambda invocation, so
      // this is the only place that usage data can be recovered.
      mergeRunUsage(chunkResult?.usage);
    }
    const votedPatientName = pickPatientName(patient_name, patientNameCandidates);
    if (votedPatientName && votedPatientName !== patientName) {
      console.log(`coordinator: patient_name majority vote -- candidates=${JSON.stringify(patientNameCandidates)} -> picked "${votedPatientName}" (first-seen was "${patientName}")`);
    }
    patientName = votedPatientName || patientName;

    // ── 8. Merge + dedup + sort ───────────────────────────────────────────────
    await setJobStatus(job_id, 'Merging and deduplicating visits...');
    try {
      allVisits = mergeEdVisits(mergeResidentCosignVisits(deduplicateVisits(allVisits)));
    } catch (mergeErr) {
      console.error('mergeEdVisits error (non-fatal, falling back to dedup only):', mergeErr.message);
      allVisits = mergeResidentCosignVisits(deduplicateVisits(allVisits));
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

    // ── 8.5. Deterministic C-4 detection ──────────────────────────────────────
    // Updated: 2026-08-31 — deterministic C-4 scan to overcome LLM variance
    // The LLM sometimes misses the C-4 form in 50-page parts. This step
    // scans extracted_text for C-4 keywords and triggers a targeted
    // extraction call if the C-4 form was missed.
    {
      const C4_KEYWORDS = /FORM C-4|EMPLOYEE'?S CLAIM FOR COMPENSATION|WORKERS'? COMPENSATION BOARD|WCB REPORT|DOCTOR'?S REPORT OF INITIAL EXAMINATION/i;
      const partsWithC4 = allParts.filter(p => C4_KEYWORDS.test(p.extracted_text || ''));

      for (const part of partsWithC4) {
        // Check if any visit already has C-4 practice_setting from this part
        const hasC4Visit = allVisits.some(v =>
          (v.practice_setting || '').toLowerCase().includes('c-4') &&
          v.source_doc_id === part.id
        );
        if (hasC4Visit) {
          console.log(`C-4 scan: ${part.label} already has C-4 visit — skipping`);
          continue;
        }

        console.log(`C-4 scan: ${part.label} has C-4 keywords but no C-4 visit — triggering targeted extraction`);
        const c4Prompt = `You are reviewing medical-legal documents. This document contains a C-4 FORM (Workers' Compensation Board Doctor's Report / WCB Form C-4 / "EMPLOYEE'S CLAIM FOR COMPENSATION/REPORT OF INITIAL TREATMENT").\n\nFind the C-4 form in this document and extract it as a single visit entry. The C-4 form may be partially illegible or printed as a scanned image — extract what you can.\n\nFor the C-4 form:\n- rendering_provider: the treating physician's name (look for signature block or printed name at bottom of form)\n- practice_setting: "C-4 Workers' Compensation Report"\n- visit_date: the date the form was completed or the examination date — CRITICAL to extract even if the rest is illegible\n- impression_diagnosis: diagnosis only — ICD codes if present, otherwise the written diagnosis\n- hpi_summary: leave empty\n- chief_complaint: leave empty\n- physical_exam_findings: leave empty\n- treatment_plan: leave empty\n- source_page: the page number within this PDF file (first page = 1) where the C-4 form begins. Always fill this in as a plain integer.\n\nDo NOT extract any other visits — only the C-4 form.`;

        try {
          const c4Schema = {
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
                  source_page:            { type: 'integer' },
                },
              },
            },
          },
        };
        const c4Result = await callBedrock([part.file_key], c4Prompt, c4Schema, regionOrder);
          if (Array.isArray(c4Result.visits) && c4Result.visits.length > 0) {
            const c4Clean = sanitizeVisits(c4Result.visits, patientName);
            for (const v of c4Clean) {
              v.source_doc_id = part.id;
              // Single-part call, no pageScope slicing — model's local page IS the real page.
              const rawPage = Number(v.source_page);
              v.source_page = (Number.isFinite(rawPage) && rawPage >= 1) ? rawPage : null;
            }
            allVisits = allVisits.concat(c4Clean);
            console.log(`C-4 scan: recovered ${c4Clean.length} C-4 visit(s) from ${part.label}`);
          } else {
            console.log(`C-4 scan: no C-4 visit extracted from ${part.label} (LLM returned empty)`);
          }
        } catch (c4Err) {
          console.warn(`C-4 scan failed for ${part.label}: ${c4Err.message}`);
        }
      }

      // Re-dedup after C-4 recovery
      try {
        allVisits = mergeEdVisits(mergeResidentCosignVisits(deduplicateVisits(allVisits)));
      } catch (mergeErr) {
        console.error('mergeEdVisits error (non-fatal, falling back to dedup only):', mergeErr.message);
        allVisits = mergeResidentCosignVisits(deduplicateVisits(allVisits));
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
    }

    // ── 8.6. enforceOneC4 (dedup multiple C-4 entries) ──────────────────────
    // Updated: 2026-08-31 — enforceOneC4 was defined but never called
    allVisits = enforceOneC4(allVisits);
    if (allVisits.some(v => (v.practice_setting || '').toLowerCase().includes('c-4'))) {
      console.log(`enforceOneC4: C-4 form present in final summary`);
    }

    // Helper: normalize dates for comparison (handles both ISO and MM/DD/YYYY)
    const normalizeDateForC4Compare = (raw) => {
      let d = (raw || '').trim();
      if (!d) return '';
      const iso = d.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (iso) return iso[1] + '-' + iso[2] + '-' + iso[3];
      const mdy = d.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
      if (mdy) {
        const yr = mdy[3].length === 2 ? '20' + mdy[3] : mdy[3];
        return yr + '-' + mdy[1].padStart(2,'0') + '-' + mdy[2].padStart(2,'0');
      }
      return d;
    };

    // ── 8.7. C-4 cross-reference enrichment ──────────────────────────────────
    // Updated: 2026-08-31 — fill illegible C-4 fields from same-date office visits
    // Updated: 2026-08-31 — fix date comparison to use normalizeDateForC4Compare
    // (was exact string match — failed when C-4 used "11/10/2021" and office visit "2021-11-10")
    // The C-4 form is often a scanned image with illegible fields. The same-date
    // office visit (typed text) has the full provider name, diagnosis, and ICD-10 codes.
    // This step deterministically enriches the C-4 from same-date non-C-4 visits.
    for (const c4v of allVisits) {
      const setting = (c4v.practice_setting || '').toLowerCase();
      if (!setting.includes('c-4')) continue;

      // Find same-date non-C-4 visits (prefer office visits over radiology)
      const c4DateNorm = normalizeDateForC4Compare(c4v.visit_date);
      const sameDateVisits = allVisits.filter(v =>
        v !== c4v &&
        normalizeDateForC4Compare(v.visit_date) === c4DateNorm &&
        !(v.practice_setting || '').toLowerCase().includes('c-4')
      );
      if (sameDateVisits.length === 0) continue;

      // Prefer office visit (not radiology) as the source
      const officeVisit = sameDateVisits.find(v =>
        !(v.practice_setting || '').toLowerCase().includes('radiology')
      ) || sameDateVisits[0];

      let enriched = [];

      // Enrich rendering_provider if illegible or partial
      const c4Provider = (c4v.rendering_provider || '').toLowerCase();
      if (c4Provider.includes('illegible') || c4Provider.includes('partial') ||
          (c4Provider.length > 0 && c4Provider.length < officeVisit.rendering_provider.length)) {
        console.log(`C-4 enrich: provider "${c4v.rendering_provider}" -> "${officeVisit.rendering_provider}" (from same-date office visit)`);
        c4v.rendering_provider = officeVisit.rendering_provider;
        enriched.push('rendering_provider');
      }

      // Enrich impression_diagnosis if partially legible
      const c4Diag = (c4v.impression_diagnosis || '');
      if (c4Diag.includes('partially legible') || c4Diag.includes('illegible') ||
          (c4Diag.length > 0 && c4Diag.length < (officeVisit.impression_diagnosis || '').length)) {
        console.log(`C-4 enrich: diagnosis "${c4v.impression_diagnosis}" -> "${officeVisit.impression_diagnosis}" (from same-date office visit)`);
        c4v.impression_diagnosis = officeVisit.impression_diagnosis;
        enriched.push('impression_diagnosis');
      }

      // Enrich icd10_codes if empty
      if ((!c4v.icd10_codes || c4v.icd10_codes.length === 0) &&
          officeVisit.icd10_codes && officeVisit.icd10_codes.length > 0) {
        console.log(`C-4 enrich: icd10_codes [] -> [${officeVisit.icd10_codes.join(', ')}] (from same-date office visit)`);
        c4v.icd10_codes = officeVisit.icd10_codes;
        enriched.push('icd10_codes');
      }

      // Enrich chief_complaint if empty
      if (!(c4v.chief_complaint || '').trim() && (officeVisit.chief_complaint || '').trim()) {
        c4v.chief_complaint = officeVisit.chief_complaint;
        enriched.push('chief_complaint');
      }

      // Enrich injury_date if empty but office visit has it
      if (!(c4v.injury_date || '').trim() && (officeVisit.injury_date || '').trim()) {
        c4v.injury_date = officeVisit.injury_date;
        enriched.push('injury_date');
      }

      if (enriched.length > 0) {
        console.log(`C-4 enrich: ${c4v.visit_date} enriched fields: ${enriched.join(', ')}`);
      } else {
        console.log(`C-4 enrich: ${c4v.visit_date} — no fields needed enrichment (provider/diagnosis already complete)`);
      }
    }

    // ── 8.75. Remove phantom "Office Visit" companions to C-4 forms ──────────
    // Updated: 2026-08-31 — the extraction prompt's C-4/office-visit pairing
    // language sometimes causes the LLM to fabricate a generic "Office Visit"
    // entry on the same date as a C-4 form, when no such separate document
    // actually exists in the source. These phantoms are identifiable by: same
    // normalized date + same provider as a real C-4 entry, the generic "Office
    // Visit" label (the LLM's literal fallback string, not a facility/document
    // type name), and ZERO unique clinical narrative (empty HPI/chief complaint/
    // exam/plan) — nothing but a diagnosis stub, sometimes with an ICD-10 code
    // borrowed from an unrelated encounter.
    const c4EntriesForPhantomCheck = allVisits.filter(v => (v.practice_setting || '').toLowerCase().includes('c-4'));
    for (const c4v of c4EntriesForPhantomCheck) {
      const c4DateNorm = normalizeDateForC4Compare(c4v.visit_date);
      const c4ProviderNorm = (c4v.rendering_provider || '').toLowerCase().trim();
      if (!c4DateNorm || !c4ProviderNorm) continue;

      allVisits = allVisits.filter(v => {
        if (v === c4v) return true;
        const isGenericOfficeVisit = (v.practice_setting || '').trim().toLowerCase() === 'office visit';
        if (!isGenericOfficeVisit) return true;
        const sameDate = normalizeDateForC4Compare(v.visit_date) === c4DateNorm;
        const sameProvider = (v.rendering_provider || '').toLowerCase().trim() === c4ProviderNorm;
        if (!sameDate || !sameProvider) return true;
        const hasNoNarrative = !(v.hpi_summary || '').trim() &&
                                !(v.chief_complaint || '').trim() &&
                                !(v.physical_exam_findings || '').trim() &&
                                !(v.treatment_plan || '').trim();
        if (hasNoNarrative) {
          console.log('phantom C-4 companion drop: removing generic "Office Visit" duplicate [' + v.visit_date + ' ' + v.rendering_provider + '] — same date+provider as C-4 entry, no unique clinical content');
          return false;
        }
        return true;
      });
    }

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
      allVisits = mergeEdVisits(mergeResidentCosignVisits(deduplicateVisits(allVisits)));
    } catch (mergeErr) {
      console.error('mergeEdVisits error (non-fatal, falling back to dedup only):', mergeErr.message);
      allVisits = mergeResidentCosignVisits(deduplicateVisits(allVisits));
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
    // Updated: 2026-09-20 (v2) -- per-document cost calculator now covers the
    // WHOLE pipeline, not just summary generation. total_pages is the
    // ORIGINAL document page count (sum across every uploaded doc, including
    // any part skipped as fully non-clinical) -- that's the number relevant
    // to a future per-page price, not the (smaller) page count actually sent
    // to the LLM after EMR filtering. upload_classify_cost_usd sums each
    // doc's Assess Relevance + Classify cost (persisted by documents_new.js
    // at upload/classify time); summary_generation_cost_usd is this run's
    // RUN_USAGE (main pass + chunk workers). estimated_cost_usd is the total
    // of both -- that total, divided by total_pages, is the real cost/page.
    const totalPagesForCost = docRecords.reduce((sum, d) => sum + (d.page_count || 0), 0);
    const uploadClassifyCostUsd = docRecords.reduce((sum, d) => sum + (d.processing_cost_usd || 0) + (d.classify_cost_usd || 0), 0);
    const summaryGenCostUsd = computeUsageCost(RUN_USAGE).estimated_cost_usd;
    const totalCostUsd = Math.round((uploadClassifyCostUsd + summaryGenCostUsd) * 10000) / 10000;
    const costPerPage = totalPagesForCost > 0 ? Math.round((totalCostUsd / totalPagesForCost) * 10000) / 10000 : 0;
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
        usage:         { ...RUN_USAGE },
        total_pages:                totalPagesForCost,
        upload_classify_cost_usd:   Math.round(uploadClassifyCostUsd * 10000) / 10000,
        summary_generation_cost_usd: summaryGenCostUsd,
        estimated_cost_usd:         totalCostUsd,
        cost_per_page:              costPerPage,
        narrative_only: true, // automatic as of 2026-09-20 -- no longer conditional on exclude_emr
        pt_consolidated: !!consolidate_pt,
        status:        'draft',
        created_at:    new Date().toISOString(),
        updated_at:    new Date().toISOString(),
      },
    }));
    console.log(`coordinator: summary saved as draft — aws_summary_id=${aws_summary_id}`);

    // Updated: 2026-09-20 -- LIVE-ONLY: stamp already_summarized on every doc used in
    // this run so a future re-run of the same document(s) can be detected and charged
    // again. Pages are only paid for once at upload time; a repeat summary generation
    // on documents that already produced a completed summary needs its own page
    // deduction (see MedicalSummaries.tsx generateSummary()/handleRerunPaymentProceed(),
    // which reads this flag and gates behind PagePaymentDialog + POST /stripe/deduct).
    // Fire-and-forget per doc -- a failed stamp here must never fail the summary run.
    for (const doc of docRecords) {
      try {
        await dynamo.send(new UpdateCommand({
          TableName: DOCS_TABLE, Key: { aws_document_id: doc.aws_document_id },
          UpdateExpression: 'SET already_summarized = :t, already_summarized_at = :now',
          ExpressionAttributeValues: { ':t': true, ':now': new Date().toISOString() },
        }));
      } catch (stampDocErr) {
        console.warn(`coordinator: failed to stamp already_summarized on doc ${doc.aws_document_id} (non-fatal):`, stampDocErr.message);
      }
    }

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

    // markJobComplete FIRST — frontend gets notified immediately with allVisits
    // verify runs after as best-effort post-processing (non-blocking)
    await markJobComplete(job_id, {
      patient_name:   patientName || '',
      case_number:    caseNumber  || '',
      visits:         allVisits,
      doc_count:      docRecords.length,
      visit_count:    allVisits.length,
      aws_summary_id,
    });

    // ── Updated: 2026-09-12 — ASYNC VERIFY HANDOFF (900s coordinator timeout fix) ──
    // Root cause: the coordinator's 900s Lambda budget must cover chunk polling
    // (~9+ min on large corpora) BEFORE verify starts, so the inline verify pass was
    // killed mid-loop by the TASK timeout — recovery never ran at all. Evidence:
    // 2026-09-12 ZSolis run: verify started at T+9min, burned ~6min re-running the
    // VI pre-pass sequentially, hit 'Status: timeout' at 17:23:20.
    // Fix: hand verify to the dedicated verifySummaryWorker via async Event invoke.
    // It gets its own FRESH 900s budget, so verify + recovery actually complete.
    // Job status/summary are already complete at this point — verify remains
    // best-effort post-processing that updates the saved summary in place.
    try {
      await lambda.send(new InvokeCommand({
        FunctionName: VERIFY_FN,
        InvocationType: 'Event',
        Payload: Buffer.from(JSON.stringify({
          job_id,
          aws_summary_id,
          doc_ids,
          org_id: docRecords[0] && docRecords[0].org_id ? docRecords[0].org_id : '',
        })),
      }));
      console.log(`coordinator: verify handed off to ${VERIFY_FN} (async) — exiting within budget`);
    } catch (verifyErr) {
      console.warn('coordinator: verify handoff failed (non-fatal):', verifyErr.message);
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
  const callerOrgId = event._orgId || '';
  const org_id = (event._isAdmin && body.org_id) ? body.org_id : callerOrgId;

  if (!doc_ids?.length) return httpResponse(400, { error: 'doc_ids required' });

  // Ownership check: every doc_id must belong to the caller's org (admin bypasses).
  if (!event._isAdmin) {
    const ownerCheckDocs = await fetchDocRecords(doc_ids);
    const foreignDoc = ownerCheckDocs.find(d => d.org_id && d.org_id !== callerOrgId);
    if (foreignDoc) return httpResponse(403, { error: 'Forbidden: one or more documents do not belong to your account' });
  }

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
  let d = (raw || '').trim();
  if (!d) return '';
  // Strip time component to prevent UTC midnight rollover
  d = d.replace(/[T\s]\d{1,2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/, '').trim();
  d = d.replace(/\s+\d{3,4}$/, '').trim(); // strip bare military time e.g. "10/01/25 1825"
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  const m = d.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (m) {
    const yr = m[3].length === 2 ? '20' + m[3] : m[3];
    return `${yr}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`;
  }
  // Never use Date() — it applies UTC conversion; return empty if unrecognized format
  return '';
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
  const resp = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: fileKey }));
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
- date: exact encounter date YYYY-MM-DD. Use SERVICE DT, REP SRV DT, or Triage Date when present — NOT ADM DT, DISCH DT, or physician signature date. Ignore any TIME or military time field entirely — dates are local calendar dates, never UTC-converted.
- provider: full name exactly as written, including credentials
- facility: treating facility name
- visit_type: Emergency Department | Consultation Report | Operative Report | Radiology Report | History & Physical | Discharge Summary | Office Visit | Physical Therapy | C-4 Form
- pages: page numbers in this PDF where the encounter appears

INCLUDE: ED notes, consultation reports, operative reports, radiology reports, office visits, H&P notes, discharge summaries, C-4/Workers Comp forms.
EXCLUDE: nursing flowsheets, MAR, anesthesia records, coding summaries, consent forms, lab printouts, appointment reminders, PPRs, PACU records, pre-op checklists, Clinical Documentation Records (nursing shift assessments), implant/vendor supply logs, discharge patient medication lists.`;

const callBedrockVI = async (fileKey, regionOrder) => {
  const pdfBytes = await fetchPdfBytes(fileKey);
  const b64 = pdfBytes.toString('base64');

  const orderedRegions = regionOrder || await getRegionOrder();
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

  for (const { region, models } of orderedRegions) {
    for (const modelId of models) {
      try {
        const client = getBedrockClient(region);
        const resp = await client.send(new InvokeModelCommand({
          modelId,
          contentType: 'application/json',
          accept:      'application/json',
          body,
        }));
        const parsed = JSON.parse(Buffer.from(resp.body).toString());
        const toolUse = parsed.content && parsed.content.find(b => b.type === 'tool_use');
        return toolUse ? toolUse.input : { visits: [] };
      } catch (err) {
        console.warn(`callBedrockVI: region=${region} model=${modelId} failed — ${err.message}`);
      }
    }
  }
  throw new Error('callBedrockVI: all regions/models exhausted');
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
  // Pure string YYYYMMDD diff — no Date() objects
  const origInt = parseInt((visit.date || '').replace(/-/g, ''), 10);
  const corrInt = parseInt((corrected || '').replace(/-/g, ''), 10);
  if (isNaN(origInt) || isNaN(corrInt) || Math.abs(origInt - corrInt) > 7) return null;

  return corrected !== visit.date ? corrected : null;
};

// ── Main handler ──────────────────────────────────────────────────────────────
// ── Shared verify logic (called inline by coordinator AND by Lambda entrypoint) ──
const runVerifyInline = async ({ job_id, aws_summary_id, doc_ids, org_id, precomputedViVisits }) => {
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
    const patientName = summary.patient_name || '';
    const regionOrder = null; // callBedrock/callBedrockVI resolve regions internally when null

    // Updated: 2026-09-20 -- seed usage from the already-saved main-pass total
    // (and clear any warm-container leftover first) so this run's write-back
    // is a superset: main pass + whatever recovery calls verify makes below.
    resetRunUsage();
    mergeRunUsage(summary.usage);

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

    // 3. Build VI visits — use precomputed data from coordinator if available (no redundant Bedrock call)
    const viVisits = [];
    if (Array.isArray(precomputedViVisits) && precomputedViVisits.length > 0) {
      console.log(`verify: using ${precomputedViVisits.length} precomputed VI visits from coordinator — skipping Bedrock re-call`);
      const partMap = {};
      for (const p of allParts) { partMap[p.aws_document_id] = p; if (p.id) partMap[p.id] = p; }
      precomputedViVisits.forEach(v => {
        const part = partMap[v.source_doc_id] || null;
        viVisits.push({ ...v, date: normalizeDate(v.date), _part: part });
      });
    } else {
      // Updated: 2026-09-12 — parallelize the VI pre-pass (was sequential).
      // Sequential took ~20s per part (~6 min for 15 parts) and blew the verify
      // budget before recovery could run. At concurrency 4: ~1.5 min, leaving
      // ~7+ minutes of the verify worker's fresh 900s for the recovery pass.
      console.log('verify: no precomputed VI visits — running Bedrock VI pre-pass (fallback, concurrency 4)');
      const VI_PARALLEL = 4;
      const viParts = allParts.filter(function(p) { return !!p.file_key; });
      for (let i = 0; i < viParts.length; i += VI_PARALLEL) {
        const group = viParts.slice(i, i + VI_PARALLEL);
        const groupResults = await Promise.all(group.map(async function(part) {
          try {
            const result = await callBedrockVI(part.file_key);
            console.log(`verify: VI pre-pass ${part.label || part.aws_document_id} → ${(result.visits||[]).length} visits`);
            return (Array.isArray(result.visits) ? result.visits : [])
              .map(function(v) { return { ...v, date: normalizeDate(v.date), _part: part }; })
              .filter(function(v) { return v.date; });
          } catch (e) {
            console.warn(`verify: VI pre-pass failed for part ${part.aws_document_id}: ${e.message}`);
            return [];
          }
        }));
        groupResults.forEach(function(rv) { rv.forEach(function(v) { viVisits.push(v); }); });
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
    // Updated: 2026-09-12 — FIELD NAME FIX: summary visits are stored with
    // visit_date/rendering_provider, but this compared v.date/v.provider (always
    // undefined) — the same bug class fixed 2026-08-30 in the coordinator. Result:
    // essentially every VI visit was falsely flagged missing ('83 missing' on runs
    // where most were present), and date corrections could never match.
    const summaryKeys = new Set(
      summaryVisits.map(v => `${normalizeDate(v.visit_date)}|${normalizeProvider(v.rendering_provider)}`)
    );
    // Also build a provider+visit_type → VI date map for targeted date correction below
    const viDateByProviderType = {};
    for (const v of uniqueViVisits) {
      const k = `${normalizeProvider(v.provider)}|${(v.visit_type || '').toLowerCase()}`;
      viDateByProviderType[k] = v.date;
    }
    // Updated: 2026-09-12 — keep _part + source_doc_id on missing entries so the
    // recovery pass below can locate the right document part for extraction.
    const missingVisits = uniqueViVisits.filter(v => {
      const k = `${v.date}|${normalizeProvider(v.provider)}`;
      return !summaryKeys.has(k);
    }).map(v => ({ date: v.date, provider: v.provider, visit_type: v.visit_type, source_doc_id: v.source_doc_id, _part: v._part }));

    // 6. Apply date corrections to summary visits
    // Strategy A: SERVICE DT regex corrections (from findServiceDate)
    // Strategy B: VI pre-pass date override — if VI says provider X had visit_type Y on date Z
    //             but summary has same provider+visit_type on a different date, correct it
    let correctedCount = 0;
    const correctedVisits = summaryVisits.map(sv => {
      const svProvKey = normalizeProvider(sv.rendering_provider || '');
      const svType    = (sv.practice_setting || sv.visit_type || '').toLowerCase();

      // Strategy A: regex correction — match on provider+visit_type to avoid hitting C-4 instead of ED note
      // Updated: 2026-09-12 — sv.provider → sv.rendering_provider, sv.date → sv.visit_date
      const regexCorrection = dateCorrections.find(c => {
        if (normalizeProvider(c.provider) !== svProvKey) return false;
        // If visit_type available on correction, require it to match
        if (c.visit_type && !svType.includes((c.visit_type || '').toLowerCase().split(/\s+/)[0])) return false;
        return true;
      });
      if (regexCorrection) {
        correctedCount++;
        console.log(`verify [regex]: correcting ${sv.rendering_provider} (${svType}) ${sv.visit_date} → ${regexCorrection.corrected_date}`);
        return { ...sv, visit_date: regexCorrection.corrected_date };
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

      if (viDate && viDate !== normalizeDate(sv.visit_date)) {
        // Sanity: only correct if within 7 days
        // Pure string YYYYMMDD diff — no Date() objects
        const origInt2 = parseInt((normalizeDate(sv.visit_date) || '').replace(/-/g, ''), 10);
        const corrInt2 = parseInt((viDate || '').replace(/-/g, ''), 10);
        if (!isNaN(origInt2) && !isNaN(corrInt2) && Math.abs(origInt2 - corrInt2) <= 7) {
          correctedCount++;
          const origFmt = normalizeDate(sv.visit_date);
          console.log(`verify [VI diff]: correcting ${sv.rendering_provider} (${svType}) ${origFmt} → ${viDate}`);
          dateCorrections.push({
            provider:       sv.rendering_provider || '',
            original_date:  origFmt,
            corrected_date: viDate,
            method:         'VI_prepass_diff',
          });
          return { ...sv, visit_date: viDate };
        }
      }

      return sv;
    });

    // 7. Re-sort corrected visits chronologically (proper date comparison)
    let finalVisits = correctedVisits.sort((a, b) => {
      // Pure string YYYYMMDD sort — no Date() objects
      // Updated: 2026-09-12 — a.date → a.visit_date (summary schema field)
      const da = parseInt((normalizeDate(a.visit_date) || '19000101').replace(/-/g, ''), 10);
      const db = parseInt((normalizeDate(b.visit_date) || '19000101').replace(/-/g, ''), 10);
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

    console.log(`verify: ${dateCorrections.length} corrections, ${missingVisits.length} missing (after field-name fix)`);

    // ── 8b. Updated: 2026-09-12 — REAL RECOVERY PASS (ported from the coordinator's
    // chunk-level recovery). Previously missing visits were only recorded as metadata
    // and never extracted. Now each genuinely-missing visit is targeted-extracted from
    // its source part and appended to the summary. Runs at concurrency 3.
    let recoveredCount = 0;
    if (missingVisits.length > 0) {
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
      // Group missing visits by source part so one Bedrock call can recover
      // several visits from the same part.
      const byPart = {};
      for (const mv of missingVisits) {
        const pid = (mv._part && (mv._part.aws_document_id || mv._part.id)) || 'unknown';
        if (!byPart[pid]) byPart[pid] = [];
        byPart[pid].push(mv);
      }
      const recGroups = Object.entries(byPart);
      console.log(`verify: recovery — ${missingVisits.length} missing visits across ${recGroups.length} parts`);
      const REC_CONCURRENCY = 3;
      for (let rg = 0; rg < recGroups.length; rg += REC_CONCURRENCY) {
        const recChunk = recGroups.slice(rg, rg + REC_CONCURRENCY);
        const recResults = await Promise.all(recChunk.map(async ([partId, mvGroup]) => {
          const recPart    = mvGroup[0]._part || allParts.find(p => p.aws_document_id === partId || p.id === partId);
          const recFileKey = (recPart && recPart.file_key) || (allParts[0] && allParts[0].file_key);
          if (!recFileKey) return [];
          const visitList = mvGroup.map(v => `- ${v.date} | ${v.provider || 'Unknown'} | ${v.facility || ''}`).join('\n');
          const recPrompt = 'You are reviewing medical-legal documents. A specific clinical visit is known to exist in these records but was missed in the prior extraction pass.\n\nTARGET VISIT' + (mvGroup.length > 1 ? 'S' : '') + ':\n' + visitList + '\n\nYour task: Find the above visit' + (mvGroup.length > 1 ? 's' : '') + ' in the provided document and extract full clinical details for ' + (mvGroup.length > 1 ? 'each one' : 'it') + '. If you cannot find it, return an empty visits array. Do not extract any other visits.';
          try {
            const recResult = await callBedrock([recFileKey], recPrompt, recSchema, regionOrder);
            if (Array.isArray(recResult.visits) && recResult.visits.length > 0) {
              const recClean = sanitizeVisits(recResult.visits || [], patientName);
              console.log(`verify: recovered ${recClean.length} visit(s) from part ${partId}`);
              return recClean;
            }
          } catch (recErr) {
            console.warn(`verify: recovery failed for part ${partId}:`, recErr.message);
          }
          return [];
        }));
        recResults.forEach(rv => { finalVisits.push(...rv); recoveredCount += rv.length; });
      }
      if (recoveredCount > 0) {
        // Re-dedup against the merged set, then re-sort chronologically
        try {
          finalVisits = mergeResidentCosignVisits(deduplicateVisits(finalVisits));
        } catch (dedupErr) {
          console.warn('verify: recovery dedup failed (non-fatal):', dedupErr.message);
        }
        finalVisits.sort((a, b) => {
          const da = parseInt((normalizeDate(a.visit_date) || '19000101').replace(/-/g, ''), 10);
          const db = parseInt((normalizeDate(b.visit_date) || '19000101').replace(/-/g, ''), 10);
          return da - db;
        });
      }
    }

    // 8c. finalize verification result with recovery info
    verification_result.recovered_count = recoveredCount;
    verification_result.missing_visits   = missingVisits.map(v => ({ date: v.date, provider: v.provider, visit_type: v.visit_type }));
    if (recoveredCount > 0) {
      verification_result.status = 'verified_with_corrections';
    }

    console.log(`verify: complete — ${dateCorrections.length} corrections, ${recoveredCount} recovered, ${missingVisits.length - recoveredCount} still missing`);

    // ── 9. Write back to summary record ──
    // Updated: 2026-09-12 — this was DEAD CODE before (unreachable early return above
    // meant corrections were computed and thrown away). Now it runs.
    // Stale-guard: skip the write-back if the user saved the summary while verify was
    // running, so verify never clobbers manual edits.
    try {
      // Updated: 2026-09-20 (v2) -- recompute cost fields on the superset
      // RUN_USAGE (main pass + this verify run's recovery calls), PLUS the
      // same upload/classify cost this doc set already carries, so the
      // persisted estimated_cost_usd/cost_per_page reflect the TRUE full
      // pipeline cost, not summary-generation alone.
      const verifyTotalPages = (summary.total_pages || 0) || docRecords.reduce((sum, d) => sum + (d.page_count || 0), 0);
      const verifyUploadClassifyCostUsd = (summary.upload_classify_cost_usd != null)
        ? summary.upload_classify_cost_usd
        : docRecords.reduce((sum, d) => sum + (d.processing_cost_usd || 0) + (d.classify_cost_usd || 0), 0);
      const verifySummaryGenCostUsd = computeUsageCost(RUN_USAGE).estimated_cost_usd;
      const verifyTotalCostUsd = Math.round((verifyUploadClassifyCostUsd + verifySummaryGenCostUsd) * 10000) / 10000;
      const verifyCostPerPage = verifyTotalPages > 0 ? Math.round((verifyTotalCostUsd / verifyTotalPages) * 10000) / 10000 : 0;
      await dynamo.send(new UpdateCommand({
        TableName: SUMMARIES_TABLE,
        Key: { aws_summary_id },
        UpdateExpression: 'SET visits = :v, visit_count = :vc, verification_result = :vr, #st = :st, #usg = :usg, total_pages = :tp, upload_classify_cost_usd = :ucc, summary_generation_cost_usd = :sgc, estimated_cost_usd = :cost, cost_per_page = :cpp, updated_at = :now',
        ConditionExpression: 'attribute_not_exists(updated_at) OR updated_at = :expected_updated',
        ExpressionAttributeNames: { '#st': 'status', '#usg': 'usage' },
        ExpressionAttributeValues: {
          ':v':  finalVisits,
          ':vc': finalVisits.length,
          ':vr': verification_result,
          ':st': verification_result.status,
          ':usg': { ...RUN_USAGE, through: 'verify' },
          ':tp': verifyTotalPages,
          ':ucc': Math.round(verifyUploadClassifyCostUsd * 10000) / 10000,
          ':sgc': verifySummaryGenCostUsd,
          ':cost': verifyTotalCostUsd,
          ':cpp': verifyCostPerPage,
          ':now': new Date().toISOString(),
          ':expected_updated': (summary.updated_at || ''),
        },
      }));
      console.log(`verify: summary updated — ${finalVisits.length} visits (${recoveredCount} recovered)`);
    } catch (condErr) {
      if (condErr.name === 'ConditionalCheckFailedException') {
        console.warn('verify: summary was modified during verify (user save?) — skipping write-back to protect manual edits');
      } else {
        throw condErr;
      }
    }

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

    return { correctedVisits: finalVisits, correctedCount, recoveredCount };

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



// redact_document.js — ChartReview Pro redaction Lambda
// Route: POST /documents/{aws_document_id}/redact
// Updated: 2026-05-26 — Expand PII extraction: bare phone/SSN, Street/City, account# variants

'use strict';

const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl }                                  = require('@aws-sdk/s3-request-presigner');
const { DynamoDBClient }                               = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { BedrockRuntimeClient, InvokeModelCommand }     = require('@aws-sdk/client-bedrock-runtime');
const { LambdaClient, InvokeCommand }                  = require('@aws-sdk/client-lambda');
const { PDFDocument, rgb }                             = require('pdf-lib');
const { randomUUID }                                   = require('crypto');
const { validateApiKey }                               = require('./auth');

const s3           = new S3Client({ region: process.env.AWS_REGION || 'us-east-1', requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' });
const dynamo       = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const bedrock      = new BedrockRuntimeClient({ region: 'us-east-1' });
const lambdaClient = new LambdaClient({ region: process.env.AWS_REGION || 'us-east-1' });

const BUCKET     = process.env.S3_BUCKET       || 'chartreview-documents-prod';
const DOCS_TABLE = process.env.DOCUMENTS_TABLE || 'chartreview-documents-prod';
const JOBS_TABLE = process.env.JOBS_TABLE      || 'chartreview-jobs-prod';
const MODEL_ID   = process.env.MODEL_ID        || 'us.anthropic.claude-sonnet-4-6';
const WORKER_FN  = process.env.REDACT_WORKER_FUNCTION_NAME || 'chartreview-pro-prod-redactDocumentWorker';

// ── helpers ───────────────────────────────────────────────────────────────────

const respond = function(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization,x-api-key,x-org-id',
    },
    body: JSON.stringify(body),
  };
};

async function getS3Bytes(key) {
  const resp = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const chunks = [];
  for await (const chunk of resp.Body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function updateJob(job_id, patch) {
  const keys   = Object.keys(patch);
  const sets   = keys.map(function(k, i) { return '#f' + i + ' = :v' + i; }).join(', ');
  const names  = {};
  const values = {};
  keys.forEach(function(k, i) { names['#f' + i] = k; });
  Object.values(patch).forEach(function(v, i) { values[':v' + i] = v; });
  await dynamo.send(new UpdateCommand({
    TableName: JOBS_TABLE,
    Key: { job_id },
    UpdateExpression: 'SET ' + sets,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  }));
}

// ── STEP 1: Regex scan — extract all known PII values from stored text ────────

function extractKnownPiiValues(extractedText) {
  // Extract all values following explicit demographic labels.
  // No minimum/maximum character limits — any labeled value is treated as PII.
  if (!extractedText || typeof extractedText !== 'string') return [];
  var found = new Set();

  var patterns = [
    // Patient name — explicit label on same line
    /^(?:PATIENT|Patient)\s*[:\|]\s*([A-Z][A-Z\-,'\. ]+)$/mg,
    /^(?:PATIENT(?:'S)?\s*NAME?|PT\.?\s*NAME)\s*[:\|]\s*([A-Za-z][A-Za-z\-,'\. ]+)$/mgi,
    /^Patient\s*Name\s*[:\|]\s*([A-Za-z][A-Za-z\-,'\. ]+)$/mgi,
    /^(?:CLAIMANT|CLIENT)\s*[:\|]\s*([A-Za-z][A-Za-z\-,'\. ]+)$/mgi,
    /Patient['\u2019]?s?\s*Nam[e]?\s*[:\|]?\s{0,5}([A-Z][A-Z\-,'\. ]+)/gi,

    // Date of birth — must follow label
    /(?:DOB|D\.O\.B\.|DATE\s*OF\s*BIRTH|BIRTH\s*(?:DATE|DT)|BIRTHDATE|Birth\s*Date|Date\s*of\s*Birth)\s*[:\|]\s*([\d]{1,2}[\/\-][\d]{1,2}[\/\-][\d]{2,4})/gi,

    // SSN — dashed xxx-xx-xxxx OR bare 9-digit after label
    /(\d{3}-\d{2}-\d{4})/g,
    /(?:SSN|S\.S\.N\.|SOCIAL\s*SECURITY)\s*[:\|]?\s*(\d{9})/gi,

    // MRN — must follow label
    /(?:MRN#?|MR\s*#|MED(?:ICAL)?\s*REC(?:ORD)?\s*(?:NO\.?|#)?|CHART\s*#|MRN\s*[:\|])\s*[:\|]?\s*([A-Z0-9\-]+)/gi,

    // Account / unit / episode numbers
    /(?:ACCOUNT\s*(?:NO\.?|NUMBER|#)|ACCT\s*(?:NO\.?|#)|Acct\s*#|ACCOUNT#)\s*[:\|]?\s*([A-Z0-9\-]+)/gi,
    /(?:UNIT\s*(?:NO\.?|NUMBER|#)|Unit\s*(?:No\.?|#)|Unit\s*#|UNIT#)\s*[:\|]?\s*([A-Z0-9\-]+)/gi,
    /(?:Episode\s*ID|FIN#?)\s*[:\|]\s*([A-Z0-9\-]+)/gi,

    // Insurance / member / claim IDs
    /(?:Plan\s*#|Plan\s*No\.?|GROUP\s*#|Group\s*No\.?|MEMBER\s*(?:ID|#)|Member\s*ID|POLICY\s*(?:NO\.?|#)|CLM#?|Claim\s*#|Member\s*ID#?)\s*[:\|]?\s*([A-Z0-9\-]+)/gi,

    // Phone — labeled OR bare xxx-xxx-xxxx OR (xxx) xxx-xxxx
    /(?:PHONE|CELL|MOBILE|TEL(?:EPHONE)?|Home\s*Phone|Work\s*Phone|Phone\s*Number|Phone\s*#|Fax)\s*[:\|]\s*([\d\(\)\-\.\s]+)/gi,
    /\((\d{3})\)\s*(\d{3}[-\s]\d{4})/g,
    /\b(\d{3}-\d{3}-\d{4})\b/g,

    // Address fields
    /\b(?:HOME\s*)?ADDRESS\s*[:|]\s*(.+)/gi,
    /\bStreet\s*[:|]\s*(.+)/gi,
    /\bCity\s*[:|]\s*([A-Za-z][A-Za-z\s]+)/gi,
    /\bState\s*[\/\\]?\s*Zip\s*[:|]\s*(.+)/gi,

    // Spouse / next of kin / emergency contact / POA / guardian
    /(?:Spouse|SPOUSE)\s*[:\|]\s*(.+)/gi,
    /(?:Next\s*of\s*Kin|NOK)\s*[:\|]\s*(.+)/gi,
    /(?:First\s*Name(?:\s*\/?\s*MI)?|Last\s*Name)\s*[:\|]\s*([A-Za-z][A-Za-z\-,'\. ]+)/gi,
    /(?:Guardian\s*Name|GUARDIAN)\s*[:\|]?\s*([A-Za-z][A-Za-z\-,'\. ]+)/gi,
    /(?:Emergency\s*Contact|EMERGENCY\s*CONTACT)\s*[:\|]?\s*([A-Za-z][A-Za-z\-,'\. ]+)/gi,
    /(?:POA|Power\s*of\s*Attorney)\s*[:\|]\s*(.+)/gi,
    /(?:Responsible\s*Party|Guarantor)\s*[:\|]\s*(.+)/gi,

    // PATIENT NAME footer pattern (operative reports): "PATIENT NAME: LAST,FIRST  #: ACCT"
    /PATIENT\s*NAME\s*[:\|]\s*([A-Z][A-Z\-,'\. ]+?)(?:\s+#[:\|]?\s*([A-Z0-9\-]+))?\s*$/mgi,
    // Also match PATIENT NAME anywhere on a line (not just end-anchored) for safety
    /PATIENT\s*NAME\s*[:\|]\s*([A-Z][A-Z\-,'\. ]{3,})/mgi,

    // Inline parenthetical family/POA names in narrative text
    // e.g. "her spouse (Luis Mora) is her medical POA"
    /(?:spouse|husband|wife|son|daughter|child|parent|mother|father|brother|sister|sibling|next\s*of\s*kin|medical\s*poa|power\s*of\s*attorney)\s*\(([A-Za-z][A-Za-z\-,'\.\s]{2,40})\)/gi,

    // Email
    /(?:EMAIL|E-MAIL)\s*[:\|]\s*([\w\.\+\-]+@[\w\-]+\.[\w\.]+)/gi,
  ];

  for (var i = 0; i < patterns.length; i++) {
    var pattern = patterns[i];
    var match;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(extractedText)) !== null) {
      // Collect all non-empty capture groups as separate PII values
      var groups = [];
      for (var g = 1; g < match.length; g++) {
        if (match[g]) groups.push(match[g].trim());
      }
      // Special case: (xxx) xxx-xxxx phone uses two groups that form one value
      if (groups.length === 2 && /^\d{3}$/.test(groups[0]) && /^\d{3}[-\s]\d{4}$/.test(groups[1])) {
        groups = ['(' + groups[0] + ') ' + groups[1]];
      }
      for (var gi = 0; gi < groups.length; gi++) {
        var val = groups[gi];
        if (!val) continue;
        // Skip ICD/CPT codes
        if (/^[A-Z]\d{2}\.?\d{0,3}[A-Z]?$/.test(val)) continue;
        // Skip pure clinical lowercase text (long narrative fragments)
        if (/^[a-z\s,\.]{15,}$/.test(val)) continue;
        // Skip single short numbers (age, vitals, room numbers)
        if (/^\d{1,3}$/.test(val)) continue;
        // Skip bare 2-letter state abbreviations
        if (/^[A-Z]{2}$/.test(val)) continue;
        found.add(val);
      }
    }
  }
  // Expand hyphenated compound names: MORA-MALDONADO -> also add MORA and MALDONADO separately
  var expanded = new Set(found);
  found.forEach(function(val) {
    if (val && val.indexOf('-') !== -1) {
      var parts = val.split('-');
      parts.forEach(function(p) {
        var trimmed = p.trim().replace(/[,\.\s]/g, '');
        if (trimmed.length >= 3) expanded.add(p.trim().split(',')[0].trim());
      });
    }
    // Also split on comma (MORA-MALDONADO,VILMA -> VILMA separately)
    if (val && val.indexOf(',') !== -1) {
      val.split(',').forEach(function(p) {
        var trimmed = p.trim();
        if (trimmed.length >= 3) expanded.add(trimmed.split(' ')[0]);
      });
    }
  });
  return Array.from(expanded);
}

// ── STEP 2A: Textract-coordinate-based redaction ──────────────────────────────
// Returns piiByPage map using exact Textract bounding boxes — no LLM needed

function normalizeForMatch(str) {
  return (str || '').toLowerCase().replace(/[\s\-,\.\(\)]/g, '');
}

function findBoxesFromBlocks(wordBlocks, piiValues) {
  // Build a map of page -> list of word blocks
  var pageMap = {};
  for (var i = 0; i < wordBlocks.length; i++) {
    var b = wordBlocks[i];
    var pg = b.p || 1;
    if (!pageMap[pg]) pageMap[pg] = [];
    pageMap[pg].push(b);
  }

  var result = {}; // page (0-indexed) -> array of boxes

  for (var pi = 0; pi < piiValues.length; pi++) {
    var pii = piiValues[pi];
    var piiNorm = normalizeForMatch(pii);
    if (piiNorm.length < 4) continue; // skip short/junk values (e.g. 'Med', 's') to prevent over-redaction

    // Try to match pii value against concatenated word sequences on each page
    var pageNums = Object.keys(pageMap);
    for (var pg2i = 0; pg2i < pageNums.length; pg2i++) {
      var pageNum = parseInt(pageNums[pg2i], 10);
      var pageWords = pageMap[pageNum];
      var pageIdx = pageNum - 1; // convert to 0-based

      // Sliding window: try 1 to 6 consecutive words — exact match only, min 6 chars
      for (var start = 0; start < pageWords.length; start++) {
        for (var len = 1; len <= 6 && start + len <= pageWords.length; len++) {
          var slice = pageWords.slice(start, start + len);
          var rawConcat = slice.map(function(w) { return w.t; }).join(''); var concat = normalizeForMatch(rawConcat);
          if (piiNorm.length > 0 && concat === piiNorm) {
            // Compute bounding box that covers all words in slice
            var minL = Math.min.apply(null, slice.map(function(w) { return w.l; }));
            var minT = Math.min.apply(null, slice.map(function(w) { return w.tp; }));
            var maxR = Math.max.apply(null, slice.map(function(w) { return w.l + w.w; }));
            var maxB = Math.max.apply(null, slice.map(function(w) { return w.tp + w.h; }));
            if (!result[String(pageIdx)]) result[String(pageIdx)] = [];
            result[String(pageIdx)].push({
              label: 'textract:' + pii.substring(0, 30),
              x: Math.max(0, minL - 0.005),
              y: minT,
              width: Math.min(1, (maxR - minL) + 0.01),
              height: maxB - minT,
            });
            // Do NOT break -- continue scanning to find ALL occurrences on this page
          }
        }
      }
    }
  }

  // ── SIGNATURE LINE DETECTION ─────────────────────────────────────────────
  // Detect label words that indicate a signature line is above them.
  // Redact a box from the left edge of the label to ~0.6 page width,
  // covering the area immediately above the label (where the signature sits).
  // Labels that appear BELOW a handwritten/filled field — redact the area above the label.
  // Covers: signature lines, C-4 form fields, structured form fields.
  var SIG_LABELS = [
    // Signature lines
    'patientsignature', 'patientorguardiansignature', 'guardiansignature',
    'signatureofpatient', 'patientguardiansignature', 'parentguardiansignature',
    'printpatientname', 'signatureofguardian',
    'employeesignature', 'witnessesignature', 'witnesssignature',
    'authorizedsignature', 'signatureofauthorizedrepresentative',
    'poasignature', 'powerofattorneysignature',
    'caregiverrnoctorsignature', 'caregiverrnoctorsig',
    'physiciansignature', 'providersignature',
    'employeesorguardiansignature',
    // C-4 / structured form field labels (value written in box above label)
    'firstname', 'lastname', 'middleinitial',
    'firstnamemi', 'firstnamemilastname',
    'birthdate', 'dateofbirth',
    'homeaddress', 'homeaddressnumberandstreet',
    'employeesname', 'employeename',
    'claimantsname', 'claimantname',
    'socialsecuritynumber', 'socialsecurityno',
    'dateofinjury', 'dateofaccident',
    'employersname', 'employername',
    'supervisorname', 'supervisortowhoinjuryreported',
    // Witness and occupational form fields
    'witnesstoaccident', 'witnessname', 'nameofwitness',
    'occupationaldisease', 'injureddescription',
  ];

  var pageNums2 = Object.keys(pageMap);
  for (var sp = 0; sp < pageNums2.length; sp++) {
    var pageNum2 = parseInt(pageNums2[sp], 10);
    var pageWords2 = pageMap[pageNum2];
    var pageIdx2 = pageNum2 - 1;

    // Sliding window of 1-5 words to detect signature label phrases
    for (var sw = 0; sw < pageWords2.length; sw++) {
      for (var sl = 1; sl <= 5 && sw + sl <= pageWords2.length; sl++) {
        var sigSlice = pageWords2.slice(sw, sw + sl);
        var sigConcat = sigSlice.map(function(w) {
          return w.t.toLowerCase().replace(/[\s\-,\.\(\)\/]/g, '');
        }).join('');

        var isSigLabel = false;
        for (var si = 0; si < SIG_LABELS.length; si++) {
          if (sigConcat === SIG_LABELS[si]) {
            isSigLabel = true;
            break;
          }
        }

        if (isSigLabel) {
          // Get the vertical position of this label
          var labelTop = Math.min.apply(null, sigSlice.map(function(w) { return w.tp; }));
          var labelLeft = Math.min.apply(null, sigSlice.map(function(w) { return w.l; }));

          // Redact the area above the label: from ~1.5x label height above it,
          // spanning from near-left to ~0.65 page width
          var labelH = Math.max.apply(null, sigSlice.map(function(w) { return w.h; }));
          // Address field labels sit ABOVE the handwritten content — redact below the label.
          // Signature/name field labels sit BELOW the content — redact above the label.
          var isAddressField = (sigConcat === 'homeaddress' || sigConcat === 'homeaddressnumberandstreet');
          var labelBottom = Math.max.apply(null, sigSlice.map(function(w) { return w.tp + w.h; }));

          if (!result[String(pageIdx2)]) result[String(pageIdx2)] = [];
          if (isAddressField) {
            // Box goes BELOW the label: from bottom of label down 0.15 page
            result[String(pageIdx2)].push({
              label: 'sig:' + sigConcat.substring(0, 30),
              x: Math.max(0, labelLeft - 0.01),
              y: labelBottom,
              width: Math.min(1, 0.92 - labelLeft + 0.01),
              height: 0.15,
            });
          } else {
            // Box goes ABOVE the label: from N*labelH above the label up to the label
            var boxHeight = labelH * 6.0;
            var boxTop = Math.max(0, labelTop - boxHeight);
            result[String(pageIdx2)].push({
              label: 'sig:' + sigConcat.substring(0, 30),
              x: Math.max(0, labelLeft - 0.01),
              y: boxTop,
              width: Math.min(1, 0.92 - labelLeft + 0.01),
              height: labelTop - boxTop,
            });
          }
          break; // don't double-match longer slices for same start word
        }
      }
    }
  }

  // ── Patient-Name label gap pass ──────────────────────────────────────────────
  // Find lines containing a "PATIENT NAME" label and redact everything after it
  // until a gap > 2% of page width appears (stops before ACCOUNT # etc.)
  // Geometry-only: immune to OCR artifacts in the name itself.
  var PATIENT_LABEL_NORM = ['patientname', 'patientname:', 'patient:', 'patientnames:', 'ptname', 'ptname:', 'name:'];
  // Labels that signal end of patient name field on same line
  var FIELD_STOP_LABELS = ['account', 'account#', 'acct', 'acct#', 'unit', 'unit#', 'unitno', 'room', 'dob', 'mrn', 'ssn', 'phone'];
  var GAP_THRESHOLD   = 0.05;  // >5% page width = field boundary (covers OCR-split tokens within a name)
  var LINE_TOLERANCE  = 0.012; // words within 1.2% vertical = same line

  function isPatientLabel(txt) {
    // Must end with ':' to be a form field label (not a narrative word)
    var trimmed = (txt || '').trim();
    if (trimmed.charAt(trimmed.length - 1) !== ':') return false;
    var n = normalizeForMatch(trimmed);
    for (var _pi = 0; _pi < PATIENT_LABEL_NORM.length; _pi++) {
      if (n === PATIENT_LABEL_NORM[_pi]) return true;
    }
    return false;
  }

  var allPageNums2 = Object.keys(pageMap);
  for (var _pgi = 0; _pgi < allPageNums2.length; _pgi++) {
    var _pageNum = parseInt(allPageNums2[_pgi], 10);
    var _pageIdx = _pageNum - 1;
    var _words   = pageMap[_pageNum].slice().sort(function(a, b) { return a.l - b.l; });
    // Pre-merge: mark two-token "PATIENT NAME:" sequences as a single label trigger
    // so isPatientLabel fires even when Textract splits them into separate tokens
    for (var _mi = 0; _mi < _words.length - 1; _mi++) {
      var _wA = _words[_mi], _wB = _words[_mi + 1];
      var _nA = normalizeForMatch(_wA.t), _nB = normalizeForMatch(_wB.t);
      if (_nA === 'patient' && _nB === 'name:') {
        // Merge: widen wA to cover both, mark as combined label, remove wB
        _wA.t = 'PATIENT NAME:';
        _wA.w = (_wB.l + _wB.w) - _wA.l;
        _words.splice(_mi + 1, 1);
      }
    }
    // DEBUG: log footer/lower tokens to diagnose page 26
    var _footerToks = _words.filter(function(w) { return w.tp > 0.75; });
    if (_footerToks.length > 0) {
      console.log('[GAP-PASS DEBUG] page=' + _pageNum + ' lower-half tokens: ' + JSON.stringify(_footerToks.map(function(w){ return {t:w.t, l:Math.round(w.l*1000)/1000, tp:Math.round(w.tp*1000)/1000, w:Math.round(w.w*1000)/1000}; })));
    }
    // Log ALL words on page 26 specifically
    if (_pageNum === 26) {
      console.log('[PAGE26 ALL WORDS] count=' + _words.length + ' words: ' + JSON.stringify(_words.map(function(w){ return {t:w.t, l:Math.round(w.l*1000)/1000, tp:Math.round(w.tp*1000)/1000}; })));
    }

    for (var _wi = 0; _wi < _words.length; _wi++) {
      var _w = _words[_wi];

      // Detect label: single word "PATIENT:" or two-word "PATIENT NAME[:]"
      var _labelRight = _w.l + _w.w;
      var _labelTop   = _w.tp;
      var _afterIdx   = _wi;
      var _isLabel    = false;

      if (isPatientLabel(_w.t)) {
        _isLabel = true;
      } else if (_wi + 1 < _words.length) {
        var _w2 = _words[_wi + 1];
        if (Math.abs(_w2.tp - _w.tp) < LINE_TOLERANCE) {
          var _rawCombo = _w.t + _w2.t;
          var _combo = normalizeForMatch(_rawCombo);
          if (_combo.indexOf('patientname') === 0 || _combo === 'patientnames') {
            _isLabel    = true;
            _labelRight = _w2.l + _w2.w;
            _afterIdx   = _wi + 1;
            // Also consume a trailing ':' token if present
            if (_wi + 2 < _words.length) {
              var _w3 = _words[_wi + 2];
              if (_w3.t.trim() === ':' && Math.abs(_w3.tp - _w.tp) < LINE_TOLERANCE) {
                _labelRight = _w3.l + _w3.w;
                _afterIdx   = _wi + 2;
              }
            }
          }
        }
      }

      if (!_isLabel) continue;

      // Scan rightward — redact until gap > threshold
      var _redactStart  = null;
      var _redactEnd    = _labelRight;
      var _prevRight    = _labelRight;

      for (var _ci = _afterIdx + 1; _ci < _words.length; _ci++) {
        var _cw = _words[_ci];
        if (Math.abs(_cw.tp - _labelTop) > LINE_TOLERANCE) continue;
        if (_cw.l < _labelRight) continue;

        var _gap = _cw.l - _prevRight;

        if (_redactStart === null) {
          // Initial gap after label colon/space — skip if huge (no content)
          if (_gap > GAP_THRESHOLD * 4) break;
          _redactStart = _cw.l;
        } else {
          // Stop at large gap OR when we hit a known non-PII field label
          var _cwNorm = normalizeForMatch(_cw.t);
          var _isStopLabel = false;
          for (var _si = 0; _si < FIELD_STOP_LABELS.length; _si++) {
            if (_cwNorm === FIELD_STOP_LABELS[_si] || _cwNorm.indexOf(FIELD_STOP_LABELS[_si]) === 0) {
              _isStopLabel = true; break;
            }
          }
          if (_gap > GAP_THRESHOLD || _isStopLabel) break; // field boundary — stop
        }

        _redactEnd  = _cw.l + _cw.w;
        _prevRight  = _cw.l + _cw.w;
      }

      if (_redactStart !== null && _redactEnd > _redactStart) {
        var _pk = String(_pageIdx);
        if (!result[_pk]) result[_pk] = [];
        result[_pk].push({
          label:  'patient_name_label_gap',
          x:      Math.max(0, _redactStart - 0.003),
          y:      _labelTop,
          width:  (_redactEnd - _redactStart) + 0.006,
          height: (_w.h || 0.012) * 1.4,
        });
      }
    }
  }
  // ── End patient-name label gap pass ──────────────────────────────────────────

  return result;
}

async function loadTextractBlocks(fileKey) {
  try {
    var blocksKey = fileKey.replace(/\/[^\/]+$/, '') + '/textract_blocks.json';
    var resp = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: blocksKey }));
    var chunks = [];
    for await (var chunk of resp.Body) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
  } catch (e) {
    console.log('No textract blocks found (will use Claude vision):', e.message);
    return null;
  }
}

// ── STEP 2B: Claude vision pass — handwritten content only ───────────────────

async function detectHandwrittenPii(pdfBytes, knownPiiValues) {
  const pdfBase64 = pdfBytes.toString('base64');

  const confirmedSection = knownPiiValues && knownPiiValues.length > 0
    ? '=== CONFIRMED PATIENT PII — MUST REDACT ALL ===\n\n' +
      'These strings are confirmed patient PII. Find EVERY handwritten occurrence.\n\n' +
      knownPiiValues.map(function(v) { return '  - "' + v + '"'; }).join('\n') + '\n'
    : '';

  const prompt = [
    'You are a HIPAA redaction assistant for workers compensation medical records.',
    'Your job is to find and return bounding boxes for PATIENT DEMOGRAPHIC information only.',
    'Clinical content must be preserved — only identity/contact information is redacted.',
    '',
    '=== WHAT TO REDACT (patient demographics only) ===',
    '',
    'PATIENT NAME — the patient name value, not provider names:',
    '  e.g. "Patient: MORA-MALDONADO,VILMA N"  →  redact "MORA-MALDONADO,VILMA N"',
    '  e.g. "PATIENT: Smith, John A"  →  redact "Smith, John A"',
    '  e.g. handwritten name on C-4 form patient name field',
    '',
    'DATE OF BIRTH — redact the birth date value when labeled as DOB:',
    '  e.g. line reads "DOB: 05/21/69  AGE: 56  SEX: F" → redact "05/21/69" AND "56"',
    '  e.g. line reads "DOB: 05/21/1969" → redact the date value',
    '  e.g. line reads "DATE OF BIRTH: May 21, 1969" → redact the date',
    '  e.g. line reads "Birth Date: 05/21/69" → redact the date',
    '  e.g. radiology header "DOB:" field → redact the value next to it',
    '  KEY RULE: The label that triggers DOB redaction MUST be one of:',
    '    DOB:  D.O.B.:  DATE OF BIRTH:  Birth Date:  Patient DOB:  Birthdate:',
    '  SERVICE DATE RULE — these labels do NOT trigger redaction:',
    '    Date:  DATE:  DATE:xx/xx/xx TIME:  ADM DT:  REP SRV DT:  SERVICE DT:',
    '    Discharge date:  Date of admission:  Observation Start Date:',
    '    Any date appearing in clinical notes, vital signs tables, medication orders',
    'COMPACT HEADER RULE — many continuation pages have this 4-line header block:',
    '  Patient: [name]  /  Unit#[number]  /  Date: [xx/xx/xx]  /  Acct# [number]',
    '  The "Date:" value in this 4-line block is a REPORT date, NOT a birth date.',
    '  DO NOT REDACT the Date: value here. Only redact the Patient name and Acct# value.',
    '',
    'MRN / UNIT / ACCOUNT NUMBERS:',
    '  e.g. "UNIT #: D003081753"  →  redact "D003081753"',
    '  e.g. "ACCOUNT#: D00136377973"  →  redact "D00136377973"',
    '  e.g. "MRN#: 403522"  →  redact "403522"',
    '  e.g. "Patient #: 403522"  →  redact the number',
    '',
    'SSN: any value in xxx-xx-xxxx format',
    '',
    'INSURANCE / CLAIM IDs:',
    '  e.g. "Plan #: 354000611225"  →  redact the number',
    '  e.g. "Group #: 76414937"  →  redact the number',
    '  e.g. "CLM#: 0583WC260300444"  →  redact the number',
    '',
    'PATIENT ADDRESS AND PHONE:',
    '  e.g. "1828 E State Highway 168 Box 578, Moapa, NV 89025"  →  redact',
    '  e.g. "(818) 497-1726"  →  redact',
    '',
    'PATIENT PHOTO or PATIENT SIGNATURE on forms',
    '',
    '=== WHAT NOT TO REDACT ===',
    '',
    'Provider names: "Electronically Signed by Ching,Wilbert MD"  →  DO NOT redact',
    'Dates of service: "SERVICE DT: 10/08/25", "ADM DT: 10/02/25", "REP SRV DT: 10/03/25"  →  DO NOT redact',
    'Date labels alone: "Date: 10/08/25" on CorVel header continuation pages  →  DO NOT redact (service date)',
    'AGE field standalone: "AGE: 56" without adjacent DOB  →  DO NOT redact',
    'Diagnoses: "S52.021A – Displaced fracture of olecranon"  →  DO NOT redact',
    'ICD/CPT codes: "S52.131A", "W01.0XXA"  →  DO NOT redact',
    'Medications: "Hydrocodone 10mg", "gabapentin 600mg"  →  DO NOT redact',
    'Clinical narrative: HPI, exam findings, assessment/plan  →  DO NOT redact',
    'Facility names: "Sunrise Hospital", "Nevada Orthopedic"  →  DO NOT redact',
    'Report numbers: "RPT #: 1003-0280"  →  DO NOT redact',
    'Employer: "DISTRICT ATTORNEY OF FAMIL"  →  DO NOT redact',
    '',
    confirmedSection,
    '=== BOX PLACEMENT ===',
    'Cover the VALUE only, not the label. E.g. for "DOB: 05/21/69" cover only "05/21/69".',
    'Start slightly LEFT of the value (subtract ~0.005 from x). Add ~0.008 to width.',
    'For multi-line values, use one box per line.',
    '',
    '=== OUTPUT FORMAT ===',
    'JSON object keyed by 0-based page index.',
    'Only include pages that have demographics to redact. Omit pages with nothing to redact.',
    'Return ONLY valid JSON — no explanation, no markdown.',
    '{',
    '  "0": [{"label":"patient name","x":0.08,"y":0.05,"width":0.38,"height":0.018}],',
    '  "3": [{"label":"DOB","x":0.22,"y":0.08,"width":0.12,"height":0.016},{"label":"unit number","x":0.10,"y":0.11,"width":0.20,"height":0.016}]',
    '}',
  ].filter(Boolean).join('\n');

  const body = JSON.stringify({
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 4096,
    temperature: 0,
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
        { type: 'text', text: prompt },
      ],
    }],
  });

  const resp = await bedrock.send(new InvokeModelCommand({
    modelId: MODEL_ID,
    contentType: 'application/json',
    accept: 'application/json',
    body,
  }));

  const result  = JSON.parse(Buffer.from(resp.body).toString('utf-8'));
  const rawText = (result.content && result.content[0] && result.content[0].text) || '{}';
  const cleaned = rawText.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try { return JSON.parse(cleaned); } catch (e) { return {}; }
}

// ── STEP 3: Apply black boxes ─────────────────────────────────────────────────

async function applyRedactions(pdfBytes, piiByPage) {
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const pages  = pdfDoc.getPages();

  for (const pageIndexStr of Object.keys(piiByPage)) {
    const pageIndex = parseInt(pageIndexStr, 10);
    const boxes     = piiByPage[pageIndexStr];
    if (pageIndex >= pages.length || !boxes || !boxes.length) continue;

    const page     = pages[pageIndex];
    const sz       = page.getSize();
    const rawW     = sz.width;
    const rawH     = sz.height;

    // Read PDF page rotation (0 / 90 / 180 / 270).
    // Textract renders the page visually (post-rotation) before OCR, so its
    // bounding boxes are in the *visually-correct* coordinate space.
    // pdf-lib draws in the *raw* (pre-rotation) coordinate space.
    // We must transform Textract's normalized [0-1] coords into raw space.
    var rotation = 0;
    try {
      var rotNode = page.node.get(page.node.doc.context.obj('Rotate'));
      if (rotNode) rotation = Number(rotNode.value || rotNode.numberValue || 0);
    } catch(_e) {
      try { rotation = page.getRotation ? page.getRotation().angle : 0; } catch(_e2) { rotation = 0; }
    }
    rotation = ((rotation % 360) + 360) % 360; // normalise to 0/90/180/270

    for (const box of boxes) {
      // box.x, box.y, box.width, box.height are Textract-normalized [0-1],
      // with origin at TOP-LEFT of the *visually rendered* page.
      var bx = box.x;
      var by = box.y;
      var bw = box.width;
      var bh = box.height;

      var px, py, pw, ph;

      if (rotation === 0) {
        // Standard: visual space == raw space, just flip Y for pdf-lib
        px = bx * rawW;
        py = rawH - (by + bh) * rawH;
        pw = bw * rawW;
        ph = bh * rawH;

      } else if (rotation === 90) {
        // Visual page is rawH wide × rawW tall (axes swapped).
        // Textract bx/by are in that visual space.
        // Map back to raw space where x-axis = raw width, y-axis = raw height.
        // In raw space: x_raw = by * rawW,  y_raw = (1 - bx - bw) * rawH
        px = by * rawW;
        py = (1 - bx - bw) * rawH;
        pw = bh * rawW;
        ph = bw * rawH;

      } else if (rotation === 270) {
        // Opposite of 90
        px = (1 - by - bh) * rawW;
        py = bx * rawH;
        pw = bh * rawW;
        ph = bw * rawH;

      } else {
        // 180: flip both axes
        px = (1 - bx - bw) * rawW;
        py = (by) * rawH;
        pw = bw * rawW;
        ph = bh * rawH;
      }

      page.drawRectangle({
        x:      Math.max(0, px),
        y:      Math.max(0, py),
        width:  Math.min(rawW - Math.max(0, px), Math.abs(pw)),
        height: Math.min(rawH - Math.max(0, py), Math.abs(ph)),
        color:  rgb(0, 0, 0),
        opacity: 1,
      });
    }
  }

  return Buffer.from(await pdfDoc.save({ useObjectStreams: false }));
}

// ── Merge two piiByPage maps ──────────────────────────────────────────────────

function mergePiiMaps(a, b) {
  var out = {};
  var keys = new Set(Object.keys(a).concat(Object.keys(b)));
  keys.forEach(function(k) {
    out[k] = (a[k] || []).concat(b[k] || []);
  });
  return out;
}

// ── Fetch extracted_text from DynamoDB ────────────────────────────────────────

async function fetchExtractedText(doc_id) {
  const docRes = await dynamo.send(new GetCommand({ TableName: DOCS_TABLE, Key: { aws_document_id: doc_id } }));
  const doc    = docRes.Item || {};
  let text     = doc.extracted_text || '';
  try {
    if (doc.original_document_id) {
      const parentRes = await dynamo.send(new GetCommand({
        TableName: DOCS_TABLE,
        Key: { aws_document_id: doc.original_document_id },
      }));
      if (parentRes.Item && parentRes.Item.extracted_text) {
        text = parentRes.Item.extracted_text + '\n' + text;
      }
    }
  } catch (e) {
    console.warn('Could not fetch parent doc:', e.message);
  }
  return text;
}

// ── START handler ─────────────────────────────────────────────────────────────

const _redactDocumentStart = async function(event) {
  const doc_id = event.pathParameters && event.pathParameters.aws_document_id;
  if (!doc_id) return respond(400, { error: 'Missing document ID' });

  const docRes = await dynamo.send(new GetCommand({ TableName: DOCS_TABLE, Key: { aws_document_id: doc_id } }));
  const doc    = docRes.Item;
  if (!doc) return respond(404, { error: 'Document not found' });

  const fileKey = doc.file_key || doc.s3_key;
  if (!fileKey) return respond(400, { error: 'Document has no S3 key' });

  const job_id = randomUUID();
  const now    = new Date().toISOString();

  await dynamo.send(new PutCommand({
    TableName: JOBS_TABLE,
    Item: {
      job_id, type: 'redact', status: 'processing',
      doc_id, org_id: doc.org_id || null,
      created_at: now, updated_at: now,
      progress_message: 'Starting redaction...',
    },
  }));

  await lambdaClient.send(new InvokeCommand({
    FunctionName:   WORKER_FN,
    InvocationType: 'Event',
    Payload:        Buffer.from(JSON.stringify({ job_id, doc_id, doc })),
  }));

  return respond(200, { job_id, status: 'processing' });
};

module.exports.redactDocumentStart = validateApiKey(_redactDocumentStart);

// ── WORKER handler ────────────────────────────────────────────────────────────

module.exports.redactDocumentWorker = async function(event) {
  const job_id = event.job_id;
  const doc_id = event.doc_id;
  const doc    = event.doc;

  try {
    await updateJob(job_id, { progress_message: 'Fetching document...', updated_at: new Date().toISOString() });

    const fileKey  = doc.file_key || doc.s3_key;
    const pdfBytes = await getS3Bytes(fileKey);

    // Extract known PII values from stored Textract text to anchor Claude's redaction
    const extractedText  = await fetchExtractedText(doc_id);
    const knownPiiValues = extractKnownPiiValues(extractedText);
    console.log('Known PII values (' + knownPiiValues.length + '):', JSON.stringify(knownPiiValues.slice(0, 15)));

    const masterDoc  = await PDFDocument.load(pdfBytes);
    const totalPages = masterDoc.getPageCount();
    var allPii       = {};

    // ── PRIMARY PATH: Textract geometry ──────────────────────────────────────
    // Load word blocks saved at upload time (orgs/.../textract_blocks.json).
    // Match known PII values against block text — coordinates are already in
    // PDF space (0-1 normalized), no vision model needed.
    const wordBlocks = await loadTextractBlocks(fileKey);

    if (wordBlocks && wordBlocks.length > 0) {
      console.log('[REDACT] Using Textract geometry path — ' + wordBlocks.length + ' word blocks');
      await updateJob(job_id, {
        progress_message: 'Scanning ' + totalPages + ' pages via Textract geometry...',
        updated_at: new Date().toISOString(),
      });
      // Pre-filter piiValues: remove standalone 4-digit military times, pure short numbers,
    // and street numbers extracted from facility/hospital addresses in the document itself.
    // Strategy: scan extractedText for lines that look like facility address lines
    // (follow a known facility name pattern) and collect their leading street numbers.
    // These numbers are facility identifiers, not patient PII.
    var facilityStreetNums = (function() {
      var nums = new Set();
      if (extractedText) {
        // Match lines that are a street address following a hospital/medical/facility name
        // e.g. "SUNRISE HOSPITAL AND MEDICAL CENTER\n3186 S MARYLAND PKWY"
        // or "Sunrise Hospital/Med Ctr.\n3186 S MARYLAND PKWY"
        var lines = extractedText.split(/\r?\n/);
        for (var _li = 0; _li < lines.length; _li++) {
          var line = lines[_li].trim();
          // If line looks like a street address (starts with number + street name)
          var addrMatch = line.match(/^(\d{3,6})\s+[A-Z]/i);
          if (addrMatch) {
            // Check if previous non-empty line contains a facility keyword
            var prevLine = '';
            for (var _pi2 = _li - 1; _pi2 >= 0 && !prevLine; _pi2--) {
              prevLine = lines[_pi2].trim();
            }
            var isFacilityLine = /hospital|medical\s*cent|med\s*ctr|clinic|health\s*system|surgery\s*cent/i.test(prevLine);
            if (isFacilityLine) {
              nums.add(addrMatch[1]); // add the street number (e.g. "3186")
            }
          }
        }
      }
      return nums;
    })();

    var filteredPiiValues = knownPiiValues.filter(function(v) {
      var trimmed = (v || '').trim();
      // Pure 4-digit value that looks like a military time (0000-2359) — skip
      if (/^\d{4}$/.test(trimmed)) {
        var n = parseInt(trimmed, 10);
        if (n >= 0 && n <= 2359 && (n % 100) < 60) return false;
      }
      // Pure 1-3 digit number — too generic
      if (/^\d{1,3}$/.test(trimmed)) return false;
      // Facility street numbers extracted dynamically from document headers — skip
      if (facilityStreetNums.has(trimmed)) return false;
      return true;
    });
    allPii = findBoxesFromBlocks(wordBlocks, filteredPiiValues);
      var textractCount = Object.values(allPii).reduce(function(s, b) { return s + b.length; }, 0);
      console.log('[REDACT] Textract path found ' + textractCount + ' box(es) across ' + Object.keys(allPii).length + ' page(s)');

    } else {
      // ── FALLBACK: Claude vision (no Textract blocks available) ─────────────
      console.log('[REDACT] No Textract blocks found — falling back to Claude vision');
      const CHUNK_SIZE = 20;

      for (let start = 0; start < totalPages; start += CHUNK_SIZE) {
        const end     = Math.min(start + CHUNK_SIZE, totalPages);
        const indices = [];
        for (let i = start; i < end; i++) indices.push(i);

        await updateJob(job_id, {
          progress_message: 'Scanning pages ' + (start + 1) + ' to ' + end + ' of ' + totalPages + ' (vision fallback)...',
          updated_at: new Date().toISOString(),
        });

        const subDoc = await PDFDocument.create();
        const copied = await subDoc.copyPages(masterDoc, indices);
        copied.forEach(function(p) { subDoc.addPage(p); });
        const subBytes = Buffer.from(await subDoc.save());

        const chunkPii = await detectHandwrittenPii(subBytes, knownPiiValues);

        for (const chunkPageStr of Object.keys(chunkPii)) {
          const globalPage = start + parseInt(chunkPageStr, 10);
          const boxes      = chunkPii[chunkPageStr];
          if (boxes && boxes.length) allPii[String(globalPage)] = boxes;
        }
      }
    }

    const totalRedactions    = Object.values(allPii).reduce(function(s, b) { return s + b.length; }, 0);
    const totalPagesAffected = Object.keys(allPii).length;

    await updateJob(job_id, {
      progress_message: 'Applying ' + totalRedactions + ' redaction(s) across ' + totalPagesAffected + ' page(s)...',
      updated_at: new Date().toISOString(),
    });

    const redactedBytes = await applyRedactions(pdfBytes, allPii);

    const keyParts     = fileKey.split('/');
    const origFilename = keyParts.pop();
    const baseName     = origFilename.replace(/\.pdf$/i, '');
    const redactedKey  = keyParts.concat([baseName + '_REDACTED.pdf']).join('/');
    const redactedName = baseName + '_REDACTED.pdf';

    await updateJob(job_id, { progress_message: 'Saving redacted document...', updated_at: new Date().toISOString() });

    await s3.send(new PutObjectCommand({
      Bucket:      BUCKET,
      Key:         redactedKey,
      Body:        redactedBytes,
      ContentType: 'application/pdf',
    }));

    const newDocId = randomUUID();
    await dynamo.send(new PutCommand({
      TableName: DOCS_TABLE,
      Item: {
        aws_document_id:   newDocId,
        org_id:            doc.org_id            || null,
        patient_id:        doc.patient_id         || null,
        folder_name:       doc.folder_name        || null,
        provider_name:     doc.provider_name      || null,
        original_filename: redactedName,
        file_key:          redactedKey,
        s3_key:            redactedKey,
        is_redacted:       true,
        redacted_from:     doc_id,
        redaction_count:   totalRedactions,
        redacted_pages:    totalPagesAffected,
        status:            'processed',
        is_clinical:       doc.is_clinical        || false,
        created_at:        new Date().toISOString(),
        updated_at:        new Date().toISOString(),
      },
    }));

    const downloadUrl = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: BUCKET, Key: redactedKey }),
      { expiresIn: 3600 }
    );

    await updateJob(job_id, {
      status:           'complete',
      progress_message: 'Redaction complete - ' + totalRedactions + ' item(s) redacted across ' + totalPagesAffected + ' page(s).',
      result: {
        new_doc_id:      newDocId,
        download_url:    downloadUrl,
        redaction_count: totalRedactions,
        redacted_pages:  totalPagesAffected,
      },
      updated_at: new Date().toISOString(),
    });

  } catch (err) {
    console.error('Redaction worker error:', err);
    await updateJob(job_id, {
      status:           'error',
      progress_message: 'Redaction failed: ' + err.message,
      updated_at:       new Date().toISOString(),
    });
  }
};

// ── CASE REDACTION START handler ─────────────────────────────────────────────
const _redactCaseStart = async function(event) {
  var body = {};
  try { body = JSON.parse(event.body || '{}'); } catch(e) {}
  var doc_ids = body.doc_ids;
  var original_document_id = body.original_document_id;
  if (!doc_ids || !Array.isArray(doc_ids) || doc_ids.length === 0) {
    return respond(400, { error: 'Missing doc_ids array' });
  }
  var docRecords = [];
  for (var _di = 0; _di < doc_ids.length; _di++) {
    var docRes = await dynamo.send(new GetCommand({ TableName: DOCS_TABLE, Key: { aws_document_id: doc_ids[_di] } }));
    if (!docRes.Item) return respond(404, { error: 'Document not found: ' + doc_ids[_di] });
    docRecords.push(docRes.Item);
  }
  var org_id = docRecords[0].org_id || body.org_id || null;
  var folder_name = docRecords[0].folder_name || null;
  var patient_id = docRecords[0].patient_id || null;
  docRecords.sort(function(a, b) {
    var aName = (a.original_filename || a.file_name || '').toLowerCase();
    var bName = (b.original_filename || b.file_name || '').toLowerCase();
    var aMatch = aName.match(/part(\d+)/i);
    var bMatch = bName.match(/part(\d+)/i);
    var aNum = aMatch ? parseInt(aMatch[1], 10) : 0;
    var bNum = bMatch ? parseInt(bMatch[1], 10) : 0;
    return aNum - bNum;
  });
  var job_id = randomUUID();
  var now = new Date().toISOString();
  await dynamo.send(new PutCommand({
    TableName: JOBS_TABLE,
    Item: {
      job_id, type: 'redact_case', status: 'processing',
      original_document_id: original_document_id || null,
      org_id, created_at: now, updated_at: now,
      progress_message: 'Starting case redaction for ' + docRecords.length + ' part(s)...',
    },
  }));
  await lambda.send(new InvokeCommand({
    FunctionName:   process.env.REDACT_CASE_WORKER_FUNCTION_NAME,
    InvocationType: 'Event',
    Payload:        Buffer.from(JSON.stringify({
      job_id, doc_records: docRecords,
      original_document_id: original_document_id || null,
      org_id, folder_name, patient_id,
    })),
  }));
  return respond(200, { job_id });
};

module.exports.redactCaseStart = validateApiKey(_redactCaseStart);

// ── CASE REDACTION WORKER ─────────────────────────────────────────────────────
module.exports.redactCaseWorker = async function(event) {
  var job_id               = event.job_id;
  var doc_records          = event.doc_records;
  var original_document_id = event.original_document_id;
  var org_id               = event.org_id;
  var folder_name          = event.folder_name;
  var patient_id           = event.patient_id;

  try {
    await updateJob(job_id, { progress_message: 'Redacting ' + doc_records.length + ' part(s) in parallel...', updated_at: new Date().toISOString() });

    var partResults = await Promise.all(doc_records.map(async function(doc) {
      var doc_id   = doc.aws_document_id;
      var fileKey  = doc.file_key || doc.s3_key;
      var pdfBytes = await getS3Bytes(fileKey);
      var extractedText  = await fetchExtractedText(doc_id);
      var knownPiiValues = extractKnownPiiValues(extractedText);
      var wordBlocks     = await loadTextractBlocks(fileKey);
      var allPii         = {};

      var facilityStreetNums = (function() {
        var nums = new Set();
        if (extractedText) {
          var lines = extractedText.split(/\r?\n/);
          for (var _li = 0; _li < lines.length; _li++) {
            var line = lines[_li].trim();
            var addrMatch = line.match(/^(\d{3,6})\s+[A-Z]/i);
            if (addrMatch) {
              var prevLine = '';
              for (var _pi2 = _li - 1; _pi2 >= 0 && !prevLine; _pi2--) { prevLine = lines[_pi2].trim(); }
              if (/hospital|medical\s*cent|med\s*ctr|clinic|health\s*system|surgery\s*cent/i.test(prevLine)) {
                nums.add(addrMatch[1]);
              }
            }
          }
        }
        return nums;
      })();

      var filteredPiiValues = knownPiiValues.filter(function(v) {
        var trimmed = (v || '').trim();
        if (/^\d{4}$/.test(trimmed)) { var n = parseInt(trimmed, 10); if (n >= 0 && n <= 2359 && (n % 100) < 60) return false; }
        if (/^\d{1,3}$/.test(trimmed)) return false;
        if (facilityStreetNums.has(trimmed)) return false;
        return true;
      });

      if (wordBlocks && wordBlocks.length > 0) {
        allPii = findBoxesFromBlocks(wordBlocks, filteredPiiValues);
      } else {
        var masterDocV = await PDFDocument.load(pdfBytes);
        var totalPagesV = masterDocV.getPageCount();
        var CHUNK_SIZE = 20;
        for (var startV = 0; startV < totalPagesV; startV += CHUNK_SIZE) {
          var endV = Math.min(startV + CHUNK_SIZE, totalPagesV);
          var indicesV = [];
          for (var iv = startV; iv < endV; iv++) indicesV.push(iv);
          var subDocV = await PDFDocument.create();
          var copiedV = await subDocV.copyPages(masterDocV, indicesV);
          copiedV.forEach(function(p) { subDocV.addPage(p); });
          var subBytesV = Buffer.from(await subDocV.save());
          var chunkPii = await detectHandwrittenPii(subBytesV, knownPiiValues);
          for (var cpStr of Object.keys(chunkPii)) {
            var gp = startV + parseInt(cpStr, 10);
            if (chunkPii[cpStr] && chunkPii[cpStr].length) allPii[String(gp)] = chunkPii[cpStr];
          }
        }
      }

      var redactedBytes = await applyRedactions(pdfBytes, allPii);
      var redactCount   = Object.values(allPii).reduce(function(s, b) { return s + b.length; }, 0);
      return { redactedBytes, redactCount };
    }));

    await updateJob(job_id, { progress_message: 'Merging ' + partResults.length + ' redacted part(s)...', updated_at: new Date().toISOString() });

    var mergedDoc = await PDFDocument.create();
    var totalRedactions = 0;
    for (var _ri = 0; _ri < partResults.length; _ri++) {
      var partDoc    = await PDFDocument.load(partResults[_ri].redactedBytes);
      var pgCount    = partDoc.getPageCount();
      var pgIndices  = [];
      for (var _pii = 0; _pii < pgCount; _pii++) pgIndices.push(_pii);
      var copiedPgs  = await mergedDoc.copyPages(partDoc, pgIndices);
      copiedPgs.forEach(function(p) { mergedDoc.addPage(p); });
      totalRedactions += partResults[_ri].redactCount;
    }
    var mergedBytes = Buffer.from(await mergedDoc.save());
    var totalPages  = mergedDoc.getPageCount();

    var baseName   = (doc_records[0].original_filename || 'document').replace(/_Part\d+\.pdf$/i, '').replace(/\.pdf$/i, '');
    var newUUID    = randomUUID();
    var mergedKey  = 'orgs/' + org_id + '/documents/' + newUUID + '/' + baseName + '_REDACTED.pdf';
    var mergedName = baseName + '_REDACTED.pdf';

    await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: mergedKey, Body: mergedBytes, ContentType: 'application/pdf' }));

    var newDocId = randomUUID();
    await dynamo.send(new PutCommand({
      TableName: DOCS_TABLE,
      Item: {
        aws_document_id:   newDocId,
        org_id:            org_id || null,
        patient_id:        patient_id || null,
        folder_name:       folder_name || null,
        provider_name:     doc_records[0].provider_name || null,
        original_filename: mergedName,
        file_key:          mergedKey,
        s3_key:            mergedKey,
        is_redacted:       true,
        redacted_from:     original_document_id || doc_records.map(function(d) { return d.aws_document_id; }).join(','),
        redaction_count:   totalRedactions,
        redacted_pages:    totalPages,
        status:            'processed',
        is_clinical:       false,
        created_at:        new Date().toISOString(),
        updated_at:        new Date().toISOString(),
      },
    }));

    var downloadUrl = await getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: mergedKey }), { expiresIn: 3600 });

    await updateJob(job_id, {
      status: 'complete',
      progress_message: 'Case redaction complete - ' + totalRedactions + ' item(s) redacted across ' + totalPages + ' page(s).',
      result: { new_doc_id: newDocId, download_url: downloadUrl, redaction_count: totalRedactions, redacted_pages: totalPages },
      updated_at: new Date().toISOString(),
    });

  } catch (err) {
    console.error('Case redaction worker error:', err);
    await updateJob(job_id, { status: 'error', progress_message: 'Case redaction failed: ' + err.message, updated_at: new Date().toISOString() });
  }
};

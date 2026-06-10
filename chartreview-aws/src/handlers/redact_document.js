// redact_document.js — ChartReview Pro redaction Lambda
// Route: POST /documents/{aws_document_id}/redact
// Updated: 2026-06-09 — Fix #835: redact fused Patient:LASTNAME footer tokens; #793: comprehensive Epic EHR superscript/marker stripping (Unicode-aware)

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

// ── ADDRESS TOKENIZER HELPERS (module-level for use by all handlers) ──────────
var _SFXS = new Set(['ave','avenue','st','street','blvd','boulevard','dr','drive','rd','road','ln','lane','ct','court','way','pl','place','cir','circle','pkwy','parkway','hwy','highway','loop','ter','terrace','trl','trail']);
var _STATES = new Set(['al','ak','az','ar','ca','co','ct','de','fl','ga','hi','id','il','in','ia','ks','ky','la','me','md','ma','mi','mn','ms','mo','mt','ne','nv','nh','nj','nm','ny','nc','nd','oh','ok','or','pa','ri','sc','sd','tn','tx','ut','vt','va','wa','wv','wi','wy','dc']);
var _GEOWORDS = new Set(['north','south','east','west','ne','nw','se','sw','las','vegas','los','angeles','san','santa','new','fort','mount','ave','avenue','st','street','blvd','boulevard','dr','drive','rd','road','ln','lane','ct','court','way','pl','place','cir','circle','pkwy','parkway','hwy','highway','loop','ter','terrace','trl','trail']);
function _atl(t) { return t.toLowerCase().replace(/[^a-z0-9]/g,''); }
function _isu(t) { var tl=_atl(t); return tl.length>=3 && !_GEOWORDS.has(tl) && !_STATES.has(tl) && !/^\d+$/.test(tl); }
function _parseAddr(v) {
  var toks=v.trim().split(/[\s,]+/).filter(function(t){return t.length>0;}), i=0, end=toks.length;
  var num=null,zip=null,state=null;
  if(i<toks.length&&/^\d{2,5}$/.test(_atl(toks[i]))) num=toks[i++];
  if(end>i&&/^\d{5}$/.test(_atl(toks[end-1]))) zip=toks[--end];
  if(end>i&&_STATES.has(_atl(toks[end-1]))&&_atl(toks[end-1]).length===2) state=toks[--end];
  var mid=toks.slice(i,end), lsfx=-1;
  for(var j=mid.length-1;j>=0;j--){if(_SFXS.has(_atl(mid[j]))){lsfx=j;break;}}
  var street,city;
  if(lsfx===-1){var luq=-1; for(var j=mid.length-1;j>=0;j--){if(_isu(mid[j])){luq=j;break;}} street=luq>=0?mid.slice(0,luq+1):mid; city=luq>=0?mid.slice(luq+1):[];}
  else{street=mid.slice(0,lsfx+1); city=mid.slice(lsfx+1);}
  return {num:num,street:street,city:city,state:state,zip:zip};
}
function _tokenizeAddress(v) {
  if(!v||!/\d/.test(v)||!/[A-Za-z]/.test(v)||v.trim().length<=6) return [v];
  var p=_parseAddr(v);
  var flat=(p.num?[p.num]:[]).concat(p.street).concat(p.city).concat(p.zip?[p.zip]:[]);
  var res=[flat.join(' ')];
  if(p.zip&&flat.length>1){var nz=flat.slice(0,-1).join(' '); if(res.indexOf(nz)===-1)res.push(nz);}
  if(p.num&&res.indexOf(p.num)===-1)res.push(p.num);
  if(p.zip&&res.indexOf(p.zip)===-1)res.push(p.zip);
  p.street.concat(p.city).forEach(function(t){if(_isu(t)&&res.indexOf(t)===-1)res.push(t);});
  return res;
}

// Clinical boilerplate words — module-level so redactCaseWorker can access them
var _clinicalBoilerplate = new Set([
  'medications', 'medication', 'allergies', 'allergy', 'surgeries', 'surgery',
  'reviewed', 'review', 'concentra', 'encounter', 'prescribed', 'dispensed',
  'treatment', 'diagnosis', 'patient', 'history', 'medical', 'clinical',
  'significant', 'tobacco', 'alcohol', 'assessment', 'physical', 'exam',
  'office', 'outpatient', 'inpatient', 'visit', 'established', 'est',
  'outpatientvisit', 'officeoutpatientvisit', 'officevisit',
]);


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

// ── Redaction log CSV builder ─────────────────────────────────────────────────
function buildRedactionLogCsv(filename, piiByPage, summary) {
  var lines = [];
  // Header
  lines.push('ChartReview Pro — Redaction Log');
  lines.push('File: ' + (filename || ''));
  lines.push('Patient: ' + (summary && summary.patientName || ''));
  lines.push('DOB: ' + (summary && summary.dob || ''));
  lines.push('MRN: ' + (summary && summary.mrn || ''));
  lines.push('Folder: ' + (summary && summary.folder || ''));
  lines.push('Generated: ' + new Date().toISOString());
  lines.push('');
  // Column headers
  lines.push('Page,Rule,Matched Text,X,Y,Width,Height');
  // Detail rows
  var totalBoxes = 0;
  var ruleCounts = {};
  var pages = Object.keys(piiByPage || {}).map(Number).sort(function(a,b){return a-b;});
  for (var pi = 0; pi < pages.length; pi++) {
    var pg = pages[pi];
    var boxes = piiByPage[String(pg)] || [];
    for (var bi = 0; bi < boxes.length; bi++) {
      var box = boxes[bi];
      var _rawLabel = (box.label || box.rule || 'unknown');
      var _rule, _text;
      if (_rawLabel.startsWith('textract|')) {
        // format: 'textract|rule-name|matched-text'  e.g. 'textract|patient-name|Kimberly'
        var _parts = _rawLabel.split('|');
        _rule = (_parts[1] || 'textract-match').replace(/,/g, ';');
        _text = (_parts[2] || '').replace(/,/g, ';').replace(/\n/g, ' ');
      } else if (_rawLabel.startsWith('textract:')) {
        // legacy format: 'textract:matched-value' (no rule name available)
        _rule = 'textract-match';
        _text = _rawLabel.replace(/^textract:/, '').replace(/,/g, ';');
      } else {
        // geometry rules: handwriting, dob-date, addr-line:VALUE, patient_name_label_gap, phone, etc.
        _rule = _rawLabel.split(':')[0].replace(/,/g, ';');
        _text = _rawLabel.indexOf(':') !== -1 ? _rawLabel.replace(/^[^:]+:/, '').replace(/,/g, ';') : '';
      }
      var x  = typeof box.x === 'number' ? box.x.toFixed(4) : '';
      var y  = typeof box.y === 'number' ? box.y.toFixed(4) : '';
      var w  = typeof box.width === 'number' ? box.width.toFixed(4) : '';
      var ht = typeof box.height === 'number' ? box.height.toFixed(4) : '';
      lines.push((pg+1) + ',' + _rule + ',' + _text + ',' + x + ',' + y + ',' + w + ',' + ht);
      totalBoxes++;
      ruleCounts[_rule] = (ruleCounts[_rule] || 0) + 1;
    }
  }
  // Summary
  lines.push('');
  lines.push('Summary');
  lines.push('Total Redactions,' + totalBoxes);
  lines.push('Pages Affected,' + pages.length);
  var ruleNames = Object.keys(ruleCounts);
  for (var ri = 0; ri < ruleNames.length; ri++) {
    lines.push(ruleNames[ri] + ',' + ruleCounts[ruleNames[ri]]);
  }
  return Buffer.from(lines.join('\r\n'), 'utf8');
}

// ── STEP 1: Regex scan — extract all known PII values from stored text ────────

// ── DOB variant expansion (module-scope so all workers can use it) ────────────
var MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
var MONTH_SHORT  = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function expandDob(raw) {
  var m = raw.replace(/[-]/g, '/').match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return [raw];
  var mon = parseInt(m[1], 10), day = parseInt(m[2], 10), yr = parseInt(m[3], 10);
  if (yr < 100) yr += (yr > 30 ? 1900 : 2000);
  var yr2 = String(yr).slice(2);
  var mm = String(mon).padStart(2, '0'), dd = String(day).padStart(2, '0');
  var variants = [
    raw,
    mm + '/' + dd + '/' + yr,
    mm + '/' + dd + '/' + yr2,
    mon + '/' + day + '/' + yr,
    mon + '/' + day + '/' + yr2,
    mm + '-' + dd + '-' + yr,
    mon + '-' + day + '-' + yr,
  ];
  if (mon >= 1 && mon <= 12) {
    var mName = MONTH_NAMES[mon-1], mShort = MONTH_SHORT[mon-1];
    variants.push(mName + ' ' + day + ', ' + yr);
    variants.push(mName + ' ' + day + ' ' + yr);
    variants.push(mShort + ' ' + day + ' ' + yr);
    variants.push(mShort + ' ' + dd + ' ' + yr);
    variants.push(dd + mShort.toUpperCase() + yr);
  }
  var seen = {};
  return variants.filter(function(v) { if (seen[v]) return false; seen[v]=true; return true; });
}

function extractKnownPiiValues(extractedText) {
  // Extract all values following explicit demographic labels.
  // No minimum/maximum character limits — any labeled value is treated as PII.
  if (!extractedText || typeof extractedText !== 'string') return [];
  var found = new Set();

  var patterns = [
    // Patient name — explicit label on same line
    /^(?:PATIENT|Patient)\s*[:\|]\s*([A-Z][A-Z\-,'\. ]+)$/mg,
    // Certification / lien / legal doc inline references
    /^(?:PATIENT(?:'S)?\s*NAME?|PT\.?\s*NAME)\s*[:\|]\s*([A-Za-z][A-Za-z\-,'\. ]+)$/mgi,
    /^Patient\s*Name\s*[:\|]\s*([A-Za-z][A-Za-z\-,'\. ]+)$/mgi,
    /^(?:CLAIMANT|CLIENT)\s*[:\|]\s*([A-Za-z][A-Za-z\-,'\. ]+)$/mgi,
    /Patient['\u2019]?s?\s*Nam[e]?\s*[:\|]?\s{0,5}([A-Z][A-Z\-,'\. ]+)/gi,

    // Full 3-part name in "LAST, FIRST MIDDLE" format (e.g. UMC page headers: "Moore, Kimberly Maria")
    // Captures the FULL phrase — never splits out middle name standalone
    // 3-part LAST, FIRST MIDDLE — requires end-of-line or MRN/DOB to follow
    // Excludes lines where the 3rd component is a title (MD, DO, RN, etc.)
    /^([A-Za-z][A-Za-z'\-\.]{2,},\s+[A-Za-z][A-Za-z'\-\.]{2,}\s+[A-Za-z][A-Za-z'\-\.]{2,})(?=\s*(?:MRN|DOB|Legal|\d))/mg,

    // Date of birth — must follow label (captures MM/DD/YYYY and variants)
    /(?:DOB|D\.O\.B\.|DATE\s*OF\s*BIRTH|BIRTH\s*(?:DATE|DT)|BIRTHDATE|Birth\s*Date|Date\s*of\s*Birth)\s*[:\|]\s*([\d]{1,2}[\/\-][\d]{1,2}[\/\-][\d]{2,4})/gi,
    // Also catch handwritten DOB variants: "2/06/76" "-2/06/76" without label (C-4 forms)
    /\bBirthdate\s*[:\|]?\s*-?([\d]{1,2}[\/\-][\d]{1,2}[\/\-][\d]{2,4})/gi,

    // SSN — dashed xxx-xx-xxxx OR bare 9-digit after label
    /(\d{3}-\d{2}-\d{4})/g,
    /(?:SSN|S\.S\.N\.|SOCIAL\s*SECURITY)\s*[:\|]?\s*(\d{9})/gi,

    // MRN / PRN / Patient Record Number — must follow label
    /(?:MRN#?|MR\s*#|MED(?:ICAL)?\s*REC(?:ORD)?\s*(?:NO\.?|#)?|CHART\s*#|MRN\s*[:\|]|PRN\s*[:\|]?|Patient\s*Record\s*(?:No\.?|#)|Record\s*(?:No\.?|#))\s*[:\|]?\s*([A-Z0-9\-]*\d[A-Z0-9\-]*)/gi,

    // Driver's License number + Document Discriminator
    /(?:DL\s*(?:NO\.?|#|NUMBER)|LICENSE\s*(?:NO\.?|#|NUMBER)|DRIVERS?\s+LIC(?:ENSE)?\s*(?:NO\.?|#)?|4[dD]\s*DL\s*NO\.?)\s*[:\|]?\s*([A-Z0-9]+)/gi,
    /\b(?:5\s*DD|DD)\s+([0-9A-Z]{10,})/gi,

    // Market URN / Encounter ID
    /(?:MARKET\s*URN|VISIT\s*(?:NO\.?|#|ID)|ENCOUNTER\s*(?:NO\.?|#|ID)|URN\s*[:\|])\s*[:\|]?\s*([A-Z0-9\-]+)/gi,

    // Account / unit / episode numbers
    /(?:ACCOUNT\s*(?:NO\.?|NUMBER|#)|ACCT\s*(?:NO\.?|#)|Acct\s*#|ACCOUNT#)\s*[:\|]?\s*([A-Z0-9\-]+)/gi,
    /(?:UNIT\s*(?:NO\.?|NUMBER|#)|Unit\s*(?:No\.?|#)|Unit\s*#|UNIT#)\s*[:\|]?\s*([A-Z0-9\-]+)/gi,
    /(?:Episode\s*ID|FIN#?)\s*[:\|]\s*([A-Z0-9\-]+)/gi,

    // Insurance / member / claim IDs
    /(?:Plan\s*#|Plan\s*No\.?|GROUP\s*#|Group\s*No\.?|MEMBER\s*(?:ID|#)|Member\s*ID|POLICY\s*(?:NO\.?|#)|CLM#?|Claim\s*#|Member\s*ID#?)\s*[:\|]?\s*([A-Z0-9\-]+)/gi,

    // Phone — labeled OR bare xxx-xxx-xxxx OR (xxx) xxx-xxxx
    /(?:PHONE#?|CELL|MOBILE|TEL(?:EPHONE)?|Home\s*Phone|Work\s*Phone|Patient\s*[Pp]hone|Patient\s*PH|Phone\s*Number|Phone\s*#|PH\s*#?|Fax)\s*[:\|]?\s*([\d\(\)\-\.\s]{10,})/gi,
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
    // First/Last Name — only fires when content follows, and not when it's a column
    // header row (C-4 forms list "First Name | MI | Last Name" as headers, not values)
    // Negative lookahead prevents matching header rows with multiple pipe-separated fields
    /(?:First\s*Name|Last\s*Name)\s*[:\|]\s*([A-Za-z][A-Za-z\-,'\. ]{1,30})(?![\s\|]*(?:MI|Middle|Last|First|Birth|Claim|Sex))/gi,
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
        // Skip ICD-10 codes (e.g. S52.592D, M79.3)
        if (/^[A-Z]\d{2}\.?\d{0,3}[A-Z]?$/.test(val)) continue;
        // Skip CPT codes (4-5 digit numeric, e.g. 72125, 96361, 99213)
        if (/^\d{4,5}$/.test(val)) continue;
        // Skip HCPCS codes (letter + 4 digits, e.g. J1885, G0463)
        if (/^[A-Z]\d{4}$/.test(val)) continue;
        // Skip revenue codes (0xxx UB-04 format)
        if (/^0\d{3}$/.test(val)) continue;
        // Skip pure clinical lowercase text (long narrative fragments)
        if (/^[a-z\s,\.]{15,}$/.test(val)) continue;
        // Skip bare 2-letter state abbreviations
        if (/^[A-Z]{2}$/.test(val)) continue;
        // Skip bare geographic fragment words — OCR-split city names like "Las", "North", "San"
        // These only redact correctly as part of multi-word city phrases, never standalone
        if (/^(Las|Los|San|Santa|Saint|North|South|East|West|New|Fort|Mount|Port|Lake|Bay|Rio|Del|Van|El|La|Le)$/i.test(val.trim())) continue;
        // Skip pure digit strings < 4 digits (ROM values, vitals, age, room#)
        if (/^\d{1,3}$/.test(val)) continue;
        // Skip PII field label words — these are extraction triggers, not values to redact.
        // Redacting them causes words like "patient", "address", "name" to be blacked out
        // in clinical narrative text throughout the document.
        var _vl = val.toLowerCase().replace(/[:\s]/g, '');
        // Skip PII field label words AND common document/medical words that
        // should never be treated as PII values
        if (/^(patient|patients|address|homeaddress|name|patientname|ptname|claimant|client|guardian|guarantor|subscriber|insured|dob|dateofbirth|birthdate|ssn|socialsecurity|mrn|medicalrecord|phone|telephone|cell|mobile|fax|email|spouse|nextofkin|nok|poa|emergencycontact|firstname|lastname|middleinitial|street|city|state|zip|zipcode)s?$/.test(_vl)) continue;
        // Skip common document navigation / medical form words
        if (/^(page|pages|date|time|form|type|code|codes|unit|room|bed|ward|floor|wing|note|notes|visit|visits|total|balance|amount|paid|status|level|none|null|same|info|information|record|records|report|order|orders|plan|plans|initial|final|follow|continued|continued|signature|initials|signed|print|printed|copy|original|draft|revised|version|section|part|item|items|number|numbers|detail|details|summary|description|comment|comments)s?$/.test(_vl)) continue;
        // (char-length filter removed — short names like "Ana", "Kim" are valid PII)
        // Skip values extracted under provider/physician labels — those are staff names not patient PII
        var _prefix = (match[0] || '').slice(0, -(val.length)).toLowerCase();
        if (/(?:rendering|treating|attending|referring|ordering|prescrib|provider|physician|surgeon|clinician|practitioner|therapist|radiologist|specialist)/.test(_prefix)) continue;
        // DEBUG: trace any value containing clinical words that should never be PII
        if (/medications|allergies|treatment|procedures/i.test(val)) {
          console.log('[PII-TRACE] Suspicious value captured:', JSON.stringify(val),
            'pattern_idx:', i, 'match_context:', JSON.stringify((match[0] || '').slice(0, 80)));
        }
        found.add(val);
      }
    }
  }
  // Expand state+zip: "NV 89084" → also "89084", "NV89084"
  Array.from(found).forEach(function(val) {
    if (!val) return;
    var stZip = val.match(/^([A-Z]{2})\s+(\d{5})(-\d{4})?$/);
    if (stZip) {
      found.add(stZip[2]);
      found.add(stZip[1] + stZip[2]);
      if (stZip[3]) found.add(stZip[2] + stZip[3]);
    }
  });

  // Expand hyphenated compound names: MORA-MALDONADO -> also add MORA and MALDONADO separately
  // SCOPE GUARD: only expand short identifier-like values (names, IDs).
  // Long strings (narrative fragments, sentences) must NOT be expanded —
  // doing so causes clinical words like "medications", "treatment" to be
  // extracted as PII tokens via comma/hyphen splitting of narrative text.
  var expanded = new Set(found);
  found.forEach(function(val) {
    if (!val) return;
    // DOB variant expansion — detect date strings and add all format variants
    if (/^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}$/.test(val.trim())) {
      expandDob(val.trim()).forEach(function(v) { if (v.length >= 4) expanded.add(v); });
      return;
    }
    // Hyphen expansion: ONLY for short values (< 50 chars, < 4 spaces = max 4 words)
    // This handles "MORA-MALDONADO", "606-02-0439", "FXT-0691" but NOT narrative sentences
    if (val && val.indexOf('-') !== -1 && val.length <= 50 && (val.match(/ /g) || []).length < 4) {
      var parts = val.split('-');
      parts.forEach(function(p) {
        var trimmed = p.trim().replace(/[,\.\s]/g, '');
        if (trimmed.length >= 3) expanded.add(p.trim().split(',')[0].trim());
      });
    }
    // Comma expansion: ONLY for values that look like "LAST, FIRST" name patterns
    // (1-2 words before comma, 1-2 words after) — NOT long comma-separated sentences
    // This handles "RODRIGUEZ, CLAUDIA" but NOT "treatment plan, medications, follow up"
    if (val && val.indexOf(',') !== -1) {
      var commaParts = val.split(',');
      // Only expand if <= 3 comma-separated segments and total length <= 60 chars
      if (commaParts.length <= 3 && val.length <= 60) {
        commaParts.forEach(function(p) {
          var trimmed = p.trim();
          // Only add if the segment looks like a name token (no internal spaces > 1 word = not a phrase)
          var firstWord = trimmed.split(' ')[0];
          if (firstWord.length >= 3 && /^[A-Za-z]/.test(firstWord) && (trimmed.match(/ /g) || []).length <= 1) {
            expanded.add(firstWord);
          }
        });
      }
    }
  });
  return Array.from(expanded);
}


// ── extractKnownPiiValuesTagged: same as extractKnownPiiValues but returns
// [{value, rule}] so the CSV can show exactly which rule triggered each redaction.
function extractKnownPiiValuesTagged(extractedText) {
  if (!extractedText || typeof extractedText !== 'string') return [];
  var tagged = [];
  var seen = new Set();

  var namedPatterns = [
    { name: 'patient-name',        rx: /^(?:PATIENT|Patient)\s*[:\|]\s*([A-Z][A-Z\-,'\. ]+)$/mg },
    { name: 'patient-name',        rx: /^(?:PATIENT(?:'S)?\s*NAME?|PT\.?\s*NAME)\s*[:\|]\s*([A-Za-z][A-Za-z\-,'\. ]+)$/mgi },
    { name: 'patient-name',        rx: /^Patient\s*Name\s*[:\|]\s*([A-Za-z][A-Za-z\-,'\. ]+)$/mgi },
    { name: 'patient-name',        rx: /^(?:CLAIMANT|CLIENT)\s*[:\|]\s*([A-Za-z][A-Za-z\-,'\. ]+)$/mgi },
    { name: 'patient-name',        rx: /Patient['\u2019]?s?\s*Nam[e]?\s*[:\|]?\s{0,5}([A-Z][A-Z\-,'\. ]+)/gi },
    { name: 'full-name-header',    rx: /^([A-Za-z][A-Za-z'\-\.]{2,},\s+[A-Za-z][A-Za-z'\-\.]{2,}\s+[A-Za-z][A-Za-z'\-\.]{2,})(?=\s*(?:MRN|DOB|Legal|\d))/mg },
    { name: 'dob',                 rx: /(?:DOB|D\.O\.B\.|DATE\s*OF\s*BIRTH|BIRTH\s*(?:DATE|DT)|BIRTHDATE|Birth\s*Date|Date\s*of\s*Birth)\s*[:\|]\s*([\d]{1,2}[\/\-][\d]{1,2}[\/\-][\d]{2,4})/gi },
    { name: 'dob',                 rx: /\bBirthdate\s*[:\|]?\s*-?([\d]{1,2}[\/\-][\d]{1,2}[\/\-][\d]{2,4})/gi },
    { name: 'ssn',                 rx: /(\d{3}-\d{2}-\d{4})/g },
    { name: 'ssn',                 rx: /(?:SSN|S\.S\.N\.|SOCIAL\s*SECURITY)\s*[:\|]?\s*(\d{9})/gi },
    { name: 'mrn',                 rx: /(?:MRN#?|MR\s*#|MED(?:ICAL)?\s*REC(?:ORD)?\s*(?:NO\.?|#)?|CHART\s*#|MRN\s*[:\|]|PRN\s*[:\|]?|Patient\s*Record\s*(?:No\.?|#)|Record\s*(?:No\.?|#))\s*[:\|]?\s*([A-Z0-9\-]+)/gi },
    { name: 'drivers-license',     rx: /(?:DL\s*(?:NO\.?|#|NUMBER)|LICENSE\s*(?:NO\.?|#|NUMBER)|DRIVERS?\s+LIC(?:ENSE)?\s*(?:NO\.?|#)?|4[dD]\s*DL\s*NO\.?)\s*[:\|]?\s*([A-Z0-9]+)/gi },
    { name: 'drivers-license-dd',  rx: /\b(?:5\s*DD|DD)\s+([0-9A-Z]{10,})/gi },
    { name: 'encounter-id',        rx: /(?:MARKET\s*URN|VISIT\s*(?:NO\.?|#|ID)|ENCOUNTER\s*(?:NO\.?|#|ID)|URN\s*[:\|])\s*[:\|]?\s*([A-Z0-9\-]+)/gi },
    { name: 'account-no',          rx: /(?:ACCOUNT\s*(?:NO\.?|NUMBER|#)|ACCT\s*(?:NO\.?|#)|Acct\s*#|ACCOUNT#)\s*[:\|]?\s*([A-Z0-9\-]+)/gi },
    { name: 'unit-no',             rx: /(?:UNIT\s*(?:NO\.?|NUMBER|#)|Unit\s*(?:No\.?|#)|Unit\s*#|UNIT#)\s*[:\|]?\s*([A-Z0-9\-]+)/gi },
    { name: 'episode-id',          rx: /(?:Episode\s*ID|FIN#?)\s*[:\|]\s*([A-Z0-9\-]+)/gi },
    { name: 'insurance-id',        rx: /(?:Plan\s*#|Plan\s*No\.?|GROUP\s*#|Group\s*No\.?|MEMBER\s*(?:ID|#)|Member\s*ID|POLICY\s*(?:NO\.?|#)|CLM#?|Claim\s*#|Member\s*ID#?)\s*[:\|]?\s*([A-Z0-9\-]*\d[A-Z0-9\-]*)/gi },
    { name: 'phone',               rx: /(?:PHONE#?|CELL|MOBILE|TEL(?:EPHONE)?|Home\s*Phone|Work\s*Phone|Patient\s*[Pp]hone|Patient\s*PH|Phone\s*Number|Phone\s*#|PH\s*#?|Fax)\s*[:\|]?\s*([\d\(\)\-\.\s]{10,})/gi },
    { name: 'phone',               rx: /\((\d{3})\)\s*(\d{3}[-\s]\d{4})/g },
    { name: 'phone',               rx: /\b(\d{3}-\d{3}-\d{4})\b/g },
    { name: 'address',             rx: /\b(?:HOME\s*)?ADDRESS\s*[:|]\s*(.+)/gi },
    { name: 'address',             rx: /\bStreet\s*[:|]\s*(.+)/gi },
    { name: 'address-city',        rx: /\bCity\s*[:|]\s*([A-Za-z][A-Za-z\s]+)/gi },
    { name: 'address-zip',         rx: /\bState\s*[\/\\]?\s*Zip\s*[:|]\s*(.+)/gi },
    { name: 'spouse-name',         rx: /(?:Spouse|SPOUSE)\s*[:\|]\s*(.+)/gi },
    { name: 'next-of-kin',         rx: /(?:Next\s*of\s*Kin|NOK)\s*[:\|]\s*(.+)/gi },
    { name: 'patient-name',        rx: /(?:First\s*Name|Last\s*Name)\s*[:\|]\s*([A-Za-z][A-Za-z\-,'\. ]{1,30})(?![\s\|]*(?:MI|Middle|Last|First|Birth|Claim|Sex))/gi },
    { name: 'guardian-name',       rx: /(?:Guardian\s*Name|GUARDIAN)\s*[:\|]?\s*([A-Za-z][A-Za-z\-,'\. ]+)/gi },
    { name: 'emergency-contact',   rx: /(?:Emergency\s*Contact|EMERGENCY\s*CONTACT)\s*[:\|]?\s*([A-Za-z][A-Za-z\-,'\. ]+)/gi },
    { name: 'poa-name',            rx: /(?:POA|Power\s*of\s*Attorney)\s*[:\|]\s*(.+)/gi },
    { name: 'guarantor-name',      rx: /(?:Responsible\s*Party|Guarantor)\s*[:\|]\s*(.+)/gi },
    { name: 'patient-name-footer', rx: /PATIENT\s*NAME\s*[:\|]\s*([A-Z][A-Z\-,'\. ]+?)(?:\s+#[:\|]?\s*([A-Z0-9\-]+))?\s*$/mgi },
    { name: 'patient-name-footer', rx: /PATIENT\s*NAME\s*[:\|]\s*([A-Z][A-Z\-,'\. ]{3,})/mgi },
    { name: 'family-member-name',  rx: /(?:spouse|husband|wife|son|daughter|child|parent|mother|father|brother|sister|sibling|next\s*of\s*kin|medical\s*poa|power\s*of\s*attorney)\s*\(([A-Za-z][A-Za-z\-,'\. \s]{2,40})\)/gi },
    { name: 'email',               rx: /(?:EMAIL|E-MAIL)\s*[:\|]\s*([\w\.\+\-]+@[\w\-]+\.[\w\.]+)/gi },
  ];

  namedPatterns.forEach(function(def) {
    def.rx.lastIndex = 0;
    var match;
    while ((match = def.rx.exec(extractedText)) !== null) {
      var groups = [];
      for (var g = 1; g < match.length; g++) { if (match[g]) groups.push(match[g].trim()); }
      if (groups.length === 2 && /^\d{3}$/.test(groups[0]) && /^\d{3}[-\s]\d{4}$/.test(groups[1])) {
        groups = ['(' + groups[0] + ') ' + groups[1]];
      }
      groups.forEach(function(val) {
        if (!val || val.length < 2) return;
        // Skip bare geographic fragment words (OCR-split city names like "Las", "North", "San")
        if (/^(Las|Los|San|Santa|Saint|North|South|East|West|New|Fort|Mount|Port|Lake|Bay|Rio|Del|Van|El|La|Le)$/i.test(val.trim())) return;
        var norm = val.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (!seen.has(norm)) {
          seen.add(norm);
          tagged.push({ value: val, rule: def.name });
          // Also tag expanded tokens (split on hyphen, comma)
          if (val.indexOf('-') !== -1) {
            val.split('-').forEach(function(p) {
              var t = p.trim(); if (t.length >= 3) { var tn = t.toLowerCase().replace(/[^a-z0-9]/g,''); if (!seen.has(tn)) { seen.add(tn); tagged.push({ value: t, rule: def.name + '-token' }); } }
            });
          }
          if (val.indexOf(',') !== -1) {
            val.split(',').forEach(function(p) {
              var t = p.trim().split(' ')[0]; if (t.length >= 3) { var tn = t.toLowerCase().replace(/[^a-z0-9]/g,''); if (!seen.has(tn)) { seen.add(tn); tagged.push({ value: t, rule: def.name + '-token' }); } }
            });
          }
        }
      });
    }
  });
  return tagged;
}


// ── STEP 1B: Discover patient address from document structure ─────────────────
// Scans extractedText for address patterns appearing:
//   (a) adjacent to a patient name label, OR
//   (b) following an address-type label (Home Address:, Address:, etc.)
// Once discovered, individual components (street, zip) are returned so they
// can be added to knownPiiValues before the main redaction pass runs.
// Facility addresses are excluded via the facilityKeyword guard.
//
// Returns an array of string tokens to add to piiValues.
function discoverPatientAddress(extractedText) {
  if (!extractedText || typeof extractedText !== 'string') return [];

  var discovered = new Set();
  var lines = extractedText.split(/\r?\n/);

  // Patterns that identify an address line
  // Street: starts with 1-5 digits followed by at least one word
  var STREET_RE  = /^(\d{1,5})\s+([A-Z][A-Z0-9\s\.]{2,40}(?:AVE?|ST(?:REET)?|BLVD|BOULEVARD|DR(?:IVE)?|RD|ROAD|WAY|LN|LANE|CT|COURT|PL(?:ACE)?|CIR(?:CLE)?|PKWY|PARKWAY|HWY|HWD)?)\b/i;
  // City/State/Zip: word(s), optional comma, 2-letter state, 5-digit zip
  var CSZ_RE     = /^([A-Z][A-Z\s\.]{1,25}),?\s+([A-Z]{2})\s+(\d{5})(-\d{4})?/i;
  // Zip alone (5 digits — will only add if discovered in address context)
  var ZIP_RE     = /\b(\d{5})\b/;

  // Labels that introduce a patient address block (NOT a facility address)
  var ADDR_LABEL_RE = /^(?:HOME\s*)?(?:ADDRESS|ADDR)\s*[:\|]|^PATIENT\s*ADDRESS\s*[:\|]|^MAILING\s*ADDRESS|^GUARANTOR\s*NAME\s*AND\s*ADDRESS|^GUAR(?:ANTOR)?\s*[:\|]|^INFO\s+/i;

  // Patient name labels — address discovered near these gets captured
  var NAME_LABEL_RE = /^(?:PATIENT|PATIENT\s*NAME|PT\.?\s*NAME|NAME|CLAIMANT|CLIENT)\s*[:\|]/i;

  // Facility keyword guard — if a street appears after one of these, skip it
  var FACILITY_RE = /hospital|medical\s*cent|med\s*ctr|clinic|health\s*system|surgery\s*cent|orthopedic|physical\s*therapy|imaging|radiology|university|college|institute|umc\s*rad|umc\s*radiology|testing\s*performed|lab.*abbreviation|valid\s*date/i;
  // Known facility street names that should never be treated as patient address
  var FACILITY_STREET_RE = /polaris|charleston\s*blvd|flamingo|desert\s*inn|mariah\s*drive|mount\s*mariah|eastern\s*ave|harrison\s*ave|pinto\s*lane|hope\s*place|third\s*st|s\.\s*third|las\s*vegas\s*blvd|wigwam\s*pkwy|washington\s*ave|w\.?\s*washington/i;

  // Suite/floor indicator — facility addresses have these, patient ones usually don't
  var SUITE_RE = /\b(?:STE|SUITE|FLOOR|FL\.|#)\s*\d/i;

  function isFacilityLine(line) {
    return FACILITY_RE.test(line) || FACILITY_STREET_RE.test(line);
  }

  // Pass 1: Find address blocks following known patient/address labels
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line) continue;

    var isAddrLabel = ADDR_LABEL_RE.test(line);
    var isNameLabel = NAME_LABEL_RE.test(line);

    if (isAddrLabel || isNameLabel) {
      // Check if a facility keyword precedes this block (within 3 lines above)
      var facilityAbove = false;
      for (var back = Math.max(0, i - 3); back < i; back++) {
        if (isFacilityLine(lines[back])) { facilityAbove = true; break; }
      }
      if (facilityAbove) continue;

      // Scan forward up to 4 lines for address pattern
      for (var j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        var candidate = lines[j].trim();
        if (!candidate) continue;

        // Skip if this line is itself a facility address
        if (isFacilityLine(candidate)) break;
        // Skip if it has a suite/floor indicator (facility)
        if (SUITE_RE.test(candidate)) break;  // facility address (has suite/floor) — stop scanning

        // Check for street address line
        var streetMatch = candidate.match(STREET_RE);
        if (streetMatch) {
          var streetNum  = streetMatch[1];
          var streetName = streetMatch[2].trim();
          if (FACILITY_STREET_RE.test(candidate)) break;
          // Build street suffix variants as full phrases (number + name + suffix).
          // The street NUMBER is NOT added standalone — bare numbers like "2424"
          // are too ambiguous (appear in dates, codes, measurements).
          // It is only meaningful as part of a complete address phrase.
          var SFXS = ['AVE', 'AVENUE', 'ST', 'STREET', 'BLVD', 'BOULEVARD', 'DR', 'DRIVE', 'RD', 'ROAD', 'LN', 'LANE', 'CT', 'COURT', 'WAY', 'PL', 'PLACE', 'CIR', 'CIRCLE', 'PKWY', 'PARKWAY', 'HWY', 'HIGHWAY', 'LOOP', 'TER', 'TERRACE', 'TRL', 'TRAIL'];
          var streetWords = streetName.replace(/\b(?:AVE?|ST(?:REET)?|BLVD|BOULEVARD|DR(?:IVE)?|RD|ROAD|WAY|LN|LANE|CT|COURT|PL(?:ACE)?|CIR(?:CLE)?|PKWY|PARKWAY|HWY|LOOP|TER(?:RACE)?|TRL|TRAIL)\b/gi, '').replace(/\s+/g, ' ').trim();
          // Look ahead for city/state/zip on the next line
          var cityStr = '';
          var zipStr = '';
          if (j + 1 < lines.length) {
            var nextLine = lines[j + 1].trim();
            var cszMatch = nextLine.match(CSZ_RE);
            if (cszMatch) {
              zipStr = cszMatch[3];
              cityStr = cszMatch[1].replace(/,/g, '').trim();
              discovered.add(zipStr);
              // Add zip alone — it's specific enough (5 digits, patient-specific)
              // Add city+zip as a phrase (e.g. "NORTH LAS VEGAS NV 89030")
              if (cityStr.length >= 3) discovered.add(cityStr + ' ' + cszMatch[2] + ' ' + zipStr);
            } else {
              var zipMatch = candidate.match(ZIP_RE);
              if (zipMatch) { zipStr = zipMatch[1]; discovered.add(zipStr); }
            }
          }
          // Add street phrases WITH suffix variants
          if (streetWords.length >= 2) {
            SFXS.forEach(function(sfx) {
              discovered.add(streetNum + ' ' + streetWords + ' ' + sfx);
              // Also add with city appended if we found one — ties street to city
              if (cityStr.length >= 3) {
                discovered.add(streetNum + ' ' + streetWords + ' ' + sfx + ' ' + cityStr);
              }
            });
            discovered.add(streetNum + ' ' + streetWords); // fallback: no suffix
            if (cityStr.length >= 3) {
              // Full address phrase: number + street words + city (no suffix)
              discovered.add(streetNum + ' ' + streetWords + ' ' + cityStr);
            }
          }
          break; // Found address for this label block — move on
        }

        // Check for city/state/zip line directly (no street number above)
        var cszMatch2 = candidate.match(CSZ_RE);
        if (cszMatch2) {
          discovered.add(cszMatch2[3]); // zip
        }
      }
    }
  }

  // Pass 2: Look for standalone guarantor address blocks in billing docs
  // Pattern: line = city/state/zip immediately following a name-looking line
  // that is NOT preceded by a facility keyword
  for (var ii = 1; ii < lines.length; ii++) {
    var l = lines[ii].trim();
    var cszM = l.match(CSZ_RE);
    if (!cszM) continue;
    // Check the line above — should look like a street address
    var prevL = lines[ii - 1] ? lines[ii - 1].trim() : '';
    var streetM = prevL.match(STREET_RE);
    if (!streetM) continue;
    // Facility guard — check the street line itself AND 4 lines above
    // The street line itself may contain "Ste 100" (facility suite) — check it directly
    if (isFacilityLine(prevL) || SUITE_RE.test(prevL)) continue;
    var isFacility = false;
    for (var bk = Math.max(0, ii - 5); bk < ii - 1; bk++) {
      if (isFacilityLine(lines[bk]) || SUITE_RE.test(lines[bk])) { isFacility = true; break; }
    }
    if (isFacility) continue;

    // Looks like a patient address block in a billing statement
    var sNum = streetM[1];
    var sName = streetM[2].trim();
    var zip2 = cszM[3];
    if (parseInt(sNum, 10) > 99) discovered.add(sNum);
    if (zip2) discovered.add(zip2);
    // Pass 2: no suffix explosion — just add the exact matched address phrase.
    // Suffix variants are only generated in Pass 1 where a patient label confirms context.
    // Generating 30 variants from an unlabeled street/city block risks capturing
    // facility addresses (e.g. "5850 Polaris Ste 100") that slipped through the guard.
    var sWords = sName.replace(/\b(?:AVE?|ST(?:REET)?|BLVD|BOULEVARD|DR(?:IVE)?|RD|ROAD|WAY|LN|LANE|CT|COURT|PL(?:ACE)?|CIR(?:CLE)?|PKWY|PARKWAY|HWY)\b/gi, '').trim();
    if (sWords.length >= 2) {
      discovered.add(sNum + ' ' + sWords); // exact phrase only, no suffix variants
    }
  }

  var COMMON_WORDS = new Set(['free','fall','feel','main','park','hill','lake','pine','rose','oak','view','high','long','open','good','best','full','just','also','only','both','even','well','help','find','call','send','back','next','last','same','none','page','date','time','form','type','code','unit','room','note','info','plan','test','exam','name','addr','city','state','with','from','have','they','your','more','some','over','after','about']);
  var result = Array.from(discovered).filter(function(v) {
    if (!v || v.trim().length < 3) return false;
    // Skip pure common English words
    if (COMMON_WORDS.has(v.trim().toLowerCase())) return false;
    return true;
  });
  if (result.length > 0) {
    console.log('[ADDR-DISCOVER] Discovered patient address tokens:', JSON.stringify(result));
  }
  return result;
}

// ── Discover facility/provider phone numbers to EXCLUDE from redaction ────────
// Scans extracted text for phone numbers that appear near facility/provider
// keywords. These are public numbers (departments, clinics, providers) and
// should NOT be redacted.
function discoverFacilityPhones(extractedText) {
  if (!extractedText || typeof extractedText !== 'string') return new Set();
  var excluded = new Set();
  var lines = extractedText.split(/\r?\n/);

  var PHONE_RE = /\b(\d{3}-\d{3}-\d{4})\b|\((\d{3})\)\s*(\d{3}[-\s]\d{4})/g;

  // Keywords that strongly indicate a facility/provider context
  var FACILITY_CTX_RE = /hospital|medical\s*cent|clinic|health\s*cent|health\s*system|university|college|department|dept\.?|trauma|resuscitation|radiology|imaging|physical\s*therapy|primary\s*care|urgent\s*care|emergency\s*dept|umc|unlv|volunteers?\s*in\s*medicine|obstetrical|guadalupe|first\s*med|nevada\s*health|m\.?d\.?|d\.?o\.?|r\.?n\.?|hotline|resource|national|suicide|trafficking|protective|substance\s*abuse|mental\s*health|follow.?up\s*with|testing\s*performed|location|blvd|hope\s*place|charleston|pinto\s*lane|mount\s*mariah|eastern\s*ave|harrison\s*ave|www\.|umcsn|umconline/i;

  // Patient-context keywords — phone near these IS the patient's number
  var PATIENT_CTX_RE = /patient\s*phone|home\s*phone|mobile|cell(?:\s*phone)?|patient.*address|demographics|date\s*of\s*birth|legal\s*sex|email\s*:|kmpoindexter/i;

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    PHONE_RE.lastIndex = 0;
    var m;
    while ((m = PHONE_RE.exec(line)) !== null) {
      var rawPhone = m[1] || (m[2] + m[3]);
      var norm = rawPhone.replace(/[^\d]/g, '');
      if (norm.length !== 10) continue;
      // Check context: current line + 3 lines above + 1 below
      var ctx = lines.slice(Math.max(0, i - 3), i + 2).join(' ');
      var isFacility = FACILITY_CTX_RE.test(ctx);
      var isPatient  = PATIENT_CTX_RE.test(ctx);
      if (isFacility && !isPatient) {
        excluded.add(norm.slice(0,3) + '-' + norm.slice(3,6) + '-' + norm.slice(6));
        excluded.add('(' + norm.slice(0,3) + ') ' + norm.slice(3,6) + '-' + norm.slice(6));
        excluded.add('(' + norm.slice(0,3) + ') ' + norm.slice(3,6) + ' ' + norm.slice(6));
        excluded.add(norm);
      }
    }
  }
  if (excluded.size > 0) {
    console.log('[PHONE-EXCLUDE] Facility phones excluded:', JSON.stringify(Array.from(excluded)));
  }
  return excluded;
}


// ── STEP 2A: Textract-coordinate-based redaction ──────────────────────────────
// Returns piiByPage map using exact Textract bounding boxes — no LLM needed

function normalizeForMatch(str) {
  return (str || '').toLowerCase().replace(/[\s\-,\.\(\)]/g, '');
}

function findBoxesFromBlocks(wordBlocks, piiValues, piiSourceMap) {
  // piiSourceMap: { normalizedValue -> source } — used to stamp audit label on each box
  // Build a map of page -> list of word blocks
  // Fix #793: strip Epic EHR attribution/superscript markers before any processing.
  // Textract reads these markers in many forms due to Unicode superscript rendering:
  //   Standard:  [JS.1T], [JS.2T], [WC.1M], [JS.3M]
  //   Unicode:   [WC.¹ᵀ], [Jˢ.2T], pain⁽⁽ᶜ.¹ᵀ⁾, acute[JS.⁴M]
  //   Truncated: 12/20/1961[JS.2  (bracket opened, not closed)
  // Strategy: strip all superscript/modifier Unicode chars + bracket-delimited markers,
  // then drop any token that becomes empty.
  function _stripEpicMarkers(t) {
    if (!t) return '';
    // 1. Remove bracket-delimited markers (closed or unclosed): [JS.1T], [WC.¹ᵀ], [JS.2
    t = t.replace(/\[(?:[A-Za-z\u02B0-\u02FF\u1D00-\u1DBF\u2070-\u209F]{1,4})[^\]]{0,20}\]?/g, '');
    // 2. Remove superscript parenthesis groups: ⁽⁽ᶜ.¹ᵀ⁾  ⁽JS.1T⁾
    t = t.replace(/[\u207D\u207E\u208D\u208E][\s\S]{0,20}?[\u207D\u207E\u208D\u208E]?/g, '');
    // 3. Remove remaining superscript/modifier letter Unicode chars
    // Ranges: superscript digits ¹²³ (U+00B9,U+00B2,U+00B3), superscript parens,
    // modifier letters (U+02B0-U+02FF), Latin modifier letters (U+1D00-U+1DBF)
    // Keep ²³ — valid in medical units (kg/m²). They only appear in markers via brackets (caught in step 1).
    t = t.replace(/[\u00B9\u02B0-\u02FF\u1D00-\u1DBF\u2070-\u209F]/g, '');
    return t.trim();
  }

  wordBlocks = wordBlocks.map(function(b) {
    return { t: _stripEpicMarkers(b.t), p: b.p, l: b.l, tp: b.tp, w: b.w, h: b.h, hw: b.hw };
  }).filter(function(b) { return b.t.length > 0; });

  var pageMap = {};
  for (var i = 0; i < wordBlocks.length; i++) {
    var b = wordBlocks[i];
    var pg = b.p || 1;
    if (!pageMap[pg]) pageMap[pg] = [];
    pageMap[pg].push(b);
  }

  var result = {}; // page (0-indexed) -> array of boxes

  // ── HANDWRITING PASS: redact ALL handwritten tokens unconditionally ─────────
  var HW_LINE_GAP  = 0.015;
  var HW_VERT_TOL  = 0.008;   // tightened: prevent adjacent form rows merging into one box
  var HW_MIN_CHARS = 2;
  var HW_MAX_HEIGHT = 0.045;  // max height per group: ~3 lines. Prevents form-field blocks from merging.

  var pageNums2 = Object.keys(pageMap);
  for (var pni = 0; pni < pageNums2.length; pni++) {
    var pgNum    = pageNums2[pni];
    var pgBlocks = pageMap[pgNum];

    var hwBlocks = pgBlocks.filter(function(b) {
      if (!b.hw) return false;
      var txt = (b.t || '').trim();
      if (txt.length < HW_MIN_CHARS) return false;
      if (/^\d{1,4}$/.test(txt)) return false; // skip short pure-digit tokens (vitals, page#, etc) but keep longer ones (dates, phones)
      if (/^[^A-Za-z0-9]+$/.test(txt)) return false; // punctuation-only tokens
      return true;
    });

    if (!hwBlocks.length) continue;

    hwBlocks.sort(function(a, b) {
      var dy = a.tp - b.tp;
      if (Math.abs(dy) > HW_VERT_TOL) return dy;
      return a.l - b.l;
    });

    var hwLines = [];
    var currentLine = [hwBlocks[0]];
    for (var hi = 1; hi < hwBlocks.length; hi++) {
      var prev = currentLine[currentLine.length - 1];
      var cur  = hwBlocks[hi];
      if (Math.abs(cur.tp - prev.tp) <= HW_VERT_TOL) {
        currentLine.push(cur);
      } else {
        hwLines.push(currentLine);
        currentLine = [cur];
      }
    }
    hwLines.push(currentLine);

    for (var li = 0; li < hwLines.length; li++) {
      var lineTokens = hwLines[li];
      if (!lineTokens.length) continue;
      var groups = [];
      var curGroup = [lineTokens[0]];
      for (var ti = 1; ti < lineTokens.length; ti++) {
        var prevTok = curGroup[curGroup.length - 1];
        var curTok  = lineTokens[ti];
        var gap = curTok.l - (prevTok.l + prevTok.w);
        if (gap <= HW_LINE_GAP) {
          curGroup.push(curTok);
        } else {
          groups.push(curGroup);
          curGroup = [curTok];
        }
      }
      groups.push(curGroup);

      for (var gi = 0; gi < groups.length; gi++) {
        var grp = groups[gi];
        if (!grp.length) continue;
        var minL = grp[0].l, minT = grp[0].tp;
        var maxR = grp[0].l + grp[0].w, maxB = grp[0].tp + grp[0].h;
        for (var gbi = 1; gbi < grp.length; gbi++) {
          if (grp[gbi].l < minL) minL = grp[gbi].l;
          if (grp[gbi].tp < minT) minT = grp[gbi].tp;
          if (grp[gbi].l + grp[gbi].w > maxR) maxR = grp[gbi].l + grp[gbi].w;
          if (grp[gbi].tp + grp[gbi].h > maxB) maxB = grp[gbi].tp + grp[gbi].h;
        }
        var pgIdx2 = parseInt(pgNum, 10) - 1;
        if (!result[pgIdx2]) result[pgIdx2] = [];
        var pad = 0.005;
        // Width: extend to right margin — cursive signatures extend beyond detected strokes.
        // Use the actual Textract stroke height (maxB - minT) so the box height matches
        // the real ink height, not an inflated estimate.
        var hwRight  = Math.max(maxR, Math.min(0.88, minL + 0.60));
        var hwHeight = maxB - minT; // exact Textract stroke height
        // Cap height: never let a handwriting group exceed HW_MAX_HEIGHT.
        // This prevents multi-row form fields from merging into one giant black box.
        var hwHeightCapped = Math.min(hwHeight, HW_MAX_HEIGHT);
        result[pgIdx2].push({
          x:      Math.max(0, minL - pad),
          y:      Math.max(0, minT - pad),
          width:  Math.min(1, hwRight - minL + pad),
          height: Math.min(1, hwHeightCapped + pad * 2),
          label:  'handwriting',
        });
      }
    }
  }
  // ── END HANDWRITING PASS ───────────────────────────────────────────────────

  // ── ID DOCUMENT PHOTO PASS ────────────────────────────────────────────────
  // Detect Driver's License / State ID pages and redact face photos
  var _pgNums3 = Object.keys(pageMap);
  for (var _idp = 0; _idp < _pgNums3.length; _idp++) {
    var _idPgNum  = parseInt(_pgNums3[_idp], 10);
    var _idWords  = pageMap[_idPgNum];
    var _idPgIdx  = _idPgNum - 1;
    var _idPageText = _idWords.map(function(w) { return w.t; }).join(' ').toUpperCase();
    var _isDlPage = /DRIVER'?S?\s*LICEN[CS]E|STATE\s*ID|IDENTIFICATION\s*CARD/.test(_idPageText);
    if (!_isDlPage) continue;

    // Card bounding box from all tokens on this page
    var _cardMinL = Math.min.apply(null, _idWords.map(function(w) { return w.l; }));
    var _cardMinT = Math.min.apply(null, _idWords.map(function(w) { return w.tp; }));
    var _cardMaxR = Math.max.apply(null, _idWords.map(function(w) { return w.l + w.w; }));
    var _cardMaxB = Math.max.apply(null, _idWords.map(function(w) { return w.tp + w.h; }));
    var _cardW    = _cardMaxR - _cardMinL;
    var _cardH    = _cardMaxB - _cardMinT;
    if (!result[String(_idPgIdx)]) result[String(_idPgIdx)] = [];

    // Primary face photo — left ~36% x top ~58% of card
    result[String(_idPgIdx)].push({
      label: 'dl-photo-primary',
      x: Math.max(0, _cardMinL - 0.005),
      y: Math.max(0, _cardMinT - 0.005),
      width: Math.min(1, _cardW * 0.27),   // narrowed: photo is left ~27% of card
      height: Math.min(1, _cardH * 0.55),  // slightly reduced height
    });
    // Thumbnail — lower-right ~17% x 20% of card
    result[String(_idPgIdx)].push({
      label: 'dl-photo-thumbnail',
      x: Math.max(0, _cardMaxR - _cardW * 0.19),
      y: Math.max(0, _cardMaxB - _cardH * 0.24),
      width: Math.min(1, _cardW * 0.18),
      height: Math.min(1, _cardH * 0.23),
    });
    console.log('[ID-PHOTO] p' + _idPgNum + ' — redacting face photo and thumbnail');

    // ── DL FIELD EXTRACTION: pull first/middle name from DL field lines ────────
    var _dlSorted = _idWords.slice().sort(function(a, b) {
      if (Math.abs(a.tp - b.tp) > 0.010) return a.tp - b.tp;
      return a.l - b.l;
    });
    var _dlLines = []; var _dlCurLine = [];
    for (var _dfi = 0; _dfi < _dlSorted.length; _dfi++) {
      var _dfw = _dlSorted[_dfi];
      if (_dlCurLine.length === 0 || Math.abs(_dfw.tp - _dlCurLine[0].tp) <= 0.010) {
        _dlCurLine.push(_dfw);
      } else { _dlLines.push(_dlCurLine); _dlCurLine = [_dfw]; }
    }
    if (_dlCurLine.length) _dlLines.push(_dlCurLine);

    for (var _dfl = 0; _dfl < _dlLines.length; _dfl++) {
      var _dlLine = _dlLines[_dfl];
      if (_dlLine.length < 2) continue;
      var _dlFirst = (_dlLine[0].t || '').trim();
      // NV DL: field "1" = middle name, field "2" = first name
      if (_dlFirst === '1' || _dlFirst === '2') {
        for (var _dfn = 1; _dfn < _dlLine.length; _dfn++) {
          var _nameW = _dlLine[_dfn];
          var _nameTok = (_nameW.t || '').trim();
          if (/^[A-Z][A-Za-z'\-\.]{2,25}$/.test(_nameTok) && !/^(CLASS|REST|END|NONE|ISS|EXP|SEX|HGT|WGT|EYES|HAIR|DD|DL|DOB)$/.test(_nameTok)) {
            if (piiValues.indexOf(_nameTok) === -1) piiValues.push(_nameTok);
            if (piiValues.indexOf(_nameTok.toUpperCase()) === -1) piiValues.push(_nameTok.toUpperCase());
            if (!result[String(_idPgIdx)]) result[String(_idPgIdx)] = [];
            result[String(_idPgIdx)].push({ label: 'dl-field-name', x: Math.max(0, _nameW.l - 0.003), y: _nameW.tp, width: Math.min(1, _nameW.w + 0.006), height: _nameW.h * 1.1 });
            console.log('[DL-FIELD] field=' + _dlFirst + ' name=' + _nameTok);
          }
        }
      }
      // Field "8" = address
      if (_dlFirst === '8' && _dlLine.length > 1) {
        var _addrTokens = _dlLine.slice(1);
        var _addrL = Math.min.apply(null, _addrTokens.map(function(w){ return w.l; }));
        var _addrR = Math.max.apply(null, _addrTokens.map(function(w){ return w.l + w.w; }));
        var _addrB = Math.max.apply(null, _addrTokens.map(function(w){ return w.tp + w.h; }));
        if (!result[String(_idPgIdx)]) result[String(_idPgIdx)] = [];
        result[String(_idPgIdx)].push({ label: 'dl-field-addr', x: Math.max(0, _addrL-0.003), y: _dlLine[1].tp, width: Math.min(1, _addrR-_addrL+0.006), height: _addrB-_dlLine[1].tp });
      }
    }
    // ── End DL field extraction ─────────────────────────────────────────────────
  }
  // ── END ID DOCUMENT PHOTO PASS ────────────────────────────────────────────

  for (var pi = 0; pi < piiValues.length; pi++) {
    var pii = piiValues[pi];
    var piiNorm = normalizeForMatch(pii);
    // Skip pure digit strings < 4 digits (ROM values, vitals, ages)
    if (/^\d{1,3}$/.test(piiNorm)) continue;
    // Skip CPT (4-5 digit), HCPCS (letter+4 digits), ICD-10 codes
    if (/^\d{4,5}$/.test(piiNorm)) continue;
    if (/^[a-z]\d{4}$/.test(piiNorm)) continue;
    if (/^[a-z]\d{2}\.?\d{0,3}[a-z]?$/.test(piiNorm)) continue;
    // Skip common English words that should never be redacted
    // These can end up in piiValues if extraction patterns grab sentence fragments
    var _piiWord = piiNorm.toLowerCase();
    if (/^(page|pages|date|time|form|type|code|unit|room|note|visit|total|amount|paid|status|level|none|same|info|record|report|order|plan|initial|final|signature|signed|print|copy|draft|section|part|item|number|detail|summary|description|comment|follow|continued|information|balance|right|left|hand|wrist|pain|none|test|exam|normal|within|limits|chest|fever|chills|family|negative|positive|shortness|breath|constipation|diarrhea|dizziness|discharge|person|family|history|preferences|treatment|options|discussed)$/.test(_piiWord)) continue;
    // Also skip common English words that appear in street names and general text
    if (/^(free|fall|feel|free|main|park|hill|lake|pine|rose|oak|elm|view|high|long|old|new|far|near|open|good|best|full|plus|just|also|only|both|even|well|help|find|call|send|back|next|last|first|second|third|must|will|that|this|with|from|have|been|they|what|when|your|their|more|most|some|other|over|under|after|before|above|below|between|through|about|should|could|would)$/.test(_piiWord)) continue;
    // Skip values that look like billing/procedure codes rather than PII:
    // 5-digit codes starting with 000-009 (bill codes like 00100, 00663)
    // ICD-10 patterns already filtered in extraction but catch stragglers here
    if (/^00\d{3}$/.test(piiNorm)) continue; // billing denial codes
    if (/^[3-9]\d[0-9]{3}$/.test(piiNorm) && parseInt(piiNorm,10) >= 36000 && parseInt(piiNorm,10) <= 99999) {
      // 5-digit numbers in CPT range (10000-99999) — only skip if they don't
      // look like a zip code (zips are in specific state ranges, not 36xxx-96xxx CPT range)
      // BUT we can't reliably distinguish, so only skip if the PII value itself
      // was derived from a code context — skip numbers > 9999 starting 36-96 if
      // they appear isolated (not part of address phrase)
      // Conservative: only skip pure 5-digit values that start with 36,72,80,81,82,85,86,96
      if (/^(36|72|80|81|82|85|86|96)\d{3}$/.test(piiNorm)) continue;
    }

    // Try to match pii value against concatenated word sequences on each page
    var pageNums = Object.keys(pageMap);
    for (var pg2i = 0; pg2i < pageNums.length; pg2i++) {
      var pageNum = parseInt(pageNums[pg2i], 10);
      var pageWords = pageMap[pageNum];
      var pageIdx = pageNum - 1; // convert to 0-based

      // Sliding window: try 1 to 8 consecutive words — exact match, no minimum char length
      for (var start = 0; start < pageWords.length; start++) {
        for (var len = 1; len <= 8 && start + len <= pageWords.length; len++) {
          var slice = pageWords.slice(start, start + len);
          // Strip Epic EHR superscript annotations like [JS.1T], [WC.2M], [JS.2T] from token text
          // before matching — these are embedded in Textract output and break PII matches.
          var rawConcat = slice.map(function(w) {
            var _t = (w.t || '');
            // Strip bracket-enclosed Epic markers: [JS.1T], [WC.2M], etc.
            _t = _t.replace(/\[[A-Za-z]{1,3}\.\d[A-Za-z]?\]/g, '');
            // Strip fused Epic suffixes Textract merges directly onto tokens:
            // e.g. "0001506950US.2TI" → "0001506950", "Moore[Js.2T]" already handled above
            _t = _t.replace(/[A-Z]{1,3}\.[0-9][A-Za-z]{0,2}I?$/g, '').trim();
            return _t;
          }).join(''); var concat = normalizeForMatch(rawConcat);
          if (piiNorm.length > 0 && concat === piiNorm) {
            // Compute bounding box that covers all words in slice
            var minL = Math.min.apply(null, slice.map(function(w) { return w.l; }));
            var minT = Math.min.apply(null, slice.map(function(w) { return w.tp; }));
            var maxR = Math.max.apply(null, slice.map(function(w) { return w.l + w.w; }));
            var maxB = Math.max.apply(null, slice.map(function(w) { return w.tp + w.h; }));
            if (!result[String(pageIdx)]) result[String(pageIdx)] = [];
            result[String(pageIdx)].push({
              label: 'textract|' + (piiSourceMap && piiSourceMap[piiNorm] ? piiSourceMap[piiNorm] : 'extracted') + '|' + pii.substring(0, 40),
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


  // ── GATED LINE-LEVEL ADDRESS PASS ────────────────────────────────────────────
  // Reconstruct LINE groups from WORD block geometry, then apply three gates:
  //   1. Line must structurally look like an address (street num, city/state/zip)
  //   2. Line must NOT look like clinical narrative (no lowercase prose)
  //   3. Line must NOT be a facility address (no suite/hospital keywords)
  // Only when all gates pass do we redact the entire line as an address.

  function reconstructLineGroups(words) {
    var sorted = words.slice().sort(function(a, b) {
      if (a.p !== b.p) return a.p - b.p;
      if (Math.abs(a.tp - b.tp) > 0.008) return a.tp - b.tp;
      return a.l - b.l;
    });
    var groups = [];
    for (var _ri = 0; _ri < sorted.length; _ri++) {
      var _rw = sorted[_ri];
      var placed = false;
      for (var _rg = groups.length - 1; _rg >= 0; _rg--) {
        var _lg2 = groups[_rg];
        if (_lg2.page === _rw.p && Math.abs(_lg2.top - _rw.tp) <= 0.008) {
          _lg2.words.push(_rw);
          placed = true;
          break;
        }
      }
      if (!placed) groups.push({ page: _rw.p, top: _rw.tp, words: [_rw] });
    }
    return groups;
  }

  function addrLineIsAddressLike(txt) {
    var t = txt.trim();
    // Street number check: must be followed by a real street-name word
    // (not a pure number, not a CPT/revenue/procedure code like J1885 or 36415)
    // Require the word after the number to be ≥3 alpha chars (street name word)
    if (/^\d{2,5}\s+[A-Za-z]{3,}/.test(t)) {
      // Reject if line contains dollar amounts or billing indicators
      if (/\$|\d+\.\d{2}\s*$|\bBilled\b|\bCharged\b|\bAllowed\b/i.test(t)) return false;
      // Reject if the line looks like a procedure/revenue code description
      // (starts with number then a CPT/HCPCS-like code or "Billed as:")
      if (/^\d+\s+\d{5}/.test(t)) return false; // two numbers = billing line
      if (/^\d{4,5}\s+[A-Z]{1,2}\d{4,5}/.test(t)) return false; // revenue + CPT
      return true;
    }
    // City/State/Zip pattern
    if (/[A-Z][A-Z\s]{1,20},?\s+[A-Z]{2}\s+\d{5}/i.test(t)) return true;
    // Zip+4 anywhere (must not start with 00 — billing codes start with 00)
    if (/\b([1-9]\d{4})-\d{4}\b/.test(t)) return true;
    return false;
  }

  function addrLineIsClinical(txt) {
    var t = txt.trim();
    // Fax header lines contain timestamps and phone numbers — not addresses
    if (/^\d{2}\/\d{2}\/\d{2}\s+\d{2}:\d{2}/.test(t)) return true;
    if (/[a-z]{4,}/.test(t)) return true;
    if (/^(the|patient|pt\.|he |she |this |there |upon |with |no |history|hpi|assessment|plan|diagnosis)/i.test(t)) return true;
    if (/\d+\s*(mg|ml|mm|cm|lbs?|kg|bpm|mmhg|mcg)/i.test(t)) return true;
    if (t.length > 90) return true;
    if (/\b(and|the|with|for|was|has|had|are|were|not|from|that|will|have|been|pain|left|right|hand|wrist|fracture|therapy|treatment|injury|motion|strength|follow|continue|improve)\b/i.test(t)) return true;
    // CPT/billing code lines: 5-digit code + description with slash or clinical keyword
    // e.g. "99214 OFFICE/OUTPATIENT VISIT EST" — 5-digit number here is a CPT code, NOT a street number
    if (/^\d{4,5}\s+[A-Z].*\//.test(t)) return true;
    if (/^\d{4,5}\s+(?:OFFICE|OUTPATIENT|INPATIENT|VISIT|ESTABLISHED|NEW\s+PATIENT)/i.test(t)) return true;
    // ICD-10 code table lines: "M25.522  Pain in left elbow"
    if (/^[A-Z]\d{2}\.\d/.test(t)) return true;
    // Billing line indicators
    if (/\$|00\.00|\bPAID\b|\bBALANCE\b|\bCHARGE\b/i.test(t)) return true;
    return false;
  }

  function addrLineIsFacility(txt) {
    // Suite/floor indicators are facility giveaways
    if (/\b(ste\.?|suite|floor|fl\.|suite\s*\d)/i.test(txt)) return true;
    // Facility type keywords
    if (/hospital|medical\s*cent|med\s*ctr|clinic|health\s*system|surgery\s*cent|orthopedic|physical\s*therapy|imaging|radiology|university|institute|pkwy|parkway/i.test(txt)) return true;
    // Known facility street patterns: Washington Ave, Wigwam Pkwy, Amazing View St
    // that appear in office letterheads — guard by checking well-known zip codes
    // that belong to facilities (not the patient zip 89084)
    if (/89128|89074|89129|89103|89117|89135|90074|90004|52733/i.test(txt)) return true;
    // PO Box is always a billing/facility address
    if (/^P\.?O\.?\s*BOX/i.test(txt)) return true;
    return false;
  }

  var _allWords2 = [];
  var _pgKeys2 = Object.keys(pageMap);
  for (var _aw = 0; _aw < _pgKeys2.length; _aw++) {
    _allWords2 = _allWords2.concat(pageMap[parseInt(_pgKeys2[_aw], 10)]);
  }
  var _lineGroups2 = reconstructLineGroups(_allWords2);

  for (var _lgi2 = 0; _lgi2 < _lineGroups2.length; _lgi2++) {
    var _lg3      = _lineGroups2[_lgi2];
    var _lineTxt  = _lg3.words.map(function(w) { return w.t; }).join(' ');
    var _pgIdx4   = _lg3.page - 1;

    if (!addrLineIsAddressLike(_lineTxt)) continue;
    if (addrLineIsClinical(_lineTxt))    continue;
    if (addrLineIsFacility(_lineTxt))    continue;

    // Require at least one PII address token match on the line.
    // We do NOT fire on bare street numbers alone — that caused CPT codes (e.g. 99214)
    // to be matched simply because they are 5-digit numbers starting a line.
    // The correct rule: only redact a line if it actually contains a known patient
    // address token (street number, street name, city, zip) from the user's PII data.
    // This is semantically correct and eliminates false positives entirely.
    var _lineNorm2 = normalizeForMatch(_lineTxt);
    var _hasPii2   = false;
    for (var _pi4 = 0; _pi4 < piiValues.length; _pi4++) {
      var _pn2 = normalizeForMatch(piiValues[_pi4]);
      // Require whole-word match for short tokens (≤5 chars) to avoid "2424" matching inside "99214"
      // For longer tokens (street names, city names) substring match is fine
      if (_pn2.length < 4) continue; // skip very short tokens that cause false substring hits
      if (_pn2.length >= 4 && _lineNorm2.indexOf(_pn2) !== -1) { _hasPii2 = true; break; }
    }
    if (!_hasPii2) continue;

    var _lMinL = Math.min.apply(null, _lg3.words.map(function(w) { return w.l; }));
    var _lMinT = Math.min.apply(null, _lg3.words.map(function(w) { return w.tp; }));
    var _lMaxR = Math.max.apply(null, _lg3.words.map(function(w) { return w.l + w.w; }));
    var _lMaxB = Math.max.apply(null, _lg3.words.map(function(w) { return w.tp + w.h; }));

    if (!result[String(_pgIdx4)]) result[String(_pgIdx4)] = [];
    result[String(_pgIdx4)].push({
      label: 'addr-line:' + _lineTxt.substring(0, 40),
      x: Math.max(0, _lMinL - 0.005),
      y: _lMinT,
      width: Math.min(1, (_lMaxR - _lMinL) + 0.01),
      height: (_lMaxB - _lMinT),
    });
    console.log('[LINE-PASS] Redacting address line p' + _lg3.page + ': "' + _lineTxt.substring(0, 60) + '"');
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
    // NOTE: firstname/lastname/middleinitial/birthdate/dateofbirth removed — captured by dedicated passes
    'firstnamemi', 'firstnamemilastname',
    'homeaddress', 'homeaddressnumberandstreet',
    'employeesname', 'employeename',
    'claimantsname', 'claimantname',
    'socialsecuritynumber', 'socialsecurityno',
    // 'dateofinjury', 'dateofaccident' REMOVED — date fields, not signature boxes.
    // On OT eval / Concentra forms these labels appear in clinical narrative context
    // and produce huge false-positive geometry boxes covering entire page sections.
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
          // Fix: "Patient Signature Page" is a document title, not a form label.
          // If the token immediately after the match normalizes to "page", skip it.
          var nextToken = pageWords2[sw + sl];
          if (nextToken && nextToken.t.toLowerCase().replace(/[\s\-,\.\(\)\/]/g, '') === 'page') {
            break; // title, not a label — skip entire start word
          }

          // Get the vertical position of this label
          var labelTop = Math.min.apply(null, sigSlice.map(function(w) { return w.tp; }));
          var labelLeft = Math.min.apply(null, sigSlice.map(function(w) { return w.l; }));

          // DEBUG: log all blocks on this page near the label so we can see HW detection
          var _nearLabel = pageWords2.filter(function(w) {
            return Math.abs(w.tp - labelTop) < 0.20; // blocks within 20% page height of label
          });
          console.log('[SIG-DEBUG] Found sig label "' + sigConcat + '" on page ' + pageNum2 +
            ' labelTop=' + labelTop.toFixed(4) + ' labelLeft=' + labelLeft.toFixed(4));
          console.log('[SIG-DEBUG] Blocks near label (+/-0.20):');
          _nearLabel.forEach(function(w) {
            console.log('  hw=' + (w.hw ? '1' : '0') + ' tp=' + w.tp.toFixed(4) +
              ' bt=' + (w.tp + w.h).toFixed(4) + ' l=' + w.l.toFixed(4) +
              ' w=' + w.w.toFixed(4) + ' txt="' + (w.t || '').substring(0, 30) + '"');
          });

          // Redact the area above the label: from ~1.5x label height above it,
          // spanning from near-left to ~0.65 page width
          var labelH = Math.max.apply(null, sigSlice.map(function(w) { return w.h; }));
          // Address field labels sit ABOVE the handwritten content — redact below the label.
          // Signature/name field labels sit BELOW the content — redact above the label.
          var isAddressField = (sigConcat === 'homeaddress' || sigConcat === 'homeaddressnumberandstreet');
          var labelBottom = Math.max.apply(null, sigSlice.map(function(w) { return w.tp + w.h; }));

          // Skip sig labels in the top 10% of page — those are document headers, not form fields
          if (labelTop < 0.10) continue; // skip header zone
          if (!result[String(pageIdx2)]) result[String(pageIdx2)] = [];
          if (isAddressField) {
            // Box goes BELOW the label: from bottom of label down 0.15 page
            result[String(pageIdx2)].push({
              label: 'sig:' + sigConcat.substring(0, 30),
              x: Math.max(0, labelLeft - 0.01),
              y: labelBottom,
              width: Math.min(0.6, 0.92 - labelLeft + 0.01),
              height: 0.15,
            });
          } else {
            // Dynamic sig box: find handwriting blocks near this label.
            // Signatures can sit ABOVE (C-4 style) or ON/BESIDE the label (discharge form style).
            // Search within ±0.08 page height of the label.
            var hwNear = pageWords2.filter(function(w) {
              return w.hw && w.tp >= labelTop - 0.08 && w.tp <= labelTop + 0.10;
            });
            var dynamicBoxTop, dynamicBoxBottom;
            if (hwNear.length > 0) {
              // HW blocks found near the label.
              // Extend upward by 0.08 to catch signature strokes that Textract may have
              // missed above the label (common on scanned discharge forms where patient
              // signs ABOVE the printed line and Textract only picks up the date).
              dynamicBoxTop = Math.max(0, labelTop - 0.08);
              // Use bottommost HW block as box bottom (with small downward padding)
              dynamicBoxBottom = Math.max.apply(null, hwNear.map(function(w) { return w.tp + w.h; }));
              dynamicBoxBottom = Math.min(1.0, dynamicBoxBottom + 0.008);
            } else {
              // No HW block detected — extend 0.08 above and 0.02 below label
              dynamicBoxTop = Math.max(0, labelTop - 0.08);
              dynamicBoxBottom = Math.min(1.0, labelBottom + 0.02);
            }
            result[String(pageIdx2)].push({
              label: 'sig:' + sigConcat.substring(0, 30),
              x: Math.max(0, labelLeft - 0.01),
              y: dynamicBoxTop,
              width: Math.min(1, 0.92 - labelLeft + 0.01),
              height: dynamicBoxBottom - dynamicBoxTop,
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
    var trimmed = (txt || '').trim();
    var n = normalizeForMatch(trimmed);
    // Exact match (token ends with ':')
    for (var _pi = 0; _pi < PATIENT_LABEL_NORM.length; _pi++) {
      if (n === PATIENT_LABEL_NORM[_pi]) return true;
    }
    // Fused match: token starts with a known label prefix but has PII after the colon
    // e.g. "Patient:MOORE," normalizes to "patientmoore," which starts with "patient:"
    for (var _pi2 = 0; _pi2 < PATIENT_LABEL_NORM.length; _pi2++) {
      var lbl = PATIENT_LABEL_NORM[_pi2];
      if (lbl.charAt(lbl.length - 1) === ':' && n.indexOf(lbl) === 0 && n.length > lbl.length) {
        return true;
      }
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

      // If the label token itself is fused (e.g. "Patient:MOORE,"), redact the whole token box
      var _labelNorm = normalizeForMatch(_w.t);
      var _fusedPii = false;
      for (var _fpi = 0; _fpi < PATIENT_LABEL_NORM.length; _fpi++) {
        var _lbl = PATIENT_LABEL_NORM[_fpi];
        if (_lbl.charAt(_lbl.length - 1) === ':' && _labelNorm.indexOf(_lbl) === 0 && _labelNorm.length > _lbl.length) {
          _fusedPii = true;
          break;
        }
      }
      if (_fusedPii) {
        var _fpk = String(_pageIdx);
        if (!result[_fpk]) result[_fpk] = [];
        result[_fpk].push({
          label:  'patient_name_fused_label',
          x:      Math.max(0, _w.l - 0.003),
          y:      _w.tp,
          width:  _w.w + 0.006,
          height: (_w.h || 0.012) * 1.4,
        });
      }

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

  // ── PHONE NUMBER PASS (all pages, print text) ────────────────────────────────
  // Redact any token sequence that forms a phone number pattern, regardless of
  // whether it matches a known PII value. Phones have no clinical significance.
  // Patterns: (NXX) NXX-XXXX | NXX-NXX-XXXX | NXX.NXX.XXXX | 10 consecutive digits
  var PHONE_RE = /^\(?\d{3}\)?[\s\-\.]\d{3}[\-\.]\d{4}$|^\d{10}$|^\d{3}[\-\.]\d{3}[\-\.]\d{4}$/;
  var _pgNumsPhone = Object.keys(pageMap);
  for (var _phi = 0; _phi < _pgNumsPhone.length; _phi++) {
    var _phPg    = parseInt(_pgNumsPhone[_phi], 10);
    var _phWords = pageMap[_phPg];
    var _phIdx   = _phPg - 1;

    // Sort words left-to-right, top-to-bottom
    var _phSorted = _phWords.slice().sort(function(a, b) {
      if (Math.abs(a.tp - b.tp) > 0.008) return a.tp - b.tp;
      return a.l - b.l;
    });

    for (var _phw = 0; _phw < _phSorted.length; _phw++) {
      var _w0 = _phSorted[_phw];
      // Test 1-token match (e.g. "7022779970" or "702-277-9970")
      var _t0 = (_w0.t || '').trim();
      if (PHONE_RE.test(_t0)) {
        if (!result[String(_phIdx)]) result[String(_phIdx)] = [];
        result[String(_phIdx)].push({ label: 'phone', x: Math.max(0, _w0.l - 0.003), y: _w0.tp, width: Math.min(1, _w0.w + 0.006), height: _w0.h });
        continue;
      }
      // Test 2-token match: "(702)" + "277-9970" or "702" + "277-9970"
      if (_phw + 1 < _phSorted.length) {
        var _w1 = _phSorted[_phw + 1];
        var _t01 = (_t0 + _w1.t).replace(/[\s\(\)]/g, '');
        if (/^\d{10}$/.test(_t01) || /^\d{3}[\-\.]\d{3}[\-\.]\d{4}$/.test(_t0 + ' ' + _w1.t)) {
          var _pMinL = Math.min(_w0.l, _w1.l);
          var _pMaxR = Math.max(_w0.l + _w0.w, _w1.l + _w1.w);
          if (!result[String(_phIdx)]) result[String(_phIdx)] = [];
          result[String(_phIdx)].push({ label: 'phone-2tok', x: Math.max(0, _pMinL - 0.003), y: _w0.tp, width: Math.min(1, _pMaxR - _pMinL + 0.006), height: Math.max(_w0.h, _w1.h) });
          continue;
        }
      }
      // Test 3-token match: "(702)" + "277" + "9970"  or "702" + "277" + "9970"
      if (_phw + 2 < _phSorted.length) {
        var _w2 = _phSorted[_phw + 2];
        var _t012 = (_t0 + _phSorted[_phw+1].t + _w2.t).replace(/[\s\(\)\-\.]/g, '');
        if (/^\d{10}$/.test(_t012)) {
          var _p3MinL = Math.min(_w0.l, _phSorted[_phw+1].l, _w2.l);
          var _p3MaxR = Math.max(_w0.l + _w0.w, _phSorted[_phw+1].l + _phSorted[_phw+1].w, _w2.l + _w2.w);
          if (!result[String(_phIdx)]) result[String(_phIdx)] = [];
          result[String(_phIdx)].push({ label: 'phone-3tok', x: Math.max(0, _p3MinL - 0.003), y: _w0.tp, width: Math.min(1, _p3MaxR - _p3MinL + 0.006), height: Math.max(_w0.h, _phSorted[_phw+1].h, _w2.h) });
        }
      }
    }
  }
  // ── End phone pass ──────────────────────────────────────────────────────────

  // ── DATE PASS — DOB-LABELED ONLY ──────────────────────────────────────────────
  // Only redact dates that appear on the same line as a DOB label token.
  // This preserves: Date of Service, filing dates, EHR timestamps, surgery dates.
  // Redacts: DOB field values wherever labeled with DOB / D.O.B. / DATE OF BIRTH etc.
  // Safe Harbor element #4 scoping: we scope to DOB only since DOS has clinical value.
  var DOB_LABEL_RE = /^(?:dob|d\.o\.b\.?|dateofbirth|birthdate|birthdt|dob:|birth)$/i;
  var DATE_VALUE_RE = /^(?:0?[1-9]|1[0-2])[\/\-](?:0?[1-9]|[12]\d|3[01])[\/\-](?:19|20)?\d{2}$/;

  var _pgNumsDob = Object.keys(pageMap);
  for (var _dobi = 0; _dobi < _pgNumsDob.length; _dobi++) {
    var _dobPg    = parseInt(_pgNumsDob[_dobi], 10);
    var _dobWords = pageMap[_dobPg];
    var _dobIdx   = _dobPg - 1;

    // Reconstruct lines, then check each line for DOB label + date value
    // Sort words into lines by vertical proximity
    var _dobSorted = _dobWords.slice().sort(function(a, b) {
      if (Math.abs(a.tp - b.tp) > 0.010) return a.tp - b.tp;
      return a.l - b.l;
    });
    var _dobLines = [];
    var _dobCurLine = [];
    for (var _dli = 0; _dli < _dobSorted.length; _dli++) {
      var _dw = _dobSorted[_dli];
      if (_dobCurLine.length === 0 || Math.abs(_dw.tp - _dobCurLine[0].tp) <= 0.010) {
        _dobCurLine.push(_dw);
      } else {
        _dobLines.push(_dobCurLine);
        _dobCurLine = [_dw];
      }
    }
    if (_dobCurLine.length) _dobLines.push(_dobCurLine);

    for (var _dli2 = 0; _dli2 < _dobLines.length; _dli2++) {
      var _dobLine = _dobLines[_dli2];
      var _lineText = _dobLine.map(function(w){ return normalizeForMatch(w.t); }).join(' ');

      // Check if this line contains a DOB label
      var _hasDobLabel = false;
      for (var _dlw = 0; _dlw < _dobLine.length; _dlw++) {
        var _tok = normalizeForMatch((_dobLine[_dlw].t || '').replace(/\[[A-Z]{1,3}\.\d[A-Z]?\]/g, ''));
        if (DOB_LABEL_RE.test(_tok) || _tok === 'dob' || _tok.startsWith('dob')) {
          _hasDobLabel = true; break;
        }
      }
      // Also catch inline format "DOB:12/20/1961" as single token
      var _inlineDobRe = /(?:dob|d\.o\.b\.?)[:\s]*((?:0?[1-9]|1[0-2])[\/\-](?:0?[1-9]|[12]\d|3[01])[\/\-](?:19|20)?\d{2})/i;
      var _inlineM = _lineText.replace(/\s/g,'').match(/dob:?(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i);

      if (!_hasDobLabel && !_inlineM) continue;

      // Redact all date-shaped tokens on this line
      for (var _dv = 0; _dv < _dobLine.length; _dv++) {
        var _dvTok = (_dobLine[_dv].t || '').replace(/\[[A-Z]{1,3}\.\d[A-Z]?\]/g, '').trim().replace(/[.,;:]+$/, '');
        if (DATE_VALUE_RE.test(_dvTok)) {
          if (!result[String(_dobIdx)]) result[String(_dobIdx)] = [];
          result[String(_dobIdx)].push({
            label: 'dob-date',
            x: Math.max(0, _dobLine[_dv].l - 0.004),
            y: _dobLine[_dv].tp,
            width: Math.min(1, _dobLine[_dv].w + 0.008),
            height: _dobLine[_dv].h * 1.15,
          });
        }
        // Also catch multi-token dates split across adjacent tokens on same line
        if (_dv + 2 < _dobLine.length) {
          var _s3 = _dobLine.slice(_dv, _dv + 5);
          var _s3c = _s3.map(function(w){ return (w.t || '').replace(/\[[A-Z]{1,3}\.\d[A-Z]?\]/g, ''); }).join('').replace(/[.,;:]+$/, '');
          if (DATE_VALUE_RE.test(_s3c)) {
            var _s3L = Math.min.apply(null, _s3.map(function(w){ return w.l; }));
            var _s3R = Math.max.apply(null, _s3.map(function(w){ return w.l + w.w; }));
            var _s3B = Math.max.apply(null, _s3.map(function(w){ return w.tp + w.h; }));
            if (!result[String(_dobIdx)]) result[String(_dobIdx)] = [];
            result[String(_dobIdx)].push({
              label: 'dob-date-multi',
              x: Math.max(0, _s3L - 0.004),
              y: _dobLine[_dv].tp,
              width: Math.min(1, _s3R - _s3L + 0.008),
              height: _s3B - _dobLine[_dv].tp,
            });
          }
        }
      }
    }
  }
  // ── End DOB date pass ────────────────────────────────────────────────────────

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


// ── STEP 2C: PDF text stream pass — catches rotated margin text Textract misses ─
// Parses raw PDF content streams to find text with rotation matrices (~90°/270°).
// No Textract, no Claude — pure PDF geometry.
function extractRotatedPdfText(pdfDoc, piiValues) {
  var result = {};
  if (!piiValues || !piiValues.length) return result;

  var piiNorm = piiValues.map(function(v) {
    return { orig: v, norm: (v || '').toLowerCase().replace(/[^a-z0-9]/g, '') };
  }).filter(function(p) { return p.norm.length >= 3; });

  var pages = pdfDoc.getPages();

  for (var pi = 0; pi < pages.length; pi++) {
    var page = pages[pi];
    var sz   = page.getSize();
    var rawW = sz.width;
    var rawH = sz.height;

    var streamBytes = '';
    try {
      var contentRef = page.node.get(page.node.doc.context.obj('Contents'));
      if (!contentRef) continue;
      var streams = [];
      var cname = contentRef.constructor ? contentRef.constructor.name : '';
      if (cname === 'PDFArray') {
        for (var si = 0; si < contentRef.size(); si++) {
          var ref = contentRef.get(si);
          var obj = page.node.doc.context.lookup(ref);
          var bytes = obj && obj.getContents ? obj.getContents() : (obj && obj.contents ? obj.contents : null);
          if (bytes) streams.push(Buffer.isBuffer(bytes) ? bytes.toString('latin1') : String.fromCharCode.apply(null, Array.from(bytes)));
        }
      } else {
        var obj2 = page.node.doc.context.lookup(contentRef);
        var bytes2 = obj2 && obj2.getContents ? obj2.getContents() : (obj2 && obj2.contents ? obj2.contents : null);
        if (bytes2) streams.push(Buffer.isBuffer(bytes2) ? bytes2.toString('latin1') : String.fromCharCode.apply(null, Array.from(bytes2)));
      }
      streamBytes = streams.join(' ');
    } catch(e) { continue; }
    if (!streamBytes) continue;

    var boxes = [];
    // Match Tm operator: a b c d e f Tm
    var tmRe = /([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+Tm/g;
    var tmMatches = [];
    var m;
    while ((m = tmRe.exec(streamBytes)) !== null) {
      var a = parseFloat(m[1]), b = parseFloat(m[2]);
      var c = parseFloat(m[3]), d = parseFloat(m[4]);
      var e = parseFloat(m[5]), f = parseFloat(m[6]);
      // Rotated ~90° or ~270°: off-diagonal components dominate
      var isRotated = (Math.abs(b) > 0.5 || Math.abs(c) > 0.5) &&
                      Math.abs(a) < 0.5 && Math.abs(d) < 0.5;
      tmMatches.push({ pos: m.index + m[0].length, a, b, c, d, e, f, isRotated });
    }
    if (!tmMatches.length) continue;

    for (var ti = 0; ti < tmMatches.length; ti++) {
      var tm = tmMatches[ti];
      if (!tm.isRotated) continue;
      var segEnd = ti + 1 < tmMatches.length ? tmMatches[ti + 1].pos : streamBytes.length;
      var seg    = streamBytes.slice(tm.pos, segEnd);

      // Extract text from Tj and TJ operators
      var texts = [];
      var tjRe  = /\(([^)]*)\)\s*Tj/g;
      var tjARe = /\[([^\]]*)\]\s*TJ/g;
      var mm;
      while ((mm = tjRe.exec(seg))  !== null) texts.push(mm[1]);
      while ((mm = tjARe.exec(seg)) !== null) {
        var strRe = /\(([^)]*)\)/g, sm;
        while ((sm = strRe.exec(mm[1])) !== null) texts.push(sm[1]);
      }
      if (!texts.length) continue;

      // Decode octal escapes (\nnn) in PDF strings
      var combined = texts.join('').replace(/\\([0-7]{3})/g, function(_, o) {
        return String.fromCharCode(parseInt(o, 8));
      }).replace(/\\\\/g, '\\').trim();
      if (!combined || combined.length < 2) continue;

      var normCombined = combined.toLowerCase().replace(/[^a-z0-9]/g, '');
      var matched = false;
      for (var pj = 0; pj < piiNorm.length; pj++) {
        var pv = piiNorm[pj];
        if (pv.norm.length < 3) continue;
        if (normCombined.indexOf(pv.norm) !== -1 || pv.norm.indexOf(normCombined) !== -1) {
          matched = true; break;
        }
      }
      if (!matched) continue;

      // Estimate font size from the matrix scale factor
      var fontSize = Math.sqrt(tm.b * tm.b + tm.d * tm.d);
      if (fontSize < 1) fontSize = 10;
      var charCount = Math.max(combined.length, 4);

      // For 90°-rotated text: e=x position, f=y position in raw PDF points
      // The text runs vertically — build a bounding box in normalized coords
      var boxW = fontSize * 1.8 / rawW;          // ~1-2 chars wide
      var boxH = (charCount * fontSize * 1.1) / rawH;  // full text height

      // Normalize: PDF origin is bottom-left, our system uses top-left
      var nx = tm.e / rawW;
      var ny = 1.0 - (tm.f / rawH);

      var bx = Math.max(0, nx - boxW * 0.3);
      var by = Math.max(0, ny - boxH);
      var bw = Math.min(1.0 - bx, boxW * 1.5);
      var bh = Math.min(1.0 - by, boxH * 1.2);

      boxes.push({ label: 'rotated_pdf_text', x: bx, y: by, width: bw, height: bh });
      console.log('[ROTATED-PDF] p=' + (pi+1) + ' t=' + JSON.stringify(combined) +
        ' e=' + tm.e.toFixed(1) + ' f=' + tm.f.toFixed(1) +
        ' box={x:' + bx.toFixed(3) + ',y:' + by.toFixed(3) + ',w:' + bw.toFixed(3) + ',h:' + bh.toFixed(3) + '}');
    }
    if (boxes.length) result[String(pi)] = (result[String(pi)] || []).concat(boxes);
  }
  return result;
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
      var bx = typeof box.x     === 'number' ? box.x     : (box.l  || 0);
      var by = typeof box.y     === 'number' ? box.y     : (box.tp || 0);
      var bw = typeof box.width === 'number' ? box.width : (box.w  || 0);
      var bh = typeof box.height=== 'number' ? box.height: (box.h  || 0);
      if (!bw || !bh || isNaN(bx) || isNaN(by) || isNaN(bw) || isNaN(bh)) continue;

      var px, py, pw, ph;

      if (rotation === 0) {
        // Standard: visual space == raw space, just flip Y for pdf-lib.
        // Handwriting boxes (label === 'handwriting') have Textract bounding boxes
        // that sit slightly below the visible ink stroke. Shift those boxes upward
        // by 1×bh so the box covers the actual signature. Print blocks are unchanged.
        pw = bw * rawW;
        if (box.label === 'handwriting') {
          var _yShift = bh * rawH;
          ph = (bh * rawH) + _yShift;
          px = bx * rawW;
          py = rawH - (by + bh) * rawH + _yShift;
        } else {
          ph = bh * rawH;
          px = bx * rawW;
          py = rawH - (by + bh) * rawH;
        }

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

  // ── Case redaction: POST /documents/redact-case/redact ────────────────────
  // Reuses the existing route pattern to avoid needing a new API GW resource.
  // Triggered when doc_id === 'redact-case' and body contains doc_ids array.
  if (doc_id === 'redact-case') {
    try {
      var caseBody = {};
      try { caseBody = JSON.parse(event.body || '{}'); } catch(e) {}
      var caseDocIds = caseBody.doc_ids;
      var caseOrigId = caseBody.original_document_id;
      console.log('[redact-case] doc_ids:', JSON.stringify(caseDocIds), 'orig:', caseOrigId);
      if (!caseDocIds || !Array.isArray(caseDocIds) || caseDocIds.length === 0) {
        return respond(400, { error: 'Missing doc_ids array' });
      }
      var caseDocRecords = [];
      for (var _cdi = 0; _cdi < caseDocIds.length; _cdi++) {
        var caseDocRes = await dynamo.send(new GetCommand({ TableName: DOCS_TABLE, Key: { aws_document_id: caseDocIds[_cdi] } }));
        if (!caseDocRes.Item) return respond(404, { error: 'Document not found: ' + caseDocIds[_cdi] });
        caseDocRecords.push(caseDocRes.Item);
      }
      caseDocRecords.sort(function(a, b) {
        var aM = (a.original_filename || '').match(/[Pp]art(\d+)/);
        var bM = (b.original_filename || '').match(/[Pp]art(\d+)/);
        return (aM ? parseInt(aM[1], 10) : 0) - (bM ? parseInt(bM[1], 10) : 0);
      });
      var caseJobId = randomUUID();
      var caseNow   = new Date().toISOString();
      var caseOrgId = caseDocRecords[0].org_id || null;
      console.log('[redact-case] creating job', caseJobId, 'for', caseDocRecords.length, 'docs, worker:', process.env.REDACT_CASE_WORKER_FUNCTION_NAME);
      await dynamo.send(new PutCommand({
        TableName: JOBS_TABLE,
        Item: {
          job_id: caseJobId, type: 'redact_case', status: 'processing',
          original_document_id: caseOrigId || null,
          org_id: caseOrgId, created_at: caseNow, updated_at: caseNow,
          progress_message: 'Starting case redaction for ' + caseDocRecords.length + ' part(s)...',
        },
      }));
      var caseUserPii = Array.isArray(caseBody.user_supplied_pii) ? caseBody.user_supplied_pii : [];
      await lambdaClient.send(new InvokeCommand({
        FunctionName:   process.env.REDACT_CASE_WORKER_FUNCTION_NAME,
        InvocationType: 'Event',
        Payload: Buffer.from(JSON.stringify({
          job_id:               caseJobId,
          doc_records:          caseDocRecords,
          original_document_id: caseOrigId || null,
          org_id:               caseOrgId,
          folder_name:          caseDocRecords[0].folder_name || null,
          patient_id:           caseDocRecords[0].patient_id  || null,
          user_supplied_pii:    caseUserPii,
        })),
      }));
      console.log('[redact-case] worker invoked, returning job_id', caseJobId);
      return respond(200, { job_id: caseJobId });
    } catch (caseErr) {
      console.error('[redact-case] ERROR:', caseErr.message, caseErr.stack);
      return respond(500, { error: 'Case redaction start failed: ' + caseErr.message });
    }
  }
  // ── END case redaction branch ─────────────────────────────────────────────

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

  // Accept optional user-supplied PII values from request body
  var singleBody = {};
  try { singleBody = JSON.parse(event.body || '{}'); } catch(e) {}
  var userSuppliedPii = Array.isArray(singleBody.user_supplied_pii) ? singleBody.user_supplied_pii : [];

  await lambdaClient.send(new InvokeCommand({
    FunctionName:   WORKER_FN,
    InvocationType: 'Event',
    Payload:        Buffer.from(JSON.stringify({ job_id, doc_id, doc, user_supplied_pii: userSuppliedPii })),
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
    const extractedTextRaw  = await fetchExtractedText(doc_id);
    // Strip Epic EHR superscript annotation markers (e.g. [JS.2T], [WC.1M]) from the
    // stored Textract text BEFORE PII extraction. These markers are embedded directly
    // in the Textract output text and break regex matches — e.g. "12/20/1961[JS.2T]"
    // never matches the DOB pattern, and "Moore, Kimberly Maria[JS.2T]" fails name capture.
    // Strip Epic EHR superscript markers AND collapse the gaps they leave.
    // Textract stores each superscript as a SEPARATE LINE block, so the raw text looks like:
    //   "DOB:\n[JS.1T]\n12/20/1961\n[JS.2T]"
    // After stripping markers: "DOB:\n\n12/20/1961\n"  ← label and value on different lines!
    // So we must also: (1) remove lines that became empty after stripping,
    // and (2) re-join a trailing colon line with the next content line.
    const extractedText = (function(raw) {
      if (!raw) return raw;
      // Step 1: strip all Epic annotation markers [JS.1T], [WC.2M], [JS.4M] etc.
      var stripped = raw.replace(/\[[A-Z]{1,4}\.[0-9][A-Z]?\]/g, '');
      // Step 2: remove lines that are now empty or whitespace-only
      var lines = stripped.split(/\r?\n/);
      var cleaned = [];
      for (var _li = 0; _li < lines.length; _li++) {
        var line = lines[_li].trimEnd();
        if (line.trim() === '') continue; // drop blank lines left by stripped superscripts
        cleaned.push(line);
      }
      // Step 3: re-join "LABEL:" lines that got separated from their values
      // e.g. ["DOB:", "12/20/1961"] → ["DOB: 12/20/1961"]
      var rejoined = [];
      for (var _ri = 0; _ri < cleaned.length; _ri++) {
        var cur = cleaned[_ri];
        if (/[:\|]\s*$/.test(cur) && _ri + 1 < cleaned.length) {
          // This line ends with a colon/pipe — join with next line
          rejoined.push(cur + ' ' + cleaned[_ri + 1]);
          _ri++; // skip next line since we consumed it
        } else {
          rejoined.push(cur);
        }
      }
      return rejoined.join('\n');
    })(extractedTextRaw);
    const knownPiiValuesBase = extractKnownPiiValues(extractedText);
    const discoveredAddrTokens = discoverPatientAddress(extractedText);
    const userSuppliedPii = Array.isArray(event.user_supplied_pii) ? event.user_supplied_pii : [];
    // Expand DOB variants from user-supplied values
    var userPiiExpanded = [];
    // Geographic/suffix words to skip when generating solo address tokens.
    // These are too common to be patient-identifying on their own.
    // ── ADDRESS TOKENIZER ─────────────────────────────────────────────────────
    // Parses: num | street (unique words + suffix) | city (words after suffix) | zip
    // Generates: (a) full phrase, (b) n-1 without zip, (c) solo unique tokens
    // State abbrev excluded. Generic words (Las, Vegas, North, Street) never solo.
    userSuppliedPii.forEach(function(v) {
      if (!v) return;
      if (/^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}$/.test(v.trim())) {
        expandDob(v.trim()).forEach(function(ev) { userPiiExpanded.push(ev); });
      } else {
        _tokenizeAddress(v).forEach(function(tok) {
          if (userPiiExpanded.indexOf(tok) === -1) userPiiExpanded.push(tok);
        });
      }
    });
    // ── 3-PART NAME PERMUTATIONS from extractKnownPiiValues ───────────────────
    // If extractKnownPiiValues found "LAST, FIRST MIDDLE", also add "FIRST MIDDLE LAST"
    var _3partExtras = [];
    knownPiiValuesBase.forEach(function(_kv) {
      if (!_kv) return;
      var _m3 = _kv.match(/^([A-Z][A-Z'\-\.]+),\s+([A-Z][A-Z'\-\.]+)\s+([A-Z][A-Z'\-\.]+)$/i);
      if (_m3) {
        var _fwd3 = _m3[2].trim() + ' ' + _m3[3].trim() + ' ' + _m3[1].trim(); // FIRST MID LAST
        var _fwd2 = _m3[2].trim() + ' ' + _m3[1].trim();                        // FIRST LAST
        var _mid2 = _m3[3].trim() + ' ' + _m3[1].trim();                        // MIDDLE LAST (e.g. "Maria Moore")
        var _rev2 = _m3[1].trim() + ', ' + _m3[2].trim();                       // LAST, FIRST (with comma)
        var _rev3 = _m3[1].trim() + ' ' + _m3[2].trim();                        // LAST FIRST (no comma) — catches Textract-fused "LAST,FIRST" tokens
        [_fwd3, _fwd2, _mid2, _rev2, _rev3].forEach(function(_v) {
          if (_3partExtras.indexOf(_v) === -1 && knownPiiValuesBase.indexOf(_v) === -1) {
            _3partExtras.push(_v);
          }
        });
      }
    });
    if (_3partExtras.length) console.log('[3-PART-NAME] extras:', JSON.stringify(_3partExtras));

    // ── FOLDER PII: fetch patientName + middleName, build 3-part phrases ──────
    var _folderPiiExtras = [];
    try {
      var _docRec = await dynamo.send(new GetCommand({ TableName: DOCS_TABLE, Key: { aws_document_id: doc_id } }));
      var _folderName = ((_docRec.Item && (_docRec.Item.folder || _docRec.Item.folder_name)) || '').trim();
      var _orgId = (_docRec.Item && _docRec.Item.org_id) || '';
      if (_folderName && _orgId) {
        var _piiRec = await dynamo.send(new GetCommand({
          TableName: 'chartreview-folder-pii-prod',
          Key: { org_folder: _orgId + '#' + _folderName }
        }));
        if (_piiRec.Item) {
          var _storedName = (_piiRec.Item.patientName || '').trim();
          var _storedMid  = (_piiRec.Item.middleName  || '').trim();
          if (_storedName && _folderPiiExtras.indexOf(_storedName) === -1) _folderPiiExtras.push(_storedName);
          // Reversed form
          var _nm1 = _storedName.match(/^([A-Z][A-Z'\-\.]+),\s*([A-Z][A-Z'\-\. ]+)$/i);
          if (_nm1) {
            var _fwd = _nm1[2].trim() + ' ' + _nm1[1].trim(); // FIRST LAST
            if (_folderPiiExtras.indexOf(_fwd) === -1) _folderPiiExtras.push(_fwd);
            // LAST FIRST (no comma) — matches Textract-fused "RODRIGUEZ,CLAUDIA" token after normalization
            var _revNoComma = _nm1[1].trim() + ' ' + _nm1[2].trim();
            if (_folderPiiExtras.indexOf(_revNoComma) === -1) _folderPiiExtras.push(_revNoComma);
          }
          var _nm2 = _storedName.match(/^([A-Z][A-Z'\-\.]+)\s+([A-Z][A-Z'\-\.]+)$/i);
          if (_nm2) {
            var _rev = _nm2[2].trim() + ', ' + _nm2[1].trim();
            if (_folderPiiExtras.indexOf(_rev) === -1) _folderPiiExtras.push(_rev);
          }
          // 3-part phrases using middleName — also add middle name as standalone if >= 4 chars
          // Needed for HPI body text where name tokens are split across markers
          if (_storedMid) {
            if (_folderPiiExtras.indexOf(_storedMid) === -1) {
              _folderPiiExtras.push(_storedMid);
            }
            if (_nm1) {
              var _fp1 = _nm1[2].trim() + ' ' + _storedMid + ' ' + _nm1[1].trim();
              var _fp2 = _nm1[1].trim() + ', ' + _nm1[2].trim() + ' ' + _storedMid;
              if (_folderPiiExtras.indexOf(_fp1) === -1) _folderPiiExtras.push(_fp1);
              if (_folderPiiExtras.indexOf(_fp2) === -1) _folderPiiExtras.push(_fp2);
            }
            if (_nm2) {
              var _fp3 = _nm2[1].trim() + ' ' + _storedMid + ' ' + _nm2[2].trim();
              if (_folderPiiExtras.indexOf(_fp3) === -1) _folderPiiExtras.push(_fp3);
            }
          }
          console.log('[FOLDER-PII] extras:', JSON.stringify(_folderPiiExtras));
        }
      }
    } catch (_fpErr) {
      console.log('[FOLDER-PII] skipped:', _fpErr.message);
    }
    // ── Supplement middle name from extractedText when store has none ────────
    // processWorker stored "MOORE, KIMBERLY" (no middle name captured).
    // Mine the middle name by scanning extracted text lines that contain both
    // the known last and first name — Epic repeats the full name on every page
    // header: e.g. "Moore, Kimberly Maria" or "Kimberly Maria Moore".
    try {
      if (!_storedMid && _storedName && extractedText) {
        var _knownLast  = '';
        var _knownFirst = '';
        if (_nm1) { _knownLast = _nm1[1].trim().toLowerCase(); _knownFirst = _nm1[2].trim().toLowerCase(); }
        else if (_nm2) { _knownFirst = _nm2[1].trim().toLowerCase(); _knownLast = _nm2[2].trim().toLowerCase(); }
        if (_knownLast && _knownFirst) {
          var _etLines = extractedText.split('\n');

          var _minedMid = null;
          for (var _eli = 0; _eli < _etLines.length && !_minedMid; _eli++) {
            var _el = _etLines[_eli];
            var _eln = _el.toLowerCase().replace(/[^a-z\s]/g, ' ');
            if (_eln.indexOf(_knownLast) === -1 || _eln.indexOf(_knownFirst) === -1) continue;
            // Line contains both last and first — tokenize and find the extra word
            var _eltoks = _eln.trim().split(/\s+/).filter(function(t) { return t.length >= 2; });
            // Find the index of the known first and last name tokens
            var _firstIdx = _eltoks.indexOf(_knownFirst);
            var _lastIdx  = _eltoks.indexOf(_knownLast);
            // Look for a candidate token BETWEEN first and last name (or immediately after first)
            // that is a pure alpha word >= 3 chars and not a known facility abbreviation
            var _stopWords = {and:1,the:1,for:1,with:1,date:1,visit:1,unit:1,room:1,page:1,
              legal:1,sex:1,adm:1,mrn:1,dob:1,csn:1,scan:1,on:1,of:1,in:1,at:1,by:1,to:1,
              umc:1,mro:1,ehr:1,emr:1,md:1,rn:1,np:1,pa:1,dr:1,ed:1,er:1,icu:1,or:1};
            if (_firstIdx >= 0 && _lastIdx >= 0) {
              var _lo = Math.min(_firstIdx, _lastIdx);
              var _hi = Math.max(_firstIdx, _lastIdx);
              // Token between first and last name
              for (var _ti = _lo + 1; _ti < _hi && !_minedMid; _ti++) {
                var _tc = _eltoks[_ti];
                if (_tc.length >= 3 && /^[a-z]+$/.test(_tc) && !_stopWords[_tc]) {
                  _minedMid = _tc.charAt(0).toUpperCase() + _tc.slice(1);
                }
              }
              // If nothing between, check the token immediately after first or last
              if (!_minedMid) {
                var _checkIdx = _hi + 1;
                if (_checkIdx < _eltoks.length) {
                  var _tc2 = _eltoks[_checkIdx];
                  if (_tc2.length >= 3 && /^[a-z]+$/.test(_tc2) && !_stopWords[_tc2]) {
                    _minedMid = _tc2.charAt(0).toUpperCase() + _tc2.slice(1);
                  }
                }
              }
            }
          }
          if (_minedMid) {
            console.log('[FOLDER-PII] mined middle name from text:', _minedMid);
            // Standalone middle name
            if (_folderPiiExtras.indexOf(_minedMid) === -1) _folderPiiExtras.push(_minedMid);
            // Middle initial
            var _minedInit = _minedMid[0].toUpperCase();
            if (_folderPiiExtras.indexOf(_minedInit) === -1) _folderPiiExtras.push(_minedInit);
            // 3-part phrases
            if (_nm1) {
              var _mp1 = _nm1[2].trim() + ' ' + _minedMid + ' ' + _nm1[1].trim();
              var _mp2 = _nm1[1].trim() + ', ' + _nm1[2].trim() + ' ' + _minedMid;
              if (_folderPiiExtras.indexOf(_mp1) === -1) _folderPiiExtras.push(_mp1);
              if (_folderPiiExtras.indexOf(_mp2) === -1) _folderPiiExtras.push(_mp2);
            }
            if (_nm2) {
              var _mp3 = _nm2[1].trim() + ' ' + _minedMid + ' ' + _nm2[2].trim();
              if (_folderPiiExtras.indexOf(_mp3) === -1) _folderPiiExtras.push(_mp3);
            }
          }
        }
      }
    } catch (_midMineErr) {
      console.log('[FOLDER-PII] mid-mine skipped:', _midMineErr.message);
    }
    // ── End folder PII ──────────────────────────────────────────────────────
    var _facilityPhones = discoverFacilityPhones(extractedText || '');
    var _filterFacPhone = function(v) { if (!v) return true; var n = String(v).replace(/[^\d]/g,''); return !(n.length === 10 && _facilityPhones.has(n.slice(0,3)+'-'+n.slice(3,6)+'-'+n.slice(6))); };
    const knownPiiValues = knownPiiValuesBase.filter(_filterFacPhone)
      .concat(discoveredAddrTokens.filter(function(v) { return knownPiiValuesBase.indexOf(v) === -1; }))
      .concat(userPiiExpanded.filter(function(v) { return v && v.trim().length >= 1; }))
      .concat(_folderPiiExtras.filter(function(v) { return v && knownPiiValuesBase.indexOf(v) === -1; }))
      .concat(_3partExtras.filter(function(v) { return v && knownPiiValuesBase.indexOf(v) === -1; }));
    // Build source map: normalizedValue -> specific rule name for CSV audit trail
    var piiSourceMap = {};
    var _taggedPii = extractKnownPiiValuesTagged(extractedText || '');
    _taggedPii.forEach(function(t) { if (t.value) piiSourceMap[normalizeForMatch(t.value)] = t.rule; });
    discoveredAddrTokens.forEach(function(v) { if (v && !piiSourceMap[normalizeForMatch(v)]) piiSourceMap[normalizeForMatch(v)] = 'addr-discovery'; });
    userPiiExpanded.forEach(function(v) { if (v && !piiSourceMap[normalizeForMatch(v)]) piiSourceMap[normalizeForMatch(v)] = 'user-supplied'; });
    _folderPiiExtras.forEach(function(v) { if (v && !piiSourceMap[normalizeForMatch(v)]) piiSourceMap[normalizeForMatch(v)] = 'folder-pii'; });
    _3partExtras.forEach(function(v) { if (v && !piiSourceMap[normalizeForMatch(v)]) piiSourceMap[normalizeForMatch(v)] = 'name-expansion'; });
    console.log('Known PII values (' + knownPiiValues.length + ') [' + discoveredAddrTokens.length + ' addr, ' + userSuppliedPii.length + ' user-supplied]:', JSON.stringify(knownPiiValues.slice(0, 200)));

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

    // Clinical / document boilerplate words that should NEVER be redacted
    // regardless of how they ended up in piiValues (e.g. false-positive extraction)
    var _clinicalBoilerplate = new Set([
      'medications', 'medication', 'allergies', 'allergy', 'surgeries', 'surgery',
      'reviewed', 'review', 'concentra', 'encounter', 'prescribed', 'dispensed',
      'treatment', 'diagnosis', 'patient', 'history', 'medical', 'clinical',
      'significant', 'tobacco', 'alcohol', 'assessment', 'physical', 'exam',
      'office', 'outpatient', 'inpatient', 'visit', 'established', 'est',
      'outpatientvisit', 'officeoutpatientvisit', 'officevisit',
    ]);
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
      // Clinical boilerplate words — never redact these regardless of source
      if (_clinicalBoilerplate.has(trimmed.toLowerCase())) return false;
      // CPT/E&M/procedure codes (4-5 pure digits like 99214, 99213, etc.)
      if (/^\d{4,5}$/.test(trimmed)) return false;
      return true;
    });

    // ── INLINE IDENTIFIER SCAN ────────────────────────────────────────────────
    // Scan word blocks directly for labeled patient identifiers (MRN, Encounter,
    // Account, Unit#) that appear in this specific document.
    // This catches identifiers from hospitals different from the one that provided
    // the facesheet PII — e.g. UMC facesheet MRN vs. Sunrise footer MRN.
    // Strategy: reconstruct per-page text from word tokens, then regex-extract.
    (function() {
      // Build a flat text string from all word blocks (concatenate tokens per page)
      var _pageTexts = {};
      for (var _bi = 0; _bi < wordBlocks.length; _bi++) {
        var _b = wordBlocks[_bi];
        var _pg = _b.p || 1;
        if (!_pageTexts[_pg]) _pageTexts[_pg] = [];
        _pageTexts[_pg].push(_b.t || '');
      }
      // Join each page's tokens with spaces, then join pages
      var _blockText = Object.values(_pageTexts).map(function(toks) {
        return toks.join(' ');
      }).join('\n');

      // Patterns to extract: labeled MRN, Encounter, Account, Unit# values
      // These appear as "MRN:D002916777" or "MRN: D002916777" (Textract may split label from value)
      // We match the fused form (label+value as one token) AND split form (two adjacent tokens)
      var _idPatterns = [
        /\bMRN[:\s#]*([A-Z0-9][A-Z0-9\-]{3,})/gi,
        /\bEncounter[:\s#]*([A-Z0-9][A-Z0-9\-]{5,})/gi,
        /\bAcct?(?:ount)?[:\s#]*([A-Z0-9][A-Z0-9\-]{4,})/gi,
        /\bUnit[:\s#]*([A-Z0-9][A-Z0-9\-]{4,})/gi,
        /\bFIN[:\s#]*([A-Z0-9][A-Z0-9\-]{4,})/gi,
        /\bCSN[:\s#]*([A-Z0-9][A-Z0-9\-]{4,})/gi,
      ];

      // Also handle split tokens: Textract may emit "MRN:D002916777" as a single WORD token
      // OR as "MRN:" + "D002916777" — handle both by also scanning raw tokens
      var _allTokens = wordBlocks.map(function(b) { return b.t || ''; });
      var _fusedText  = _allTokens.join(' ');
      var _scanTargets = [_blockText, _fusedText];

      var _found = [];
      _scanTargets.forEach(function(_txt) {
        _idPatterns.forEach(function(_pat) {
          var _pm;
          _pat.lastIndex = 0;
          while ((_pm = _pat.exec(_txt)) !== null) {
            var _val = _pm[1].trim();
            // Must be at least 5 chars and contain at least one digit
            if (_val.length >= 5 && /\d/.test(_val) && _found.indexOf(_val) === -1) {
              // Skip values already in filteredPiiValues
              if (filteredPiiValues.indexOf(_val) === -1) {
                _found.push(_val);
                if (!piiSourceMap[_val.toLowerCase().replace(/[^a-z0-9]/g,'')])
                  piiSourceMap[_val.toLowerCase().replace(/[^a-z0-9]/g,'')] = 'inline-id';
              }
            }
          }
        });
      });

      if (_found.length) {
        console.log('[INLINE-IDS] found inline patient identifiers:', JSON.stringify(_found));
        _found.forEach(function(v) { filteredPiiValues.push(v); });
      }
    })();
    allPii = findBoxesFromBlocks(wordBlocks, filteredPiiValues, piiSourceMap);
      var textractCount = Object.values(allPii).reduce(function(s, b) { return s + b.length; }, 0);
      console.log('[REDACT] Textract path found ' + textractCount + ' box(es) across ' + Object.keys(allPii).length + ' page(s)');
      // PDF text stream pass — catches rotated margin text Textract skips entirely
      try {
        var _pdfDocR = await PDFDocument.load(pdfBytes);
        var _rotPii  = extractRotatedPdfText(_pdfDocR, filteredPiiValues);
        var _rotCnt  = Object.values(_rotPii).reduce(function(s,b){return s+b.length;},0);
        if (_rotCnt > 0) {
          console.log('[ROTATED-PDF] ' + _rotCnt + ' box(es) from rotated margin text');
          allPii = mergePiiMaps(allPii, _rotPii);
        }
      } catch(_re) { console.warn('[ROTATED-PDF] pass failed (non-fatal):', _re.message); }

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

    // ── Generate + upload redaction log DOCX ──────────────────────────────────
    try {
      var _piiSummary = { patientName: knownPiiValues[0] || '', dob: '', mrn: '', folder: doc.folder_name || '' };
      // Try to pull DOB and MRN from extractedText
      var _dobM = (extractedText || '').match(/DOB[:\s]+([\d\/]+)/i);
      var _mrnM = (extractedText || '').match(/MRN[:\s]+([A-Z0-9]+)/i);
      if (_dobM) _piiSummary.dob = _dobM[1];
      if (_mrnM) _piiSummary.mrn = _mrnM[1];
      var _logBytes = buildRedactionLogCsv(origFilename, allPii, _piiSummary);
      var _logKey   = keyParts.concat([baseName + '_REDACTION_LOG.csv']).join('/');
      await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: _logKey, Body: _logBytes, ContentType: 'text/csv' }));
      var _logUrl   = await getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: _logKey }), { expiresIn: 604800 });
      console.log('[REDACTION-LOG] DOCX uploaded to', _logKey);
    } catch (_logErr) {
      console.warn('[REDACTION-LOG] Failed to generate log DOCX:', _logErr.message);
      var _logKey = null; var _logUrl = null;
    }
    // ── End redaction log ──────────────────────────────────────────────────────

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
        redaction_log_key: _logKey  || null,
        redaction_log_url: _logUrl  || null,
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
  var folder_name = (docRecords[0].folder || docRecords[0].folder_name || '').trim() || null;
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
  await lambdaClient.send(new InvokeCommand({
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
  var folder_name          = (event.folder_name || (Array.isArray(event.doc_records) && event.doc_records[0] && (event.doc_records[0].folder || event.doc_records[0].folder_name)) || '').trim() || null;
  var patient_id           = event.patient_id;

  console.log('[CASE-WORKER-INIT] job_id:', job_id, '| org_id:', org_id, '| folder_name:', folder_name, '| doc_records count:', Array.isArray(doc_records) ? doc_records.length : 'n/a', '| first doc.folder:', (Array.isArray(doc_records) && doc_records[0]) ? doc_records[0].folder : 'n/a', '| first doc.folder_name:', (Array.isArray(doc_records) && doc_records[0]) ? doc_records[0].folder_name : 'n/a');

  try {
    await updateJob(job_id, { progress_message: 'Redacting ' + doc_records.length + ' part(s) in parallel...', updated_at: new Date().toISOString() });

    var partResults = await Promise.all(doc_records.map(async function(doc) {
      var doc_id   = doc.aws_document_id;
      var fileKey  = doc.file_key || doc.s3_key;
      var pdfBytes = await getS3Bytes(fileKey);
      var extractedText  = await fetchExtractedText(doc_id);
      var knownPiiValuesBase = extractKnownPiiValues(extractedText);
      var discoveredAddrTokens = discoverPatientAddress(extractedText);
      var caseDocUserPii = Array.isArray(event.user_supplied_pii) ? event.user_supplied_pii : [];
      var caseUserPiiExpanded = [];
      caseDocUserPii.forEach(function(v) {
        if (!v) return;
        if (/^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}$/.test(v.trim())) {
          expandDob(v.trim()).forEach(function(ev) { caseUserPiiExpanded.push(ev); });
        } else {
          _tokenizeAddress(v).forEach(function(tok) {
            if (caseUserPiiExpanded.indexOf(tok) === -1) caseUserPiiExpanded.push(tok);
          });
        }
      });

      // ── DOC WORKER: fetch folder-level PII from DynamoDB ──────────────────
      var _docFolderExtras = [];
      try {
        var _docFolderName = (doc.folder || doc.folder_name || event.folder_name || '').trim() || null;
        var _docOrgId      = (doc.org_id || event.org_id || '').trim();
        console.log('[DOC-FOLDER-PII] folder_name:', _docFolderName, '| org_id:', _docOrgId);
        if (_docFolderName && _docOrgId) {
          var _docPiiRec = await dynamo.send(new GetCommand({
            TableName: 'chartreview-folder-pii-prod',
            Key: { org_folder: _docOrgId + '#' + _docFolderName }
          }));
          if (_docPiiRec.Item) {
            var _docStoredName = (_docPiiRec.Item.patientName || '').trim();
            var _docStoredMid  = (_docPiiRec.Item.middleName  || '').trim();
            var _docStoredMrn  = (_docPiiRec.Item.mrn || _docPiiRec.Item.MRN || '').trim().replace(/[,;]+$/, '');
            var _docStoredMrn2 = (_docPiiRec.Item.hospitalMrn || _docPiiRec.Item.mrn2 || '').trim().replace(/[,;]+$/, '');
            var _docStoredDob  = (_docPiiRec.Item.dob || '').trim().replace(/[,;]+$/, '');
            var _docStoredPhone = (_docPiiRec.Item.phone || '').trim();
            console.log('[DOC-FOLDER-PII] loaded:', _docStoredName, '| mid:', _docStoredMid || '(empty)', '| mrn:', _docStoredMrn || '(empty)', '| mrn2:', _docStoredMrn2 || '(empty)', '| dob:', _docStoredDob || '(empty)');
            if (_docStoredMrn)  { _docFolderExtras.push(_docStoredMrn); }
            if (_docStoredMrn2) { _docFolderExtras.push(_docStoredMrn2); }
            if (_docStoredDob) { expandDob(_docStoredDob).forEach(function(ev) { _docFolderExtras.push(ev); }); }
            if (_docStoredPhone) {
              var _dPhNum = _docStoredPhone.replace(/[^\d]/g, '');
              if (_dPhNum.length >= 7) {
                _docFolderExtras.push(_docStoredPhone);
                _docFolderExtras.push(_dPhNum);
                if (_dPhNum.length === 10) {
                  _docFolderExtras.push(_dPhNum.slice(0,3)+'-'+_dPhNum.slice(3,6)+'-'+_dPhNum.slice(6));
                  _docFolderExtras.push('('+_dPhNum.slice(0,3)+')-'+_dPhNum.slice(3,6)+'-'+_dPhNum.slice(6));
                  _docFolderExtras.push('('+_dPhNum.slice(0,3)+')'+_dPhNum.slice(3,6)+'-'+_dPhNum.slice(6));
                }
              }
            }
            if (_docStoredName) {
              _docFolderExtras.push(_docStoredName);
              var _dNm1 = _docStoredName.match(/^([A-Za-z][A-Za-z'\-]+),\s*([A-Za-z][A-Za-z'\-]+)$/);
              var _dNm2 = _docStoredName.match(/^([A-Za-z][A-Za-z'\-]+)\s+([A-Za-z][A-Za-z'\-]+)$/);
              if (_dNm1) { _docFolderExtras.push(_dNm1[1].trim()); _docFolderExtras.push(_dNm1[2].trim()); _docFolderExtras.push(_dNm1[2].trim()+' '+_dNm1[1].trim()); }
              if (_dNm2) { _docFolderExtras.push(_dNm2[1].trim()); _docFolderExtras.push(_dNm2[2].trim()); _docFolderExtras.push(_dNm2[2].trim()+' '+_dNm2[1].trim()); }
            }
            var _dMidToUse = _docStoredMid;
            if (!_dMidToUse && _docStoredName && extractedText) {
              var _dKnownLast  = _dNm1 ? _dNm1[1].trim().toLowerCase() : (_dNm2 ? _dNm2[2].trim().toLowerCase() : '');
              var _dKnownFirst = _dNm1 ? _dNm1[2].trim().toLowerCase() : (_dNm2 ? _dNm2[1].trim().toLowerCase() : '');
              if (_dKnownLast && _dKnownFirst) {
                var _dStopWords = {and:1,the:1,for:1,with:1,date:1,visit:1,unit:1,room:1,page:1,legal:1,sex:1,adm:1,mrn:1,dob:1,csn:1,scan:1,on:1,of:1,in:1,at:1,by:1,to:1,md:1,rn:1,np:1,pa:1,dr:1};
                var _dLines = extractedText.split('\n');
                for (var _dli = 0; _dli < _dLines.length && !_dMidToUse; _dli++) {
                  var _dln = _dLines[_dli].toLowerCase().replace(/[^a-z\s]/g, ' ');
                  if (_dln.indexOf(_dKnownLast) >= 0 && _dln.indexOf(_dKnownFirst) >= 0) {
                    var _dToks = _dln.trim().split(/\s+/).filter(function(t){ return t.length >= 3 && !_dStopWords[t]; });
                    for (var _dti = 0; _dti < _dToks.length; _dti++) {
                      if (_dToks[_dti] !== _dKnownLast && _dToks[_dti] !== _dKnownFirst && _dToks[_dti].length >= 3 && /^[a-z]+$/.test(_dToks[_dti])) {
                        _dMidToUse = _dToks[_dti].charAt(0).toUpperCase() + _dToks[_dti].slice(1);
                        console.log('[DOC-FOLDER-PII] mined middle name:', _dMidToUse);
                        break;
                      }
                    }
                  }
                }
              }
            }
            if (_dMidToUse) {
              _docFolderExtras.push(_dMidToUse);
              _docFolderExtras.push(_dMidToUse.charAt(0) + '.');
              if (_docStoredName) {
                var _dN1 = _docStoredName.match(/^([A-Za-z][A-Za-z'\-]+),\s*([A-Za-z][A-Za-z'\-]+)$/);
                var _dN2 = _docStoredName.match(/^([A-Za-z][A-Za-z'\-]+)\s+([A-Za-z][A-Za-z'\-]+)$/);
                if (_dN1) { _docFolderExtras.push(_dN1[2].trim()+' '+_dMidToUse+' '+_dN1[1].trim()); }
                if (_dN2) { _docFolderExtras.push(_dN2[1].trim()+' '+_dMidToUse+' '+_dN2[2].trim()); }
              }
            }
            console.log('[DOC-FOLDER-PII] extras count:', _docFolderExtras.length);
          } else {
            console.log('[DOC-FOLDER-PII] no record for key:', _docOrgId + '#' + _docFolderName);
          }
        }
      } catch(e) { console.log('[DOC-FOLDER-PII] error:', e.message); }

      var _caseFacPhones = discoverFacilityPhones(extractedText || '');
      var _caseFilterFac = function(v) { if (!v) return true; var n = String(v).replace(/[^\d]/g,''); return !(n.length === 10 && _caseFacPhones.has(n.slice(0,3)+'-'+n.slice(3,6)+'-'+n.slice(6))); };

      // ── CASE: fetch folder-level PII (name, middle name) from DynamoDB ─────
      var _caseFolderExtras = [];
      try {
        var _caseFolderName = (folder_name || (doc.folder || doc.folder_name) || '').trim();
        var _caseOrgId      = (org_id || '').trim();
        if (_caseFolderName && _caseOrgId) {
          var _casePiiRec = await dynamo.send(new GetCommand({
            TableName: 'chartreview-folder-pii-prod',
            Key: { org_folder: _caseOrgId + '#' + _caseFolderName }
          }));
          if (_casePiiRec.Item) {
            var _caseStoredName = (_casePiiRec.Item.patientName || '').trim();
            var _caseStoredMid  = (_casePiiRec.Item.middleName  || '').trim();
            var _caseStoredMrn  = (_casePiiRec.Item.mrn || _casePiiRec.Item.MRN || '').trim().replace(/[,;]+$/, '');
            var _caseStoredMrn2 = (_casePiiRec.Item.mrn2 || _casePiiRec.Item.hospitalMrn || '').trim().replace(/[,;]+$/, '');
            var _caseStoredDob  = (_casePiiRec.Item.dob || '').trim().replace(/[,;]+$/, '');
            var _caseStoredPhone = (_casePiiRec.Item.phone || '').trim();
            var _caseStoredSsn  = (_casePiiRec.Item.ssn || '').trim();
            console.log('[CASE-FOLDER-PII] loaded:', _caseStoredName, '| mid:', _caseStoredMid || '(empty)', '| mrn:', _caseStoredMrn || '(empty)', '| dob:', _caseStoredDob || '(empty)');
            if (_caseStoredMrn)  { _caseFolderExtras.push(_caseStoredMrn); }
            if (_caseStoredMrn2) { _caseFolderExtras.push(_caseStoredMrn2); }
            if (_caseStoredDob) {
              expandDob(_caseStoredDob).forEach(function(ev) { _caseFolderExtras.push(ev); });
            }
            if (_caseStoredPhone) {
              var _cPhNum = _caseStoredPhone.replace(/[^\d]/g, '');
              if (_cPhNum.length >= 7) {
                _caseFolderExtras.push(_caseStoredPhone);
                _caseFolderExtras.push(_cPhNum);
                if (_cPhNum.length === 10) {
                  _caseFolderExtras.push(_cPhNum.slice(0,3)+'-'+_cPhNum.slice(3,6)+'-'+_cPhNum.slice(6));
                  _caseFolderExtras.push('('+_cPhNum.slice(0,3)+')-'+_cPhNum.slice(3,6)+'-'+_cPhNum.slice(6));
                  _caseFolderExtras.push('('+_cPhNum.slice(0,3)+')'+_cPhNum.slice(3,6)+'-'+_cPhNum.slice(6));
                }
              }
            }
            var _cNm1 = _caseStoredName ? _caseStoredName.match(/^([A-Za-z][A-Za-z'\-]+),\s*([A-Za-z][A-Za-z'\-]+)$/) : null;
            var _cNm2 = _caseStoredName ? _caseStoredName.match(/^([A-Za-z][A-Za-z'\-]+)\s+([A-Za-z][A-Za-z'\-]+)$/) : null;
            if (_caseStoredName) {
              _caseFolderExtras.push(_caseStoredName);
              if (_cNm1) {
                _caseFolderExtras.push(_cNm1[1].trim());
                _caseFolderExtras.push(_cNm1[2].trim());
                _caseFolderExtras.push(_cNm1[2].trim() + ' ' + _cNm1[1].trim());
              }
              if (_cNm2) {
                _caseFolderExtras.push(_cNm2[1].trim());
                _caseFolderExtras.push(_cNm2[2].trim());
                _caseFolderExtras.push(_cNm2[2].trim() + ' ' + _cNm2[1].trim());
              }
            }
            var _cMidToUse = _caseStoredMid;
            if (!_cMidToUse && _caseStoredName && extractedText) {
              var _cKnownLast  = _cNm1 ? _cNm1[1].trim().toLowerCase() : (_cNm2 ? _cNm2[2].trim().toLowerCase() : '');
              var _cKnownFirst = _cNm1 ? _cNm1[2].trim().toLowerCase() : (_cNm2 ? _cNm2[1].trim().toLowerCase() : '');
              if (_cKnownLast && _cKnownFirst) {
                var _cLines = extractedText.split('\n');
                var _cStopWords = {and:1,the:1,for:1,with:1,date:1,visit:1,unit:1,room:1,page:1,legal:1,sex:1,adm:1,mrn:1,dob:1,csn:1,scan:1,on:1,of:1,in:1,at:1,by:1,to:1,umc:1,mro:1,ehr:1,emr:1,md:1,rn:1,np:1,pa:1,dr:1,ed:1,er:1,icu:1,or:1};
                for (var _cli = 0; _cli < _cLines.length && !_cMidToUse; _cli++) {
                  var _cln = _cLines[_cli].toLowerCase().replace(/[^a-z\s]/g, ' ');
                  if (_cln.indexOf(_cKnownLast) === -1 || _cln.indexOf(_cKnownFirst) === -1) continue;
                  var _ctoks = _cln.trim().split(/\s+/).filter(function(t) { return t.length >= 2; });
                  var _cFiIdx = _ctoks.indexOf(_cKnownFirst);
                  var _cLaIdx = _ctoks.indexOf(_cKnownLast);
                  if (_cFiIdx >= 0 && _cLaIdx >= 0) {
                    var _cLo = Math.min(_cFiIdx, _cLaIdx);
                    var _cHi = Math.max(_cFiIdx, _cLaIdx);
                    for (var _cti = _cLo + 1; _cti < _cHi && !_cMidToUse; _cti++) {
                      var _ctc = _ctoks[_cti];
                      if (_ctc.length >= 3 && /^[a-z]+$/.test(_ctc) && !_cStopWords[_ctc]) {
                        _cMidToUse = _ctc.charAt(0).toUpperCase() + _ctc.slice(1);
                      }
                    }
                  }
                }
                if (_cMidToUse) { console.log('[CASE-FOLDER-PII] mined middle name:', _cMidToUse); }
              }
            }
            if (_cMidToUse) {
              _caseFolderExtras.push(_cMidToUse);
              _caseFolderExtras.push(_cMidToUse[0].toUpperCase());
              if (_cNm1) {
                _caseFolderExtras.push(_cNm1[2].trim() + ' ' + _cMidToUse + ' ' + _cNm1[1].trim());
                _caseFolderExtras.push(_cNm1[1].trim() + ', ' + _cNm1[2].trim() + ' ' + _cMidToUse);
              }
              if (_cNm2) { _caseFolderExtras.push(_cNm2[1].trim() + ' ' + _cMidToUse + ' ' + _cNm2[2].trim()); }
            }
            console.log('[CASE-FOLDER-PII] extras:', JSON.stringify(_caseFolderExtras));
          } else {
            console.log('[CASE-FOLDER-PII] no record for key:', _caseOrgId + '#' + _caseFolderName);
          }
        } else {
          console.log('[CASE-FOLDER-PII] skipped — folder_name:', _caseFolderName, 'org_id:', _caseOrgId);
        }
      } catch (_cFpErr) {
        console.log('[CASE-FOLDER-PII] error:', _cFpErr.message);
      }
      // ── End CASE folder PII ─────────────────────────────────────────────────

      var knownPiiValues = knownPiiValuesBase.filter(_caseFilterFac)
        .concat(discoveredAddrTokens.filter(function(v) { return knownPiiValuesBase.indexOf(v) === -1; }))
        .concat(caseUserPiiExpanded.filter(function(v) { return v && v.trim().length >= 1; }))
        .concat(_caseFolderExtras.filter(function(v) { return v && v.trim().length >= 1 && knownPiiValuesBase.indexOf(v) === -1; }));
      // Build source map for CSV audit trail — uses tagged rules for specificity
      var piiSourceMap = {};
      var _caseTaggedPii = extractKnownPiiValuesTagged(extractedText || '');
      _caseTaggedPii.forEach(function(t) { if (t.value) piiSourceMap[normalizeForMatch(t.value)] = t.rule; });
      discoveredAddrTokens.forEach(function(v) { if (v && !piiSourceMap[normalizeForMatch(v)]) piiSourceMap[normalizeForMatch(v)] = 'addr-discovery'; });
      caseUserPiiExpanded.forEach(function(v) { if (v && !piiSourceMap[normalizeForMatch(v)]) piiSourceMap[normalizeForMatch(v)] = 'user-supplied'; });
      console.log('[ADDR] Added ' + discoveredAddrTokens.length + ' addr + ' + caseDocUserPii.length + ' user-supplied tokens to PII set');
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
        if (_clinicalBoilerplate.has(trimmed.toLowerCase())) return false;
        // CPT/E&M/procedure codes (4-5 pure digits like 99214, 99213, etc.)
        if (/^\d{4,5}$/.test(trimmed)) return false;
        return true;
      });

      if (wordBlocks && wordBlocks.length > 0) {
        var _mrnCheck = filteredPiiValues.filter(function(v) { return v && v.indexOf('0001506950') >= 0; });
        console.log('[PII-PREFLIGHT] filteredPiiValues count:', filteredPiiValues.length, '| MRN 0001506950 in list:', _mrnCheck.length > 0, '| MRN entries:', JSON.stringify(_mrnCheck));
        allPii = findBoxesFromBlocks(wordBlocks, filteredPiiValues, piiSourceMap);
        var _p31boxes = allPii['31'] || allPii['32'] || [];
        console.log('[ALLPII-PAGE32] key 31 boxes:', (allPii['31']||[]).length, '| key 32 boxes:', (allPii['32']||[]).length);
        console.log('[ALLPII-PAGE32] page31 MRN boxes:', JSON.stringify((allPii['31']||[]).filter(function(b){ return b.label && b.label.indexOf('506950') >= 0; })));
        console.log('[ALLPII-KEYS] total pages with boxes:', Object.keys(allPii).length, '| keys:', Object.keys(allPii).sort(function(a,b){return parseInt(a)-parseInt(b);}).join(','));
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
      return { redactedBytes, redactCount, piiByPage: allPii };
    }));

    await updateJob(job_id, { progress_message: 'Merging ' + partResults.length + ' redacted part(s)...', updated_at: new Date().toISOString() });

    var mergedDoc = await PDFDocument.create();
    var totalRedactions = 0;
    var mergedPiiByPage = {};
    var _globalPageOffset = 0;
    for (var _ri = 0; _ri < partResults.length; _ri++) {
      var partDoc    = await PDFDocument.load(partResults[_ri].redactedBytes);
      var pgCount    = partDoc.getPageCount();
      var pgIndices  = [];
      for (var _pii = 0; _pii < pgCount; _pii++) pgIndices.push(_pii);
      var copiedPgs  = await mergedDoc.copyPages(partDoc, pgIndices);
      copiedPgs.forEach(function(p) { mergedDoc.addPage(p); });
      totalRedactions += partResults[_ri].redactCount;
      var partPii = partResults[_ri].piiByPage || {};
      for (var _pp in partPii) {
        if (partPii.hasOwnProperty(_pp)) {
          mergedPiiByPage[String(parseInt(_pp, 10) + _globalPageOffset)] = partPii[_pp];
        }
      }
      _globalPageOffset += pgCount;
    }
    var mergedBytes = Buffer.from(await mergedDoc.save());
    var totalPages  = mergedDoc.getPageCount();

    var baseName   = (doc_records[0].original_filename || 'document').replace(/_Part\d+\.pdf$/i, '').replace(/\.pdf$/i, '');
    var newUUID    = randomUUID();
    var mergedKey  = 'orgs/' + org_id + '/documents/' + newUUID + '/' + baseName + '_REDACTED.pdf';
    var mergedName = baseName + '_REDACTED.pdf';

    await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: mergedKey, Body: mergedBytes, ContentType: 'application/pdf' }));

    // ── Redaction log CSV ────────────────────────────────────────────────────
    var _caseLogKey = null; var _caseLogUrl = null;
    try {
      var _casePiiSummary = {
        patientName: folder_name || '',
        dob:         '',
        mrn:         '',
        folder:      folder_name || '',
      };
      var _caseLogBytes = buildRedactionLogCsv(mergedName, mergedPiiByPage, _casePiiSummary);
      _caseLogKey = mergedKey.replace(/_REDACTED\.pdf$/i, '_REDACTION_LOG.csv');
      await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: _caseLogKey, Body: _caseLogBytes, ContentType: 'text/csv' }));
      _caseLogUrl = await getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: _caseLogKey }), { expiresIn: 604800 });
      console.log('[REDACTION-LOG] Case CSV uploaded to', _caseLogKey);
    } catch (_caseLogErr) {
      console.warn('[REDACTION-LOG] Failed to generate case CSV:', _caseLogErr.message);
    }

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
        redaction_log_key: _caseLogKey  || null,
        redaction_log_url: _caseLogUrl  || null,
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

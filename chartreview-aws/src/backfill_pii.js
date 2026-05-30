'use strict';
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand, PutCommand } = require('@aws-sdk/lib-dynamodb');

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' }));
const DOCS_TABLE   = 'chartreview-documents-prod';
const PII_TABLE    = 'chartreview-folder-pii-prod';
const ORG_ID       = process.env.ORG_ID;
const FOLDER_INPUT = process.env.FOLDER_NAME;

const ANCHORS = [
  'IN/OUT/ER PATIENT ADMISSION RECORD','ADMISSION RECORD','PATIENT REGISTRATION',
  'REGISTRATION FORM','PATIENT INFORMATION','DEMOGRAPHIC','FACE SHEET','FACESHEET',
  'PATIENT DEMOGRAPHICS','PATIENT PROFILE','ADMISSION FORM',
];

// Label tokens that appear as column headers — strip them from value matches
const LABEL_TOKENS = /^(MRN|DOB|SSN|PHONE|ADDRESS|CITY|STATE|ZIP|EMPLOYER|LEGAL|NAME|PATIENT|ACCOUNT|ACCT|ROOM|UNIT|PRN|URN|TEL|FAX|SEX|AGE|RACE|DOA|ADMIT|DISCHARGE|DX|ICD|PCP|ATTENDING|EMERGENCY|CONTACT|RELATIONSHIP|INSURANCE|GROUP|POLICY|SUBSCRIBER|GUARANTOR|NEXT|OF|KIN|POA)[\s]+/gi;

function stripLabels(s) {
  if (!s) return s;
  let prev = '';
  while (prev !== s) { prev = s; s = s.replace(LABEL_TOKENS, '').trim(); }
  return s.trim();
}

function findWindow(text) {
  if (!text) return null;
  const u = text.toUpperCase();
  for (const a of ANCHORS) {
    const i = u.indexOf(a);
    if (i !== -1) return text.slice(i, i + 3000);
  }
  return null;
}

function grab(text, patterns, clean = false) {
  for (const p of patterns) {
    const m = text.match(p);
    if (m && m[1] && m[1].trim().length > 1) {
      const val = m[1].trim().toUpperCase();
      return clean ? stripLabels(val) : val;
    }
  }
  return '';
}

function parsePii(w) {
  const t = w.replace(/\n/g, ' ').replace(/\s{2,}/g, ' ');
  return {
    // Name: try "LAST, FIRST" pattern first, fallback to label-then-value
    patientName: (function() {
      // Pattern 1: explicit PATIENT NAME label
      const m1 = t.match(/PATIENT\s*NAME\s*[:\-]?\s*([A-Z][A-Z,'\s\-]{3,40})/i);
      if (m1) return stripLabels(m1[1].trim().toUpperCase());
      // Pattern 2: "LAST, FIRST" directly — at least 5 chars, comma required
      const m2 = t.match(/\b([A-Z]{2,20},\s*[A-Z][A-Z\s]{2,20})\b/);
      if (m2) return m2[1].trim().toUpperCase();
      return '';
    })(),
    dob:      grab(t, [/(?:DOB|DATE OF BIRTH|BIRTH DATE)\s*[:\-]?\s*([\d]{1,2}[\/\-][\d]{1,2}[\/\-][\d]{2,4})/i]),
    ssn:      grab(t, [/(?:SSN|SOCIAL SECURITY)\s*[:\-#]?\s*([\d]{3}[\-\s]?[\d]{2}[\-\s]?[\d]{4})/i]),
    phone:    grab(t, [/(?:PHONE|HOME|CELL|TEL)\s*[:\-]?\s*([\(]?[\d]{3}[\)\-\.\s][\d]{3}[\-\.\s][\d]{4})/i]),
    mrn:      (function(){
      // MRN: must be digits or short alphanumeric, NOT all-alpha label words
      const m = t.match(/(?:MRN|MEDICAL RECORD)\s*[:\-#]?\s*([A-Z0-9]{5,15})/i);
      if (m && /\d/.test(m[1])) return m[1].trim().toUpperCase();
      return '';
    })(),
    street:   grab(t, [/(?:ADDRESS|STREET)\s*[:\-]?\s*(\d+\s+[A-Z][A-Z0-9\s,\.#'\-]{5,50})/i]),
    city:     grab(t, [/CITY\s*[:\-]?\s*([A-Z][A-Z\s]{2,30})/i]),
    stateZip: grab(t, [/(?:STATE|ZIP)\s*[:\-]?\s*([A-Z]{2}[\s\-]*\d{5}[\-\d]*)/i]),
    employer: (function(){ const m=t.match(/(?:EMPLOYER|EMPLOYER NAME)\s*[:\-]?\s*([A-Z][A-Z0-9\s,\.&'\-]{3,50})/i); return (m&&m[1]&&!/GUARANTOR|UNEMPLOYED|NONE|N\/A|SELF|RETIRED|DISABLED|STUDENT/i.test(m[1])) ? m[1].trim().toUpperCase() : ''; })(),
    spouse:   (function(){ const m=t.match(/(?:SPOUSE|PARTNER)\s*[:\-]?\s*([A-Z][A-Z ,'\-]{3,40})/i); const v=m&&m[1]?m[1].trim().toUpperCase():''; return /^(PERSON TO NOTIFY|NEXT OF KIN|NOK|N\/A|NONE|EMERGENCY CONTACT|RELATIONSHIP|NAME)$/i.test(v)?'':v; })(),
  };
}

async function run() {
  console.log(`Scanning org=${ORG_ID} folder='${FOLDER_INPUT}'`);
  let ExclusiveStartKey, processed = 0, found = false;
  do {
    const res = await dynamo.send(new ScanCommand({
      TableName: DOCS_TABLE,
      FilterExpression: 'org_id = :o AND #f = :v AND attribute_exists(extracted_text)',
      ExpressionAttributeNames: { '#f': 'folder' },
      ExpressionAttributeValues: { ':o': ORG_ID, ':v': FOLDER_INPUT },
      ExclusiveStartKey,
      ProjectionExpression: 'aws_document_id, file_name, extracted_text',
    }));
    ExclusiveStartKey = res.LastEvaluatedKey;
    console.log(`Page: ${res.Items.length} docs`);

    for (const doc of (res.Items || [])) {
      if (!doc.extracted_text || doc.extracted_text.length < 100) { processed++; continue; }
      const win = findWindow(doc.extracted_text);
      if (!win) { processed++; continue; }
      const pii = parsePii(win);
      const hasData = Object.values(pii).some(v => v && v.length > 0);
      if (!hasData) { processed++; continue; }

      console.log('Facesheet found in:', doc.file_name);
      console.log('PII:', JSON.stringify(pii, null, 2));

      const key = ORG_ID + '#' + FOLDER_INPUT.trim();
      await dynamo.send(new PutCommand({
        TableName: PII_TABLE,
        Item: { org_folder: key, org_id: ORG_ID, ...pii, updated_at: new Date().toISOString(), source_doc: doc.file_name },
      }));
      console.log('Written. Key:', key);
      found = true;
      break;
    }
    if (found) break;
  } while (ExclusiveStartKey);

  if (!found) console.log('No facesheet found. Docs scanned:', processed);
}

run().catch(e => { console.error(e); process.exit(1); });

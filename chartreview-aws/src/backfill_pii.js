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

function findWindow(text) {
  if (!text) return null;
  const u = text.toUpperCase();
  for (const a of ANCHORS) {
    const i = u.indexOf(a);
    if (i !== -1) return text.slice(i, i + 3000);
  }
  return null;
}

function grab(text, patterns) {
  for (const p of patterns) {
    const m = text.match(p);
    if (m && m[1] && m[1].trim().length > 1) return m[1].trim().toUpperCase();
  }
  return '';
}

function parsePii(w) {
  const t = w.replace(/\n/g, ' ').replace(/\s{2,}/g, ' ');
  return {
    patientName: grab(t, [/PATIENT\s*NAME[:\s]+([A-Z][A-Z ,'-]{3,40})/i, /NAME[:\s]+([A-Z][A-Z ,'-]{3,40})/i]),
    dob:         grab(t, [/(?:DOB|DATE OF BIRTH|BIRTH DATE)[:\s]+([\d\/\-]+)/i]),
    ssn:         grab(t, [/(?:SSN|SOCIAL SECURITY)[:\s#]*([\d\-X*]{4,11})/i]),
    phone:       grab(t, [/(?:PHONE|TEL|TELEPHONE|CELL|HOME)[:\s]+([\d\s\(\)\-\.]{7,16})/i]),
    mrn:         grab(t, [/(?:MRN|MEDICAL RECORD|ACCOUNT\s*#?|ACCT\s*#?)[:\s]+([\w\-]{4,20})/i]),
    street:      grab(t, [/(?:ADDRESS|STREET)[:\s]+([\d]+\s+[A-Z][A-Z0-9\s,\.#'-]{5,50})/i]),
    city:        grab(t, [/CITY[:\s]+([A-Z][A-Z\s]{2,30})/i]),
    stateZip:    grab(t, [/(?:STATE|ZIP)[:\s]+([A-Z]{2}[\s\-]*[\d]{5}[\-\d]*)/i]),
    employer:    grab(t, [/(?:EMPLOYER|EMPLOYER NAME)[:\s]+([A-Z][A-Z0-9\s,\.&'\-]{3,50})/i]),
    spouse:      grab(t, [/(?:SPOUSE|PARTNER)[:\s]+([A-Z][A-Z ,'-]{3,40})/i]),
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
    console.log(`Page: ${res.Items.length} docs (total scanned: ${processed + res.Items.length})`);

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
      console.log('Written to table. Key:', key);
      found = true;
      break;
    }
    if (found) break;
  } while (ExclusiveStartKey);

  if (!found) console.log('No facesheet anchor found in folder. Docs scanned:', processed);
}

run().catch(e => { console.error(e); process.exit(1); });

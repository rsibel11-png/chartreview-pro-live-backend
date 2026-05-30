// backfill_folder_pii.js
// Run once to scan all existing docs and populate chartreview-folder-pii-prod
// Usage: node backfill_folder_pii.js
// Requires: AWS credentials with DynamoDB access

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand, PutCommand, GetCommand } = require('@aws-sdk/lib-dynamodb');

const client = new DynamoDBClient({ region: 'us-east-1' });
const dynamo = DynamoDBDocumentClient.from(client);

const DOCUMENTS_TABLE  = 'chartreview-documents-prod';
const FOLDER_PII_TABLE = 'chartreview-folder-pii-prod';

const ADMISSION_ANCHORS = [
  'IN/OUT/ER PATIENT ADMISSION RECORD',
  'ADMISSION RECORD',
  'PATIENT REGISTRATION',
  'REGISTRATION FORM',
  'FACE SHEET',
  'FACESHEET',
  'ER REGISTRATION',
  'EMERGENCY REGISTRATION',
];
const FACESHEET_FIELD_SIGNALS = ['NAME:', 'DOB:', 'D.O.B', 'STREET:', 'ADDRESS:', 'PHONE', 'SS#:', 'SSN:'];
const FACESHEET_FIELD_THRESHOLD = 3;

function findFacesheetWindow(text) {
  const upper = (text || '').toUpperCase();
  let anchorIdx = -1;
  for (const anchor of ADMISSION_ANCHORS) {
    const idx = upper.indexOf(anchor);
    if (idx >= 0 && (anchorIdx === -1 || idx < anchorIdx)) anchorIdx = idx;
  }
  if (anchorIdx === -1) return null;
  const window = text.slice(anchorIdx, anchorIdx + 2000);
  const hits = FACESHEET_FIELD_SIGNALS.filter(sig => window.toUpperCase().includes(sig));
  if (hits.length < FACESHEET_FIELD_THRESHOLD) return null;
  return window;
}

function parsePiiFromWindow(window) {
  const find = (patterns) => {
    for (const p of patterns) { const m = p.exec(window); if (m && m[1]) return m[1].trim(); }
    return '';
  };
  const name = find([/^NAME:\s*([A-Z][A-Z,'.\- ]{2,40})/m, /PATIENT\s*NAME[:\s]+([A-Z][A-Z,'.\- ]{2,40})/i]);
  const dob  = find([/DOB[:\s]+([\d]{1,2}\/[\d]{1,2}\/[\d]{2,4})/i, /DATE\s+OF\s+BIRTH[:\s]+([\d]{1,2}\/[\d]{1,2}\/[\d]{2,4})/i]);
  const ssn  = find([/SS#[:\s]+([Xx0-9-]{7,11})/, /SSN[:#\s]+([Xx0-9-]{7,11})/i, /(\d{3}-\d{2}-\d{4})/]);
  const phone = find([/PHONE#?[:\s]+([\(\d][\d().\- ]{8,})/i]);
  const mrn  = find([/UNIT\s*RCRD\s*#[:\s]+([A-Z0-9]{5,})/i, /MRN[:\s]+([A-Z0-9]{5,})/i, /ACCOUNT#?\s*([A-Z0-9]{6,})/i]);
  const streetM = window.match(/STREET[:\s]+([\w][^\n]{5,50})/i) || window.match(/ADDRESS[:\s]+([\w][^\n]{5,50})/i);
  const street = streetM ? streetM[1].trim() : '';
  const cszM = window.match(/C\/S\/Z[P]?[:\s]+([A-Z][A-Z ]+),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)/i);
  const city = cszM ? cszM[1].trim() : '';
  const stateZip = cszM ? (cszM[2] + ' ' + cszM[3]) : '';
  const spouseM = window.match(/SPOUSE\s*(?:\/\s*NOK)?[\s\S]{0,15}\n([A-Z][A-Z, ]{3,40})\n/i);
  const spouse = spouseM ? spouseM[1].trim() : '';
  const empM = window.match(/(?:PATIENT\s+)?EMPLOYER[:\n\s]+([A-Z][A-Z &,.]{3,50})/i);
  const employer = (empM && !/UNEMPLOYED|NONE|N\/A/i.test(empM[1])) ? empM[1].trim() : '';
  return { patientName: name, dob, ssn, phone, mrn, street, city, stateZip, spouse, employer };
}

async function scanAllDocs() {
  const docs = [];
  let lastKey = null;
  do {
    const params = { TableName: DOCUMENTS_TABLE, ProjectionExpression: 'aws_document_id, org_id, folder, extracted_text' };
    if (lastKey) params.ExclusiveStartKey = lastKey;
    const result = await dynamo.send(new ScanCommand(params));
    docs.push(...(result.Items || []));
    lastKey = result.LastEvaluatedKey;
    process.stdout.write(`\rScanned ${docs.length} docs...`);
  } while (lastKey);
  console.log(`\nTotal docs: ${docs.length}`);
  return docs;
}

async function main() {
  console.log('Backfill: scanning all docs for admission records...');
  const docs = await scanAllDocs();
  const processed = new Set();
  let written = 0;

  for (const doc of docs) {
    const folder = (doc.folder || '').trim();
    const orgId  = doc.org_id || '';
    if (!folder || !orgId) continue;
    const orgFolder = `${orgId}#${folder}`;
    if (processed.has(orgFolder)) continue; // already found a facesheet for this folder

    const window = findFacesheetWindow(doc.extracted_text || '');
    if (!window) continue;

    const pii = parsePiiFromWindow(window);
    if (!Object.values(pii).some(v => v)) continue;

    // Check if a richer record already exists
    const existing = await dynamo.send(new GetCommand({ TableName: FOLDER_PII_TABLE, Key: { org_folder: orgFolder } })).catch(() => ({ Item: null }));
    const base = existing?.Item || {};
    const merged = {
      org_folder: orgFolder, org_id: orgId, folder, updated_at: new Date().toISOString(),
      patientName: pii.patientName || base.patientName || '',
      dob:         pii.dob         || base.dob         || '',
      ssn:         pii.ssn         || base.ssn         || '',
      phone:       pii.phone       || base.phone       || '',
      mrn:         pii.mrn         || base.mrn         || '',
      street:      pii.street      || base.street      || '',
      city:        pii.city        || base.city        || '',
      stateZip:    pii.stateZip    || base.stateZip    || '',
      spouse:      pii.spouse      || base.spouse      || '',
      employer:    pii.employer    || base.employer    || '',
    };
    await dynamo.send(new PutCommand({ TableName: FOLDER_PII_TABLE, Item: merged }));
    console.log(`✓ Folder "${folder}" — name: ${merged.patientName}, dob: ${merged.dob}`);
    written++;
    processed.add(orgFolder); // mark so we don't scan every doc in same folder
  }
  console.log(`\nDone. Wrote ${written} folder PII records.`);
}

main().catch(console.error);

var fs = require('fs');

// Fix documents.js - remove null index fields AND fix presigned URL to not require checksum
var dp = 'src/handlers/documents.js';
var dc = fs.readFileSync(dp, 'utf8');

// Fix 1: Remove null aws_patient_id and patient_name from item
dc = dc.replace(
  "const item = {\n      aws_document_id,\n      aws_patient_id: data.aws_patient_id || null,\n      patient_name: data.patient_name || null,\n      file_name: data.file_name,\n      file_key: key,\n      content_type: data.content_type || 'application/octet-stream',\n      status: 'uploaded',\n      created_at: now,\n      updated_at: now\n    };",
  "const item = {\n      aws_document_id,\n      file_name: data.file_name,\n      file_key: key,\n      content_type: data.content_type || 'application/octet-stream',\n      status: 'uploaded',\n      created_at: now,\n      updated_at: now\n    };\n    if (data.aws_patient_id) item.aws_patient_id = data.aws_patient_id;\n    if (data.patient_name) item.patient_name = data.patient_name;"
);

// Fix 2: Disable checksum on PutObjectCommand for presigned URL
dc = dc.replace(
  "const command = new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: data.content_type || 'application/octet-stream' });",
  "const command = new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: data.content_type || 'application/octet-stream', ChecksumAlgorithm: undefined });"
);

fs.writeFileSync(dp, dc, 'utf8');

// Verify
var check = fs.readFileSync(dp, 'utf8');
console.log('null aws_patient_id removed:', !check.includes('aws_patient_id: data.aws_patient_id || null'));
console.log('null patient_name removed:', !check.includes('patient_name: data.patient_name || null'));
console.log('Done!');

var fs = require('fs');

// Fix documents.js - replace null aws_patient_id with empty string
var dp = 'src/handlers/documents.js';
var dc = fs.readFileSync(dp, 'utf8');
dc = dc.replace("aws_patient_id: data.aws_patient_id || null,", "aws_patient_id: data.aws_patient_id || '',");
dc = dc.replace("patient_name: data.patient_name || null,", "patient_name: data.patient_name || '',");
fs.writeFileSync(dp, dc, 'utf8');
console.log('documents.js: patched null -> empty string');

// Fix summaries.js - replace null aws_patient_id and aws_document_id with empty string
var sp = 'src/handlers/summaries.js';
var sc = fs.readFileSync(sp, 'utf8');
sc = sc.replace("aws_patient_id: data.aws_patient_id || null,", "aws_patient_id: data.aws_patient_id || '',");
sc = sc.replace("aws_document_id: data.aws_document_id || null,", "aws_document_id: data.aws_document_id || '',");
fs.writeFileSync(sp, sc, 'utf8');
console.log('summaries.js: patched null -> empty string');

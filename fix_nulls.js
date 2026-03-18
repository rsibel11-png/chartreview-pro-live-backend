var fs = require('fs');

// Fix documents.js
var dp = 'src/handlers/documents.js';
var dc = fs.readFileSync(dp, 'utf8');
// Replace the item construction to conditionally include aws_patient_id
var oldItem = "const item = { aws_document_id, aws_patient_id: data.aws_patient_id || '', patient_name: data.patient_name || '', file_name: data.file_name, file_key: key, content_type: data.content_type || 'application/octet-stream', status: 'uploaded', created_at: now, updated_at: now };";
var newItem = "const item = { aws_document_id, file_name: data.file_name, file_key: key, content_type: data.content_type || 'application/octet-stream', status: 'uploaded', created_at: now, updated_at: now }; if (data.patient_name) item.patient_name = data.patient_name; if (data.aws_patient_id) item.aws_patient_id = data.aws_patient_id;";
if (dc.indexOf(oldItem) !== -1) {
  dc = dc.replace(oldItem, newItem);
  console.log('documents.js: found and replaced item construction');
} else {
  // Try alternate versions
  dc = dc.replace("aws_patient_id: data.aws_patient_id || null,", "").replace("aws_patient_id: data.aws_patient_id || '',", "").replace("patient_name: data.patient_name || null,", "").replace("patient_name: data.patient_name || '',", "");
  console.log('documents.js: stripped null/empty fields');
}
fs.writeFileSync(dp, dc, 'utf8');

// Fix summaries.js
var sp = 'src/handlers/summaries.js';
var sc = fs.readFileSync(sp, 'utf8');
sc = sc.replace("aws_patient_id: data.aws_patient_id || null,", "").replace("aws_patient_id: data.aws_patient_id || '',", "").replace("aws_document_id: data.aws_document_id || null,", "").replace("aws_document_id: data.aws_document_id || '',", "");
fs.writeFileSync(sp, sc, 'utf8');
console.log('summaries.js: stripped null/empty index fields');

console.log('All done!');

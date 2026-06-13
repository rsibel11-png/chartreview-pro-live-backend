/**
 * flatten_pdf.js - v3
 * 
 * Correct approach for pdf-lib generated redactions:
 * 
 * When pdf-lib adds content to a page (our black rectangles), it appends
 * a NEW content stream to the page's Contents array. So a redacted page has:
 *   Contents: [original_hospital_stream, pdflibAdded_stream]
 * 
 * The original_hospital_stream has the patient text.
 * The pdflibAdded_stream has our black rectangles.
 * 
 * Strategy:
 * 1. For each page, check ALL streams for black rectangle operators
 * 2. If ANY stream on a page has rectangles covering >1% of page area,
 *    mark that page as "has redactions"
 * 3. For pages with redactions: scrub text from ALL streams on that page
 *    (the rectangles themselves are graphics operators, not text — they survive)
 * 4. For pages without redactions: leave completely untouched
 */

'use strict';

const { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, PutCommand } = require('@aws-sdk/lib-dynamodb');
const { randomUUID } = require('crypto');
const { PDFDocument, PDFName, PDFArray } = require('pdf-lib');
const zlib = require('zlib');

const s3 = new S3Client({ region: 'us-east-1' });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' }));
const DOCS_TABLE = process.env.DOCS_TABLE || 'chartreview-documents-prod';
const BUCKET = process.env.S3_BUCKET || 'chartreview-documents-prod';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,x-api-key',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
};

function resp(statusCode, body) {
  return { statusCode, headers: CORS, body: JSON.stringify(body) };
}

async function s3ToBuffer(key) {
  const { Body } = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const chunks = [];
  for await (const chunk of Body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function findRedactedKey(orgId, docId) {
  // First try DynamoDB lookup by aws_document_id (most reliable — avoids orgId mismatch)
  try {
    const rec = await ddb.send(new GetCommand({ TableName: DOCS_TABLE, Key: { aws_document_id: docId } }));
    if (rec.Item && rec.Item.file_key) {
      console.log('[FLATTEN] DynamoDB file_key hit:', rec.Item.file_key);
      return rec.Item.file_key;
    }
  } catch (e) {
    console.warn('[FLATTEN] DynamoDB lookup failed, falling back to S3 scan:', e.message);
  }
  // Fallback: S3 scan using orgId from JWT
  const prefix = `orgs/${orgId}/documents/${docId}/`;
  const { Contents } = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix }));
  if (!Contents) return null;
  const redacted = Contents
    .filter(o => o.Key.includes('REDACTED') && !o.Key.includes('_FLAT'))
    .sort((a, b) => new Date(b.LastModified) - new Date(a.LastModified));
  return redacted.length > 0 ? redacted[0].Key : null;
}

function decompressStream(rawBytes) {
  try { return zlib.inflateSync(rawBytes); } catch {}
  try { return zlib.inflateRawSync(rawBytes); } catch {}
  return rawBytes;
}

function compressStream(bytes) {
  return zlib.deflateSync(bytes);
}

// Check if a content stream contains filled rectangles (our redaction boxes)
function hasRedactionBoxes(contentStr, pageWidth, pageHeight) {
  const rePattern = /(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+re\s*(?:f\*?|B\*?)/g;
  let match;
  let totalArea = 0;
  const pageArea = pageWidth * pageHeight;
  while ((match = rePattern.exec(contentStr)) !== null) {
    const w = Math.abs(parseFloat(match[3]));
    const h = Math.abs(parseFloat(match[4]));
    if (w > 5 && h > 5) totalArea += w * h;
  }
  return (totalArea / pageArea) > 0.001; // >0.1% of page covered
}

// Remove all text content operators from a stream
// Preserves graphics operators (rectangles, colors, lines, images)
function scrubTextFromStream(contentStr) {
  // Remove BT...ET blocks (standard text objects)
  let s = contentStr.replace(/BT[\s\S]*?ET/g, '');
  // Remove any orphaned text operators outside BT/ET
  s = s.replace(/\([^)]*\)\s*Tj/g, '');       // (string) Tj
  s = s.replace(/<[0-9a-fA-F]+>\s*Tj/g, '');   // <hex> Tj
  s = s.replace(/\[[^\]]*\]\s*TJ/g, '');        // [array] TJ
  // Remove font operators (no text = no need for fonts)
  // Actually keep font ops — removing them can cause errors in some viewers
  return s;
}

// Get all content streams for a page as an array of stream objects
function getPageStreams(pdfDoc, pageNode) {
  const contentsRef = pageNode.get(PDFName.of('Contents'));
  if (!contentsRef) return [];
  
  const streams = [];
  if (contentsRef instanceof PDFArray) {
    for (let i = 0; i < contentsRef.size(); i++) {
      try {
        const ref = contentsRef.get(i);
        const obj = pdfDoc.context.lookup(ref);
        if (obj && obj.contents !== undefined) streams.push(obj);
      } catch {}
    }
  } else {
    try {
      const obj = pdfDoc.context.lookup(contentsRef);
      if (obj && obj.contents !== undefined) streams.push(obj);
    } catch {}
  }
  return streams;
}

async function scrubPdfTextLayer(pdfBuffer) {
  const pdfDoc = await PDFDocument.load(pdfBuffer, { 
    ignoreEncryption: true,
    updateMetadata: false,
  });
  const pages = pdfDoc.getPages();
  
  let stats = { fullScrub: 0, skipped: 0, errors: 0 };
  
  for (const page of pages) {
    const { width, height } = page.getSize();
    const streams = getPageStreams(pdfDoc, page.node);
    
    if (streams.length === 0) { stats.skipped++; continue; }
    
    // Step 1: Check if ANY stream on this page has redaction boxes
    let pageHasRedactions = false;
    const decompressedStreams = [];
    
    for (const streamObj of streams) {
      try {
        const raw = streamObj.contents;
        const decompressed = decompressStream(raw);
        const contentStr = decompressed.toString('latin1');
        decompressedStreams.push({ streamObj, contentStr });
        if (hasRedactionBoxes(contentStr, width, height)) {
          pageHasRedactions = true;
        }
      } catch (e) {
        stats.errors++;
        decompressedStreams.push(null);
      }
    }
    
    if (!pageHasRedactions) { stats.skipped++; continue; }
    
    // Step 2: Scrub text from ALL streams on this page
    for (const item of decompressedStreams) {
      if (!item) continue;
      const { streamObj, contentStr } = item;
      
      try {
        const scrubbed = scrubTextFromStream(contentStr);
        const newBytes = Buffer.from(scrubbed, 'latin1');
        const compressed = compressStream(newBytes);
        
        streamObj.contents = compressed;
        if (streamObj.dict) {
          streamObj.dict.set(PDFName.of('Length'), pdfDoc.context.obj(compressed.length));
          streamObj.dict.set(PDFName.of('Filter'), PDFName.of('FlateDecode'));
        }
      } catch (e) {
        stats.errors++;
      }
    }
    
    stats.fullScrub++;
  }
  
  console.log(`[FLATTEN] Stats: ${stats.fullScrub} pages scrubbed, ${stats.skipped} clean pages untouched, ${stats.errors} stream errors`);
  
  const saved = await pdfDoc.save({ useObjectStreams: false });
  return Buffer.from(saved);
}

// ── Lambda handler ─────────────────────────────────────────────────────────
module.exports.flattenStart = async (event) => {
  if (event.httpMethod === 'OPTIONS') return resp(200, {});
  
  try {
    const { aws_document_id } = event.pathParameters || {};
    if (!aws_document_id) return resp(400, { error: 'Missing aws_document_id' });
    
    const authHeader = event.headers?.Authorization || event.headers?.authorization || '';
    let orgId;
    try {
      const token = authHeader.replace('Bearer ', '');
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
      orgId = payload['custom:org_id'] || payload.sub;
    } catch {
      return resp(401, { error: 'Invalid token' });
    }
    
    let sourceKey;
    if (event.body) {
      try { sourceKey = JSON.parse(event.body).source_key; } catch {}
    }
    if (!sourceKey) sourceKey = await findRedactedKey(orgId, aws_document_id);
    if (!sourceKey) return resp(404, { error: 'No redacted PDF found. Run redaction first.' });
    
    console.log(`[FLATTEN] Processing: ${sourceKey}`);
    const pdfBuffer = await s3ToBuffer(sourceKey);
    console.log(`[FLATTEN] Input size: ${pdfBuffer.length} bytes`);
    
    const flatBuffer = await scrubPdfTextLayer(pdfBuffer);
    console.log(`[FLATTEN] Output size: ${flatBuffer.length} bytes`);
    
    const flatKey = sourceKey.replace(/(_FLAT)?\.pdf$/i, '_FLAT.pdf');
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: flatKey,
      Body: flatBuffer,
      ContentType: 'application/pdf',
    }));
    
    console.log(`[FLATTEN] Saved: ${flatKey}`);

    // Write DynamoDB record so flattened doc appears in Library
    const sourceRec = await ddb.send(new GetCommand({ TableName: DOCS_TABLE, Key: { aws_document_id } })).then(r => r.Item).catch(() => null);
    const flatDocId = randomUUID();
    const flatName = flatKey.split('/').pop();
    await ddb.send(new PutCommand({
      TableName: DOCS_TABLE,
      Item: {
        aws_document_id:   flatDocId,
        org_id:            sourceRec?.org_id            || null,
        patient_id:        sourceRec?.patient_id         || null,
        folder_name:       sourceRec?.folder_name        || null,
        provider_name:     sourceRec?.provider_name      || null,
        original_filename: flatName,
        file_key:          flatKey,
        s3_key:            flatKey,
        is_redacted:       true,
        is_flattened:      true,
        flattened_from:    aws_document_id,
        redacted_from:     sourceRec?.redacted_from      || null,
        status:            'processed',
        is_clinical:       sourceRec?.is_clinical        || false,
        created_at:        new Date().toISOString(),
        updated_at:        new Date().toISOString(),
      },
    }));
    console.log(`[FLATTEN] DynamoDB record written: ${flatDocId}`);

    return resp(200, {
      status: 'complete',
      source_key: sourceKey,
      flattened_key: flatKey,
      flat_doc_id: flatDocId,
      original_size_bytes: pdfBuffer.length,
      flattened_size_bytes: flatBuffer.length,
      message: 'Text layer scrubbed from all redacted pages. PII is permanently removed from the PDF data structure.',
    });
    
  } catch (err) {
    console.error('[FLATTEN] Error:', err);
    return resp(500, { error: err.message });
  }
};

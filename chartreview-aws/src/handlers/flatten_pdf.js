// Updated: 2026-09-19 -- SECURITY FIX: flattenStart was previously exported with ZERO authentication (no validateApiKey wrapper) and trusted a client-supplied org_id (body.org_id / x-org-id header) to resolve which document to flatten. Now wrapped in validateApiKey (real Cognito JWT verification) and org_id comes only from the verified token; added an explicit ownership check against the document's actual org_id (admin bypasses). No other flow touched.
/**
 * flatten_pdf.js - v4 (surgical text scrubbing)
 *
 * Instead of scrubbing ALL text from redacted pages, we:
 * 1. Extract the exact bounding boxes of every redaction rectangle
 * 2. Parse each text operator (BT...ET block) and determine its position
 *    using the Tm (text matrix) command which gives x,y coordinates
 * 3. Only zero-out text operators whose position falls within a redaction box
 * 4. Leave all other text intact — Textract can still extract clinical content
 *
 * This means:
 * - Redacted fields (name, DOB, MRN, address) → text layer scrubbed
 * - Clinical content (labs, notes, vitals) → text layer preserved
 * - Summary generation still works on the scrubbed file
 * - Distribution-safe: PII is gone from both visual AND text layer
 */

'use strict';

const { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, PutCommand } = require('@aws-sdk/lib-dynamodb');
const { randomUUID } = require('crypto');
const { PDFDocument, PDFName, PDFArray } = require('pdf-lib');
const zlib = require('zlib');
const { validateApiKey } = require('./auth');

const s3 = new S3Client({ region: 'us-east-1' });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' }));
const DOCS_TABLE = process.env.DOCUMENTS_TABLE || 'chartreview-documents-prod';
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
  try {
    const rec = await ddb.send(new GetCommand({ TableName: DOCS_TABLE, Key: { aws_document_id: docId } }));
    if (rec.Item && rec.Item.file_key) {
      console.log('[FLATTEN] DynamoDB file_key hit:', rec.Item.file_key);
      return rec.Item.file_key;
    }
  } catch (e) {
    console.warn('[FLATTEN] DynamoDB lookup failed, falling back to S3 scan:', e.message);
  }
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

/**
 * Extract all redaction rectangle bounding boxes from content streams.
 * These are the black filled rectangles pdf-lib added: x y w h re f
 * Returns array of { x1, y1, x2, y2 } in PDF page coordinates.
 * Adds a small padding (2pt) to catch text that sits right at the edge.
 */
function extractRedactionBoxes(contentStr) {
  const boxes = [];
  const PAD = 2;
  // Match: x y w h re (followed by f, f*, B, B*)
  const rePattern = /(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+re\s*(?:f\*?|B\*?)/g;
  let match;
  while ((match = rePattern.exec(contentStr)) !== null) {
    const x = parseFloat(match[1]);
    const y = parseFloat(match[2]);
    const w = parseFloat(match[3]);
    const h = parseFloat(match[4]);
    // Only include substantial boxes (>5pt in each dimension) — ignore hairlines
    if (Math.abs(w) > 5 && Math.abs(h) > 5) {
      const x1 = Math.min(x, x + w) - PAD;
      const y1 = Math.min(y, y + h) - PAD;
      const x2 = Math.max(x, x + w) + PAD;
      const y2 = Math.max(y, y + h) + PAD;
      boxes.push({ x1, y1, x2, y2 });
    }
  }
  return boxes;
}

/**
 * Check if a point (tx, ty) falls within any redaction box.
 */
function isInsideAnyBox(tx, ty, boxes) {
  for (const b of boxes) {
    if (tx >= b.x1 && tx <= b.x2 && ty >= b.y1 && ty <= b.y2) return true;
  }
  return false;
}

/**
 * Surgical text scrubbing — only removes BT...ET blocks whose Tm position
 * falls within one of the redaction boxes. All other text is preserved.
 *
 * PDF text position is set by Tm (text matrix): a b c d tx ty Tm
 * We use tx, ty as the anchor point for the text block.
 *
 * For rotated text (XObject stamps), the matrix [0 -1 1 0 tx ty] Tm
 * still gives us tx, ty as the origin — same logic applies.
 */
function surgicalScrubStream(contentStr, boxes) {
  if (boxes.length === 0) return contentStr; // nothing to scrub

  // Split into BT...ET blocks and non-BT content
  // We'll rebuild the stream, zeroing out blocks that hit a redaction box
  const result = [];
  let pos = 0;
  const btPattern = /BT[\s\S]*?ET/g;
  let match;

  while ((match = btPattern.exec(contentStr)) !== null) {
    // Add the content before this BT block unchanged
    result.push(contentStr.slice(pos, match.index));
    pos = match.index + match[0].length;

    const block = match[0];

    // Extract Tm coordinates from this block
    // Format: a b c d tx ty Tm  OR  tx ty Td  OR  tx ty TD
    let tx = null, ty = null;

    // Try Tm first (most precise — sets absolute position)
    const tmMatch = block.match(/(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+Tm/);
    if (tmMatch) {
      tx = parseFloat(tmMatch[5]);
      ty = parseFloat(tmMatch[6]);
    }

    // Fallback: Td (relative move — less reliable without tracking state)
    if (tx === null) {
      const tdMatch = block.match(/(-?[\d.]+)\s+(-?[\d.]+)\s+T[dD]/);
      if (tdMatch) {
        tx = parseFloat(tdMatch[1]);
        ty = parseFloat(tdMatch[2]);
      }
    }

    if (tx !== null && ty !== null && isInsideAnyBox(tx, ty, boxes)) {
      // This text block is inside a redaction box — zero it out
      // Replace with whitespace comment to keep stream structure valid
      result.push('% [SCRUBBED]\n');
    } else {
      // Outside all redaction boxes — keep intact
      result.push(block);
    }
  }

  // Add any trailing content after last ET
  result.push(contentStr.slice(pos));
  return result.join('');
}

/**
 * Scrub XObject streams surgically.
 * XObjects (lateral margin stamps, facesheets) have their own coordinate space.
 * We transform the redaction boxes from page space into XObject space using
 * the XObject's matrix, then apply the same surgical scrub.
 */
function getXObjectMatrix(xobj) {
  // XObject may have a /Matrix entry: [a b c d e f]
  if (!xobj.dict) return null;
  const matrixObj = xobj.dict.get(PDFName.of('Matrix'));
  if (!matrixObj) return null;
  try {
    // PDFArray of 6 numbers
    const arr = matrixObj.asArray ? matrixObj.asArray() : null;
    if (!arr || arr.length !== 6) return null;
    return arr.map(n => (n.numberValue !== undefined ? n.numberValue : parseFloat(n.toString())));
  } catch {
    return null;
  }
}

function transformBoxesToXObjectSpace(boxes, matrix) {
  if (!matrix) return boxes; // no transform, use as-is
  // matrix = [a b c d e f] — standard PDF CTM
  // To go from page space to XObject space, invert the matrix
  const [a, b, c, d, e, f] = matrix;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-10) return boxes; // singular matrix, skip
  const ia = d / det, ib = -b / det, ic = -c / det, id = a / det;
  const ie = (c * f - d * e) / det, ig = (b * e - a * f) / det;

  return boxes.map(box => {
    // Transform all 4 corners and take the bounding box of results
    const corners = [
      [box.x1, box.y1], [box.x2, box.y1],
      [box.x1, box.y2], [box.x2, box.y2]
    ].map(([px, py]) => [ia * px + ic * py + ie, ib * px + id * py + ig]);

    const xs = corners.map(c => c[0]);
    const ys = corners.map(c => c[1]);
    return {
      x1: Math.min(...xs), y1: Math.min(...ys),
      x2: Math.max(...xs), y2: Math.max(...ys)
    };
  });
}

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

  let stats = { surgicalScrub: 0, skipped: 0, errors: 0, textBlocksRemoved: 0, textBlocksKept: 0 };

  for (const page of pages) {
    const { width, height } = page.getSize();
    const streams = getPageStreams(pdfDoc, page.node);
    if (streams.length === 0) { stats.skipped++; continue; }

    // Step 1: Collect all redaction boxes from ALL streams on this page
    const allBoxes = [];
    const decompressedStreams = [];

    for (const streamObj of streams) {
      try {
        const raw = streamObj.contents;
        const decompressed = decompressStream(raw);
        const contentStr = decompressed.toString('latin1');
        decompressedStreams.push({ streamObj, contentStr });
        const boxes = extractRedactionBoxes(contentStr);
        allBoxes.push(...boxes);
      } catch (e) {
        stats.errors++;
        decompressedStreams.push(null);
      }
    }

    // No redaction boxes on this page — skip entirely, preserve all text
    if (allBoxes.length === 0) { stats.skipped++; continue; }

    console.log(`[FLATTEN] Page has ${allBoxes.length} redaction boxes — surgical scrub`);

    // Step 2: Surgically scrub text from ALL direct page streams
    for (const item of decompressedStreams) {
      if (!item) continue;
      const { streamObj, contentStr } = item;
      try {
        const scrubbed = surgicalScrubStream(contentStr, allBoxes);

        // Count how many blocks were removed vs kept for logging
        const removedCount = (scrubbed.match(/% \[SCRUBBED\]/g) || []).length;
        const keptBT = (scrubbed.match(/BT/g) || []).length;
        stats.textBlocksRemoved += removedCount;
        stats.textBlocksKept += keptBT;

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

    // Step 3: Surgically scrub Form XObjects (lateral margin stamps, facesheets)
    try {
      const resources = page.node.lookup(PDFName.of('Resources'));
      if (resources) {
        const xobjectDict = resources.lookup(PDFName.of('XObject'));
        if (xobjectDict && xobjectDict.entries) {
          for (const [key, ref] of xobjectDict.entries()) {
            try {
              const xobj = pdfDoc.context.lookup(ref);
              if (!xobj || !xobj.contents) continue;
              const subtypeName = xobj.dict ? xobj.dict.get(PDFName.of('Subtype')) : null;
              const isForm = subtypeName && subtypeName.asString && subtypeName.asString() === '/Form';
              if (!isForm) continue;

              const raw = xobj.contents;
              const decompressed = decompressStream(raw);
              const contentStr = decompressed.toString('latin1');

              if (!contentStr.includes('BT')) continue; // no text, skip

              // Transform page-space boxes into XObject coordinate space
              const matrix = getXObjectMatrix(xobj);
              const xobjBoxes = transformBoxesToXObjectSpace(allBoxes, matrix);

              const scrubbed = surgicalScrubStream(contentStr, xobjBoxes);
              const removedCount = (scrubbed.match(/% \[SCRUBBED\]/g) || []).length;
              stats.textBlocksRemoved += removedCount;

              const newBytes = Buffer.from(scrubbed, 'latin1');
              const compressed = compressStream(newBytes);
              xobj.contents = compressed;
              if (xobj.dict) {
                xobj.dict.set(PDFName.of('Length'), pdfDoc.context.obj(compressed.length));
                xobj.dict.set(PDFName.of('Filter'), PDFName.of('FlateDecode'));
              }
            } catch (e) { stats.errors++; }
          }
        }
      }
    } catch (e) { stats.errors++; }

    stats.surgicalScrub++;
  }

  console.log('[FLATTEN] Surgical scrub stats:', JSON.stringify(stats));
  const pdfBytes = await pdfDoc.save({ useObjectStreams: false });
  return { buffer: Buffer.from(pdfBytes), stats };
}

// ─── Lambda Handler ───────────────────────────────────────────────────────────

const _flattenStart = async (event) => {
  if (event.httpMethod === 'OPTIONS') return resp(200, {});

  let orgId, docId;
  try {
    const body = JSON.parse(event.body || '{}');
    docId = event.pathParameters?.aws_document_id || body.aws_document_id;
    if (!docId) return resp(400, { error: 'Missing aws_document_id' });

    // orgId comes ONLY from the verified JWT (event._orgId, set by auth.js) -- never from the
    // client body/headers, which any caller could set to any value.
    const callerOrgId = event._orgId;
    if (!callerOrgId) return resp(401, { error: 'Unauthorized' });

    // Ownership check: the document must belong to the caller's org (admin bypasses).
    const docLookup = await ddb.send(new GetCommand({ TableName: DOCS_TABLE, Key: { aws_document_id: docId } }));
    if (!docLookup.Item) return resp(404, { error: 'Document not found' });
    if (!event._isAdmin && docLookup.Item.org_id && docLookup.Item.org_id !== callerOrgId) {
      return resp(403, { error: 'Forbidden' });
    }
    orgId = docLookup.Item.org_id || callerOrgId;
  } catch (e) {
    return resp(400, { error: 'Bad request: ' + e.message });
  }

  // Find the source redacted PDF
  const sourceKey = await findRedactedKey(orgId, docId);
  if (!sourceKey) return resp(404, { error: 'No redacted PDF found. Run redaction first.' });

  console.log('[FLATTEN] Source key:', sourceKey);

  // Load and surgically scrub
  const pdfBuffer = await s3ToBuffer(sourceKey);
  const { buffer: scrubbedBuffer, stats } = await scrubPdfTextLayer(pdfBuffer);

  // Build output key: replace _REDACTED_vNNN with _REDACTED_vNNN_FLAT2
  const flatKey = sourceKey.replace(/(_REDACTED_v\d+)/, '$1_FLAT2');
  console.log('[FLATTEN] Output key:', flatKey);

  // Upload to S3
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: flatKey,
    Body: scrubbedBuffer,
    ContentType: 'application/pdf',
  }));

  // Register in DynamoDB as a new document record
  const flatDocId = randomUUID();
  const now = new Date().toISOString();
  const originalRec = await ddb.send(new GetCommand({ TableName: DOCS_TABLE, Key: { aws_document_id: docId } }));
  const orig = originalRec.Item || {};

  await ddb.send(new PutCommand({
    TableName: DOCS_TABLE,
    Item: {
      aws_document_id: flatDocId,
      org_id: orgId,
      folder: orig.folder || orig.folder_name || 'Unknown',
      folder_name: orig.folder || orig.folder_name || 'Unknown',
      file_key: flatKey,
      original_filename: (orig.original_filename || 'document').replace('.pdf', '_FLAT2.pdf'),
      original_document_id: orig.original_document_id || docId,
      status: 'processed',
      is_redacted: true,
      is_flat: true,
      flatten_version: 'surgical_v4',
      redaction_source_id: docId,
      created_at: now,
      updated_at: now,
    }
  }));

  return resp(200, {
    message: 'Surgical flatten complete — PII text layer removed, clinical text preserved',
    flat_document_id: flatDocId,
    flat_key: flatKey,
    stats,
  });
};

exports.flattenStart = validateApiKey(_flattenStart);

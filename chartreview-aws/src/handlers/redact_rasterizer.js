// redact_rasterizer.js — ChartReview Pro page rasterizer
// Updated: 2026-05-26 — Dedicated Lambda with pdfjs+canvas layer, renders single PDF page to PNG
// Called by redactDocumentWorker; returns { imageBase64, width, height }
// Layer provides: pdfjs-dist, canvas  (at /opt/nodejs/node_modules/)

'use strict';

// When running in Lambda with layer, modules are at /opt/nodejs/node_modules/
// Fall back to local node_modules for local testing
function requireLayer(mod) {
  try { return require('/opt/nodejs/node_modules/' + mod); }
  catch(e) { return require(mod); }
}

const pdfjsLib = requireLayer('pdfjs-dist/legacy/build/pdf.js');
const { createCanvas } = requireLayer('canvas');

const RENDER_SCALE = 2.0; // 2x = ~150 DPI on standard letter page — clear for Claude

module.exports.handler = async function(event) {
  const { pdfBase64, pageIndex } = event;

  if (pdfBase64 === undefined || pageIndex === undefined) {
    return { error: 'Missing pdfBase64 or pageIndex' };
  }

  try {
    const pdfBytes  = Buffer.from(pdfBase64, 'base64');
    const pdfDoc    = await pdfjsLib.getDocument({ data: pdfBytes }).promise;
    const page      = await pdfDoc.getPage(pageIndex + 1); // pdfjs is 1-indexed

    const viewport  = page.getViewport({ scale: RENDER_SCALE });
    const imgW      = Math.round(viewport.width);
    const imgH      = Math.round(viewport.height);

    const canvas    = createCanvas(imgW, imgH);
    const ctx       = canvas.getContext('2d');

    // White background
    ctx.fillStyle   = '#ffffff';
    ctx.fillRect(0, 0, imgW, imgH);

    await page.render({ canvasContext: ctx, viewport }).promise;

    const pngBuffer = canvas.toBuffer('image/png');

    return {
      imageBase64: pngBuffer.toString('base64'),
      width:       imgW,
      height:      imgH,
      pageIndex,
    };
  } catch (err) {
    console.error('[RASTERIZER] Error on page', pageIndex, err);
    return { error: err.message };
  }
};

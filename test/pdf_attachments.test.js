const assert = require('node:assert/strict');
const test = require('node:test');
const { PDFDocument } = require('pdf-lib');

const { mergeWithAttachments } = require('../src/pdf/ficha-renderer');

async function pdfWithPages(pageCount) {
  const pdf = await PDFDocument.create();
  for (let index = 0; index < pageCount; index += 1) {
    pdf.addPage();
  }
  return Buffer.from(await pdf.save());
}

test('appends every attachment page to the generated sheet', async () => {
  const merged = await mergeWithAttachments(
    await pdfWithPages(2),
    [await pdfWithPages(1), await pdfWithPages(3)]
  );

  const document = await PDFDocument.load(merged);
  assert.equal(document.getPageCount(), 6);
});

test('does not silently discard an invalid registered PDF', async () => {
  await assert.rejects(
    mergeWithAttachments(await pdfWithPages(1), [Buffer.from('not-a-pdf')]),
    /Não foi possível mesclar um anexo PDF/
  );
});

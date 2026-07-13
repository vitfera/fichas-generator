const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const generateSheetsSource = fs.readFileSync(
  path.join(__dirname, '..', 'generate_sheets.js'),
  'utf-8'
);

test('generate form does not show legacy optimization badge or alert', () => {
  assert.equal(generateSheetsSource.includes('performance-badge'), false);
  assert.equal(generateSheetsSource.includes('<span class="performance-badge">OTIMIZADO</span>'), false);
  assert.equal(generateSheetsSource.includes('<strong>Melhorias:</strong>'), false);
  assert.equal(generateSheetsSource.includes('Consultas em batch, cache, processamento paralelo'), false);
});

test('generate form includes generated files block for selected opportunity', () => {
  assert.equal(generateSheetsSource.includes("app.get('/generated-files'"), true);
  assert.equal(generateSheetsSource.includes('generatedFilesBlock'), true);
  assert.equal(generateSheetsSource.includes('Arquivos já gerados'), true);
  assert.equal(generateSheetsSource.includes("fetch('/generated-files?parent='"), true);
});

test('generated files block is rendered outside the generation form card', () => {
  const formStart = generateSheetsSource.indexOf('<form id="formGenerate"');
  const formEnd = generateSheetsSource.indexOf('</form>', formStart);
  const formHtml = generateSheetsSource.slice(formStart, formEnd);

  assert.equal(formStart > -1, true);
  assert.equal(formEnd > formStart, true);
  assert.equal(formHtml.includes('generatedFilesBlock'), false);
});

test('generated files list does not use internal scrolling', () => {
  assert.equal(/\.generated-files-list\s*\{[^}]*max-height/.test(generateSheetsSource), false);
  assert.equal(/\.generated-files-list\s*\{[^}]*overflow/.test(generateSheetsSource), false);
});

test('generation result page uses the generated files card layout', () => {
  const resultPageStart = generateSheetsSource.indexOf('const generatedResultFiles =');
  const resultPageEnd = generateSheetsSource.indexOf('res.send(html);', resultPageStart);
  const resultPageSource = generateSheetsSource.slice(resultPageStart, resultPageEnd);

  assert.equal(resultPageStart > -1, true);
  assert.equal(resultPageEnd > resultPageStart, true);
  assert.equal(resultPageSource.includes('<strong>Lista de PDFs gerados:</strong>'), false);
  assert.equal(resultPageSource.includes('renderGeneratedFilesCard({'), true);
  assert.equal(resultPageSource.includes("title: 'Arquivos gerados'"), true);
  assert.equal(resultPageSource.includes('files: generatedResultFiles'), true);
  assert.equal(resultPageSource.includes("type: 'zip'"), true);
  assert.equal(resultPageSource.includes("type: 'pdf'"), true);
});

test('generated files cards reuse the same server-side renderer', () => {
  const rendererMatches = generateSheetsSource.match(/function renderGeneratedFilesCard/g) || [];
  const rendererCallMatches = generateSheetsSource.match(/renderGeneratedFilesCard\(/g) || [];

  assert.equal(rendererMatches.length, 1);
  assert.equal(rendererCallMatches.length, 3);
});

test('generated files endpoint reuses server-rendered list markup', () => {
  const routeStart = generateSheetsSource.indexOf("app.get('/generated-files'");
  const routeEnd = generateSheetsSource.indexOf('////////////////////////////////////////////////////////////////////////////////', routeStart);
  const routeSource = generateSheetsSource.slice(routeStart, routeEnd);
  const scriptStart = generateSheetsSource.indexOf('const form = document.getElementById');
  const scriptEnd = generateSheetsSource.indexOf('</script>', scriptStart);
  const scriptSource = generateSheetsSource.slice(scriptStart, scriptEnd);

  assert.equal(routeSource.includes('html: renderGeneratedFilesList(files)'), true);
  assert.equal(scriptSource.includes('generatedFilesContent.innerHTML = html;'), true);
  assert.equal(scriptSource.includes('function escapeHtml(value)'), false);
});

test('generate form includes attachment mode select defaulting to ficha plus anexos', () => {
  const formStart = generateSheetsSource.indexOf('<form id="formGenerate"');
  const formEnd = generateSheetsSource.indexOf('</form>', formStart);
  const formHtml = generateSheetsSource.slice(formStart, formEnd);

  assert.equal(formHtml.includes('name="attachmentMode"'), true);
  assert.equal(formHtml.includes('id="attachmentMode"'), true);
  assert.equal(formHtml.includes('Incluir anexos:'), true);
  assert.equal(formHtml.includes('<option value="with_attachments" selected>Ficha + anexos</option>'), true);
  assert.equal(formHtml.includes('<option value="sheet_only">Somente ficha</option>'), true);
});

test('generate route validates attachment mode and keeps current behavior as default', () => {
  const routeStart = generateSheetsSource.indexOf("app.post('/generate'");
  const routeEnd = generateSheetsSource.indexOf('const generatedResultFiles =', routeStart);
  const routeSource = generateSheetsSource.slice(routeStart, routeEnd);

  assert.equal(routeSource.includes("const attachmentMode = req.body.attachmentMode || 'with_attachments';"), true);
  assert.equal(routeSource.includes("const validAttachmentModes = ['with_attachments', 'sheet_only'];"), true);
  assert.equal(routeSource.includes('if (!validAttachmentModes.includes(attachmentMode))'), true);
  assert.equal(routeSource.includes("return res.status(400).send('Tipo de geração inválido.');"), true);
  assert.equal(routeSource.includes("const includeAttachments = attachmentMode === 'with_attachments';"), true);
  assert.equal(routeSource.includes('generateFichas(parentId, filterType, includeAttachments)'), true);
});

test('sheet only mode skips attachment merge and writes separate generated filenames', () => {
  assert.equal(
    generateSheetsSource.includes("async function generateFichas(parentId, filterType = 'selected', includeAttachments = true)"),
    true
  );
  assert.equal(generateSheetsSource.includes('if (includeAttachments) {'), true);
  assert.equal(generateSheetsSource.includes('if (includeAttachments && attachmentBuffers.length)'), true);
  assert.equal(generateSheetsSource.includes("const filenameSuffix = includeAttachments ? '' : '_sem_anexos';"), true);
  assert.equal(generateSheetsSource.includes('`ficha_${parentId}_${regNumber}_${nomeSemAcento}${filenameSuffix}.pdf`'), true);
  assert.equal(generateSheetsSource.includes('`fichas_${parentId}${filenameSuffix}.zip`'), true);
});

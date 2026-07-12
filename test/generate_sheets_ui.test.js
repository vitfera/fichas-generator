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

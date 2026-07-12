const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { listGeneratedFilesForOpportunity } = require('../generated_files');

test('listGeneratedFilesForOpportunity returns generated ZIP and PDFs for the selected parent', () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'generated-files-'));
  const files = [
    'fichas_123.zip',
    'ficha_123_AC001_maria.pdf',
    'ficha_123_AC002_joao.pdf',
    'fichas_456.zip',
    'ficha_456_AC003_ana.pdf',
    'ficha_123_not-a-pdf.txt',
    'random.pdf'
  ];

  for (const file of files) {
    fs.writeFileSync(path.join(outputDir, file), file);
  }

  const result = listGeneratedFilesForOpportunity(outputDir, 123);

  assert.deepEqual(result.map(file => file.name).sort(), [
    'ficha_123_AC001_maria.pdf',
    'ficha_123_AC002_joao.pdf',
    'fichas_123.zip'
  ]);
  assert.deepEqual(new Set(result.map(file => file.type)), new Set(['pdf', 'zip']));
  assert.equal(result.every(file => file.url.startsWith('/downloads/')), true);
});

test('listGeneratedFilesForOpportunity returns an empty list when output dir does not exist', () => {
  const missingDir = path.join(os.tmpdir(), `missing-generated-files-${Date.now()}`);

  assert.deepEqual(listGeneratedFilesForOpportunity(missingDir, 123), []);
});

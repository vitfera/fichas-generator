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

test('listGeneratedFilesForOpportunity returns an empty list for invalid parent ids', () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'generated-files-'));
  fs.writeFileSync(path.join(outputDir, 'fichas_123.zip'), 'zip');

  assert.deepEqual(listGeneratedFilesForOpportunity(outputDir, 0), []);
  assert.deepEqual(listGeneratedFilesForOpportunity(outputDir, -1), []);
  assert.deepEqual(listGeneratedFilesForOpportunity(outputDir, 'abc'), []);
});

test('listGeneratedFilesForOpportunity encodes download urls for special filenames', () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'generated-files-'));
  const filename = 'ficha_123_AC001_maria da silva.pdf';
  fs.writeFileSync(path.join(outputDir, filename), 'pdf');

  const [result] = listGeneratedFilesForOpportunity(outputDir, 123);

  assert.equal(result.name, filename);
  assert.equal(result.url, '/downloads/ficha_123_AC001_maria%20da%20silva.pdf');
});

test('listGeneratedFilesForOpportunity keeps zip first and sorts pdfs by newest modified time', () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'generated-files-'));
  const oldPdf = path.join(outputDir, 'ficha_123_AC001_antiga.pdf');
  const newPdf = path.join(outputDir, 'ficha_123_AC002_nova.pdf');
  const zip = path.join(outputDir, 'fichas_123.zip');

  fs.writeFileSync(oldPdf, 'old');
  fs.writeFileSync(newPdf, 'new');
  fs.writeFileSync(zip, 'zip');

  const oldTime = new Date('2026-01-01T00:00:00.000Z');
  const newTime = new Date('2026-01-02T00:00:00.000Z');
  fs.utimesSync(oldPdf, oldTime, oldTime);
  fs.utimesSync(newPdf, newTime, newTime);

  const result = listGeneratedFilesForOpportunity(outputDir, 123);

  assert.deepEqual(result.map(file => file.name), [
    'fichas_123.zip',
    'ficha_123_AC002_nova.pdf',
    'ficha_123_AC001_antiga.pdf'
  ]);
});

test('listGeneratedFilesForOpportunity includes sheet-only zip files', () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'generated-files-'));
  fs.writeFileSync(path.join(outputDir, 'fichas_123_sem_anexos.zip'), 'zip');
  fs.writeFileSync(path.join(outputDir, 'ficha_123_AC001_maria_sem_anexos.pdf'), 'pdf');

  const result = listGeneratedFilesForOpportunity(outputDir, 123);

  assert.deepEqual(result.map(file => file.name).sort(), [
    'ficha_123_AC001_maria_sem_anexos.pdf',
    'fichas_123_sem_anexos.zip'
  ]);
});

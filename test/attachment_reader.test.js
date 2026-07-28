const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { readAttachmentBuffers } = require('../src/pdf/attachment-reader');

function createFilesDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fichas-attachments-'));
}

function writeRegistrationFile(filesDir, registrationId, filename, contents) {
  const registrationDir = path.join(filesDir, String(registrationId));
  fs.mkdirSync(registrationDir, { recursive: true });
  fs.writeFileSync(path.join(registrationDir, filename), contents);
}

test('reads the valid PDF names selected by the database for every phase', () => {
  const filesDir = createFilesDir();
  writeRegistrationFile(filesDir, 2053771627, 'projeto.pdf', 'parent-pdf');
  writeRegistrationFile(filesDir, 1708867654, 'certidao.pdf', 'child-pdf');
  writeRegistrationFile(filesDir, 1708867654, 'arquivo-antigo.pdf', 'stale-pdf');

  const buffers = readAttachmentBuffers([
    { evalRegId: 2053771627, files: ['projeto.pdf'] },
    { evalRegId: 1708867654, files: ['certidao.pdf'] }
  ], filesDir);

  assert.deepEqual(buffers.map(buffer => buffer.toString()), [
    'parent-pdf',
    'child-pdf'
  ]);
});

test('does not silently generate a partial sheet when a registered PDF is missing', () => {
  const filesDir = createFilesDir();

  assert.throws(
    () => readAttachmentBuffers([
      { evalRegId: 2053771627, files: ['projeto.pdf'] }
    ], filesDir),
    /Anexo registrado não encontrado.*projeto\.pdf/
  );
});

test('deduplicates the same registered PDF path', () => {
  const filesDir = createFilesDir();
  writeRegistrationFile(filesDir, 10, 'documento.pdf', 'pdf');

  const buffers = readAttachmentBuffers([
    { evalRegId: 10, files: ['documento.pdf'] },
    { evalRegId: 10, files: ['documento.pdf'] }
  ], filesDir);

  assert.equal(buffers.length, 1);
});

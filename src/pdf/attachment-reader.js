/**
 * Lê do volume montado apenas os PDFs que o banco marcou como anexos válidos.
 *
 * Cada fase informa o registration_id físico (evalRegId) e os nomes retornados
 * pela tabela file. A raiz filesDir corresponde ao diretório registration/ do
 * armazenamento privado, inclusive quando ele é um volume remoto em produção.
 */

const fs = require('node:fs');
const path = require('node:path');

function readAttachmentBuffers(phases, filesDir) {
  const buffers = [];
  const seenPaths = new Set();

  for (const phase of phases) {
    if (!phase.evalRegId) continue;

    for (const fileName of phase.files || []) {
      if (!fileName.toLowerCase().endsWith('.pdf')) continue;
      if (path.basename(fileName) !== fileName) {
        throw new Error(`Nome de anexo inválido: ${fileName}`);
      }

      const filePath = path.join(filesDir, String(phase.evalRegId), fileName);
      if (seenPaths.has(filePath)) continue;
      seenPaths.add(filePath);

      if (!fs.existsSync(filePath)) {
        throw new Error(`Anexo registrado não encontrado no volume: ${fileName}`);
      }

      try {
        buffers.push(fs.readFileSync(filePath));
      } catch (error) {
        throw new Error(`Não foi possível ler o anexo registrado: ${fileName}`, { cause: error });
      }
    }
  }

  return buffers;
}

module.exports = { readAttachmentBuffers };

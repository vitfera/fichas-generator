const fs = require('fs');
const path = require('path');

function getGeneratedFileType(filename) {
  if (filename.endsWith('.zip')) return 'zip';
  if (filename.endsWith('.pdf')) return 'pdf';
  return 'file';
}

function isGeneratedFileForOpportunity(filename, parentId) {
  const id = String(parentId);
  return filename === `fichas_${id}.zip` ||
    filename === `fichas_${id}_sem_anexos.zip` || (
    filename.startsWith(`ficha_${id}_`) && filename.endsWith('.pdf')
  );
}

function listGeneratedFilesForOpportunity(outputDir, parentId) {
  if (!Number.isInteger(Number(parentId)) || Number(parentId) <= 0) {
    return [];
  }

  if (!fs.existsSync(outputDir)) {
    return [];
  }

  return fs.readdirSync(outputDir)
    .filter(filename => isGeneratedFileForOpportunity(filename, parentId))
    .map(filename => {
      const filepath = path.join(outputDir, filename);
      const stats = fs.statSync(filepath);

      return {
        name: filename,
        url: `/downloads/${encodeURIComponent(filename)}`,
        type: getGeneratedFileType(filename),
        size: stats.size,
        mtime: stats.mtime.toISOString()
      };
    })
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === 'zip' ? -1 : 1;
      return b.mtime.localeCompare(a.mtime);
    });
}

module.exports = {
  listGeneratedFilesForOpportunity
};

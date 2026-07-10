const fs = require('fs');
const path = require('path');

function resolveLogoPath(env, projectRoot) {
  const configuredPath = env.LOGO_PATH && env.LOGO_PATH.trim();
  if (!configuredPath) {
    return path.join(projectRoot, 'assets', 'logo.png');
  }

  return path.isAbsolute(configuredPath)
    ? configuredPath
    : path.join(projectRoot, configuredPath);
}

function loadLogoBase64({ env = process.env, projectRoot = __dirname, warn = console.warn } = {}) {
  const logoPath = resolveLogoPath(env, projectRoot);

  try {
    return fs.readFileSync(logoPath).toString('base64');
  } catch (err) {
    warn(`Atenção: não foi possível ler a logo em ${logoPath} para incorporar no PDF.`);
    return '';
  }
}

module.exports = {
  loadLogoBase64,
  resolveLogoPath
};

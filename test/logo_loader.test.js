const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { loadLogoBase64, resolveLogoPath } = require('../logo_loader');

test('resolveLogoPath trims LOGO_PATH before resolving it', () => {
  const result = resolveLogoPath({ LOGO_PATH: '  assets/custom-logo.png  ' }, '/project');

  assert.equal(result, path.join('/project', 'assets/custom-logo.png'));
});

test('resolveLogoPath falls back to assets/logo.png when LOGO_PATH is blank', () => {
  const result = resolveLogoPath({ LOGO_PATH: '   ' }, '/project');

  assert.equal(result, path.join('/project', 'assets', 'logo.png'));
});

test('loadLogoBase64 uses LOGO_PATH when it is absolute', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logo-loader-'));
  const logoPath = path.join(tmpDir, 'custom-logo.png');
  const logoBuffer = Buffer.from('custom logo');
  fs.writeFileSync(logoPath, logoBuffer);

  const result = loadLogoBase64({ env: { LOGO_PATH: logoPath }, projectRoot: __dirname });

  assert.equal(result, logoBuffer.toString('base64'));
});

test('loadLogoBase64 resolves relative LOGO_PATH from the project root', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logo-loader-'));
  const logoBuffer = Buffer.from('relative logo');
  fs.mkdirSync(path.join(tmpDir, 'custom-assets'));
  fs.writeFileSync(path.join(tmpDir, 'custom-assets', 'logo.png'), logoBuffer);

  const result = loadLogoBase64({
    env: { LOGO_PATH: 'custom-assets/logo.png' },
    projectRoot: tmpDir
  });

  assert.equal(result, logoBuffer.toString('base64'));
});

test('loadLogoBase64 falls back to assets/logo.png when LOGO_PATH is empty', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logo-loader-'));
  const logoBuffer = Buffer.from('fallback logo');
  fs.mkdirSync(path.join(tmpDir, 'assets'));
  fs.writeFileSync(path.join(tmpDir, 'assets', 'logo.png'), logoBuffer);

  const result = loadLogoBase64({ env: {}, projectRoot: tmpDir });

  assert.equal(result, logoBuffer.toString('base64'));
});

test('loadLogoBase64 returns empty string and warns when logo file is missing', () => {
  const messages = [];
  const result = loadLogoBase64({
    env: { LOGO_PATH: 'missing-logo.png' },
    projectRoot: '/project',
    warn: message => messages.push(message)
  });

  assert.equal(result, '');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].includes('/project/missing-logo.png'), true);
});

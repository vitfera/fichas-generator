const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.join(__dirname, '..');

test('project exposes a single generate_sheets.js entrypoint', () => {
  const removedFiles = [
    'generate_sheets_optimized.js',
    'generate_sheets_ultra_optimized.js',
    'cache_manager.js',
    'test_performance.sh',
    'ACTIVATION_GUIDE.md'
  ];

  for (const file of removedFiles) {
    assert.equal(fs.existsSync(path.join(projectRoot, file)), false, `${file} should not exist`);
  }
});

test('documentation does not reference removed generator variants', () => {
  const docs = [
    'README.md',
    'INSTALLATION_GUIDE.md',
    'PERFORMANCE_COMPARISON.md',
    'PRODUCTION_TEST_GUIDE.md',
    'deploy-test.sh'
  ];
  const obsoletePatterns = [
    /generate_sheets_optimized\.js/,
    /generate_sheets_ultra_optimized\.js/,
    /test_performance\.sh/,
    /ACTIVATION_GUIDE\.md/,
    /USE_REDIS/,
    /REDIS_/,
    /\/stats/,
    /\/clear-cache/
  ];

  for (const doc of docs) {
    const content = fs.readFileSync(path.join(projectRoot, doc), 'utf-8');
    for (const pattern of obsoletePatterns) {
      assert.equal(pattern.test(content), false, `${doc} should not contain ${pattern}`);
    }
  }
});

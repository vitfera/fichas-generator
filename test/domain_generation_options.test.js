const assert = require('node:assert/strict');
const test = require('node:test');

const {
  REGISTRATION_FILTERS,
  ATTACHMENT_MODES,
  isValidFilterType,
  isValidAttachmentMode,
  statusFilterFor,
  includesAttachments
} = require('../src/domain/generation-options');

test('registration filters map to the expected registration statuses', () => {
  assert.equal(statusFilterFor('selected'), 'r.status = 10');
  assert.equal(statusFilterFor('selected_and_alternate'), 'r.status IN (8, 10)');
  assert.equal(statusFilterFor('all'), 'r.status != 0');
});

test('an unknown filter falls back to selected only', () => {
  assert.equal(statusFilterFor('inexistente'), 'r.status = 10');
  assert.equal(statusFilterFor(undefined), 'r.status = 10');
});

test('only the documented filters are accepted', () => {
  assert.equal(isValidFilterType('selected'), true);
  assert.equal(isValidFilterType('selected_and_alternate'), true);
  assert.equal(isValidFilterType('all'), true);
  assert.equal(isValidFilterType('todas'), false);
  assert.equal(isValidFilterType(''), false);
});

test('only the documented attachment modes are accepted', () => {
  assert.equal(isValidAttachmentMode('with_attachments'), true);
  assert.equal(isValidAttachmentMode('sheet_only'), true);
  assert.equal(isValidAttachmentMode('zip'), false);
});

test('attachments are included only in with_attachments mode', () => {
  assert.equal(includesAttachments('with_attachments'), true);
  assert.equal(includesAttachments('sheet_only'), false);
});

test('every option offered in the form is also accepted by the validation', () => {
  for (const filter of REGISTRATION_FILTERS) {
    assert.equal(isValidFilterType(filter.value), true, `filtro ${filter.value}`);
    assert.equal(typeof filter.label, 'string');
    assert.notEqual(filter.label, '');
  }
  for (const mode of ATTACHMENT_MODES) {
    assert.equal(isValidAttachmentMode(mode.value), true, `modo ${mode.value}`);
  }
});

test('exactly one attachment mode is pre-selected in the form', () => {
  assert.equal(ATTACHMENT_MODES.filter(mode => mode.selected).length, 1);
  assert.equal(ATTACHMENT_MODES.find(mode => mode.selected).value, 'with_attachments');
});

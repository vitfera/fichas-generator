const assert = require('node:assert/strict');
const test = require('node:test');
const { selectRegistrationsForGeneration } = require('../src/domain/registration-selection');

const pending = { registration_id: 101, registration_status: 1, matches_filter: true };
const selected = { registration_id: 102, registration_status: 10, matches_filter: false };
const draft = { registration_id: 103, registration_status: 0, matches_filter: false };

test('pending generation prioritizes matching registrations in the parent phase', () => {
  const result = selectRegistrationsForGeneration({ 34: [pending, draft], 36: [pending] }, 34, [{ id: 36 }]);
  assert.deepEqual(result, { chosenPhaseId: 34, registrations: [pending] });
});

test('a fallback child phase also respects the chosen registration filter', () => {
  const childRegistrations = [pending, selected, draft];
  const result = selectRegistrationsForGeneration({ 34: [], 36: childRegistrations }, 34, [{ id: 36 }]);
  assert.deepEqual(result, { chosenPhaseId: 36, registrations: [pending] });
  assert.deepEqual(childRegistrations, [pending, selected, draft]);
});

test('a child phase with no matching registrations is skipped', () => {
  const result = selectRegistrationsForGeneration({ 36: [selected], 37: [pending] }, 34, [{ id: 36 }, { id: 37 }]);
  assert.deepEqual(result, { chosenPhaseId: 37, registrations: [pending] });
});

test('no matching registrations cannot produce sheets for other statuses', () => {
  const result = selectRegistrationsForGeneration({ 34: [], 36: [selected, draft] }, 34, [{ id: 36 }]);
  assert.deepEqual(result, { chosenPhaseId: null, registrations: [] });
});

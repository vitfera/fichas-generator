const assert = require('node:assert/strict');
const test = require('node:test');

const {
  parseEvaluationData,
  processEvaluation,
  processAppealResult,
  buildSectionsWithCriteria
} = require('../src/domain/evaluation');

const TECHNICAL_SECTIONS = [
  {
    id: 's1',
    name: 'Mérito Cultural',
    criteria: [
      { id: 'c1', title: 'Relevância' },
      { id: 'c2', title: 'Originalidade' }
    ]
  }
];

const noSections = async () => [];
const withSections = async () => TECHNICAL_SECTIONS;

test('processEvaluation returns an empty result when there is no evaluation', async () => {
  for (const input of [undefined, null, []]) {
    const result = await processEvaluation(1, input, withSections);
    assert.deepEqual(result, { evaluations: [], hasTechnical: false, hasSimplified: false });
  }
});

test('processEvaluation maps technical criteria scores by criterion id', async () => {
  const result = await processEvaluation(1, [
    { evaluation_data: JSON.stringify({ c1: '8', c2: 5, obs: 'Bom projeto', status: '10' }), total_score: 13 }
  ], withSections);

  assert.equal(result.hasTechnical, true);
  assert.equal(result.hasSimplified, false);
  assert.equal(result.evaluations.length, 1);

  const [evaluation] = result.evaluations;
  assert.equal(evaluation.evaluator, '#1');
  assert.equal(evaluation.total, 13);
  assert.equal(evaluation.parecer, 'Bom projeto');
  assert.equal(evaluation.status, '10');
  assert.deepEqual(evaluation.sections, [
    {
      sectionTitle: 'Mérito Cultural',
      criteria: [
        { label: 'Relevância', score: 8 },
        { label: 'Originalidade', score: 5 }
      ]
    }
  ]);
});

test('processEvaluation scores missing or non-numeric criteria as zero', async () => {
  const result = await processEvaluation(1, [
    { evaluation_data: { c1: 'não informado' }, total_score: 0 }
  ], withSections);

  assert.deepEqual(
    result.evaluations[0].sections[0].criteria.map(c => c.score),
    [0, 0]
  );
});

test('processEvaluation numbers each evaluator sequentially', async () => {
  const result = await processEvaluation(1, [
    { evaluation_data: { c1: 1 }, total_score: 1 },
    { evaluation_data: { c1: 2 }, total_score: 2 }
  ], withSections);

  assert.deepEqual(result.evaluations.map(e => e.evaluator), ['#1', '#2']);
});

test('processEvaluation loads the phase sections only once per phase', async () => {
  let calls = 0;
  const countingLoader = async () => {
    calls++;
    return TECHNICAL_SECTIONS;
  };

  await processEvaluation(1, [
    { evaluation_data: { c1: 1 }, total_score: 1 },
    { evaluation_data: { c1: 2 }, total_score: 2 },
    { evaluation_data: { c1: 3 }, total_score: 3 }
  ], countingLoader);

  assert.equal(calls, 1);
});

test('processEvaluation falls back to a simplified evaluation when the phase has no sections', async () => {
  const result = await processEvaluation(1, [
    { evaluation_data: JSON.stringify({ obs: 'Aprovado' }), total_score: 7 }
  ], noSections);

  assert.equal(result.hasTechnical, false);
  assert.equal(result.hasSimplified, true);
  assert.deepEqual(result.evaluations[0].sections, []);
  assert.equal(result.evaluations[0].total, 7);
});

test('processEvaluation is not simplified when there is no score at all', async () => {
  const result = await processEvaluation(1, [
    { evaluation_data: {}, total_score: 0 }
  ], noSections);

  assert.equal(result.hasSimplified, false);
});

test('processEvaluation survives malformed evaluation data', async () => {
  for (const rawEval of ['{quebrado', null, 42, 'texto solto']) {
    const result = await processEvaluation(1, [{ evaluation_data: rawEval, total_score: 0 }], noSections);
    assert.equal(result.evaluations.length, 1);
    assert.equal(result.evaluations[0].parecer, '');
    assert.equal(result.evaluations[0].status, '');
  }
});

test('parseEvaluationData always yields an object', () => {
  assert.deepEqual(parseEvaluationData('{"a":1}'), { a: 1 });
  assert.deepEqual(parseEvaluationData('{quebrado'), {});
  assert.deepEqual(parseEvaluationData(null), {});
  assert.deepEqual(parseEvaluationData(7), {});
  assert.deepEqual(parseEvaluationData({ a: 1 }), { a: 1 });
});

test('processAppealResult uses appeal-specific labels', () => {
  const result = processAppealResult([
    { evaluation_data: JSON.stringify({ status: 10, obs: 'Recurso aceito' }), total_score: 0 }
  ], 3);

  assert.equal(result.statusText, 'Deferido');
  assert.equal(result.parecer, 'Recurso aceito');
});

test('processAppealResult considers only the last evaluation', () => {
  const result = processAppealResult([
    { evaluation_data: { status: 2, obs: 'Primeira análise' }, total_score: 0 },
    { evaluation_data: { status: 10, obs: 'Análise final' }, total_score: 0 }
  ], 1);

  assert.equal(result.statusText, 'Deferido');
  assert.equal(result.parecer, 'Análise final');
});

test('processAppealResult falls back to the registration status without evaluations', () => {
  assert.deepEqual(processAppealResult([], 2), { statusText: 'Negado', parecer: '' });
  assert.deepEqual(processAppealResult(null, 1), { statusText: 'Aguardando resposta', parecer: '' });
});

test('processAppealResult falls back to the total score when the evaluation has no status', () => {
  const result = processAppealResult([{ evaluation_data: { obs: 'Sem status' }, total_score: 10 }], 1);
  assert.equal(result.statusText, 'Deferido');
});

test('buildSectionsWithCriteria groups criteria under their section', () => {
  const sections = buildSectionsWithCriteria(
    [{ id: 's1', name: 'Seção A' }, { id: 's2', name: 'Seção B' }],
    [
      { id: 'c1', title: 'Critério 1', sid: 's1' },
      { id: 'c2', title: 'Critério 2', sid: 's2' },
      { id: 'c3', title: 'Critério 3', sid: 's1' }
    ]
  );

  assert.deepEqual(sections.map(s => s.criteria.map(c => c.id)), [['c1', 'c3'], ['c2']]);
});

test('buildSectionsWithCriteria tolerates missing metadata', () => {
  assert.deepEqual(buildSectionsWithCriteria(null, null), []);
  assert.deepEqual(buildSectionsWithCriteria([{ id: 's1', name: 'A' }], null), [
    { id: 's1', name: 'A', criteria: [] }
  ]);
});

const assert = require('node:assert/strict');
const test = require('node:test');

const { renderFichaHtml } = require('../src/pdf/ficha-renderer');

function fichaData(overrides = {}) {
  return {
    registration_number: 'EG1234',
    agent: { id: 42, name: 'Ana Cultural' },
    phases: [],
    ...overrides
  };
}

test('the sheet shows the registration number and the agent data', () => {
  const html = renderFichaHtml(fichaData());

  assert.match(html, /EG1234/);
  assert.match(html, /Ana Cultural/);
  assert.match(html, /DADOS DO AGENTE CULTURAL/);
});

test('the sheet renders each phase with its fields and attachments', () => {
  const html = renderFichaHtml(fichaData({
    phases: [{
      id: 9,
      name: 'Inscrição',
      isAppealPhase: false,
      rows: [{ label: 'Título do projeto', value: 'Sarau na Praça' }],
      evaluation: { evaluations: [], hasTechnical: false, hasSimplified: false },
      appealResult: null,
      regStatusText: 'Selecionada',
      files: ['portfolio.pdf']
    }]
  }));

  assert.match(html, /Título do projeto/);
  assert.match(html, /Sarau na Praça/);
  assert.match(html, /Anexos/);
  assert.match(html, /portfolio\.pdf/);
});

test('the sheet omits the attachments block when the phase has no files', () => {
  const html = renderFichaHtml(fichaData({
    phases: [{
      id: 9,
      name: 'Inscrição',
      isAppealPhase: false,
      rows: [],
      evaluation: { evaluations: [], hasTechnical: false, hasSimplified: false },
      appealResult: null,
      regStatusText: '',
      files: []
    }]
  }));

  assert.doesNotMatch(html, /Anexos/);
});

test('the first phase gets the fixed heading and the others keep their own name', () => {
  const emptyPhase = name => ({
    id: 1,
    name,
    isAppealPhase: false,
    rows: [],
    evaluation: { evaluations: [], hasTechnical: false, hasSimplified: false },
    appealResult: null,
    regStatusText: '',
    files: []
  });

  const html = renderFichaHtml(fichaData({
    phases: [emptyPhase('Nome ignorado da primeira fase'), emptyPhase('Habilitação Documental')]
  }));

  assert.match(html, /Fase de Inscrições/);
  assert.doesNotMatch(html, /Nome ignorado da primeira fase/);
  assert.match(html, /Habilitação Documental/);
});

test('the sheet renders technical evaluation sections, criteria and scores', () => {
  const html = renderFichaHtml(fichaData({
    phases: [{
      id: 10,
      name: 'Fase de Avaliação',
      isAppealPhase: false,
      rows: [],
      evaluation: {
        evaluations: [{
          evaluator: '#1',
          sections: [{
            sectionTitle: 'Mérito Cultural',
            criteria: [{ label: 'Relevância', score: 8 }]
          }],
          status: '10',
          parecer: 'Projeto consistente',
          total: 8,
          hasTechnical: true,
          hasSimplified: false
        }],
        hasTechnical: true,
        hasSimplified: false
      },
      appealResult: null,
      regStatusText: 'Selecionada',
      files: []
    }]
  }));

  assert.match(html, /Análise de Mérito/);
  assert.match(html, /Mérito Cultural/);
  assert.match(html, /Relevância/);
  assert.match(html, /Projeto consistente/);
  // O status da inscrição só é exibido junto ao bloco de avaliação
  assert.match(html, /Status da Inscrição/);
  assert.match(html, /Selecionada/);
});

test('the sheet renders an appeal phase with its result and justification', () => {
  const html = renderFichaHtml(fichaData({
    phases: [{
      id: 11,
      name: 'Recurso',
      isAppealPhase: true,
      rows: [],
      evaluation: { evaluations: [], hasTechnical: false, hasSimplified: false },
      appealResult: { statusText: 'Deferido', parecer: 'Recurso acolhido' },
      regStatusText: '',
      files: []
    }]
  }));

  assert.match(html, /Resultado do Recurso/);
  assert.match(html, /Status do Recurso/);
  assert.match(html, /Deferido/);
  assert.match(html, /Justificativa/);
  assert.match(html, /Recurso acolhido/);
});

test('the sheet embeds the bootstrap styles so the PDF keeps its layout', () => {
  const html = renderFichaHtml(fichaData());

  assert.match(html, /<style>/);
  assert.match(html, /\.container/);
});

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const generateSheetsSource = fs.readFileSync(
  path.join(__dirname, '..', 'generate_sheets.js'),
  'utf-8'
);
const templateSource = fs.readFileSync(
  path.join(__dirname, '..', 'templates', 'ficha-inscricao.html'),
  'utf-8'
);

function extractFunctionSource(source, functionName) {
  const start = source.indexOf(`function ${functionName}`);
  assert.notEqual(start, -1, `missing function ${functionName}`);

  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index++) {
    const char = source[index];
    if (char === '{') depth++;
    if (char === '}') depth--;
    if (depth === 0) return source.slice(start, index + 1);
  }

  throw new Error(`could not extract function ${functionName}`);
}

const formatValueSource = extractFunctionSource(generateSheetsSource, 'formatValue');
const formatHelpersStart = generateSheetsSource.indexOf('const PEOPLE_FIELD_LABELS');
const formatHelpersEnd = generateSheetsSource.indexOf(formatValueSource) + formatValueSource.length;
const formatValue = Function(
  `${generateSheetsSource.slice(formatHelpersStart, formatHelpersEnd)}; return formatValue;`
)();

test('generate form does not show legacy optimization badge or alert', () => {
  assert.equal(generateSheetsSource.includes('performance-badge'), false);
  assert.equal(generateSheetsSource.includes('<span class="performance-badge">OTIMIZADO</span>'), false);
  assert.equal(generateSheetsSource.includes('<strong>Melhorias:</strong>'), false);
  assert.equal(generateSheetsSource.includes('Consultas em batch, cache, processamento paralelo'), false);
});

test('generate form includes generated files block for selected opportunity', () => {
  assert.equal(generateSheetsSource.includes("app.get('/generated-files'"), true);
  assert.equal(generateSheetsSource.includes('generatedFilesBlock'), true);
  assert.equal(generateSheetsSource.includes('Arquivos já gerados'), true);
  assert.equal(generateSheetsSource.includes("fetch('/generated-files?parent='"), true);
});

test('generated files block is rendered outside the generation form card', () => {
  const formStart = generateSheetsSource.indexOf('<form id="formGenerate"');
  const formEnd = generateSheetsSource.indexOf('</form>', formStart);
  const formHtml = generateSheetsSource.slice(formStart, formEnd);

  assert.equal(formStart > -1, true);
  assert.equal(formEnd > formStart, true);
  assert.equal(formHtml.includes('generatedFilesBlock'), false);
});

test('generated files list does not use internal scrolling', () => {
  assert.equal(/\.generated-files-list\s*\{[^}]*max-height/.test(generateSheetsSource), false);
  assert.equal(/\.generated-files-list\s*\{[^}]*overflow/.test(generateSheetsSource), false);
});

test('generation result page uses the generated files card layout', () => {
  const resultPageStart = generateSheetsSource.indexOf('const generatedResultFiles =');
  const resultPageEnd = generateSheetsSource.indexOf('res.send(html);', resultPageStart);
  const resultPageSource = generateSheetsSource.slice(resultPageStart, resultPageEnd);

  assert.equal(resultPageStart > -1, true);
  assert.equal(resultPageEnd > resultPageStart, true);
  assert.equal(resultPageSource.includes('<strong>Lista de PDFs gerados:</strong>'), false);
  assert.equal(resultPageSource.includes('renderGeneratedFilesCard({'), true);
  assert.equal(resultPageSource.includes("title: 'Arquivos gerados'"), true);
  assert.equal(resultPageSource.includes('files: generatedResultFiles'), true);
  assert.equal(resultPageSource.includes("type: 'zip'"), true);
  assert.equal(resultPageSource.includes("type: 'pdf'"), true);
});

test('generation result page highlights the opportunity name instead of only the id', () => {
  const routeStart = generateSheetsSource.indexOf("app.post('/generate'");
  const routeEnd = generateSheetsSource.indexOf('res.send(html);', routeStart);
  const routeSource = generateSheetsSource.slice(routeStart, routeEnd);

  assert.equal(generateSheetsSource.includes('async function fetchOpportunityById'), true);
  assert.equal(routeSource.includes('await fetchOpportunityById(parentId)'), true);
  assert.equal(routeSource.includes('${escapeHtml(opportunity.name)}'), true);
  assert.equal(routeSource.includes('Oportunidade #${parentId}'), true);
  assert.equal(routeSource.includes('Fichas geradas para oportunidade ${parentId}'), false);
});

test('generated files cards reuse the same server-side renderer', () => {
  const rendererMatches = generateSheetsSource.match(/function renderGeneratedFilesCard/g) || [];
  const rendererCallMatches = generateSheetsSource.match(/renderGeneratedFilesCard\(/g) || [];

  assert.equal(rendererMatches.length, 1);
  assert.equal(rendererCallMatches.length, 3);
});

test('generated files endpoint reuses server-rendered list markup', () => {
  const routeStart = generateSheetsSource.indexOf("app.get('/generated-files'");
  const routeEnd = generateSheetsSource.indexOf('////////////////////////////////////////////////////////////////////////////////', routeStart);
  const routeSource = generateSheetsSource.slice(routeStart, routeEnd);
  const scriptStart = generateSheetsSource.indexOf('const form = document.getElementById');
  const scriptEnd = generateSheetsSource.indexOf('</script>', scriptStart);
  const scriptSource = generateSheetsSource.slice(scriptStart, scriptEnd);

  assert.equal(routeSource.includes('html: renderGeneratedFilesList(files)'), true);
  assert.equal(scriptSource.includes('generatedFilesContent.innerHTML = html;'), true);
  assert.equal(scriptSource.includes('function escapeHtml(value)'), false);
});

test('generate form includes attachment mode select defaulting to ficha plus anexos', () => {
  const formStart = generateSheetsSource.indexOf('<form id="formGenerate"');
  const formEnd = generateSheetsSource.indexOf('</form>', formStart);
  const formHtml = generateSheetsSource.slice(formStart, formEnd);

  assert.equal(formHtml.includes('name="attachmentMode"'), true);
  assert.equal(formHtml.includes('id="attachmentMode"'), true);
  assert.equal(formHtml.includes('Incluir anexos:'), true);
  assert.equal(formHtml.includes('<option value="with_attachments" selected>Ficha + anexos</option>'), true);
  assert.equal(formHtml.includes('<option value="sheet_only">Somente ficha</option>'), true);
});

test('generate route validates attachment mode and keeps current behavior as default', () => {
  const routeStart = generateSheetsSource.indexOf("app.post('/generate'");
  const routeEnd = generateSheetsSource.indexOf('const generatedResultFiles =', routeStart);
  const routeSource = generateSheetsSource.slice(routeStart, routeEnd);

  assert.equal(routeSource.includes("const attachmentMode = req.body.attachmentMode || 'with_attachments';"), true);
  assert.equal(routeSource.includes("const validAttachmentModes = ['with_attachments', 'sheet_only'];"), true);
  assert.equal(routeSource.includes('if (!validAttachmentModes.includes(attachmentMode))'), true);
  assert.equal(routeSource.includes("return res.status(400).send('Tipo de geração inválido.');"), true);
  assert.equal(routeSource.includes("const includeAttachments = attachmentMode === 'with_attachments';"), true);
  assert.equal(routeSource.includes('generateFichas(parentId, filterType, includeAttachments)'), true);
});

test('generate route validates parent id and registration filter type', () => {
  const routeStart = generateSheetsSource.indexOf("app.post('/generate'");
  const routeEnd = generateSheetsSource.indexOf('let zipFilename;', routeStart);
  const routeSource = generateSheetsSource.slice(routeStart, routeEnd);

  assert.equal(routeSource.includes('const parentId = parseInt(req.body.parent, 10);'), true);
  assert.equal(routeSource.includes('if (isNaN(parentId))'), true);
  assert.equal(routeSource.includes("return res.status(400).send('Oportunidade inválida.');"), true);
  assert.equal(routeSource.includes("const validFilters = ['selected', 'selected_and_alternate', 'all'];"), true);
  assert.equal(routeSource.includes('if (!validFilters.includes(filterType))'), true);
  assert.equal(routeSource.includes("return res.status(400).send('Tipo de filtro inválido.');"), true);
});

test('generated files endpoint rejects invalid parent ids', () => {
  const routeStart = generateSheetsSource.indexOf("app.get('/generated-files'");
  const routeEnd = generateSheetsSource.indexOf('////////////////////////////////////////////////////////////////////////////////', routeStart);
  const routeSource = generateSheetsSource.slice(routeStart, routeEnd);

  assert.equal(routeSource.includes('const parentId = parseInt(req.query.parent, 10);'), true);
  assert.equal(routeSource.includes('if (isNaN(parentId))'), true);
  assert.equal(routeSource.includes("return res.status(400).json({ error: 'Oportunidade inválida.' });"), true);
});

test('sheet only mode skips attachment merge and writes separate generated filenames', () => {
  assert.equal(
    generateSheetsSource.includes("async function generateFichas(parentId, filterType = 'selected', includeAttachments = true)"),
    true
  );
  assert.equal(generateSheetsSource.includes('if (includeAttachments) {'), true);
  assert.equal(generateSheetsSource.includes('if (includeAttachments && attachmentBuffers.length)'), true);
  assert.equal(generateSheetsSource.includes("const filenameSuffix = includeAttachments ? '' : '_sem_anexos';"), true);
  assert.equal(generateSheetsSource.includes('`ficha_${parentId}_${regNumber}_${nomeSemAcento}${filenameSuffix}.pdf`'), true);
  assert.equal(generateSheetsSource.includes('`fichas_${parentId}${filenameSuffix}.zip`'), true);
});

test('people list fields render Portuguese labels and omit blank values', () => {
  const rawPeople = JSON.stringify([
    {
      name: 'John da Silva Meireles',
      fullName: '',
      socialName: '',
      cpf: '030.816.651-59',
      income: '',
      education: '',
      telephone: '',
      email: '',
      race: '',
      gender: '',
      sexualOrientation: '',
      deficiencies: {},
      comunty: '',
      area: [],
      funcao: ['Produtor Cultural']
    },
    {
      name: 'Raquel Pedrosa do Amaral',
      cpf: '708.666.181-39',
      funcao: []
    }
  ]);

  const formatted = formatValue(rawPeople, 'persons');

  assert.match(formatted, /Nome: John da Silva Meireles/);
  assert.match(formatted, /CPF: 030\.816\.651-59/);
  assert.match(formatted, /Funções\/Profissões: Produtor Cultural/);
  assert.match(formatted, /Nome: Raquel Pedrosa do Amaral/);
  assert.doesNotMatch(formatted, /\bname:/);
  assert.doesNotMatch(formatted, /\bfullName:/);
  assert.doesNotMatch(formatted, /Nome completo:\s*(;|<br\/>)/);
  assert.doesNotMatch(formatted, /Email do representante:\s*(;|<br\/>)/);
});

test('registration metadata formatting receives the field type from MapasCulturais', () => {
  const metaFunctionStart = generateSheetsSource.indexOf('async function fetchOrderedMetaForRegistrations');
  const metaFunctionEnd = generateSheetsSource.indexOf('// Cache para seções e critérios', metaFunctionStart);
  const metaFunctionSource = generateSheetsSource.slice(metaFunctionStart, metaFunctionEnd);

  assert.equal(metaFunctionSource.includes('rfc.field_type'), true);
  assert.equal(metaFunctionSource.includes('fieldType: row.field_type'), true);
  assert.equal(generateSheetsSource.includes('formatValue(item.value, item.fieldType)'), true);
});

test('relevant phases include appeal phases marked with MapasCulturais appeal status', () => {
  const phaseFunctionStart = generateSheetsSource.indexOf('async function fetchRelevantPhasesWithAppeals');
  const phaseFunctionEnd = generateSheetsSource.indexOf('// 6.4)', phaseFunctionStart);
  const phaseFunctionSource = generateSheetsSource.slice(phaseFunctionStart, phaseFunctionEnd);

  assert.equal(generateSheetsSource.includes('const OPPORTUNITY_STATUS_APPEAL_PHASE = -20;'), true);
  assert.equal(phaseFunctionStart > -1, true);
  assert.equal(phaseFunctionSource.includes('appeal.parent_id = main.id'), true);
  assert.equal(phaseFunctionSource.includes('appeal.status = $2'), true);
  assert.equal(phaseFunctionSource.includes("appeal_meta.key = 'isAppealPhase'"), true);
  assert.equal(phaseFunctionSource.includes('is_appeal_phase'), true);
  assert.equal(phaseFunctionSource.includes('ORDER BY sort_phase_id, sort_order, id'), true);
});

test('appeal phase registration is matched by registration number instead of agent only', () => {
  const phaseMapStart = generateSheetsSource.indexOf('const regIdsByPhase = {};');
  const phaseMapEnd = generateSheetsSource.indexOf('// 8.7.3)', phaseMapStart);
  const phaseMapSource = generateSheetsSource.slice(phaseMapStart, phaseMapEnd);

  assert.equal(phaseMapSource.includes('phase.isAppealPhase'), true);
  assert.equal(phaseMapSource.includes('r.registration_number === reg.registration_number'), true);
  assert.equal(phaseMapSource.includes('r.agent_id === reg.agent_id'), true);
  assert.equal(phaseMapSource.includes('registrationsByPhaseMatch[phase.id]'), true);
});

test('appeal phases without appeal registration do not inherit the main registration status', () => {
  const phasePromiseStart = generateSheetsSource.indexOf('const phasePromises = phases.map');
  const phasePromiseEnd = generateSheetsSource.indexOf('return {', phasePromiseStart);
  const phasePromiseSource = generateSheetsSource.slice(phasePromiseStart, phasePromiseEnd);

  assert.equal(phasePromiseSource.includes('phase.isAppealPhase ? null : reg.registration_status'), true);
});

test('appeal phases without appeal registration are not rendered for that sheet', () => {
  const phasePromiseStart = generateSheetsSource.indexOf('const phasePromises = phases.map');
  const phasePromiseEnd = generateSheetsSource.indexOf('// 8.7.4)', phasePromiseStart);
  const phasePromiseSource = generateSheetsSource.slice(phasePromiseStart, phasePromiseEnd);

  assert.equal(
    phasePromiseSource.includes('if (phase.isAppealPhase && (!phaseRegistration || phaseRegistration.registration_status === 0))'),
    true
  );
  assert.equal(phasePromiseSource.includes('return null;'), true);
  assert.equal(phasePromiseSource.includes('(await Promise.all(phasePromises)).filter(Boolean)'), true);
});

test('draft appeal registrations are not rendered for that sheet', () => {
  const phasePromiseStart = generateSheetsSource.indexOf('const phasePromises = phases.map');
  const phasePromiseEnd = generateSheetsSource.indexOf('// 8.7.4)', phasePromiseStart);
  const phasePromiseSource = generateSheetsSource.slice(phasePromiseStart, phasePromiseEnd);

  assert.equal(phasePromiseSource.includes('phaseRegistration.registration_status === 0'), true);
});

test('appeal result uses appeal-specific labels and is passed to the template', () => {
  assert.equal(generateSheetsSource.includes('const APPEAL_STATUS_LABELS = {'), true);
  assert.equal(generateSheetsSource.includes('1:  \'Aguardando resposta\''), true);
  assert.equal(generateSheetsSource.includes('2:  \'Negado\''), true);
  assert.equal(generateSheetsSource.includes('3:  \'Indeferido\''), true);
  assert.equal(generateSheetsSource.includes('10: \'Deferido\''), true);
  assert.equal(generateSheetsSource.includes('function processAppealResult'), true);
  assert.equal(generateSheetsSource.includes('appealResult: phase.isAppealPhase'), true);
});

test('file lookup groups attached file names by registration id and phase id', () => {
  const filesFunctionStart = generateSheetsSource.indexOf('async function fetchFilesForRegistrations');
  const filesFunctionEnd = generateSheetsSource.indexOf('// 6.10)', filesFunctionStart);
  const filesFunctionSource = generateSheetsSource.slice(filesFunctionStart, filesFunctionEnd);

  assert.equal(filesFunctionSource.includes('r.id AS reg_id'), true);
  assert.equal(filesFunctionSource.includes('FROM registration r'), true);
  assert.equal(filesFunctionSource.includes('f.object_id = r.id'), true);
  assert.equal(filesFunctionSource.includes('WHERE r.id = ANY($1::int[])'), true);
});

test('template renders appeal phase result with status and justification', () => {
  assert.equal(templateSource.includes('{{#if this.isAppealPhase}}'), true);
  assert.equal(templateSource.includes('Resultado do Recurso'), true);
  assert.equal(templateSource.includes('Status do Recurso'), true);
  assert.equal(templateSource.includes('{{this.appealResult.statusText}}'), true);
  assert.equal(templateSource.includes('Justificativa'), true);
  assert.equal(templateSource.includes('{{this.appealResult.parecer}}'), true);
});

test('template keeps all major sheet sections available', () => {
  const requiredSections = [
    'DADOS DO AGENTE CULTURAL',
    'Fase de Inscrições',
    'Anexos',
    'Análise de Mérito',
    'Avaliação Simplificada',
    'Resultado do Recurso'
  ];

  for (const section of requiredSections) {
    assert.equal(templateSource.includes(section), true, `missing section: ${section}`);
  }
});

test('appeal result is rendered separately from merit analysis', () => {
  const appealIndex = templateSource.indexOf('Resultado do Recurso');
  const meritIndex = templateSource.indexOf('Análise de Mérito');

  assert.equal(appealIndex > -1, true);
  assert.equal(meritIndex > -1, true);
  assert.equal(appealIndex < meritIndex, true);
});

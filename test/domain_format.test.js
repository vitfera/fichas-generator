const assert = require('node:assert/strict');
const test = require('node:test');

const { formatValue, formatPeopleList, isBlankValue, slugifyAgentName } = require('../src/domain/format');

test('formatValue converts ISO dates to Brazilian format', () => {
  assert.equal(formatValue('2025-03-09'), '09/03/2025');
  assert.equal(formatValue('2025-03-09T14:30:00Z'), '09/03/2025 14:30:00');
});

test('formatValue returns empty string for null and undefined', () => {
  assert.equal(formatValue(null), '');
  assert.equal(formatValue(undefined), '');
});

test('formatValue joins JSON arrays of scalars with line breaks', () => {
  assert.equal(formatValue('["Teatro","Dança"]'), 'Teatro<br/>Dança');
});

test('formatValue renders JSON arrays of objects as key/value pairs', () => {
  assert.equal(
    formatValue('[{"titulo":"Oficina","ano":"2024"}]'),
    'titulo: Oficina; ano: 2024'
  );
});

test('formatValue leaves plain text untouched', () => {
  assert.equal(formatValue('Projeto cultural'), 'Projeto cultural');
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

test('persons field type is only applied to arrays', () => {
  assert.equal(formatValue('não informado', 'persons'), 'não informado');
});

test('formatPeopleList separates each person with a blank line', () => {
  const formatted = formatPeopleList([{ name: 'Ana' }, { name: 'Bruno' }]);
  assert.equal(formatted, 'Nome: Ana<br/><br/>Nome: Bruno');
});

test('isBlankValue treats empty structures and false as blank', () => {
  assert.equal(isBlankValue(''), true);
  assert.equal(isBlankValue('   '), true);
  assert.equal(isBlankValue([]), true);
  assert.equal(isBlankValue({}), true);
  assert.equal(isBlankValue({ a: '', b: [] }), true);
  assert.equal(isBlankValue(false), true);
  assert.equal(isBlankValue('x'), false);
  assert.equal(isBlankValue(0), false);
});

test('slugifyAgentName strips accents and unsafe filename characters', () => {
  assert.equal(slugifyAgentName('José Antônio da Silva Júnior'), 'jose-antonio-da-silva-junior');
  assert.equal(slugifyAgentName('Coletivo #1 (Artes/Cênicas)'), 'coletivo-1-artescenicas');
  assert.equal(slugifyAgentName(''), 'sem-nome');
  assert.equal(slugifyAgentName(null), 'sem-nome');
});

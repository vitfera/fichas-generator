/**
 * Renderização das páginas web.
 *
 * Todo o HTML das páginas vive em src/web/views/*.hbs; este módulo apenas
 * compila os templates e expõe funções de renderização tipadas por página.
 * O escape é responsabilidade do Handlebars ({{ }}), não do código de rota.
 */

const fs = require('fs');
const path = require('path');
const Handlebars = require('handlebars');

const VIEWS_DIR = path.join(__dirname, 'views');
const PARTIALS_DIR = path.join(VIEWS_DIR, 'partials');

const handlebars = Handlebars.create();

handlebars.registerHelper('typeLabel', type => (type === 'zip' ? 'ZIP' : 'PDF'));

function compileView(name) {
  return handlebars.compile(fs.readFileSync(path.join(VIEWS_DIR, `${name}.hbs`), 'utf-8'));
}

for (const file of fs.readdirSync(PARTIALS_DIR)) {
  if (!file.endsWith('.hbs')) continue;
  // generated-files-card.hbs → generatedFilesCard
  const name = path.basename(file, '.hbs').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  handlebars.registerPartial(name, fs.readFileSync(path.join(PARTIALS_DIR, file), 'utf-8'));
}

const views = {
  layout: compileView('layout'),
  index: compileView('index'),
  result: compileView('result')
};

function renderPage(viewName, { title, logoBase64 = '', pageScript = '' }, data) {
  return views.layout({
    title,
    logoBase64,
    pageScript,
    body: views[viewName](data)
  }).trim();
}

function renderIndexPage({ opportunities, filterOptions, attachmentOptions, logoBase64 }) {
  return renderPage(
    'index',
    { title: 'Gerar Fichas de Inscrição', logoBase64, pageScript: '/assets/js/index-page.js' },
    { opportunities, filterOptions, attachmentOptions }
  );
}

function renderResultPage({ opportunity, zipUrl, files, logoBase64 }) {
  return renderPage(
    'result',
    { title: 'Fichas Geradas', logoBase64 },
    { opportunity, zipUrl, files }
  );
}

/**
 * Só a lista de arquivos, para a atualização assíncrona em GET /generated-files.
 */
function renderGeneratedFilesList(files) {
  return handlebars.partials.generatedFilesList
    ? handlebars.compile(handlebars.partials.generatedFilesList)({ files })
    : '';
}

module.exports = {
  renderIndexPage,
  renderResultPage,
  renderGeneratedFilesList
};

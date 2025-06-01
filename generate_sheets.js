/**
 * generate_sheets.js
 *
 * Serviço HTTP para gerar fichas de inscrição em PDF de uma oportunidade pai
 * incluindo todas as suas fases-filhas (exceto “Publicação final do resultado”).
 * Os campos em cada fase são listados segundo o display_order, e valores
 * que forem arrays JSON são formatados para exibição legível, assim como datas
 * "YYYY-MM-DD" são convertidas para "DD/MM/YYYY". O logo é embutido como Base64
 * para não depender de file:// no Puppeteer.
 *
 * URLs suportadas:
 *   GET  /         → exibe formulário de seleção de oportunidade e logo com Bootstrap
 *   POST /generate → gera os PDFs, empacota em ZIP, e exibe página de resultado
 *
 * Antes de executar, crie .env contendo:
 *   DB_HOST=localhost
 *   DB_PORT=5432
 *   DB_USER=mapas
 *   DB_PASSWORD=mapas
 *   DB_NAME=mapas
 *   OUTPUT_DIR=./output
 *   SERVER_PORT=4444
 *
 * Garanta também que existam:
 *   - ./assets/logo.png
 *   - ./templates/ficha-inscricao.html
 *   - ./output (pasta para arquivos gerados)
 */

require('dotenv').config();
const express    = require('express');
const path       = require('path');
const fs         = require('fs');
const { Pool }   = require('pg');
const Handlebars = require('handlebars');
const puppeteer  = require('puppeteer-core');
const archiver   = require('archiver');

// ------------------------------------------------------------
// 1) Configuração do banco a partir do .env
// ------------------------------------------------------------
const DB_HOST     = process.env.DB_HOST     || 'localhost';
const DB_PORT     = parseInt(process.env.DB_PORT     || '5432', 10);
const DB_USER     = process.env.DB_USER     || 'mapas';
const DB_PASSWORD = process.env.DB_PASSWORD || 'mapas';
const DB_NAME     = process.env.DB_NAME     || 'mapas';
const OUTPUT_DIR  = process.env.OUTPUT_DIR  || path.join(__dirname, 'output');
const SERVER_PORT = parseInt(process.env.SERVER_PORT || '4444', 10);

const pool = new Pool({
  host: DB_HOST,
  port: DB_PORT,
  user: DB_USER,
  password: DB_PASSWORD,
  database: DB_NAME,
});

// ------------------------------------------------------------
// 2) Helpers Handlebars (para o template PDF)
// ------------------------------------------------------------
Handlebars.registerHelper('get', (obj, key) => {
  return (obj && obj[key] !== undefined) ? obj[key] : '';
});
Handlebars.registerHelper('keys', (obj) => {
  if (obj && typeof obj === 'object') {
    return Object.keys(obj);
  }
  return [];
});
Handlebars.registerHelper('lookup', (obj, field) => {
  return (obj && obj[field] !== undefined) ? obj[field] : '';
});

// ------------------------------------------------------------
// 3) Carrega e compila o template PDF (ficha-inscricao.html)
// ------------------------------------------------------------
const templatePath = path.join(__dirname, 'templates', 'ficha-inscricao.html');
if (!fs.existsSync(templatePath)) {
  console.error(`Template PDF não encontrado em ${templatePath}`);
  process.exit(1);
}
const templateSource = fs.readFileSync(templatePath, 'utf-8');
const template       = Handlebars.compile(templateSource);

// ------------------------------------------------------------
// 4) Lê o logo.png e converte para Base64 (para permitir <img data:…>)
// ------------------------------------------------------------
const assetPath = path.join(__dirname, 'assets');
let logoBase64 = '';
try {
  const logoBuffer = fs.readFileSync(path.join(assetPath, 'logo.png'));
  logoBase64 = logoBuffer.toString('base64');
} catch (err) {
  console.warn('Atenção: não foi possível ler assets/logo.png para incorporar no PDF.');
  // logoBase64 ficará vazio → template exibirá vazio se não houver logo
}

// ------------------------------------------------------------
// 5) Função para formatar valores: datas e JSON-arrays
// ------------------------------------------------------------
function formatValue(raw) {
  if (raw == null) return '';

  // 5.1) Se for string no formato YYYY-MM-DD, converte para DD/MM/YYYY
  if (typeof raw === 'string') {
    const isoDateMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (isoDateMatch) {
      const [, year, month, day] = isoDateMatch;
      return `${day}/${month}/${year}`;
    }
  }

  // 5.2) Se for string no formato YYYY-MM-DDTHH:MM:SSZ, converte para "DD/MM/YYYY HH:MM:SS"
  const isoDateTimeMatch = typeof raw === 'string'
    ? raw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2}:\d{2})/)
    : null;
  if (isoDateTimeMatch) {
    const [, year, month, day, time] = isoDateTimeMatch;
    return `${day}/${month}/${year} ${time}`;
  }

  // 5.3) Tenta parsear como JSON
  let parsed;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
  }

  if (Array.isArray(parsed)) {
    // 5.4) Caso seja array de strings ou números → junta com <br/>
    if (parsed.every(x => typeof x === 'string' || typeof x === 'number')) {
      return parsed.map(x => String(x)).join('<br/>');
    }
    // 5.5) Caso seja array de objetos → converte cada objeto em "chave: valor; ..." e separa objetos com <br/><br/>
    if (parsed.every(x => x && typeof x === 'object' && !Array.isArray(x))) {
      const lines = parsed.map(obj => {
        const parts = [];
        for (const [k, v] of Object.entries(obj)) {
          if (k === '$$hashKey') continue;
          parts.push(`${k}: ${v}`);
        }
        return parts.join('; ');
      });
      return lines.join('<br/><br/>');
    }
  }

  // 5.6) Senão, retorna o raw como string simples
  return String(raw);
}

// ------------------------------------------------------------
// 6) Funções de acesso ao banco
// ------------------------------------------------------------

// 6.1) Lista todas as oportunidades‐pai (parent_id IS NULL), ordenadas por nome
async function fetchParentOpportunities() {
  const client = await pool.connect();
  try {
    const query = `
      SELECT id, name
      FROM opportunity
      WHERE parent_id IS NULL
      ORDER BY name;
    `;
    const res = await client.query(query);
    return res.rows;
  } finally {
    client.release();
  }
}

// 6.2) Lista todos os filhos de parentId, EXCLUINDO parentId+1, ordenados por ID
async function fetchChildrenExcludingNext(parentId) {
  const client = await pool.connect();
  try {
    const query = `
      SELECT id, name
      FROM opportunity
      WHERE parent_id = $1
        AND id != $2
      ORDER BY id;
    `;
    const res = await client.query(query, [parentId, parentId + 1]);
    return res.rows;
  } finally {
    client.release();
  }
}

// 6.3) Busca TODAS as fases relevantes (pai + filhos exceto parentId+1), em ordem crescente de ID
async function fetchAllRelevantPhases(parentId) {
  const client = await pool.connect();
  try {
    const query = `
      SELECT id, name
      FROM opportunity
      WHERE (id = $1 OR parent_id = $1)
        AND id != $1 + 1
      ORDER BY id;
    `;
    const res = await client.query(query, [parentId]);
    return res.rows;
  } finally {
    client.release();
  }
}

// 6.4) Busca inscrições para uma fase (phaseId) → retorna:
//      [ { registration_id, registration_number, agent_id, agent_name }, … ]
async function fetchRegistrationsForPhase(phaseId) {
  const client = await pool.connect();
  try {
    const query = `
      SELECT
        r.id     AS registration_id,
        r.number AS registration_number,
        a.id     AS agent_id,
        a.name   AS agent_name
      FROM registration r
      LEFT JOIN agent a ON r.agent_id = a.id
      WHERE r.opportunity_id = $1
      ORDER BY r.number;
    `;
    const res = await client.query(query, [phaseId]);
    return res.rows;
  } finally {
    client.release();
  }
}

// 6.5) Busca a inscrição‐pai associada a uma inscrição‐child, lendo
//      previousPhaseRegistrationId de registration_meta. Retorna null se não achar.
async function fetchParentRegistrationId(childRegistrationId) {
  const client = await pool.connect();
  try {
    const query = `
      SELECT value
      FROM registration_meta
      WHERE object_id = $1
        AND key = 'previousPhaseRegistrationId'
      LIMIT 1;
    `;
    const res = await client.query(query, [childRegistrationId]);
    if (res.rowCount === 0) return null;
    const parentRegId = parseInt(res.rows[0].value, 10);
    return isNaN(parentRegId) ? null : parentRegId;
  } finally {
    client.release();
  }
}

// 6.6) Busca TODAS as respostas (registration_meta → registration_field_configuration)
//      de uma inscrição específica (regId), filtrando rm.key LIKE 'field_%' e
//      rfc.opportunity_id ∈ phaseIds. Retorna um objeto { [phaseId]: [ {label,value}, … ] }
//      em que cada array está ordenado por display_order.
//
//      → regId    (inteiro)
//      → phaseIds (array de inteiros)
async function fetchOrderedMetaForRegistration(regId, phaseIds) {
  const client = await pool.connect();
  try {
    const query = `
      SELECT
        rfc.opportunity_id   AS phase_id,
        rfc.title            AS field_label,
        rfc.display_order    AS field_order,
        rm.value             AS field_value
      FROM registration_meta rm
      JOIN registration_field_configuration rfc
        ON rm.key LIKE 'field_%'
        AND CAST(replace(rm.key, 'field_', '') AS INTEGER) = rfc.id
        AND rfc.opportunity_id = ANY($2::int[])
      WHERE rm.object_id = $1
      ORDER BY rfc.opportunity_id, rfc.display_order;
    `;
    const res = await client.query(query, [regId, phaseIds]);
    const grouped = {};
    for (const row of res.rows) {
      const pid = row.phase_id;
      if (!grouped[pid]) grouped[pid] = [];
      grouped[pid].push({
        label: row.field_label,
        value: row.field_value
      });
    }
    return grouped;
  } finally {
    client.release();
  }
}

// ------------------------------------------------------------
// 6.7) Busca, para uma fase (phaseId), a lista de critérios e títulos:
//      a) Lê evaluation_method_configuration.id
//      b) Lê evaluationmethodconfiguration_meta (key='sections')
//      c) Extrai cada critério → [ { crit_id, crit_title }, … ]
// ------------------------------------------------------------
async function getCriteriaListForPhase(phaseId) {
  const client = await pool.connect();
  try {
    // 1) Buscar evaluation_method_configuration.id
    const q1 = `
      SELECT id
      FROM evaluation_method_configuration
      WHERE opportunity_id = $1
      LIMIT 1;
    `;
    const r1 = await client.query(q1, [phaseId]);
    if (r1.rowCount === 0) {
      return []; // não há configuração de avaliação nesta fase
    }
    const evalMethodConfigId = r1.rows[0].id;

    // 2) Buscar JSON 'sections'
    const q2 = `
      SELECT value
      FROM evaluationmethodconfiguration_meta
      WHERE object_id = $1
        AND key = 'sections'
      LIMIT 1;
    `;
    const r2 = await client.query(q2, [evalMethodConfigId]);
    if (r2.rowCount === 0) {
      return [];
    }

    // 3) Parse do JSONB (se vier como string, dar JSON.parse)
    let sectionsRaw = r2.rows[0].value;
    if (typeof sectionsRaw === 'string') {
      try {
        sectionsRaw = JSON.parse(sectionsRaw);
      } catch {
        return [];
      }
    }

    // 4) Flatten: de cada seção, pegar cada critério em sec.criteria[]
    const criteriaList = [];
    for (const sec of sectionsRaw) {
      if (Array.isArray(sec.criteria)) {
        for (const c of sec.criteria) {
          // c.id → ex: "c-1726927579600"
          // c.title → ex: "Qualidade técnico-artística"
          criteriaList.push({
            crit_id:    c.id,
            crit_title: c.title
          });
        }
      }
    }
    return criteriaList;

  } finally {
    client.release();
  }
}

/**
 * 6.8) Para um dado registration_id (regId) e fase (phaseId), retorna:
 *      {
 *        criteria: [ { label: crit_title, score: número }, … ],
 *        parecer:  "...texto vindo de campo 'obs'...", 
 *        total:    soma de todas as notas numéricas (somente chaves "c-")
 *      }
 */
async function getEvaluationForRegistrationAndPhase(regNumber, phaseId) {
  const client = await pool.connect();
  try {
    const q1 = `
      SELECT re.evaluation_data
      FROM registration_evaluation re
      JOIN registration r
        ON r.number = re.registration_id
      WHERE re.registration_id = $1
        AND r.opportunity_id    = $2
      LIMIT 1;
    `;
    // Aqui PASSAMOS regNumber (VARCHAR) para $1, e phaseId (INTEGER) para $2.
    const r1 = await client.query(q1, [regNumber, phaseId]);
    if (r1.rowCount === 0) {
      return { criteria: [], parecer: '', total: 0 };
    }

    let rawEval = r1.rows[0].evaluation_data;
    if (typeof rawEval === 'string') {
      try {
        rawEval = JSON.parse(rawEval);
      } catch {
        rawEval = {};
      }
    }
    if (!rawEval || typeof rawEval !== 'object') {
      return { criteria: [], parecer: '', total: 0 };
    }

    // Agora filtramos somente as chaves "c-..." e capturamos "obs"
    const numericPairs = [];
    let parecerText = '';
    let totalScore  = 0;

    for (const key of Object.keys(rawEval)) {
      if (key === 'obs') {
        parecerText = String(rawEval[key]);
      } else if (key.startsWith('c-')) {
        const v = rawEval[key];
        const num = Number(v);
        if (!isNaN(num)) {
          numericPairs.push({ crit_id: key, score: num });
          totalScore += num;
        }
      }
      // ignorar "uid", "status", ou qualquer outra chave
    }

    const criteriaList = await getCriteriaListForPhase(phaseId);
    const resultCriteria = numericPairs.map(p => {
      const found = criteriaList.find(c => c.crit_id === p.crit_id);
      return {
        label: found ? found.crit_title : p.crit_id,
        score: p.score
      };
    });

    return {
      criteria: resultCriteria,
      parecer:  parecerText || '',
      total:    totalScore
    };
  } finally {
    client.release();
  }
}

// ------------------------------------------------------------
// 7) Converte HTML em PDF via Puppeteer-core + Chromium do sistema
// ------------------------------------------------------------
async function htmlToPdfBuffer(html) {
  const executablePath = '/usr/bin/chromium';
  const browser = await puppeteer.launch({
    executablePath,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
  });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'networkidle0' });
  const pdfBuffer = await page.pdf({
    format: 'A4',
    printBackground: true,
    margin: { top: '1.5cm', bottom: '1.5cm', left: '1cm', right: '1cm' },
  });
  await browser.close();
  return pdfBuffer;
}

// ------------------------------------------------------------
// 8) Geração de fichas para um parentId
// ------------------------------------------------------------
async function generateFichas(parentId) {
  // 8.1) Buscar todos os filhos (exceto parentId+1)
  const children = await fetchChildrenExcludingNext(parentId);

  // 8.2) Encontrar, entre os filhos, a primeira fase com inscrições
  let chosenPhaseId = null;
  let registrations  = [];
  for (const child of children) {
    const regs = await fetchRegistrationsForPhase(child.id);
    if (regs.length > 0) {
      chosenPhaseId = child.id;
      registrations  = regs;
      break;
    }
  }

  // 8.3) Se nenhum filho tiver inscrições, tentar no próprio parentId
  if (!chosenPhaseId) {
    const regsParent = await fetchRegistrationsForPhase(parentId);
    if (regsParent.length > 0) {
      chosenPhaseId = parentId;
      registrations  = regsParent;
    }
  }

  // 8.4) Se ainda não encontrou, erro
  if (!chosenPhaseId) {
    throw new Error(`Nenhuma inscrição encontrada para parentId=${parentId}`);
  }

  // 8.5) Carregar TODAS as fases relevantes (pai + filhos exceto parentId+1)
  let phases = await fetchAllRelevantPhases(parentId);
  if (!phases.length) {
    // fallback: ao menos colocar o próprio parentId
    const client = await pool.connect();
    try {
      const r = await client.query(
        `SELECT id,name FROM opportunity WHERE id = $1 LIMIT 1;`,
        [parentId]
      );
      if (r.rowCount) {
        phases = [{ id: r.rows[0].id, name: r.rows[0].name }];
      }
    } finally {
      client.release();
    }
  }

  // 8.6) Garante que OUTPUT_DIR exista e cria placeholder
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
  const placeholder = path.join(OUTPUT_DIR, 'index.html');
  if (!fs.existsSync(placeholder)) {
    fs.writeFileSync(placeholder, '', 'utf-8');
  }

  const pdfFilenames = [];

  // 8.7) Para cada inscrição encontrada na fase escolhida, processa:
  for (const reg of registrations) {
    const regNumber = reg.registration_number || reg.registration_id;

    // 8.7.1) Descobre parentRegistrationId via previousPhaseRegistrationId
    const parentRegId = await fetchParentRegistrationId(reg.registration_id);

    // 8.7.2) Montar array de metadados do PAI (caso exista)
    let parentMetaArray = [];
    if (parentRegId) {
      const parentGrouped = await fetchOrderedMetaForRegistration(parentRegId, [parentId]);
      const rawParentArray = parentGrouped[parentId] || [];
      parentMetaArray = rawParentArray.map(item => ({
        label: item.label,
        value: formatValue(item.value)
      }));
    }

    // 8.7.3) Buscar meta do CHILD e demais fases-filhas
    const allPhaseIds    = phases.map(p => p.id);
    const allMetaGrouped = await fetchOrderedMetaForRegistration(reg.registration_id, allPhaseIds);

    // Formatar cada array de metadados por fase (exceto parentId)
    const childMetaArrays = {};
    for (const phase of phases) {
      if (phase.id === parentId) continue;
      const rawArr = allMetaGrouped[phase.id] || [];
      childMetaArrays[phase.id] = rawArr.map(item => ({
        label: item.label,
        value: formatValue(item.value)
      }));
    }

    // 8.7.4) Montar dataPhases: cada elemento { id, name, rows, evaluation }
    const dataPhases = [];
    for (let idx = 0; idx < phases.length; idx++) {
      const phase = phases[idx];
      const rowsForThisPhase = (idx === 0)
        ? parentMetaArray
        : (childMetaArrays[phase.id] || []);

      // 8.7.4.1) Buscar avaliação (critérios + parecer + total)
      const evalObj = await getEvaluationForRegistrationAndPhase(
        reg.registration_id,
        phase.id
      );
      // evalObj = { criteria: [ {label,score}, … ], parecer: "...", total: 42 }

      dataPhases.push({
        id:         phase.id,
        name:       phase.name,
        rows:       rowsForThisPhase,
        evaluation: evalObj
      });
    }

    // 8.7.5) Montar objeto “data” e incluir logoBase64
    const data = {
      registration_number: regNumber,
      agent: {
        id:   reg.agent_id,
        name: reg.agent_name || '',
      },
      phases:     dataPhases,
      logoBase64: logoBase64
    };

    // 8.7.6) Renderizar HTML
    let html;
    try {
      html = template(data);
    } catch (err) {
      console.error(`Erro ao renderizar template para registration_number=${regNumber}:`, err);
      continue;
    }

    // 8.7.7) Converter HTML em PDF
    let pdfBuffer;
    try {
      pdfBuffer = await htmlToPdfBuffer(html);
    } catch (err) {
      console.error(`Erro ao gerar PDF para registration_number=${regNumber}:`, err);
      continue;
    }

    // 8.7.8) Salvar o PDF em OUTPUT_DIR
    const filename = `ficha_${parentId}_${regNumber}.pdf`;
    const filepath = path.join(OUTPUT_DIR, filename);
    try {
      fs.writeFileSync(filepath, pdfBuffer);
      pdfFilenames.push(filename);
      console.log(`PDF gerado: ${filename}`);
    } catch (err) {
      console.error(`Erro ao salvar PDF ${filename}:`, err);
    }
  }

  // 8.8) Empacota todos os PDFs num ZIP e retorna o nome
  const zipFilename = `fichas_${parentId}.zip`;
  const zipFilepath = path.join(OUTPUT_DIR, zipFilename);
  const output = fs.createWriteStream(zipFilepath);
  const archive = archiver('zip', { zlib: { level: 9 } });

  return new Promise((resolve, reject) => {
    output.on('close', () => {
      console.log(`ZIP gerado: ${zipFilename} (${archive.pointer()} bytes)`);
      resolve(zipFilename);
    });
    archive.on('error', err => {
      console.error('Erro ao criar ZIP:', err);
      reject(err);
    });
    archive.pipe(output);
    for (const filename of pdfFilenames) {
      archive.file(path.join(OUTPUT_DIR, filename), { name: filename });
    }
    archive.finalize();
  });
}

// ------------------------------------------------------------
// 9) Configuração do Express (rotas / e /generate)
// ------------------------------------------------------------
const app = express();
app.use(express.urlencoded({ extended: true }));

// Servir estáticos em /downloads (PDFs e ZIP gerados)
app.use('/downloads', express.static(OUTPUT_DIR));

////////////////////////////////////////////////////////////////////////////////
// GET / → formulário com <select> de oportunidades-pai + Bootstrap + logo
////////////////////////////////////////////////////////////////////////////////
app.get('/', async (req, res) => {
  let parents = [];
  try {
    parents = await fetchParentOpportunities();
  } catch (err) {
    console.error('Erro ao buscar oportunidades-pai:', err);
  }

  // Monta as <option> com todas as oportunidades-pai
  const optionsHtml = parents
    .map(row => `<option value="${row.id}">${row.name}</option>`)
    .join('\n');

  // Monta HTML usando Bootstrap 5 (CDN). No topo, logo centralizada.
  // Quando o usuário clicar em "Gerar Fichas", exibimos um spinner e desabilitamos o botão.
  const html = `
<!DOCTYPE html>
<html lang="pt-BR">
  <head>
    <meta charset="UTF-8" />
    <title>Gerar Fichas de Inscrição</title>
    <!-- Bootstrap CSS v5.3 -->
    <link
      href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.1/dist/css/bootstrap.min.css"
      rel="stylesheet"
      integrity="sha384-9ndCyUa1zY3nWD0gqP7B7mYyt0ea3Q2Ua4H9z7NL0v5uyI6oBkP6eJzIvzhP1hxd"
      crossorigin="anonymous"
    />
    <style>
      body {
        padding-top: 40px;
        background-color: #f8f9fa;
      }
      .logo-container {
        margin-bottom: 30px;
      }
      .logo-container img {
        max-height: 80px;
      }
      #loadingSpinner {
        display: none;
      }
    </style>
  </head>
  <body class="bg-light">
    <div class="container">

      <!-- Logo centralizada -->
      <div class="row mb-4">
        <div class="col text-center logo-container">
          ${
            logoBase64
              ? `<img src="data:image/png;base64,${logoBase64}" alt="Logo">`
              : ``
          }
        </div>
      </div>

      <div class="row justify-content-center">
        <div class="col-md-6">
          <div class="card shadow-sm">
            <div class="card-body">
              <h5 class="card-title text-center mb-4">Gerar Fichas de Inscrição</h5>
              <form id="formGenerate" action="/generate" method="POST">
                <div class="mb-3">
                  <label for="parent" class="form-label">Escolha a oportunidade principal:</label>
                  <select name="parent" id="parent" class="form-select" required>
                    <option value="" disabled selected>-- selecione --</option>
                    ${optionsHtml}
                  </select>
                </div>
                <button id="btnSubmit" type="submit" class="btn btn-primary w-100">
                  <span id="btnText">Gerar Fichas</span>
                  <span id="loadingSpinner" class="spinner-border spinner-border-sm ms-2" role="status" aria-hidden="true"></span>
                </button>
              </form>
            </div>
          </div>
        </div>
      </div>

    </div>

    <!-- Bootstrap JS v5.3 (bundle) e script de loading -->
    <script
      src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.1/dist/js/bootstrap.bundle.min.js"
      integrity="sha384-HoA5lDhr+tr1EBbk1nk4avourmQw519JfVLnLYhuwYSp7mKozZqDaVqGm2fZbuYj"
      crossorigin="anonymous"
    ></script>
    <script>
      const form = document.getElementById('formGenerate');
      const btnSubmit = document.getElementById('btnSubmit');
      const btnText = document.getElementById('btnText');
      const loadingSpinner = document.getElementById('loadingSpinner');

      form.addEventListener('submit', () => {
        btnSubmit.disabled = true;
        btnText.textContent = 'Gerando...';
        loadingSpinner.style.display = 'inline-block';
      });
    </script>
  </body>
</html>
  `.trim();

  res.send(html);
});

////////////////////////////////////////////////////////////////////////////////
// POST /generate → gera as fichas e mostra a página de resultado
////////////////////////////////////////////////////////////////////////////////
app.post('/generate', async (req, res) => {
  const parentId = parseInt(req.body.parent, 10);
  if (isNaN(parentId)) {
    return res.status(400).send('Oportunidade inválida.');
  }

  let zipFilename;
  try {
    zipFilename = await generateFichas(parentId);
  } catch (err) {
    console.error('Erro ao gerar fichas:', err);
    return res.status(500).send('Erro ao gerar fichas. Veja o log no servidor.');
  }

  // Após criar o ZIP, lista todos os PDFs gerados:
  let pdfFiles = [];
  try {
    pdfFiles = fs.readdirSync(OUTPUT_DIR).filter(fname => {
      return (
        fname.startsWith(`ficha_${parentId}_`) &&
        fname.toLowerCase().endsWith('.pdf')
      );
    });
    pdfFiles.sort();
  } catch (err) {
    console.error('Erro ao listar PDFs gerados:', err);
  }

  const listPdfHtml = pdfFiles
    .map(fname => {
      return `
      <li class="list-group-item">
        <a href="/downloads/${fname}" target="_blank">${fname}</a>
      </li>`;
    })
    .join('\n');

  // Página de resultado com botão para baixar ZIP e lista de PDFs individuais
  const html = `
<!DOCTYPE html>
<html lang="pt-BR">
  <head>
    <meta charset="UTF-8" />
    <title>Fichas Geradas</title>
    <!-- Bootstrap CSS v5.3 -->
    <link
      href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.1/dist/css/bootstrap.min.css"
      rel="stylesheet"
      integrity="sha384-9ndCyUa1zY3nWD0gqP7B7mYyt0ea3Q2Ua4H9z7NL0v5uyI6oBkP6eJzIvzhP1hxd"
      crossorigin="anonymous"
    />
    <style>
      body {
        padding-top: 40px;
        background-color: #f8f9fa;
      }
      .logo-container {
        margin-bottom: 30px;
      }
      .logo-container img {
        max-height: 80px;
      }
    </style>
  </head>
  <body class="bg-light">
    <div class="container">

      <!-- Logo centralizada -->
      <div class="row mb-4">
        <div class="col text-center logo-container">
          ${
            logoBase64
              ? `<img src="data:image/png;base64,${logoBase64}" alt="Logo">`
              : ``
          }
        </div>
      </div>

      <div class="row justify-content-center">
        <div class="col-md-8">
          <div class="card shadow-sm mb-4">
            <div class="card-body text-center">
              <h5 class="card-title mb-3">Fichas geradas para oportunidade ${parentId}</h5>
              <a href="/downloads/${zipFilename}" class="btn btn-success me-2">
                <i class="bi bi-download"></i> Baixar todas as fichas (ZIP)
              </a>
              <a href="/" class="btn btn-secondary">
                <i class="bi bi-arrow-left"></i> Voltar
              </a>
            </div>
          </div>

          <div class="card shadow-sm">
            <div class="card-header">
              <strong>Lista de PDFs gerados:</strong>
            </div>
            <ul class="list-group list-group-flush">
              ${listPdfHtml || `<li class="list-group-item"><em>Nenhum PDF encontrado.</em></li>`}
            </ul>
          </div>
        </div>
      </div>

    </div>

    <!-- Bootstrap JS v5.3 (bundle) e Bootstrap Icons -->
    <script
      src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.1/dist/js/bootstrap.bundle.min.js"
      integrity="sha384-HoA5lDhr+tr1EBbk1nk4avourmQw519JfVLnLYhuwYSp7mKozZqDaVqGm2fZbuYj"
      crossorigin="anonymous"
    ></script>
    <link
      rel="stylesheet"
      href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.10.5/font/bootstrap-icons.css"
    />
  </body>
</html>
  `.trim();

  res.send(html);
});

// ------------------------------------------------------------
// 10) Inicia servidor HTTP
// ------------------------------------------------------------
app.listen(SERVER_PORT, () => {
  console.log(`Servidor rodando na porta ${SERVER_PORT}`);
  console.log(`Acesse http://localhost:${SERVER_PORT}/ para gerar fichas.`);
});

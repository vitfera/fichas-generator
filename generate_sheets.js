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
    // 5.5) Caso seja array de objetos → converte cada objeto em "chave: valor; chave2: valor2" e separa cada objeto com <br/><br/>
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

// 6.3) Retorna o menor ID dentre os filhos (exceto parentId+1), ou null se não houver
async function findFirstPhaseId(parentId) {
  const children = await fetchChildrenExcludingNext(parentId);
  if (children.length === 0) return null;
  return children[0].id;
}

// 6.4) Busca todas as fases relevantes (pai + filhos exceto parentId+1), em ordem crescente de ID
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

// 6.5) Busca inscrições para uma fase (phaseId) → retorna:
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

// 6.6) Busca a inscrição‐pai associada a uma inscrição‐child, lendo
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

// 6.7) Busca TODAS as respostas (registration_meta → registration_field_configuration)
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
  // 8.1) Identifica a “primeira fase filha” (menor ID dentre filhos ≠ parentId+1)
  const firstPhaseId = await findFirstPhaseId(parentId);
  if (!firstPhaseId) {
    throw new Error(`Nenhuma fase-filho válida encontrada para parentId=${parentId}`);
  }

  // 8.2) Carrega TODAS as fases relevantes: 
  //      [ {id:parentId, name:…}, {id:filho1, name:…}, … ]
  const phases = await fetchAllRelevantPhases(parentId);

  // 8.3) Busca as inscrições SÓ da “firstPhaseId”
  const registrations = await fetchRegistrationsForPhase(firstPhaseId);

  // 8.4) Garante que OUTPUT_DIR exista e cria placeholder
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
  const placeholder = path.join(OUTPUT_DIR, 'index.html');
  if (!fs.existsSync(placeholder)) {
    fs.writeFileSync(placeholder, '', 'utf-8');
  }

  const pdfFilenames = [];

  // 8.5) Para cada inscrição da primeira fase (child), processa:
  for (const reg of registrations) {
    const regNumber = reg.registration_number || reg.registration_id;

    // 8.5.1) Descobre parentRegistrationId via previousPhaseRegistrationId
    const parentRegId = await fetchParentRegistrationId(reg.registration_id);

    // 8.5.2) Busca meta do PAI (phaseId = parentId) se existir
    let parentMetaArray = [];
    if (parentRegId) {
      const parentGrouped = await fetchOrderedMetaForRegistration(parentRegId, [parentId]);
      const rawParentArray = parentGrouped[parentId] || [];
      // Aplica formatValue a cada valor
      parentMetaArray = rawParentArray.map(item => ({
        label: item.label,
        value: formatValue(item.value)
      }));
    }

    // 8.5.3) Busca meta do CHILD e demais fases-filhas
    const allPhaseIds = phases.map(p => p.id);
    const allMetaGrouped = await fetchOrderedMetaForRegistration(reg.registration_id, allPhaseIds);

    // Formata cada array por fase-filho:
    const childMetaArrays = {};
    for (const phase of phases) {
      if (phase.id === parentId) continue;
      const rawArr = allMetaGrouped[phase.id] || [];
      childMetaArrays[phase.id] = rawArr.map(item => ({
        label: item.label,
        value: formatValue(item.value)
      }));
    }

    // 8.5.4) Monta dataPhases, cada elemento { id, name, rows }
    const dataPhases = phases.map((phase, idx) => {
      if (idx === 0) {
        return {
          id:   phase.id,
          name: phase.name,
          rows: parentMetaArray
        };
      } else {
        return {
          id:   phase.id,
          name: phase.name,
          rows: childMetaArrays[phase.id] || []
        };
      }
    });

    // 8.5.5) Monta objeto “data” e inclui logoBase64
    const data = {
      registration_number: regNumber,
      agent: {
        id:   reg.agent_id,
        name: reg.agent_name || '',
      },
      phases:     dataPhases,
      logoBase64: logoBase64
    };

    // 8.5.6) Renderiza HTML
    let html;
    try {
      html = template(data);
    } catch (err) {
      console.error(`Erro ao renderizar template para registration_number=${regNumber}:`, err);
      continue;
    }

    // 8.5.7) Converte HTML em PDF
    let pdfBuffer;
    try {
      pdfBuffer = await htmlToPdfBuffer(html);
    } catch (err) {
      console.error(`Erro ao gerar PDF para registration_number=${regNumber}:`, err);
      continue;
    }

    // 8.5.8) Salva o PDF em OUTPUT_DIR
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

  // 8.6) Empacota todos os PDFs num ZIP e retorna o nome
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
// 9) Configuração do Express
// ------------------------------------------------------------
const app = express();
app.use(express.urlencoded({ extended: true }));

// Servir estáticos em /downloads (PDFs e ZIP gerados)
app.use('/downloads', express.static(OUTPUT_DIR));

////////////////////////////////////////////////////////////////////////////////
// GET / → formulário com <select> apenas de oportunidades-pai
//          + Bootstrap + logo centralizada + loading button
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
    <!-- Bootstrap CSS v5.3 (CDN) -->
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

      <!-- Logo centralizada no topo -->
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

    <!-- Bootstrap JS v5.3 (bundle com Popper) e script de loading -->
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
// POST /generate → gera as fichas para o parentId selecionado
//                  → exibe página de resultado com botão download ZIP e lista PDFs
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

  // Depois que o ZIP foi gerado, listamos todos os PDFs correspondentes:
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

  // Monta lista de links para cada PDF
  const listPdfHtml = pdfFiles
    .map(fname => {
      return `
      <li class="list-group-item">
        <a href="/downloads/${fname}" target="_blank">${fname}</a>
      </li>`;
    })
    .join('\n');

  // Página de resultado: logo + botão de download do ZIP + lista de todos os PDFs
  const html = `
<!DOCTYPE html>
<html lang="pt-BR">
  <head>
    <meta charset="UTF-8" />
    <title>Fichas Geradas</title>
    <!-- Bootstrap CSS v5.3 (CDN) -->
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
                Baixar todas as fichas (ZIP)
              </a>
              <a href="/" class="btn btn-secondary">← Voltar</a>
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

    <!-- Bootstrap JS v5.3 (Bundle com Popper) e ícones Bootstrap Icons (CDN) -->
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

/**
 * generate_sheets.js
 *
 * Serviço HTTP para gerar fichas de inscrição em PDF de uma oportunidade pai
 * incluindo todas as suas fases-filhas (exceto “Publicação final do resultado”).
 *
 * Passos:
 *   1) GET  /        → lista apenas as oportunidades‐pai (parent_id IS NULL).
 *   2) POST /generate → recebe parentId, identifica “primeira fase filha” (menor ID > parentId,
 *                      ignorando parentId+1), busca inscrições dessa fase, e para cada inscrição:
 *                      a) lê a chave previousPhaseRegistrationId para achar a inscrição-pai,
 *                         então busca meta para a fase-pai (phaseId = parentId);
 *                      b) busca meta para a própria inscrição (phaseId = firstPhaseId);
 *                      c) (opcional) busca meta para fases-filhas posteriores (phaseId > firstPhaseId),
 *                         se existirem e forem relevantes;
 *                      d) monta os blocos “pai” + “filhos” e gera PDF+ZIP.
 *
 * No template, o primeiro bloco (pai) será exibido como “Fase de inscrições” (título fixo),
 * e os demais blocos exibirão “FASE: <nome real>”.
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
 *   - ./templates/ficha-inscricao.html (o template Handlebars abaixo)
 *   - ./output      (pasta para arquivos gerados)
 */

require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');
const Handlebars = require('handlebars');
const puppeteer = require('puppeteer-core');
const archiver = require('archiver');

// 1. Carrega variáveis de ambiente
const DB_HOST = process.env.DB_HOST || 'localhost';
const DB_PORT = parseInt(process.env.DB_PORT || '5432', 10);
const DB_USER = process.env.DB_USER || 'mapas';
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

// 2) Helpers Handlebars
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

// 3) Carrega e compila o template
const templatePath = path.join(__dirname, 'templates', 'ficha-inscricao.html');
if (!fs.existsSync(templatePath)) {
  console.error(`Template não encontrado em ${templatePath}`);
  process.exit(1);
}
const templateSource = fs.readFileSync(templatePath, 'utf-8');
const template       = Handlebars.compile(templateSource);

// 4) Caminho do logo
const assetPath = path.join(__dirname, 'assets');

////////////////////////////////////////////////////////////////////////////////
// Funções de acesso ao banco
////////////////////////////////////////////////////////////////////////////////

// 4.1) Lista todas as oportunidades‐pai (parent_id IS NULL), ordenadas por nome
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

// 4.2) Lista todos os filhos de parentId, EXCLUINDO parentId+1, ordenados por ID
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

// 4.3) Retorna o menor ID dentre os filhos (exceto parentId+1), ou null se não houver
async function findFirstPhaseId(parentId) {
  const children = await fetchChildrenExcludingNext(parentId);
  if (!children.length) return null;
  return children[0].id;
}

// 4.4) Buscar todas as fases relevantes (pai + filhos exceto parentId+1), em ordem crescente de ID
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

// 4.5) Busca inscrições para uma fase (phaseId) qualquer → retorna
//      [{ registration_id, registration_number, agent_id, agent_name }, …]
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

// 4.6) Busca a inscrição‐pai associada a uma inscrição‐child, lendo
//      previousPhaseRegistrationId de registration_meta.
//      Retorna null se não encontrar.
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
    // O campo “value” vem como texto (VARCHAR), convertemos para inteiro:
    const parentRegId = parseInt(res.rows[0].value, 10);
    return isNaN(parentRegId) ? null : parentRegId;
  } finally {
    client.release();
  }
}

// 4.7) Busca TODAS as respostas (registration_meta → registration_field_configuration)
//      de uma inscrição específica, mas SEMPRE filtrando rm.key LIKE 'field_%'.
//      Se “isParent” for true, usa registrationIdPai e phaseId = parentId. 
//      Caso contrário, usa registrationIdFilho e phaseIdsFilho (array).
async function fetchMetaForSingleRegistration(regId, phaseIds) {
  // retorna { phaseId: { field_label: field_value, … }, … }
  const client = await pool.connect();
  try {
    const query = `
      SELECT
        rfc.opportunity_id AS phase_id,
        rfc.title          AS field_label,
        rm.value           AS field_value
      FROM registration_meta rm
      JOIN registration_field_configuration rfc
        ON rm.key LIKE 'field_%'
        AND CAST(replace(rm.key, 'field_', '') AS INTEGER) = rfc.id
        AND rfc.opportunity_id = ANY($2::int[])
      WHERE rm.object_id = $1
    `;
    const res = await client.query(query, [regId, phaseIds]);
    const grouped = {};
    for (const row of res.rows) {
      const pid = row.phase_id;
      if (!grouped[pid]) grouped[pid] = {};
      grouped[pid][row.field_label] = row.field_value;
    }
    return grouped;
  } finally {
    client.release();
  }
}

////////////////////////////////////////////////////////////////////////////////
// 5) Converte HTML em PDF via Puppeteer/Chromium
////////////////////////////////////////////////////////////////////////////////
async function htmlToPdfBuffer(html) {
  // Ajuste conforme seu ambiente se o binário for diferente
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

////////////////////////////////////////////////////////////////////////////////
// 6) Geração de fichas:  
//    Recebe um parentId e realiza todos os passos:
//      - Identifica firstPhaseId (menor filho ≠ parentId+1)
//      - Carrega todas as fases [parentId, firstPhaseId, outros filhos…]
//      - Carrega inscrições só da firstPhaseId (child)
//      - Para cada inscrição-child:
//          * Lê previousPhaseRegistrationId → parentRegistrationId
//          * Busca meta do parent (fase pai) usando parentRegistrationId + [parentId]
//          * Busca meta do child (fase 1) etc para outras fases
//          * Gera PDF + armazena lista de nomes
//      - Empacota tudo num ZIP e devolve o nome do ZIP
////////////////////////////////////////////////////////////////////////////////
async function generateFichas(parentId) {
  // 6.1) Identifica a “primeira fase” (menor ID dentre filhos ≠ parentId+1)
  const firstPhaseId = await findFirstPhaseId(parentId);
  if (!firstPhaseId) {
    throw new Error(`Nenhuma fase-filho válida encontrada para parentId=${parentId}`);
  }

  // 6.2) Carrega TODAS as fases relevantes: [ {id:parentId,name:…}, {id:filho1,name:…}, … ]
  const phases = await fetchAllRelevantPhases(parentId);
  // Exemplo de phases: 
  // [ {id:11,  name:"Trindade-GO–Edital…"}, 
  //   {id:208, name:"Recebimento de Documentos de Habilitação"}, 
  //   {id:290, name:"Prestação de Contas"} ]

  // 6.3) Busca as inscrições SÓ da dado firstPhaseId (a “fase de inscrições” na prática)
  const registrations = await fetchRegistrationsForPhase(firstPhaseId);
  // registrations = [ { registration_id:2000, registration_number:"AC429222796", agent_id:xxx, agent_name:"…" }, … ]

  // 6.4) Garante que OUTPUT_DIR exista e cria placeholder
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
  const placeholder = path.join(OUTPUT_DIR, 'index.html');
  if (!fs.existsSync(placeholder)) {
    fs.writeFileSync(placeholder, '', 'utf-8');
  }

  const pdfFilenames = [];

  // 6.5) Para cada inscrição da primeira fase, montamos os blocos de meta
  for (const reg of registrations) {
    // registra o “número” como preferencial; se vier null, usa registration_id
    const regNumber = reg.registration_number || reg.registration_id;

    // 6.5.1) Descobre o parentRegistrationId (se existir) lendo previousPhaseRegistrationId
    const parentRegId = await fetchParentRegistrationId(reg.registration_id);

    // 6.5.2) Carrega meta do PAI (fase parentId), se parentRegId existir
    let parentMetaFields = {};
    if (parentRegId) {
      // Buscar apenas os campos da fase-pai (parentId) para parentRegId
      const obj = await fetchMetaForSingleRegistration(parentRegId, [parentId]);
      parentMetaFields = obj[parentId] || {};
    }

    // 6.5.3) Carrega meta da inscrição-child (firstPhaseId) para as fases-filhas (além de parentId),
    //          devemos englobar todos phaseIds, mas parent já coberto; 
    //          portanto usamos TODOS os phases.map(p=>p.id) exceto parentId+? se for ignorado repetido
    const allPhaseIds = phases.map(p => p.id);
    // A consulta já filtra only ‘field_%’ e rfc.opportunity_id ∈ allPhaseIds
    const allMeta = await fetchMetaForSingleRegistration(reg.registration_id, allPhaseIds);
    // allMeta poderá ter chaves para phase 208, 290, etc, EXCETO PAI (porque este não será meta daquele registrationId)

    // 6.5.4) Monta o array data.phases com metaFields para cada fase, na ordem de phases[]
    //          idx=0 sempre será o PAI → metaFields = parentMetaFields.
    //          idx>0 serão as fases-filhas, metaFields = allMeta[thatPhaseId] ou {} se não existir.
    const dataPhases = phases.map((phase, idx) => {
      if (idx === 0) {
        // fase-pai, rotulada no template como “Fase de inscrições”
        return {
          id:         phase.id,
          name:       phase.name,
          metaFields: parentMetaFields
        };
      } else {
        // fase-filho
        return {
          id:         phase.id,
          name:       phase.name,
          metaFields: allMeta[phase.id] || {}
        };
      }
    });

    // 6.5.5) Monta objeto “data” e renderiza HTML via Handlebars
    const data = {
      registration_number: regNumber,
      agent: {
        id:   reg.agent_id,
        name: reg.agent_name || '',
      },
      phases:   dataPhases,
      assetPath: assetPath
    };

    let html;
    try {
      html = template(data);
    } catch (err) {
      console.error(`Erro ao renderizar template para registration_number=${regNumber}:`, err);
      continue;
    }

    // 6.5.6) Converte HTML em PDF
    let pdfBuffer;
    try {
      pdfBuffer = await htmlToPdfBuffer(html);
    } catch (err) {
      console.error(`Erro ao gerar PDF para registration_number=${regNumber}:`, err);
      continue;
    }

    // 6.5.7) Salva o PDF em OUTPUT_DIR
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

  // 6.6) Empacota todos os PDFs num ZIP e retorna o nome do arquivo
  const zipFilename = `fichas_${parentId}.zip`;
  const zipFilepath = path.join(OUTPUT_DIR, zipFilename);
  const output = fs.createWriteStream(zipFilepath);
  const archive = archiver('zip', { zlib: { level: 9 } });

  return new Promise((resolve, reject) => {
    output.on('close', () => {
      console.log(`ZIP gerado: ${zipFilename} (${archive.pointer()} bytes)`);
      resolve(zipFilename);
    });
    archive.on('error', (err) => {
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

////////////////////////////////////////////////////////////////////////////////
// Configuração do Express
////////////////////////////////////////////////////////////////////////////////
const app = express();
app.use(express.urlencoded({ extended: true }));

// Servir arquivos estáticos em /downloads (PDFs e ZIPs)
app.use('/downloads', express.static(OUTPUT_DIR));

////////////////////////////////////////////////////////////////////////////////
// GET / → form com <select> apenas de oportunidades-pai
////////////////////////////////////////////////////////////////////////////////
app.get('/', async (req, res) => {
  let parents = [];
  try {
    parents = await fetchParentOpportunities();
  } catch (err) {
    console.error('Erro ao buscar oportunidades-pai:', err);
  }

  const optionsHtml = parents
    .map((row) => `<option value="${row.id}">${row.name}</option>`)
    .join('\n');

  const html = `
<!DOCTYPE html>
<html lang="pt-BR">
  <head>
    <meta charset="UTF-8" />
    <title>Gerar Fichas de Inscrição</title>
  </head>
  <body>
    <h1>Gerar Fichas de Inscrição</h1>
    <form action="/generate" method="POST">
      <label for="parent">Escolha a oportunidade principal:</label><br/>
      <select name="parent" id="parent" required>
        ${optionsHtml}
      </select>
      <br/><button type="submit">Gerar Fichas</button>
    </form>
  </body>
</html>
  `.trim();

  res.send(html);
});

////////////////////////////////////////////////////////////////////////////////
// POST /generate → gera as fichas para o parentId selecionado
////////////////////////////////////////////////////////////////////////////////
app.post('/generate', async (req, res) => {
  const parentId = parseInt(req.body.parent, 10);
  if (isNaN(parentId)) {
    return res.status(400).send('Oportunidade inválida.');
  }

  try {
    const zipFilename = await generateFichas(parentId);
    const html = `
<!DOCTYPE html>
<html lang="pt-BR">
  <head>
    <meta charset="UTF-8" />
    <title>Fichas Geradas</title>
  </head>
  <body>
    <h1>Fichas geradas para oportunidade principal ${parentId}</h1>
    <p>
      <a href="/downloads/${zipFilename}" download>
        Baixar todas as fichas (ZIP)
      </a>
    </p>
    <p><a href="/">Voltar</a></p>
  </body>
</html>
    `.trim();
    res.send(html);
  } catch (err) {
    console.error('Erro ao gerar fichas:', err);
    res.status(500).send('Erro ao gerar fichas. Veja o log no servidor.');
  }
});

// Inicia servidor
app.listen(SERVER_PORT, () => {
  console.log(`Servidor rodando na porta ${SERVER_PORT}`);
  console.log(`Acesse http://localhost:${SERVER_PORT}/ para gerar fichas.`);
});

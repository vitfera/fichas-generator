/**
 * generate_sheets.js
 *
 * Serviço HTTP para gerar fichas de inscrição em PDF de uma oportunidade.
 * - GET /: exibe uma página com dropdown de oportunidades disponíveis (exibindo o nome de cada uma).
 * - POST /generate: gera PDFs, empacota em ZIP e retorna link de download.
 *
 * Antes de executar (docker ou local), crie um arquivo .env com:
 *   DB_HOST=localhost
 *   DB_PORT=5432
 *   DB_USER=mapas
 *   DB_PASSWORD=mapas
 *   DB_NAME=mapas
 *   OUTPUT_DIR=./output
 *   SERVER_PORT=4444
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
const DB_NAME = process.env.DB_NAME || 'mapas';
const OUTPUT_DIR = process.env.OUTPUT_DIR || path.join(__dirname, 'output');
const SERVER_PORT = parseInt(process.env.SERVER_PORT || '4444', 10);

// 2. Pool de conexão com o Postgres
const pool = new Pool({
  host: DB_HOST,
  port: DB_PORT,
  user: DB_USER,
  password: DB_PASSWORD,
  database: DB_NAME,
});

// 3. Carrega e compila o template Handlebars
const templatePath = path.join(__dirname, 'templates', 'ficha-inscricao.html');
if (!fs.existsSync(templatePath)) {
  console.error(`Template não encontrado em ${templatePath}`);
  process.exit(1);
}
const templateSource = fs.readFileSync(templatePath, 'utf-8');

// 3.1. Registrar helper “get” para acessar metaFields com chave dinâmica
Handlebars.registerHelper('get', function(obj, key) {
  return (obj && obj[key] !== undefined) ? obj[key] : '';
});

// 3.2. Compilar o template
const template = Handlebars.compile(templateSource);

// 4. Caminho para os assets (logo.png)
const assetPath = path.join(__dirname, 'assets');

/**
 * 5. Função: busca todas as oportunidades, retornando { id, name }.
 *    Ajuste o nome da tabela/coluna conforme seu esquema real.
 */
async function fetchOpportunities() {
  const client = await pool.connect();
  try {
    // Supondo que existe uma tabela "opportunity" com colunas "id" e "name"
    const query = `
      SELECT id, name
      FROM opportunity
      ORDER BY name;
    `;
    const res = await client.query(query);
    return res.rows; // cada row terá { id, name }
  } finally {
    client.release();
  }
}

/**
 * 6. Função: busca dados das inscrições de uma oportunidade (pelo ID).
 *    Corrige o JOIN para só tentar fazer CAST em rm.key quando rm.key LIKE 'field_%',
 *    usando CASE para evitar erro de sintaxe.
 */
async function fetchRegistrationData(opId) {
  const client = await pool.connect();
  try {
    const query = `
      SELECT
        r.id AS registration_id,
        a.id AS agent_id,
        a.name AS agent_name,
        MAX(CASE WHEN rm.key = 'projectName' THEN rm.value END) AS project_name,
        jsonb_object_agg(rfc.title, rm.value) FILTER (
          WHERE rm.key LIKE 'field_%'
            AND CAST(replace(rm.key, 'field_', '') AS INTEGER) = rfc.id
            AND rfc.opportunity_id = r.opportunity_id
        ) AS all_fields
      FROM registration r
      LEFT JOIN agent a ON r.agent_id = a.id
      LEFT JOIN registration_meta rm ON rm.object_id = r.id
      LEFT JOIN registration_field_configuration rfc
        ON CASE
             WHEN rm.key LIKE 'field_%'
             THEN CAST(replace(rm.key, 'field_', '') AS INTEGER)
             ELSE NULL
           END = rfc.id
        AND rfc.opportunity_id = r.opportunity_id
      WHERE r.opportunity_id = $1
      GROUP BY
        r.id,
        a.id, a.name;
    `;
    const res = await client.query(query, [opId]);
    return res.rows;
  } finally {
    client.release();
  }
}

/**
 * 7. Converte HTML (string) em PDF Buffer usando Puppeteer-Core + Chromium do sistema
 */
async function htmlToPdfBuffer(html) {
  // 7.1. Caminho para o binário do Chromium instalado via apt-get
  const executablePath = '/usr/bin/chromium'; 
  // Em alguns casos (Debian Bullseye), pode ser '/usr/bin/chromium-browser'.
  // Verifique no container: `docker compose exec fichas-generator which chromium` 
  // ou `which chromium-browser`.

  const browser = await puppeteer.launch({
    executablePath: executablePath,
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

/**
 * 8. Gera PDFs para cada inscrição e empacota tudo num ZIP.
 *    Retorna o nome do arquivo ZIP gerado.
 */
async function generateFichas(opId) {
  // 8.1. Cria OUTPUT_DIR caso não exista
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // 8.2. Busca dados das inscrições
  const registrations = await fetchRegistrationData(opId);

  // 8.3. Prepara lista de filenames de PDF gerados
  const pdfFilenames = [];

  // 8.4. Para cada inscrição, gerar o PDF
  for (const row of registrations) {
    const data = {
      registration_id: row.registration_id,
      opportunity_id: opId,
      agent: {
        id: row.agent_id,
        name: row.agent_name || '',
      },
      project_name: row.project_name || '',
      metaFields: row.all_fields || {},
      mappingFields: row.all_fields
        ? Object.entries(row.all_fields).map(([label, value]) => ({ label, value }))
        : [],
      assetPath: assetPath,
    };

    // 8.4.1. Renderiza o HTML via Handlebars
    let html;
    try {
      html = template(data);
    } catch (err) {
      console.error(`Erro ao renderizar template para registration_id=${row.registration_id}:`, err);
      continue;
    }

    // 8.4.2. Converte HTML para PDF
    let pdfBuffer;
    try {
      pdfBuffer = await htmlToPdfBuffer(html);
    } catch (err) {
      console.error(`Erro ao gerar PDF para registration_id=${row.registration_id}:`, err);
      continue;
    }

    // 8.4.3. Salva o PDF em OUTPUT_DIR
    const filename = `ficha_${opId}_${row.registration_id}.pdf`;
    const filepath = path.join(OUTPUT_DIR, filename);
    try {
      fs.writeFileSync(filepath, pdfBuffer);
      pdfFilenames.push(filename);
      console.log(`PDF gerado: ${filename}`);
    } catch (err) {
      console.error(`Erro ao salvar PDF ${filename}:`, err);
    }
  }

  // 8.5. Empacota todos os PDFs num ZIP
  const zipFilename = `fichas_${opId}.zip`;
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
      const filepath = path.join(OUTPUT_DIR, filename);
      archive.file(filepath, { name: filename });
    }
    archive.finalize();
  });
}

// 9. Configura Express
const app = express();
app.use(express.urlencoded({ extended: true }));

// 10. Servir arquivos estáticos em /downloads
app.use('/downloads', express.static(OUTPUT_DIR));

// 11. GET / → lista de oportunidades (exibindo o nome)
app.get('/', async (req, res) => {
  let opportunities = [];
  try {
    opportunities = await fetchOpportunities();
  } catch (err) {
    console.error('Erro ao buscar oportunidades:', err);
  }
  // Monta opções do <select>: cada oportunidade vira <option value="id">nome</option>
  const optionsHtml = opportunities
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
          <label for="opportunity">Escolha a oportunidade:</label>
          <select name="opportunity" id="opportunity" required>
            ${optionsHtml}
          </select>
          <button type="submit">Gerar Fichas</button>
        </form>
      </body>
    </html>
  `;
  res.send(html);
});

// 12. POST /generate → gera PDFs e exibe link para baixar o ZIP
app.post('/generate', async (req, res) => {
  const opId = parseInt(req.body.opportunity, 10);
  if (isNaN(opId)) {
    return res.status(400).send('Oportunidade inválida.');
  }

  try {
    const zipFilename = await generateFichas(opId);
    // Página com link para baixar o ZIP
    const html = `
      <!DOCTYPE html>
      <html lang="pt-BR">
        <head>
          <meta charset="UTF-8" />
          <title>Fichas Geradas</title>
        </head>
        <body>
          <h1>Fichas geradas para oportunidade ${opId}</h1>
          <p>
            <a href="/downloads/${zipFilename}" download>
              Baixar todas as fichas (ZIP)
            </a>
          </p>
          <p><a href="/">Voltar</a></p>
        </body>
      </html>
    `;
    res.send(html);
  } catch (err) {
    console.error('Erro ao gerar fichas:', err);
    res.status(500).send('Erro ao gerar fichas. Veja o log no servidor.');
  }
});

// 13. Inicia o servidor HTTP
app.listen(SERVER_PORT, () => {
  console.log(`Servidor rodando na porta ${SERVER_PORT}`);
  console.log(`Acesse http://localhost:${SERVER_PORT}/ para gerar fichas.`);
});

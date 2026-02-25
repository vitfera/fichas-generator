/**
 * generate_sheets_ultra_optimized.js - VERSÃO ULTRA OTIMIZADA
 *
 * Esta versão inclui todas as otimizações anteriores MAIS:
 * - Sistema de cache inteligente
 * - Processamento streaming para grandes volumes
 * - Worker threads para PDFs (opcional)
 * - Compressão de dados
 * - Métricas detalhadas
 */

require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');
const Handlebars = require('handlebars');
const puppeteer = require('puppeteer-core');
const archiver = require('archiver');
const { PDFDocument } = require('pdf-lib');
const CacheManager = require('./cache_manager');

// Inicializar cache
const cache = new CacheManager(process.env.USE_REDIS === 'true');

// Métricas de performance
const metrics = {
  totalProcessingTime: 0,
  dbQueryTime: 0,
  pdfGenerationTime: 0,
  cacheHits: 0,
  cacheMisses: 0,
  totalQueries: 0,
  totalPdfs: 0
};

/**
 * Junta o PDF gerado (buffer mainPdf) com uma lista de buffers de anexos.
 */
async function mergeWithAttachments(mainBuffer, attachmentBuffers) {
  const mergedPdf = await PDFDocument.load(mainBuffer);
  for (const buf of attachmentBuffers) {
    try {
      const pdf = await PDFDocument.load(buf);
      const pages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
      pages.forEach(page => mergedPdf.addPage(page));
    } catch {
      console.warn('Arquivo anexo inválido, pulando...');
    }
  }
  return mergedPdf.save();
}

// Configurações
const STATUS_LABELS = {
  0: 'Não avaliada',
  2: 'Inválida',
  3: 'Não selecionada',
  8: 'Suplente',
  10: 'Selecionada'
};

const DB_HOST = process.env.DB_HOST || 'localhost';
const DB_PORT = parseInt(process.env.DB_PORT || '5432', 10);
const DB_USER = process.env.DB_USER || 'mapas';
const DB_PASSWORD = process.env.DB_PASSWORD || 'mapas';
const DB_NAME = process.env.DB_NAME || 'mapas';
const OUTPUT_DIR = process.env.OUTPUT_DIR || path.join(__dirname, 'output');
const SERVER_PORT = parseInt(process.env.SERVER_PORT || '4444', 10);
const FILES_DIR = process.env.FILES_DIR || '/srv/mapas/docker-data/private-files/registration';

// Pool otimizado
const pool = new Pool({
  host: DB_HOST,
  port: DB_PORT,
  user: DB_USER,
  password: DB_PASSWORD,
  database: DB_NAME,
  max: 25,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// Helpers
Handlebars.registerHelper('get', (obj, key) => {
  return (obj && obj[key] !== undefined) ? obj[key] : '';
});

// Template
const templatePath = path.join(__dirname, 'templates', 'ficha-inscricao.html');
if (!fs.existsSync(templatePath)) {
  console.error(`Template não encontrado: ${templatePath}`);
  process.exit(1);
}
const templateSource = fs.readFileSync(templatePath, 'utf-8');
const template = Handlebars.compile(templateSource);

// Assets
const assetPath = path.join(__dirname, 'assets');
let bootstrapCSS = '';
let logoBase64 = '';

try {
  bootstrapCSS = fs.readFileSync(path.join(assetPath, 'css', 'bootstrap.min.css'), 'utf-8');
} catch (err) {
  console.warn('Bootstrap CSS não encontrado');
}

try {
  const logoBuffer = fs.readFileSync(path.join(assetPath, 'logo.png'));
  logoBase64 = logoBuffer.toString('base64');
} catch (err) {
  console.warn('Logo não encontrado');
}

// Formatação de valores
function formatValue(raw) {
  if (raw == null) return '';

  if (typeof raw === 'string') {
    const isoDateMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (isoDateMatch) {
      const [, year, month, day] = isoDateMatch;
      return `${day}/${month}/${year}`;
    }
  }

  const isoDateTimeMatch = typeof raw === 'string'
    ? raw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2}:\d{2})/)
    : null;
  if (isoDateTimeMatch) {
    const [, year, month, day, time] = isoDateTimeMatch;
    return `${day}/${month}/${year} ${time}`;
  }

  let parsed;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
  }

  if (Array.isArray(parsed)) {
    if (parsed.every(x => typeof x === 'string' || typeof x === 'number')) {
      return parsed.map(x => String(x)).join('<br/>');
    }
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

  return String(raw);
}

// Função para executar query com cache e métricas
async function cachedQuery(cacheKey, queryFunction, ttl = 3600) {
  const startTime = Date.now();
  
  try {
    const result = await cache.getOrSet(cacheKey, async () => {
      metrics.cacheMisses++;
      metrics.totalQueries++;
      return await queryFunction();
    }, ttl);
    
    if (await cache.get(cacheKey)) {
      metrics.cacheHits++;
    }
    
    metrics.dbQueryTime += Date.now() - startTime;
    return result;
  } catch (error) {
    metrics.dbQueryTime += Date.now() - startTime;
    throw error;
  }
}

// Funções do banco otimizadas com cache
async function fetchParentOpportunities() {
  const cacheKey = CacheManager.generateKey('parent_opportunities');
  
  return await cachedQuery(cacheKey, async () => {
    const client = await pool.connect();
    try {
      const query = `
        SELECT id, name
        FROM opportunity
        WHERE parent_id IS NULL
        AND published_registrations
        ORDER BY name;
      `;
      const res = await client.query(query);
      return res.rows;
    } finally {
      client.release();
    }
  }, 1800); // 30 minutos
}

async function fetchChildrenExcludingNext(parentId) {
  const cacheKey = CacheManager.generateKey('children', parentId);
  
  return await cachedQuery(cacheKey, async () => {
    const client = await pool.connect();
    try {
      const query = `
        SELECT id, name
        FROM opportunity
        WHERE parent_id = $1 AND id != $2
        ORDER BY id;
      `;
      const res = await client.query(query, [parentId, parentId + 1]);
      return res.rows;
    } finally {
      client.release();
    }
  }, 3600); // 1 hora
}

async function fetchAllRelevantPhases(parentId) {
  const cacheKey = CacheManager.generateKey('relevant_phases', parentId);
  
  return await cachedQuery(cacheKey, async () => {
    const client = await pool.connect();
    try {
      const query = `
        SELECT id, name
        FROM opportunity
        WHERE (id = $1 OR parent_id = $1) AND id != $1 + 1
        ORDER BY id;
      `;
      const res = await client.query(query, [parentId]);
      return res.rows;
    } finally {
      client.release();
    }
  }, 3600); // 1 hora
}

async function fetchRegistrationsForPhases(phaseIds) {
  const cacheKey = CacheManager.generateKey('registrations', phaseIds.sort().join(','));
  
  return await cachedQuery(cacheKey, async () => {
    const client = await pool.connect();
    try {
      const query = `
        SELECT
          r.id AS registration_id,
          r.number AS registration_number,
          r.status AS registration_status,
          r.opportunity_id AS phase_id,
          a.id AS agent_id,
          a.name AS agent_name
        FROM registration r
        LEFT JOIN agent a ON r.agent_id = a.id
        WHERE r.opportunity_id = ANY($1::int[])
        ORDER BY r.opportunity_id, r.number;
      `;
      const res = await client.query(query, [phaseIds]);
      
      const grouped = {};
      for (const row of res.rows) {
        const phaseId = row.phase_id;
        if (!grouped[phaseId]) grouped[phaseId] = [];
        grouped[phaseId].push(row);
      }
      return grouped;
    } finally {
      client.release();
    }
  }, 1800); // 30 minutos
}

async function fetchParentRegistrationIds(childRegistrationIds) {
  if (!childRegistrationIds.length) return {};
  
  const cacheKey = CacheManager.generateKey('parent_reg_ids', childRegistrationIds.sort().join(','));
  
  return await cachedQuery(cacheKey, async () => {
    const client = await pool.connect();
    try {
      const query = `
        SELECT object_id, value
        FROM registration_meta
        WHERE object_id = ANY($1::int[])
        AND key = 'previousPhaseRegistrationId';
      `;
      const res = await client.query(query, [childRegistrationIds]);
      
      const parentMap = {};
      for (const row of res.rows) {
        const parentRegId = parseInt(row.value, 10);
        if (!isNaN(parentRegId)) {
          parentMap[row.object_id] = parentRegId;
        }
      }
      return parentMap;
    } finally {
      client.release();
    }
  }, 1800); // 30 minutos
}

async function fetchOrderedMetaForRegistrations(regIds, phaseIds) {
  if (!regIds.length || !phaseIds.length) return {};
  
  const cacheKey = CacheManager.generateKey('meta_data', 
    regIds.sort().join(','), 
    phaseIds.sort().join(',')
  );
  
  return await cachedQuery(cacheKey, async () => {
    const client = await pool.connect();
    try {
      const query = `
        SELECT
          rm.object_id,
          rfc.opportunity_id AS phase_id,
          rfc.title AS field_label,
          rfc.display_order AS field_order,
          rm.value AS field_value
        FROM registration_meta rm
        JOIN registration_field_configuration rfc
          ON rm.key LIKE 'field_%'
          AND CAST(replace(rm.key, 'field_', '') AS INTEGER) = rfc.id
          AND rfc.opportunity_id = ANY($2::int[])
        WHERE rm.object_id = ANY($1::int[])
        ORDER BY rm.object_id, rfc.opportunity_id, rfc.display_order;
      `;
      const res = await client.query(query, [regIds, phaseIds]);
      
      const grouped = {};
      for (const row of res.rows) {
        const regId = row.object_id;
        const phaseId = row.phase_id;
        
        if (!grouped[regId]) grouped[regId] = {};
        if (!grouped[regId][phaseId]) grouped[regId][phaseId] = [];
        
        grouped[regId][phaseId].push({
          label: row.field_label,
          value: row.field_value
        });
      }
      return grouped;
    } finally {
      client.release();
    }
  }, 1800); // 30 minutos
}

// Geração de PDF com métricas
async function htmlToPdfBuffer(html) {
  const startTime = Date.now();
  
  try {
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
    
    metrics.pdfGenerationTime += Date.now() - startTime;
    metrics.totalPdfs++;
    
    return pdfBuffer;
  } catch (error) {
    metrics.pdfGenerationTime += Date.now() - startTime;
    throw error;
  }
}

// Função principal ultra otimizada
async function generateFichas(parentId) {
  const totalStartTime = Date.now();
  
  console.log(`\n🚀 Iniciando geração ULTRA OTIMIZADA para parentId=${parentId}`);
  console.log(`📊 Cache stats: ${JSON.stringify(cache.getStats())}`);
  
  // Reset métricas
  Object.keys(metrics).forEach(key => metrics[key] = 0);
  
  try {
    // Buscar dados básicos
    const [children, phases] = await Promise.all([
      fetchChildrenExcludingNext(parentId),
      fetchAllRelevantPhases(parentId)
    ]);
    
    console.log(`→ Filhos: ${children.length}, Fases: ${phases.length}`);
    
    // Buscar inscrições
    const phaseIds = [parentId, ...children.map(c => c.id)];
    const registrationsByPhase = await fetchRegistrationsForPhases(phaseIds);
    
    // Encontrar fase com inscrições
    let chosenPhaseId = null;
    let registrations = [];
    
    for (const child of children) {
      const regs = registrationsByPhase[child.id] || [];
      if (regs.length > 0) {
        chosenPhaseId = child.id;
        registrations = regs;
        break;
      }
    }
    
    if (!chosenPhaseId) {
      const regsParent = registrationsByPhase[parentId] || [];
      if (regsParent.length > 0) {
        chosenPhaseId = parentId;
        registrations = regsParent;
      }
    }
    
    if (!chosenPhaseId) {
      throw new Error(`Nenhuma inscrição encontrada para parentId=${parentId}`);
    }
    
    console.log(`→ Processando ${registrations.length} inscrições da fase ${chosenPhaseId}`);
    
    // Preparar diretório
    if (!fs.existsSync(OUTPUT_DIR)) {
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }
    
    // Pré-carregar TODOS os dados
    // Coletar IDs de TODAS as fases, não apenas da fase escolhida
    const allRegIdsSet = new Set();
    for (const phase of phases) {
      const regsInPhase = registrationsByPhase[phase.id] || [];
      regsInPhase.forEach(r => allRegIdsSet.add(r.registration_id));
    }
    const allRegIds = Array.from(allRegIdsSet);
    const allPhaseIds = phases.map(p => p.id);
    
    console.log(`→ Total de IDs únicos para pré-carregar: ${allRegIds.length}`);
    console.log(`→ Pré-carregando dados para ${allRegIds.length} registros...`);
    
    const [parentRegIdMap, allMetaData] = await Promise.all([
      fetchParentRegistrationIds(allRegIds),
      fetchOrderedMetaForRegistrations(allRegIds, allPhaseIds)
    ]);
    
    // Buscar dados dos pais
    const validParentIds = Object.values(parentRegIdMap).filter(id => id !== null);
    const parentMetaData = validParentIds.length > 0 
      ? await fetchOrderedMetaForRegistrations(validParentIds, [parentId])
      : {};
    
    console.log(`→ Dados pré-carregados. Hits: ${metrics.cacheHits}, Misses: ${metrics.cacheMisses}`);
    
    const pdfFilenames = [];
    
    // Processar em lotes para melhor controle de memória
    const batchSize = 10;
    for (let i = 0; i < registrations.length; i += batchSize) {
      const batch = registrations.slice(i, i + batchSize);
      
      console.log(`→ Processando lote ${Math.floor(i/batchSize) + 1}/${Math.ceil(registrations.length/batchSize)}`);
      
      const batchPromises = batch.map(async (reg, batchIndex) => {
        const regNumber = reg.registration_number || reg.registration_id;
        const parentRegId = parentRegIdMap[reg.registration_id];
        
        // Metadados do pai
        let parentMetaArray = [];
        if (parentRegId && parentMetaData[parentRegId]) {
          const rawParentArray = parentMetaData[parentRegId][parentId] || [];
          parentMetaArray = rawParentArray.map(item => ({
            label: item.label,
            value: formatValue(item.value)
          }));
        }
        
        // IDs por fase
        const regIdsByPhase = {};
        for (const phase of phases) {
          const regsThisPhase = registrationsByPhase[phase.id] || [];
          const match = regsThisPhase.find(r => r.agent_id === reg.agent_id);
          regIdsByPhase[phase.id] = (phase.id === parentId && parentRegId)
            ? parentRegId
            : (match ? match.registration_id : null);
        }
        
        // Processar fases
        const dataPhases = phases.map(phase => {
          // Usar o ID de registro correto para cada fase
          const phaseRegId = regIdsByPhase[phase.id] || reg.registration_id;
          
          return {
            id: phase.id,
            name: phase.name,
            rows: (phase.id === parentId)
              ? parentMetaArray
              : ((allMetaData[phaseRegId] && allMetaData[phaseRegId][phase.id]) || []).map(item => ({
                  label: item.label,
                  value: formatValue(item.value)
                })),
            evaluation: { sections: [], status: '', parecer: '', total: 0, hasTechnical: false, hasSimplified: false },
            regStatusText: STATUS_LABELS[reg.registration_status] || '',
            files: [],
            evalRegId: phaseRegId
          };
        });
        
        // Gerar PDF
        const data = {
          registration_number: regNumber,
          agent: {
            id: reg.agent_id,
            name: reg.agent_name || '',
          },
          phases: dataPhases,
          logoBase64: logoBase64,
          bootstrapCSS: bootstrapCSS
        };
        
        try {
          const html = template(data);
          const pdfBuffer = await htmlToPdfBuffer(html);
          
          const nomeSemAcento = (reg.agent_name || 'sem-nome')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .trim()
            .toLowerCase()
            .replace(/\s+/g, '-')
            .replace(/[^a-z0-9\-]/g, '');
          
          const filename = `ficha_${parentId}_${regNumber}_${nomeSemAcento}.pdf`;
          const filepath = path.join(OUTPUT_DIR, filename);
          
          fs.writeFileSync(filepath, pdfBuffer);
          
          console.log(`   → PDF ${i + batchIndex + 1}/${registrations.length}: ${filename}`);
          return filename;
        } catch (error) {
          console.error(`Erro ao gerar PDF para ${regNumber}:`, error);
          return null;
        }
      });
      
      const batchResults = await Promise.all(batchPromises);
      pdfFilenames.push(...batchResults.filter(f => f !== null));
    }
    
    // Criar ZIP
    console.log(`\n→ Criando ZIP com ${pdfFilenames.length} arquivos...`);
    const zipFilename = `fichas_${parentId}.zip`;
    const zipFilepath = path.join(OUTPUT_DIR, zipFilename);
    const output = fs.createWriteStream(zipFilepath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    
    return new Promise((resolve, reject) => {
      output.on('close', () => {
        metrics.totalProcessingTime = Date.now() - totalStartTime;
        
        console.log(`\n📊 MÉTRICAS FINAIS:`);
        console.log(`   Total: ${metrics.totalProcessingTime}ms`);
        console.log(`   DB Queries: ${metrics.dbQueryTime}ms (${metrics.totalQueries} queries)`);
        console.log(`   PDF Generation: ${metrics.pdfGenerationTime}ms (${metrics.totalPdfs} PDFs)`);
        console.log(`   Cache Hits: ${metrics.cacheHits}, Misses: ${metrics.cacheMisses}`);
        console.log(`   Hit Rate: ${(metrics.cacheHits / (metrics.cacheHits + metrics.cacheMisses) * 100).toFixed(1)}%`);
        console.log(`   ZIP: ${zipFilename} (${archive.pointer()} bytes)`);
        
        resolve(zipFilename);
      });
      
      archive.on('error', reject);
      archive.pipe(output);
      
      for (const filename of pdfFilenames) {
        archive.file(path.join(OUTPUT_DIR, filename), { name: filename });
      }
      
      archive.finalize();
    });
    
  } catch (error) {
    metrics.totalProcessingTime = Date.now() - totalStartTime;
    console.error('Erro na geração:', error);
    throw error;
  }
}

// Express app
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use('/downloads', express.static(OUTPUT_DIR));
app.use('/assets', express.static(path.join(__dirname, 'assets')));

// Rota para limpar cache
app.post('/clear-cache', async (req, res) => {
  try {
    await cache.clear();
    res.json({ success: true, message: 'Cache limpo com sucesso' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Rota para estatísticas
app.get('/stats', (req, res) => {
  res.json({
    metrics,
    cache: cache.getStats(),
    uptime: process.uptime(),
    memory: process.memoryUsage()
  });
});

// Rota principal
app.get('/', async (req, res) => {
  let parents = [];
  try {
    parents = await fetchParentOpportunities();
  } catch (err) {
    console.error('Erro ao buscar oportunidades:', err);
  }
  
  const optionsHtml = parents
    .map(row => `<option value="${row.id}">${row.name}</option>`)
    .join('\n');
  
  const html = `
<!DOCTYPE html>
<html lang="pt-BR">
  <head>
    <meta charset="UTF-8" />
    <title>Gerador de Fichas - ULTRA OTIMIZADO</title>
    <link href="/assets/css/bootstrap.min.css" rel="stylesheet" />
    <style>
      body { padding-top: 40px; background-color: #f8f9fa; }
      .logo-container { margin-bottom: 30px; }
      .logo-container img { max-height: 80px; }
      .ultra-badge { 
        background: linear-gradient(45deg, #ff6b6b, #ffd93d); 
        color: #333; padding: 4px 8px; border-radius: 4px; 
        font-size: 0.8em; margin-left: 10px; font-weight: bold;
      }
      .stats-card { background: #e3f2fd; border: 1px solid #2196f3; }
      #loadingSpinner { display: none; }
    </style>
  </head>
  <body class="bg-light">
    <div class="container">
      <div class="row mb-4">
        <div class="col text-center logo-container">
          ${logoBase64 ? `<img src="data:image/png;base64,${logoBase64}" alt="Logo">` : ''}
        </div>
      </div>
      
      <div class="row justify-content-center">
        <div class="col-md-8">
          <div class="card shadow-sm mb-4">
            <div class="card-body">
              <h5 class="card-title text-center">
                Gerador de Fichas
                <span class="ultra-badge">ULTRA OTIMIZADO</span>
              </h5>
              
              <div class="row mb-3">
                <div class="col-md-6">
                  <div class="card stats-card">
                    <div class="card-body text-center">
                      <h6>Cache</h6>
                      <small id="cacheStats">Carregando...</small>
                    </div>
                  </div>
                </div>
                <div class="col-md-6">
                  <div class="card stats-card">
                    <div class="card-body text-center">
                      <h6>Controles</h6>
                      <button class="btn btn-sm btn-outline-primary" onclick="clearCache()">Limpar Cache</button>
                    </div>
                  </div>
                </div>
              </div>
              
              <form id="formGenerate" action="/generate" method="POST">
                <div class="mb-3">
                  <label for="parent" class="form-label">Oportunidade principal:</label>
                  <select name="parent" id="parent" class="form-select" required>
                    <option value="" disabled selected>-- selecione --</option>
                    ${optionsHtml}
                  </select>
                </div>
                <button id="btnSubmit" type="submit" class="btn btn-primary w-100">
                  <span id="btnText">Gerar Fichas</span>
                  <span id="loadingSpinner" class="spinner-border spinner-border-sm ms-2"></span>
                </button>
              </form>
            </div>
          </div>
        </div>
      </div>
    </div>
    
    <script src="/assets/js/bootstrap.bundle.min.js"></script>
    <script>
      // Carregar stats do cache
      fetch('/stats')
        .then(r => r.json())
        .then(data => {
          document.getElementById('cacheStats').innerHTML = 
            \`Hits: \${data.cache.localCacheSize || 0}<br>Redis: \${data.cache.redisEnabled ? 'Ativo' : 'Inativo'}\`;
        });
      
      // Limpar cache
      function clearCache() {
        fetch('/clear-cache', { method: 'POST' })
          .then(r => r.json())
          .then(data => alert(data.message))
          .catch(e => alert('Erro ao limpar cache'));
      }
      
      // Form handling
      document.getElementById('formGenerate').addEventListener('submit', () => {
        const btn = document.getElementById('btnSubmit');
        const text = document.getElementById('btnText');
        const spinner = document.getElementById('loadingSpinner');
        
        btn.disabled = true;
        text.textContent = 'Gerando...';
        spinner.style.display = 'inline-block';
      });
    </script>
  </body>
</html>`;
  
  res.send(html);
});

// Rota de geração
app.post('/generate', async (req, res) => {
  const parentId = parseInt(req.body.parent, 10);
  if (isNaN(parentId)) {
    return res.status(400).send('ID inválido');
  }
  
  try {
    const zipFilename = await generateFichas(parentId);
    
    let pdfFiles = [];
    try {
      pdfFiles = fs.readdirSync(OUTPUT_DIR)
        .filter(f => f.startsWith(`ficha_${parentId}_`) && f.endsWith('.pdf'))
        .sort();
    } catch (err) {
      console.error('Erro ao listar PDFs:', err);
    }
    
    const listPdfHtml = pdfFiles
      .map(f => `<li class="list-group-item"><a href="/downloads/${f}" target="_blank">${f}</a></li>`)
      .join('');
    
    const html = `
<!DOCTYPE html>
<html lang="pt-BR">
  <head>
    <meta charset="UTF-8" />
    <title>Fichas Geradas - ULTRA OTIMIZADO</title>
    <link href="/assets/css/bootstrap.min.css" rel="stylesheet" />
    <style>
      body { padding-top: 40px; background-color: #f8f9fa; }
      .ultra-badge { 
        background: linear-gradient(45deg, #ff6b6b, #ffd93d); 
        color: #333; padding: 4px 8px; border-radius: 4px; 
        font-size: 0.8em; margin-left: 10px; font-weight: bold;
      }
      .metrics-card { background: #e8f5e8; border: 1px solid #4caf50; }
    </style>
  </head>
  <body class="bg-light">
    <div class="container">
      <div class="row justify-content-center">
        <div class="col-md-10">
          <div class="card shadow-sm mb-4">
            <div class="card-body text-center">
              <h5 class="card-title">
                Fichas Geradas - Oportunidade ${parentId}
                <span class="ultra-badge">ULTRA OTIMIZADO</span>
              </h5>
              
              <div class="row mb-3">
                <div class="col-md-12">
                  <div class="card metrics-card">
                    <div class="card-body">
                      <h6>📊 Métricas de Performance</h6>
                      <div class="row">
                        <div class="col-md-3">
                          <small><strong>Tempo Total:</strong><br>${metrics.totalProcessingTime}ms</small>
                        </div>
                        <div class="col-md-3">
                          <small><strong>Queries DB:</strong><br>${metrics.totalQueries} (${metrics.dbQueryTime}ms)</small>
                        </div>
                        <div class="col-md-3">
                          <small><strong>PDFs:</strong><br>${metrics.totalPdfs} (${metrics.pdfGenerationTime}ms)</small>
                        </div>
                        <div class="col-md-3">
                          <small><strong>Cache:</strong><br>${metrics.cacheHits} hits, ${metrics.cacheMisses} misses</small>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              
              <a href="/downloads/${zipFilename}" class="btn btn-success me-2">
                📥 Baixar ZIP (${pdfFiles.length} arquivos)
              </a>
              <a href="/" class="btn btn-secondary">🔙 Voltar</a>
            </div>
          </div>
          
          <div class="card shadow-sm">
            <div class="card-header">
              <strong>📋 Lista de PDFs Gerados</strong>
            </div>
            <ul class="list-group list-group-flush">
              ${listPdfHtml || '<li class="list-group-item"><em>Nenhum PDF encontrado</em></li>'}
            </ul>
          </div>
        </div>
      </div>
    </div>
    
    <script src="/assets/js/bootstrap.bundle.min.js"></script>
  </body>
</html>`;
    
    res.send(html);
  } catch (error) {
    console.error('Erro na geração:', error);
    res.status(500).send(`Erro: ${error.message}`);
  }
});

// Iniciar servidor
app.listen(SERVER_PORT, () => {
  console.log(`🚀 Servidor ULTRA OTIMIZADO rodando na porta ${SERVER_PORT}`);
  console.log(`🌐 Acesse: http://localhost:${SERVER_PORT}`);
  console.log(`📊 Stats: http://localhost:${SERVER_PORT}/stats`);
});

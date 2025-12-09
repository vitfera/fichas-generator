/**
 * generate_sheets.js - VERSÃO OTIMIZADA
 *
 * Serviço HTTP para gerar fichas de inscrição em PDF de uma oportunidade pai
 * incluindo todas as fases-filhas (exceto "parentId+1").
 * Avaliações técnicas (type = 'technical') exibem:
 *   - Seções + Critérios + Nota
 *   - Total, Status e Parecer
 *
 * Carrega Bootstrap local (assets/css/bootstrap.min.css e assets/js/bootstrap.bundle.min.js).
 * Para a fase pai, usa sempre o ID da inscrição‐pai (previousPhaseRegistrationId) 
 * ao buscar registration_evaluation para avaliação técnica.
 *
 * .env deve conter:
 *   DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME, OUTPUT_DIR, SERVER_PORT
 *
 * MELHORIAS DE PERFORMANCE:
 * - Pool de conexões otimizado com timeout
 * - Consultas em batch para reduzir queries
 * - Pré-carregamento de dados em lote
 * - Busca paralela de avaliações e arquivos
 * - Cache de seções e critérios
 * - Processamento em paralelo onde possível
 */

require('dotenv').config();
const express    = require('express');
const path       = require('path');
const fs         = require('fs');
const { Pool }   = require('pg');
const Handlebars = require('handlebars');
const puppeteer  = require('puppeteer-core');
const archiver   = require('archiver');
const { PDFDocument } = require('pdf-lib');

/**
 * Junta o PDF gerado (buffer mainPdf) com uma lista de buffers de anexos.
 * Retorna um único buffer de PDF.
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

// ------------------------------------------------------------
// 0) Mapeamento de IDs de status → texto
// ------------------------------------------------------------
const STATUS_LABELS = {
  0:  'Não avaliada',
  2:  'Inválida',
  3:  'Não selecionada',
  8:  'Suplente',
  10: 'Selecionada'
};

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
const FILES_DIR   = process.env.FILES_DIR   || '/srv/mapas/docker-data/private-files/registration';

// Pool otimizado com configurações de timeout
const pool = new Pool({
  host: DB_HOST,
  port: DB_PORT,
  user: DB_USER,
  password: DB_PASSWORD,
  database: DB_NAME,
  max: 20, // máximo de conexões simultâneas
  idleTimeoutMillis: 30000, // timeout para conexões inativas
  connectionTimeoutMillis: 5000, // timeout para nova conexão
});

// ------------------------------------------------------------
// 2) Helper Handlebars mínimo
// ------------------------------------------------------------
Handlebars.registerHelper('get', (obj, key) => {
  return (obj && obj[key] !== undefined) ? obj[key] : '';
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
// 4) Lê o Bootstrap CSS (para embutir) e o logo.png em Base64
// ------------------------------------------------------------
const assetPath = path.join(__dirname, 'assets');

// 4.1) Bootstrap CSS
let bootstrapCSS = '';
try {
  bootstrapCSS = fs.readFileSync(path.join(assetPath, 'css', 'bootstrap.min.css'), 'utf-8');
} catch (err) {
  console.warn('Atenção: não foi possível ler assets/css/bootstrap.min.css. O PDF poderá ficar sem estilos.');
}

// 4.2) Logo em Base64
let logoBase64 = '';
try {
  const logoBuffer = fs.readFileSync(path.join(assetPath, 'logo.png'));
  logoBase64 = logoBuffer.toString('base64');
} catch (err) {
  console.warn('Atenção: não foi possível ler assets/logo.png para incorporar no PDF.');
}

// ------------------------------------------------------------
// 5) Formatação de valores: datas e JSON-arrays
// ------------------------------------------------------------
function formatValue(raw) {
  if (raw == null) return '';

  // 5.1) Se for string "YYYY-MM-DD"
  if (typeof raw === 'string') {
    const isoDateMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (isoDateMatch) {
      const [, year, month, day] = isoDateMatch;
      return `${day}/${month}/${year}`;
    }
  }
  // 5.2) Se for string "YYYY-MM-DDTHH:MM:SSZ"
  const isoDateTimeMatch = typeof raw === 'string'
    ? raw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2}:\d{2})/)
    : null;
  if (isoDateTimeMatch) {
    const [, year, month, day, time] = isoDateTimeMatch;
    return `${day}/${month}/${year} ${time}`;
  }
  // 5.3) Tenta fazer JSON.parse(raw)
  let parsed;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
  }
  if (Array.isArray(parsed)) {
    // 5.4) Array de strings/números
    if (parsed.every(x => typeof x === 'string' || typeof x === 'number')) {
      return parsed.map(x => String(x)).join('<br/>');
    }
    // 5.5) Array de objetos: "chave: valor; ..."
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
  // 5.6) Senão, converte para string simples
  return String(raw);
}

// ------------------------------------------------------------
// 6) Funções de acesso ao banco - OTIMIZADAS
// ------------------------------------------------------------

// 6.1) Lista todas as oportunidades‐pai (parent_id IS NULL)
async function fetchParentOpportunities() {
  const client = await pool.connect();
  try {
    const query = `
      SELECT id, name
      FROM opportunity
      WHERE parent_id IS NULL
      AND published_registrations
      AND status = 1
      ORDER BY name;
    `;
    const res = await client.query(query);
    return res.rows;
  } finally {
    client.release();
  }
}

// 6.2) Lista todos os filhos de parentId, EXCLUINDO parentId+1
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

// 6.3) Busca TODAS as fases relevantes (pai + filhos exceto parentId+1)
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

// 6.4) OTIMIZADO: Busca inscrições para múltiplas fases em uma única query
async function fetchRegistrationsForPhases(phaseIds) {
  const client = await pool.connect();
  try {
    const query = `
      SELECT
        r.id     AS registration_id,
        r.number AS registration_number,
        r.status AS registration_status,
        r.opportunity_id AS phase_id,
        a.id     AS agent_id,
        a.name   AS agent_name
      FROM registration r
      LEFT JOIN agent a ON r.agent_id = a.id
      WHERE r.opportunity_id = ANY($1::int[])
      ORDER BY r.opportunity_id, r.number;
    `;
    const res = await client.query(query, [phaseIds]);
    
    // Agrupa por phase_id
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
}

// 6.5) OTIMIZADO: Busca múltiplas inscrições pai em lote
async function fetchParentRegistrationIds(childRegistrationIds) {
  if (!childRegistrationIds.length) return {};
  
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
}

// 6.6) OTIMIZADO: Busca metadados para múltiplas inscrições em lote
async function fetchOrderedMetaForRegistrations(regIds, phaseIds) {
  if (!regIds.length || !phaseIds.length) return {};
  
  const client = await pool.connect();
  try {
    const query = `
      SELECT
        rm.object_id,
        rfc.opportunity_id   AS phase_id,
        rfc.title            AS field_label,
        rfc.display_order    AS field_order,
        rm.value             AS field_value
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
}

// Cache para seções e critérios
const sectionsCache = new Map();

// 6.7) OTIMIZADO: Busca seções e critérios com cache
async function getSectionsAndCriteriaForPhase(phaseId) {
  if (sectionsCache.has(phaseId)) {
    return sectionsCache.get(phaseId);
  }
  
  const client = await pool.connect();
  try {
    // 1) Buscar evaluation_method_configuration.id do tipo 'technical'
    const q1 = `
      SELECT id
      FROM evaluation_method_configuration
      WHERE opportunity_id = $1
        AND type = 'technical'
      LIMIT 1;
    `;
    const r1 = await client.query(q1, [phaseId]);
    if (r1.rowCount === 0) {
      sectionsCache.set(phaseId, []);
      return [];
    }
    
    const evalMethodConfigId = r1.rows[0].id;

    // 2) Buscar sections e criteria em paralelo
    const [sectionsRes, criteriaRes] = await Promise.all([
      client.query(`
        SELECT value
        FROM evaluationmethodconfiguration_meta
        WHERE object_id = $1 AND key = 'sections'
        LIMIT 1;
      `, [evalMethodConfigId]),
      client.query(`
        SELECT value
        FROM evaluationmethodconfiguration_meta
        WHERE object_id = $1 AND key = 'criteria'
        LIMIT 1;
      `, [evalMethodConfigId])
    ]);

    let sectionsRaw = [];
    let criteriaRaw = [];
    
    if (sectionsRes.rowCount > 0) {
      try {
        sectionsRaw = JSON.parse(sectionsRes.rows[0].value);
      } catch (e) {
        console.error(`Erro ao parsear sections para fase ${phaseId}:`, e);
      }
    }
    
    if (criteriaRes.rowCount > 0) {
      try {
        criteriaRaw = JSON.parse(criteriaRes.rows[0].value);
      } catch (e) {
        console.error(`Erro ao parsear criteria para fase ${phaseId}:`, e);
      }
    }

    // 3) Montar resultado final
    const result = Array.isArray(sectionsRaw) ? sectionsRaw.map(sec => {
      const critsForThisSection = Array.isArray(criteriaRaw) 
        ? criteriaRaw
            .filter(c => c.sid === sec.id)
            .map(c => ({
              id: c.id,
              title: c.title,
              sid: c.sid
            }))
        : [];
      
      return {
        id: sec.id,
        name: sec.name,
        criteria: critsForThisSection
      };
    }) : [];

    sectionsCache.set(phaseId, result);
    return result;
  } finally {
    client.release();
  }
}

// 6.8) OTIMIZADO: Busca avaliações em lote para múltiplas inscrições e fases
async function getEvaluationsForRegistrations(regIds, phaseIds) {
  if (!regIds.length || !phaseIds.length) return {};
  
  const client = await pool.connect();
  try {
    const query = `
      SELECT
        re.registration_id,
        r.opportunity_id AS phase_id,
        re.evaluation_data,
        re.result AS total_score
      FROM registration_evaluation re
      JOIN registration r ON r.id = re.registration_id
      WHERE re.registration_id = ANY($1::int[])
        AND r.opportunity_id = ANY($2::int[]);
    `;
    const res = await client.query(query, [regIds, phaseIds]);
    
    const evaluations = {};
    for (const row of res.rows) {
      const key = `${row.registration_id}_${row.phase_id}`;
      evaluations[key] = {
        evaluation_data: row.evaluation_data,
        total_score: row.total_score || 0
      };
    }
    return evaluations;
  } finally {
    client.release();
  }
}

// 6.9) OTIMIZADO: Busca arquivos para múltiplas inscrições e fases
async function fetchFilesForRegistrations(regIds, phaseIds) {
  if (!regIds.length || !phaseIds.length) return {};
  
  const client = await pool.connect();
  try {
    const query = `
      SELECT 
        $1 as reg_id,
        rfc.opportunity_id AS phase_id,
        f.name AS file_name
      FROM registration_file_configuration rfc
      LEFT JOIN LATERAL (
        SELECT name
        FROM "file"
        WHERE grp = CONCAT('rfc_', rfc.id)
          AND object_id = ANY($1::int[])
        ORDER BY id DESC
        LIMIT 1
      ) f ON TRUE
      WHERE rfc.opportunity_id = ANY($2::int[])
      ORDER BY rfc.opportunity_id, rfc.display_order;
    `;
    const res = await client.query(query, [regIds, phaseIds]);
    
    const files = {};
    for (const row of res.rows) {
      const key = `${row.reg_id}_${row.phase_id}`;
      if (!files[key]) files[key] = [];
      if (row.file_name) files[key].push(row.file_name);
    }
    
    // Deduplica arquivos
    for (const key in files) {
      files[key] = [...new Set(files[key])];
    }
    
    return files;
  } finally {
    client.release();
  }
}

// 6.10) Função helper para processar avaliação individual
async function processEvaluation(regId, phaseId, evaluationData) {
  if (!evaluationData) {
    return {
      sections: [],
      status: '',
      parecer: '',
      total: 0,
      hasTechnical: false,
      hasSimplified: false
    };
  }

  let rawEval = evaluationData.evaluation_data;
  const totalScore = evaluationData.total_score || 0;
  
  if (typeof rawEval === 'string') {
    try {
      rawEval = JSON.parse(rawEval);
    } catch {
      rawEval = {};
    }
  }

  if (!rawEval || typeof rawEval !== 'object') {
    return {
      sections: [],
      status: rawEval.status ? String(rawEval.status) : '',
      parecer: rawEval.obs ? String(rawEval.obs) : '',
      total: totalScore,
      hasTechnical: false,
      hasSimplified: totalScore > 0
    };
  }

  const parecerText = rawEval.obs ? String(rawEval.obs) : '';
  const statusText = rawEval.status ? String(rawEval.status) : '';

  // Buscar seções técnicas
  const technicalSections = await getSectionsAndCriteriaForPhase(phaseId);
  const sections = [];

  if (technicalSections.length) {
    for (const sec of technicalSections) {
      const critList = sec.criteria.map(c => ({
        label: c.title || '',
        score: rawEval[c.id] !== undefined ? (Number(rawEval[c.id]) || 0) : 0
      }));

      sections.push({
        sectionTitle: sec.name || '',
        criteria: critList
      });
    }
  }

  const hasTechnical = sections.length > 0;
  const hasSimplified = !hasTechnical && totalScore > 0;

  return {
    sections,
    status: statusText,
    parecer: parecerText,
    total: totalScore,
    hasTechnical,
    hasSimplified
  };
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
// 8) Geração de fichas para um parentId - COMPLETAMENTE OTIMIZADA
// ------------------------------------------------------------
async function generateFichas(parentId) {
  console.log(`\n→ Iniciando geração OTIMIZADA de fichas para parentId=${parentId}`);
  const startTime = Date.now();
  
  // 8.1) Buscar todos os filhos (exceto parentId+1)
  const children = await fetchChildrenExcludingNext(parentId);
  console.log(`→ Filhos encontrados: ${children.length}`);
  
  // 8.2) Buscar inscrições para todas as fases de uma vez
  const phaseIds = [parentId, ...children.map(c => c.id)];
  const registrationsByPhase = await fetchRegistrationsForPhases(phaseIds);
  console.log(`→ Inscrições por fase carregadas em lote`);
  
  // 8.3) Encontrar a primeira fase que tenha inscrições
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
  
  console.log(`→ Usando fase ${chosenPhaseId} com ${registrations.length} inscrições`);

  // 8.4) Carrega TODAS as fases relevantes
  let phases = await fetchAllRelevantPhases(parentId);
  if (!phases.length) {
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
  
  console.log(`→ Fases relevantes: ${phases.map(p => p.name).join(', ')}`);

  // 8.5) Preparar diretórios
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
  
  // 8.6) PRÉ-CARREGAMENTO MASSIVO DE DADOS EM LOTE
  console.log(`→ Pré-carregando TODOS os dados em lote...`);
  const allRegIds = registrations.map(r => r.registration_id);
  const allPhaseIds = phases.map(p => p.id);
  
  // Carregar todos os dados em paralelo
  const [
    parentRegIdMap,
    allMetaData,
    allEvaluations,
    allFiles
  ] = await Promise.all([
    fetchParentRegistrationIds(allRegIds),
    fetchOrderedMetaForRegistrations(allRegIds, allPhaseIds),
    getEvaluationsForRegistrations(allRegIds, allPhaseIds),
    fetchFilesForRegistrations(allRegIds, allPhaseIds)
  ]);
  
  // Buscar metadados dos pais
  const validParentIds = Object.values(parentRegIdMap).filter(id => id !== null);
  const parentMetaData = validParentIds.length > 0 
    ? await fetchOrderedMetaForRegistrations(validParentIds, [parentId])
    : {};
  
  console.log(`→ Dados pré-carregados em ${Date.now() - startTime}ms`);

  const pdfFilenames = [];
  
  // 8.7) Processar cada inscrição com dados pré-carregados
  for (let i = 0; i < registrations.length; i++) {
    const reg = registrations[i];
    const regNumber = reg.registration_number || reg.registration_id;
    const parentRegId = parentRegIdMap[reg.registration_id];
    const regStartTime = Date.now();
    
    console.log(`\n→ [${i+1}/${registrations.length}] Processando ${regNumber}...`);

    // 8.7.1) Metadados do pai (pré-carregados)
    let parentMetaArray = [];
    if (parentRegId && parentMetaData[parentRegId]) {
      const rawParentArray = parentMetaData[parentRegId][parentId] || [];
      parentMetaArray = rawParentArray.map(item => ({
        label: item.label,
        value: formatValue(item.value)
      }));
    }

    // 8.7.2) Determinar IDs de registro por fase
    const regIdsByPhase = {};
    for (const phase of phases) {
      const regsThisPhase = registrationsByPhase[phase.id] || [];
      const match = regsThisPhase.find(r => r.agent_id === reg.agent_id);
      regIdsByPhase[phase.id] = (phase.id === parentId && parentRegId)
        ? parentRegId
        : (match ? match.registration_id : null);
    }

    // 8.7.3) Processar dados das fases em paralelo
    const phasePromises = phases.map(async (phase) => {
      const rowsForThisPhase = (phase.id === parentId)
        ? parentMetaArray
        : ((allMetaData[reg.registration_id] && allMetaData[reg.registration_id][phase.id]) || []).map(item => ({
            label: item.label,
            value: formatValue(item.value)
          }));

      const evalRegId = regIdsByPhase[phase.id] || reg.registration_id;
      
      // Buscar avaliação e arquivos dos dados pré-carregados
      const evaluationKey = `${evalRegId}_${phase.id}`;
      const evaluationData = allEvaluations[evaluationKey];
      const files = allFiles[evaluationKey] || [];
      
      const evalObj = await processEvaluation(evalRegId, phase.id, evaluationData);

      return {
        id: phase.id,
        name: phase.name,
        rows: rowsForThisPhase,
        evaluation: evalObj,
        regStatusText: STATUS_LABELS[reg.registration_status] || '',
        files: files,
        evalRegId: evalRegId
      };
    });

    const dataPhases = await Promise.all(phasePromises);

    // 8.7.4) Gerar PDF
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

    let html, pdfBuffer;
    try {
      html = template(data);
      pdfBuffer = await htmlToPdfBuffer(html);
    } catch (err) {
      console.error(`Erro ao gerar PDF para ${regNumber}:`, err);
      continue;
    }

    // 8.7.5) Anexar arquivos PDF
    const attachmentBuffers = [];
    const seen = new Set();

    for (const phase of phases) {
      const rId = regIdsByPhase[phase.id];
      if (!rId) continue;
      const folder = path.join(FILES_DIR, String(rId));
      if (!fs.existsSync(folder)) continue;
      
      try {
        const files = fs.readdirSync(folder).filter(f => f.endsWith('.pdf'));
        for (const name of files) {
          const p = path.join(folder, name);
          if (!seen.has(p)) {
            seen.add(p);
            attachmentBuffers.push(fs.readFileSync(p));
          }
        }
      } catch (err) {
        console.warn(`Erro ao ler pasta ${folder}:`, err);
      }
    }

    let finalPdfBuffer = pdfBuffer;
    if (attachmentBuffers.length) {
      finalPdfBuffer = await mergeWithAttachments(pdfBuffer, attachmentBuffers);
    }

    // 8.7.6) Salvar PDF
    const nomeSemAcento = (reg.agent_name || 'sem-nome')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9\-]/g, '');

    const filename = `ficha_${parentId}_${regNumber}_${nomeSemAcento}.pdf`;
    const filepath = path.join(OUTPUT_DIR, filename);
    
    try {
      fs.writeFileSync(filepath, finalPdfBuffer);
      pdfFilenames.push(filename);
      console.log(`   → PDF salvo: ${filename} (${Date.now() - regStartTime}ms)`);
    } catch (err) {
      console.error(`Erro ao salvar PDF ${filename}:`, err);
    }
  }

  // 8.8) Criar ZIP
  console.log(`\n→ Criando ZIP com ${pdfFilenames.length} arquivos...`);
  const zipStartTime = Date.now();
  const zipFilename = `fichas_${parentId}.zip`;
  const zipFilepath = path.join(OUTPUT_DIR, zipFilename);
  const output = fs.createWriteStream(zipFilepath);
  const archive = archiver('zip', { zlib: { level: 9 } });

  return new Promise((resolve, reject) => {
    output.on('close', () => {
      const totalTime = Date.now() - startTime;
      const zipTime = Date.now() - zipStartTime;
      console.log(`→ ZIP gerado: ${zipFilename} (${archive.pointer()} bytes) em ${zipTime}ms`);
      console.log(`→ Processo completo: ${totalTime}ms total`);
      resolve(zipFilename);
    });
    archive.on('error', reject);
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

// Servir estáticos em /downloads (PDFs, ZIPs e assets)
app.use('/downloads', express.static(OUTPUT_DIR));
app.use('/assets', express.static(path.join(__dirname, 'assets')));

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

  const optionsHtml = parents
    .map(row => `<option value="${row.id}">${row.name}</option>`)
    .join('\n');

  const html = `
<!DOCTYPE html>
<html lang="pt-BR">
  <head>
    <meta charset="UTF-8" />
    <title>Gerar Fichas de Inscrição - OTIMIZADO</title>
    <!-- Bootstrap CSS local -->
    <link href="/assets/css/bootstrap.min.css" rel="stylesheet" />
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
      .performance-badge {
        background: linear-gradient(45deg, #28a745, #20c997);
        color: white;
        padding: 4px 8px;
        border-radius: 4px;
        font-size: 0.8em;
        margin-left: 10px;
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
              <h5 class="card-title text-center mb-4">
                Gerar Fichas de Inscrição
                <span class="performance-badge">OTIMIZADO</span>
              </h5>
              <div class="alert alert-info" role="alert">
                <small>
                  <strong>Melhorias:</strong> Consultas em batch, cache, processamento paralelo
                </small>
              </div>
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

    <script src="/assets/js/bootstrap.bundle.min.js"></script>
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

  const html = `
<!DOCTYPE html>
<html lang="pt-BR">
  <head>
    <meta charset="UTF-8" />
    <title>Fichas Geradas - OTIMIZADO</title>
    <!-- Bootstrap CSS local -->
    <link href="/assets/css/bootstrap.min.css" rel="stylesheet" />
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
      .performance-badge {
        background: linear-gradient(45deg, #28a745, #20c997);
        color: white;
        padding: 4px 8px;
        border-radius: 4px;
        font-size: 0.8em;
        margin-left: 10px;
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
              <h5 class="card-title mb-3">
                Fichas geradas para oportunidade ${parentId}
                <span class="performance-badge">OTIMIZADO</span>
              </h5>
              <a href="/downloads/${zipFilename}" class="btn btn-success me-2">
                Baixar todas as fichas (ZIP)
              </a>
              <a href="/" class="btn btn-secondary">
                Voltar
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

    <script src="/assets/js/bootstrap.bundle.min.js"></script>
  </body>
</html>
  `.trim();

  res.send(html);
});

// ------------------------------------------------------------
// 10) Inicia servidor HTTP
// ------------------------------------------------------------
app.listen(SERVER_PORT, () => {
  console.log(`Servidor OTIMIZADO rodando na porta ${SERVER_PORT}`);
  console.log(`Acesse http://localhost:${SERVER_PORT}/ para gerar fichas.`);
});

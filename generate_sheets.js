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
 *   DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME, OUTPUT_DIR, SERVER_PORT, LOGO_PATH
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
const { loadLogoBase64 } = require('./logo_loader');
const { listGeneratedFilesForOpportunity } = require('./generated_files');

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
  1:  'Pendente',
  2:  'Inválida',
  3:  'Não selecionada',
  8:  'Suplente',
  10: 'Selecionada'
};

const OPPORTUNITY_STATUS_APPEAL_PHASE = -20;

const APPEAL_STATUS_LABELS = {
  1:  'Aguardando resposta',
  2:  'Negado',
  3:  'Indeferido',
  10: 'Deferido'
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
// 4) Lê o Bootstrap CSS (para embutir) e a logo em Base64
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
const logoBase64 = loadLogoBase64();

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
      SELECT o.id, o.name
      FROM opportunity o
      LEFT JOIN opportunity_meta appeal_meta
        ON appeal_meta.object_id = o.id
       AND appeal_meta.key = 'isAppealPhase'
      WHERE o.parent_id = $1
        AND o.id != $2
        AND o.status != $3
        AND COALESCE(appeal_meta.value, '0') NOT IN ('1', 'true', 't')
      ORDER BY o.id;
    `;
    const res = await client.query(query, [parentId, parentId + 1, OPPORTUNITY_STATUS_APPEAL_PHASE]);
    return res.rows;
  } finally {
    client.release();
  }
}

// 6.3) Busca fases relevantes, inserindo fases de recurso logo após a fase avaliada
async function fetchRelevantPhasesWithAppeals(parentId) {
  const client = await pool.connect();
  try {
    const query = `
      WITH main_phases AS (
        SELECT
          main.id,
          main.name,
          main.parent_id,
          main.status,
          false AS is_appeal_phase,
          main.id AS sort_phase_id,
          0 AS sort_order
        FROM opportunity main
        LEFT JOIN opportunity_meta main_meta
          ON main_meta.object_id = main.id
         AND main_meta.key = 'isAppealPhase'
        WHERE (main.id = $1 OR main.parent_id = $1)
          AND main.id != $1 + 1
          AND main.status != $2
          AND COALESCE(main_meta.value, '0') NOT IN ('1', 'true', 't')
      )
      SELECT id, name, parent_id, status, is_appeal_phase AS "isAppealPhase"
      FROM (
        SELECT
          main.id,
          main.name,
          main.parent_id,
          main.status,
          main.is_appeal_phase,
          main.sort_phase_id,
          main.sort_order
        FROM main_phases main

        UNION ALL

        SELECT
          appeal.id,
          appeal.name,
          appeal.parent_id,
          appeal.status,
          true AS is_appeal_phase,
          main.id AS sort_phase_id,
          1 AS sort_order
        FROM main_phases main
        JOIN opportunity appeal
          ON appeal.parent_id = main.id
        LEFT JOIN opportunity_meta appeal_meta
          ON appeal_meta.object_id = appeal.id
         AND appeal_meta.key = 'isAppealPhase'
        WHERE appeal.status = $2
           OR COALESCE(appeal_meta.value, '0') IN ('1', 'true', 't')
      ) phases
      ORDER BY sort_phase_id, sort_order, id;
    `;
    const res = await client.query(query, [parentId, OPPORTUNITY_STATUS_APPEAL_PHASE]);
    return res.rows;
  } finally {
    client.release();
  }
}

// 6.4) OTIMIZADO: Busca inscrições para múltiplas fases em uma única query
async function fetchRegistrationsForPhases(phaseIds, parentId, filterType = 'selected') {
  const client = await pool.connect();
  try {
    // Define o filtro de status baseado no filterType
    let statusFilter;
    switch(filterType) {
      case 'selected':
        statusFilter = 'r.status = 10';
        break;
      case 'selected_and_alternate':
        statusFilter = 'r.status IN (8, 10)';
        break;
      case 'all':
        statusFilter = 'r.status != 0';
        break;
      default:
        statusFilter = 'r.status = 10';
    }
    
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
      AND (r.opportunity_id != $2 OR ${statusFilter})
      ORDER BY r.opportunity_id, r.number;
    `;
    const res = await client.query(query, [phaseIds, parentId]);
    
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
        re.result AS total_score,
        re.user_id
      FROM registration_evaluation re
      JOIN registration r ON r.id = re.registration_id
      WHERE re.registration_id = ANY($1::int[])
        AND r.opportunity_id = ANY($2::int[])
      ORDER BY re.registration_id, re.id;
    `;
    const res = await client.query(query, [regIds, phaseIds]);
    
    const evaluations = {};
    for (const row of res.rows) {
      const key = `${row.registration_id}_${row.phase_id}`;
      if (!evaluations[key]) {
        evaluations[key] = [];
      }
      evaluations[key].push({
        evaluation_data: row.evaluation_data,
        total_score: row.total_score || 0,
        user_id: row.user_id
      });
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
        r.id AS reg_id,
        rfc.opportunity_id AS phase_id,
        file_data.name AS file_name
      FROM registration r
      JOIN registration_file_configuration rfc
        ON rfc.opportunity_id = ANY($2::int[])
      LEFT JOIN LATERAL (
        SELECT f.name
        FROM "file" f
        WHERE f.grp = CONCAT('rfc_', rfc.id)
          AND f.object_id = r.id
        ORDER BY id DESC
        LIMIT 1
      ) file_data ON TRUE
      WHERE r.id = ANY($1::int[])
      ORDER BY r.id, rfc.opportunity_id, rfc.display_order;
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

// 6.10) Função helper para processar avaliação individual (agora suporta múltiplas avaliações)
async function processEvaluation(regId, phaseId, evaluationDataArray) {
  if (!evaluationDataArray || !Array.isArray(evaluationDataArray) || evaluationDataArray.length === 0) {
    return {
      evaluations: [],
      hasTechnical: false,
      hasSimplified: false
    };
  }

  const processedEvaluations = [];
  let technicalSections = null;
  
  for (let i = 0; i < evaluationDataArray.length; i++) {
    const evaluationData = evaluationDataArray[i];
    let rawEval = evaluationData.evaluation_data;
    const totalScore = evaluationData.total_score || 0;
    const evaluatorId = `#${i + 1}`;
  
    if (typeof rawEval === 'string') {
      try {
        rawEval = JSON.parse(rawEval);
      } catch {
        rawEval = {};
      }
    }

    if (!rawEval || typeof rawEval !== 'object') {
      processedEvaluations.push({
        evaluator: evaluatorId,
        sections: [],
        status: rawEval.status ? String(rawEval.status) : '',
        parecer: rawEval.obs ? String(rawEval.obs) : '',
        total: totalScore,
        hasTechnical: false,
        hasSimplified: totalScore > 0
      });
      continue;
    }

    const parecerText = rawEval.obs ? String(rawEval.obs) : '';
    const statusText = rawEval.status ? String(rawEval.status) : '';

    // Buscar seções técnicas apenas uma vez
    if (!technicalSections) {
      technicalSections = await getSectionsAndCriteriaForPhase(phaseId);
    }
    
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

    processedEvaluations.push({
      evaluator: evaluatorId,
      sections,
      status: statusText,
      parecer: parecerText,
      total: totalScore,
      hasTechnical,
      hasSimplified
    });
  }

  return {
    evaluations: processedEvaluations,
    hasTechnical: processedEvaluations.some(e => e.hasTechnical),
    hasSimplified: processedEvaluations.some(e => e.hasSimplified)
  };
}

function parseEvaluationData(rawEval) {
  if (typeof rawEval === 'string') {
    try {
      return JSON.parse(rawEval);
    } catch {
      return {};
    }
  }

  return rawEval && typeof rawEval === 'object' ? rawEval : {};
}

function formatAppealStatus(status) {
  const numericStatus = Number(status);
  return APPEAL_STATUS_LABELS[numericStatus] || STATUS_LABELS[numericStatus] || '';
}

function processAppealResult(evaluationDataArray, registrationStatus) {
  const result = {
    statusText: formatAppealStatus(registrationStatus),
    parecer: ''
  };

  if (!evaluationDataArray || !Array.isArray(evaluationDataArray) || evaluationDataArray.length === 0) {
    return result;
  }

  const lastEvaluation = evaluationDataArray[evaluationDataArray.length - 1];
  const rawEval = parseEvaluationData(lastEvaluation.evaluation_data);
  const evaluationStatus = rawEval.status !== undefined && rawEval.status !== ''
    ? rawEval.status
    : lastEvaluation.total_score;

  result.statusText = formatAppealStatus(evaluationStatus || registrationStatus);
  result.parecer = rawEval.obs ? String(rawEval.obs) : '';

  return result;
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
async function generateFichas(parentId, filterType = 'selected', includeAttachments = true) {
  const generationMode = includeAttachments ? 'ficha + anexos' : 'somente ficha';
  console.log(`\n→ Iniciando geração OTIMIZADA de fichas para parentId=${parentId} (filtro: ${filterType}, modo: ${generationMode})`);
  const startTime = Date.now();
  
  // 8.1) Buscar todos os filhos (exceto parentId+1)
  const children = await fetchChildrenExcludingNext(parentId);
  console.log(`→ Filhos encontrados: ${children.length}`);

  // 8.2) Carrega todas as fases relevantes, incluindo recursos após suas fases avaliadas
  let phases = await fetchRelevantPhasesWithAppeals(parentId);
  if (!phases.length) {
    const client = await pool.connect();
    try {
      const r = await client.query(
        `SELECT id, name, parent_id, status, false AS "isAppealPhase" FROM opportunity WHERE id = $1 LIMIT 1;`,
        [parentId]
      );
      if (r.rowCount) {
        phases = [r.rows[0]];
      }
    } finally {
      client.release();
    }
  }
  
  console.log(`→ Fases relevantes: ${phases.map(p => p.name).join(', ')}`);
  
  // 8.3) Buscar inscrições para todas as fases de uma vez
  const phaseIds = phases.map(p => p.id);
  const registrationsByPhase = await fetchRegistrationsForPhases(phaseIds, parentId, filterType);
  console.log(`→ Inscrições por fase carregadas em lote`);
  
  // 8.4) Encontrar a fase que tenha inscrições - PRIORIZA A FASE PAI
  let chosenPhaseId = null;
  let registrations = [];
  
  // Primeiro tenta usar a fase pai
  const regsParent = registrationsByPhase[parentId] || [];
  if (regsParent.length > 0) {
    chosenPhaseId = parentId;
    registrations = regsParent;
  }
  
  // Se a fase pai não tiver inscrições, usa a primeira filha que tiver
  if (!chosenPhaseId) {
    for (const child of children) {
      const regs = registrationsByPhase[child.id] || [];
      if (regs.length > 0) {
        chosenPhaseId = child.id;
        registrations = regs;
        break;
      }
    }
  }
  
  if (!chosenPhaseId) {
    throw new Error(`Nenhuma inscrição encontrada para parentId=${parentId}`);
  }
  
  console.log(`→ Usando fase ${chosenPhaseId} com ${registrations.length} inscrições`);

  // 8.5) Preparar diretórios
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
  
  // 8.6) PRÉ-CARREGAMENTO MASSIVO DE DADOS EM LOTE
  console.log(`→ Pré-carregando TODOS os dados em lote...`);
  
  // Coletar TODOS os IDs de registro de TODAS as fases (não apenas da fase escolhida)
  const allRegIdsSet = new Set();
  for (const phaseId of phaseIds) {
    const regsInPhase = registrationsByPhase[phaseId] || [];
    regsInPhase.forEach(r => allRegIdsSet.add(r.registration_id));
  }
  const allRegIds = Array.from(allRegIdsSet);
  const allPhaseIds = phases.map(p => p.id);
  
  console.log(`→ Total de IDs únicos para pré-carregar: ${allRegIds.length}`);
  
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
  const filenameSuffix = includeAttachments ? '' : '_sem_anexos';
  
  // 8.7) Processar cada inscrição com dados pré-carregados
  for (let i = 0; i < registrations.length; i++) {
    const reg = registrations[i];
    const regNumber = reg.registration_number || reg.registration_id;
    const parentRegId = parentRegIdMap[reg.registration_id];
    const regStartTime = Date.now();
    
    console.log(`\n→ [${i+1}/${registrations.length}] Processando ${regNumber}...`);

    // 8.7.1) Metadados do pai (pré-carregados)
    // Se não tem parentRegId, é porque esta É a inscrição pai - usa o próprio ID
    const actualParentRegId = parentRegId || reg.registration_id;
    
    let parentMetaArray = [];
    if (actualParentRegId && allMetaData[actualParentRegId]) {
      const rawParentArray = allMetaData[actualParentRegId][parentId] || [];
      parentMetaArray = rawParentArray.map(item => ({
        label: item.label,
        value: formatValue(item.value)
      }));
    }

    // 8.7.2) Determinar IDs de registro por fase
    const regIdsByPhase = {};
    const registrationsByPhaseMatch = {};
    for (const phase of phases) {
      const regsThisPhase = registrationsByPhase[phase.id] || [];
      const match = phase.isAppealPhase
        ? regsThisPhase.find(r => r.registration_number === reg.registration_number)
        : regsThisPhase.find(r => r.agent_id === reg.agent_id);
      registrationsByPhaseMatch[phase.id] = (phase.id === parentId)
        ? reg
        : (match || null);
      regIdsByPhase[phase.id] = (phase.id === parentId)
        ? actualParentRegId
        : (match ? match.registration_id : null);
    }

    // 8.7.3) Processar dados das fases em paralelo
    const phasePromises = phases.map(async (phase) => {
      const phaseRegistration = registrationsByPhaseMatch[phase.id];
      if (phase.isAppealPhase && (!phaseRegistration || phaseRegistration.registration_status === 0)) {
        return null;
      }

      // Para fase pai usa parentMetaArray, para filhas usa o regId correto de cada fase
      const phaseRegId = regIdsByPhase[phase.id] || reg.registration_id;
      
      const rowsForThisPhase = (phase.id === parentId)
        ? parentMetaArray
        : ((allMetaData[phaseRegId] && allMetaData[phaseRegId][phase.id]) || []).map(item => ({
            label: item.label,
            value: formatValue(item.value)
          }));

      const evalRegId = phaseRegId;
      
      // Buscar avaliação e arquivos dos dados pré-carregados
      const evaluationKey = `${evalRegId}_${phase.id}`;
      const evaluationData = allEvaluations[evaluationKey];
      const files = allFiles[evaluationKey] || [];
      
      const evalObj = await processEvaluation(evalRegId, phase.id, evaluationData);
      const phaseStatus = phaseRegistration
        ? phaseRegistration.registration_status
        : (phase.isAppealPhase ? null : reg.registration_status);

      return {
        id: phase.id,
        name: phase.name,
        isAppealPhase: Boolean(phase.isAppealPhase),
        rows: rowsForThisPhase,
        evaluation: evalObj,
        appealResult: phase.isAppealPhase
          ? processAppealResult(evaluationData, phaseStatus)
          : null,
        regStatusText: STATUS_LABELS[phaseStatus] || '',
        files: files,
        evalRegId: evalRegId
      };
    });

    const dataPhases = (await Promise.all(phasePromises)).filter(Boolean);

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

    if (includeAttachments) {
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
    }

    let finalPdfBuffer = pdfBuffer;
    if (includeAttachments && attachmentBuffers.length) {
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

    const filename = `ficha_${parentId}_${regNumber}_${nomeSemAcento}${filenameSuffix}.pdf`;
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
  const zipFilename = `fichas_${parentId}${filenameSuffix}.zip`;
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

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatGeneratedFileType(type) {
  return type === 'zip' ? 'ZIP' : 'PDF';
}

function renderGeneratedFileItem(file) {
  const name = escapeHtml(file.name);
  const url = escapeHtml(file.url);
  const type = escapeHtml(formatGeneratedFileType(file.type));

  return `
      <a class="list-group-item list-group-item-action d-flex justify-content-between align-items-center gap-2" href="${url}" target="_blank">
        <span class="text-break">${name}</span>
        <span class="badge text-bg-light">${type}</span>
      </a>`;
}

function renderGeneratedFilesList(files) {
  return files.map(renderGeneratedFileItem).join('\n');
}

function renderGeneratedFilesCard({
  title,
  files = [],
  className = 'card shadow-sm',
  blockId = '',
  contentId = '',
  countId = '',
  hidden = false,
  emptyMessage = '',
}) {
  const idAttribute = blockId ? ` id="${escapeHtml(blockId)}"` : '';
  const countIdAttribute = countId ? ` id="${escapeHtml(countId)}"` : '';
  const contentIdAttribute = contentId ? ` id="${escapeHtml(contentId)}"` : '';
  const hiddenClass = hidden ? ' generated-files-block' : '';
  const contentHtml = files.length
    ? `<div${contentIdAttribute} class="generated-files-list list-group">
${renderGeneratedFilesList(files)}
              </div>`
    : `<div${contentIdAttribute} class="small text-muted">${escapeHtml(emptyMessage)}</div>`;

  return `
          <div${idAttribute} class="${escapeHtml(className)}${hiddenClass}">
            <div class="card-body">
              <div class="d-flex justify-content-between align-items-center gap-2 mb-2">
                <h6 class="card-title mb-0">${escapeHtml(title)}</h6>
                <span${countIdAttribute} class="badge text-bg-secondary">${files.length}</span>
              </div>
              ${contentHtml}
            </div>
          </div>`;
}

// ------------------------------------------------------------
// 9) Configuração do Express (rotas / e /generate)
// ------------------------------------------------------------
const app = express();
app.use(express.urlencoded({ extended: true }));

// Servir estáticos em /downloads (PDFs, ZIPs e assets)
app.use('/downloads', express.static(OUTPUT_DIR));
app.use('/assets', express.static(path.join(__dirname, 'assets')));

app.get('/generated-files', (req, res) => {
  const parentId = parseInt(req.query.parent, 10);
  if (isNaN(parentId)) {
    return res.status(400).json({ error: 'Oportunidade inválida.' });
  }

  try {
    const files = listGeneratedFilesForOpportunity(OUTPUT_DIR, parentId);
    return res.json({
      files,
      html: renderGeneratedFilesList(files),
    });
  } catch (err) {
    console.error('Erro ao listar arquivos gerados:', err);
    return res.status(500).json({ error: 'Erro ao listar arquivos gerados.' });
  }
});

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
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Gerar Fichas de Inscrição</title>
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
      .generated-files-block {
        display: none;
      }
      @media (max-width: 576px) {
        body {
          padding-top: 20px;
        }
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
              </h5>
              <form id="formGenerate" action="/generate" method="POST">
                <div class="mb-3">
                  <label for="parent" class="form-label">Escolha a oportunidade principal:</label>
                  <select name="parent" id="parent" class="form-select" required>
                    <option value="" disabled selected>-- selecione --</option>
                    ${optionsHtml}
                  </select>
                </div>
                <div class="mb-3">
                  <label for="filterType" class="form-label">Filtrar inscrições:</label>
                  <select name="filterType" id="filterType" class="form-select" required>
                    <option value="selected">Apenas selecionadas (status 10)</option>
                    <option value="selected_and_alternate">Selecionadas e suplentes (status 8 e 10)</option>
                    <option value="all">Todas inscritas (exceto não avaliadas)</option>
                  </select>
                  <div class="form-text">Escolha quais inscrições devem ser incluídas nas fichas</div>
                </div>
                <div class="mb-3">
                  <label for="attachmentMode" class="form-label">Incluir anexos:</label>
                  <select name="attachmentMode" id="attachmentMode" class="form-select" required>
                    <option value="with_attachments" selected>Ficha + anexos</option>
                    <option value="sheet_only">Somente ficha</option>
                  </select>
                  <div class="form-text">Escolha se os PDFs anexos serão juntados ao final da ficha</div>
                </div>
                <button id="btnSubmit" type="submit" class="btn btn-primary w-100">
                  <span id="btnText">Gerar Fichas</span>
                  <span id="loadingSpinner" class="spinner-border spinner-border-sm ms-2" role="status" aria-hidden="true"></span>
                </button>
              </form>
            </div>
          </div>

          ${renderGeneratedFilesCard({
            title: 'Arquivos já gerados',
            className: 'card shadow-sm mt-3',
            blockId: 'generatedFilesBlock',
            contentId: 'generatedFilesContent',
            countId: 'generatedFilesCount',
            hidden: true,
          })}
        </div>
      </div>
    </div>

    <script src="/assets/js/bootstrap.bundle.min.js"></script>
    <script>
      const form = document.getElementById('formGenerate');
      const btnSubmit = document.getElementById('btnSubmit');
      const btnText = document.getElementById('btnText');
      const loadingSpinner = document.getElementById('loadingSpinner');
      const parentSelect = document.getElementById('parent');
      const generatedFilesBlock = document.getElementById('generatedFilesBlock');
      const generatedFilesContent = document.getElementById('generatedFilesContent');
      const generatedFilesCount = document.getElementById('generatedFilesCount');

      function renderGeneratedFiles(files, html) {
        generatedFilesBlock.style.display = 'block';
        generatedFilesCount.textContent = files.length;

        if (!files.length) {
          generatedFilesContent.className = 'small text-muted';
          generatedFilesContent.textContent = 'Nenhum arquivo gerado encontrado para esta oportunidade.';
          return;
        }

        generatedFilesContent.className = 'generated-files-list list-group';
        generatedFilesContent.innerHTML = html;
      }

      parentSelect.addEventListener('change', async () => {
        const parentId = parentSelect.value;
        if (!parentId) {
          generatedFilesBlock.style.display = 'none';
          return;
        }

        generatedFilesBlock.style.display = 'block';
        generatedFilesCount.textContent = '...';
        generatedFilesContent.className = 'small text-muted';
        generatedFilesContent.textContent = 'Buscando arquivos gerados...';

        try {
          const response = await fetch('/generated-files?parent=' + encodeURIComponent(parentId));
          if (!response.ok) {
            throw new Error('Erro ao buscar arquivos');
          }
          const data = await response.json();
          renderGeneratedFiles(data.files || [], data.html || '');
        } catch (error) {
          generatedFilesCount.textContent = '0';
          generatedFilesContent.className = 'small text-danger';
          generatedFilesContent.textContent = 'Não foi possível listar os arquivos gerados.';
        }
      });

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
  const filterType = req.body.filterType || 'selected';
  const attachmentMode = req.body.attachmentMode || 'with_attachments';
  
  if (isNaN(parentId)) {
    return res.status(400).send('Oportunidade inválida.');
  }
  
  // Validar filterType
  const validFilters = ['selected', 'selected_and_alternate', 'all'];
  if (!validFilters.includes(filterType)) {
    return res.status(400).send('Tipo de filtro inválido.');
  }

  const validAttachmentModes = ['with_attachments', 'sheet_only'];
  if (!validAttachmentModes.includes(attachmentMode)) {
    return res.status(400).send('Tipo de geração inválido.');
  }

  const includeAttachments = attachmentMode === 'with_attachments';

  let zipFilename;
  try {
    zipFilename = await generateFichas(parentId, filterType, includeAttachments);
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

  const generatedResultFiles = [
    {
      name: zipFilename,
      url: `/downloads/${zipFilename}`,
      type: 'zip',
    },
    ...pdfFiles.map(fname => ({
      name: fname,
      url: `/downloads/${fname}`,
      type: 'pdf',
    })),
  ];

  const html = `
<!DOCTYPE html>
<html lang="pt-BR">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Fichas Geradas</title>
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
      @media (max-width: 576px) {
        body {
          padding-top: 20px;
        }
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
              </h5>
              <div class="d-grid gap-2 d-sm-flex justify-content-sm-center">
                <a href="/downloads/${zipFilename}" class="btn btn-success">
                  Baixar todas as fichas (ZIP)
                </a>
                <a href="/" class="btn btn-secondary">
                  Voltar
                </a>
              </div>
            </div>
          </div>

          ${renderGeneratedFilesCard({
            title: 'Arquivos gerados',
            files: generatedResultFiles,
          })}
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
  console.log(`Servidor rodando na porta ${SERVER_PORT}`);
  console.log(`Acesse http://localhost:${SERVER_PORT}/ para gerar fichas.`);
});

/**
 * generate_sheets.js
 *
 * Serviço HTTP para gerar fichas de inscrição em PDF de uma oportunidade pai
 * incluindo todas as fases-filhas (exceto "parentId+1").
 * Avaliações técnicas (type = 'technical') exibem:
 *   - Seções + Critérios + Nota
 *   - Total, Status e Parecer
 *
 * Para a fase pai, usa sempre o ID da inscrição-pai (previousPhaseRegistrationId)
 * ao buscar registration_evaluation para avaliação técnica.
 *
 * .env deve conter:
 *   DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME, OUTPUT_DIR, SERVER_PORT,
 *   LOGO_PATH, FILES_DIR, CHROMIUM_PATH
 *
 * ORGANIZAÇÃO:
 * - src/domain/     → regras puras (formatação, status, avaliações, opções)
 * - src/web/        → app Express + templates Handlebars das páginas
 * - src/pdf/        → template e renderização do PDF da ficha
 * - este arquivo    → acesso ao banco, orquestração da geração e bootstrap
 *
 * PERFORMANCE:
 * - Pool de conexões otimizado com timeout
 * - Consultas em batch para reduzir queries
 * - Pré-carregamento de dados em lote
 * - Busca paralela de avaliações e arquivos
 * - Cache de seções e critérios
 */

require('dotenv').config();
const path       = require('path');
const fs         = require('fs');
const { Pool }   = require('pg');
const archiver   = require('archiver');

const { STATUS_LABELS, OPPORTUNITY_STATUS_APPEAL_PHASE } = require('./src/domain/status');
const { formatValue, slugifyAgentName } = require('./src/domain/format');
const { processEvaluation, processAppealResult, buildSectionsWithCriteria } = require('./src/domain/evaluation');
const { statusFilterFor } = require('./src/domain/generation-options');
const { renderFichaPdf, mergeWithAttachments, logoBase64 } = require('./src/pdf/ficha-renderer');
const { createApp } = require('./src/web/app');
const { listGeneratedFilesForOpportunity, listResultFilesForGeneration } = require('./generated_files');

// ------------------------------------------------------------
// 1) Configuração a partir do .env
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

/**
 * Executa uma consulta com um client do pool, sempre devolvendo-o ao final.
 */
async function withClient(fn) {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

// ------------------------------------------------------------
// 2) Funções de acesso ao banco
// ------------------------------------------------------------

// 2.1) Lista todas as oportunidades-pai (parent_id IS NULL)
async function fetchParentOpportunities() {
  return withClient(async client => {
    const res = await client.query(`
      SELECT id, name
      FROM opportunity
      WHERE parent_id IS NULL
      AND published_registrations
      AND status = 1
      ORDER BY name;
    `);
    return res.rows;
  });
}

async function fetchOpportunityById(opportunityId) {
  return withClient(async client => {
    const res = await client.query(`
      SELECT id, name
      FROM opportunity
      WHERE id = $1
      LIMIT 1;
    `, [opportunityId]);
    return res.rows[0] || null;
  });
}

// 2.2) Lista todos os filhos de parentId, EXCLUINDO parentId+1
async function fetchChildrenExcludingNext(parentId) {
  return withClient(async client => {
    const res = await client.query(`
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
    `, [parentId, parentId + 1, OPPORTUNITY_STATUS_APPEAL_PHASE]);
    return res.rows;
  });
}

// 2.3) Busca fases relevantes, inserindo fases de recurso logo após a fase avaliada
async function fetchRelevantPhasesWithAppeals(parentId) {
  return withClient(async client => {
    const res = await client.query(`
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
    `, [parentId, OPPORTUNITY_STATUS_APPEAL_PHASE]);
    return res.rows;
  });
}

async function fetchOpportunityAsSinglePhase(parentId) {
  return withClient(async client => {
    const res = await client.query(
      `SELECT id, name, parent_id, status, false AS "isAppealPhase" FROM opportunity WHERE id = $1 LIMIT 1;`,
      [parentId]
    );
    return res.rowCount ? [res.rows[0]] : [];
  });
}

// 2.4) Busca inscrições para múltiplas fases em uma única query
async function fetchRegistrationsForPhases(phaseIds, parentId, filterType = 'selected') {
  return withClient(async client => {
    const res = await client.query(`
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
      AND (r.opportunity_id != $2 OR ${statusFilterFor(filterType)})
      ORDER BY r.opportunity_id, r.number;
    `, [phaseIds, parentId]);

    // Agrupa por phase_id
    const grouped = {};
    for (const row of res.rows) {
      const phaseId = row.phase_id;
      if (!grouped[phaseId]) grouped[phaseId] = [];
      grouped[phaseId].push(row);
    }
    return grouped;
  });
}

// 2.5) Busca múltiplas inscrições pai em lote
async function fetchParentRegistrationIds(childRegistrationIds) {
  if (!childRegistrationIds.length) return {};

  return withClient(async client => {
    const res = await client.query(`
      SELECT object_id, value
      FROM registration_meta
      WHERE object_id = ANY($1::int[])
        AND key = 'previousPhaseRegistrationId';
    `, [childRegistrationIds]);

    const parentMap = {};
    for (const row of res.rows) {
      const parentRegId = parseInt(row.value, 10);
      if (!isNaN(parentRegId)) {
        parentMap[row.object_id] = parentRegId;
      }
    }
    return parentMap;
  });
}

// 2.6) Busca metadados para múltiplas inscrições em lote
async function fetchOrderedMetaForRegistrations(regIds, phaseIds) {
  if (!regIds.length || !phaseIds.length) return {};

  return withClient(async client => {
    const res = await client.query(`
      SELECT
        rm.object_id,
        rfc.opportunity_id   AS phase_id,
        rfc.title            AS field_label,
        rfc.field_type       AS field_type,
        rfc.display_order    AS field_order,
        rm.value             AS field_value
      FROM registration_meta rm
      JOIN registration_field_configuration rfc
        ON rm.key LIKE 'field_%'
        AND CAST(replace(rm.key, 'field_', '') AS INTEGER) = rfc.id
        AND rfc.opportunity_id = ANY($2::int[])
      WHERE rm.object_id = ANY($1::int[])
      ORDER BY rm.object_id, rfc.opportunity_id, rfc.display_order;
    `, [regIds, phaseIds]);

    const grouped = {};
    for (const row of res.rows) {
      const regId = row.object_id;
      const phaseId = row.phase_id;

      if (!grouped[regId]) grouped[regId] = {};
      if (!grouped[regId][phaseId]) grouped[regId][phaseId] = [];

      grouped[regId][phaseId].push({
        label: row.field_label,
        fieldType: row.field_type,
        value: row.field_value
      });
    }
    return grouped;
  });
}

// Cache para seções e critérios
const sectionsCache = new Map();

// 2.7) Busca seções e critérios de avaliação técnica, com cache por fase
async function getSectionsAndCriteriaForPhase(phaseId) {
  if (sectionsCache.has(phaseId)) {
    return sectionsCache.get(phaseId);
  }

  const result = await withClient(async client => {
    // 1) evaluation_method_configuration.id do tipo 'technical'
    const r1 = await client.query(`
      SELECT id
      FROM evaluation_method_configuration
      WHERE opportunity_id = $1
        AND type = 'technical'
      LIMIT 1;
    `, [phaseId]);
    if (r1.rowCount === 0) return [];

    const evalMethodConfigId = r1.rows[0].id;

    // 2) sections e criteria em paralelo
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

    const parseMeta = (res, label) => {
      if (res.rowCount === 0) return [];
      try {
        return JSON.parse(res.rows[0].value);
      } catch (e) {
        console.error(`Erro ao parsear ${label} para fase ${phaseId}:`, e);
        return [];
      }
    };

    return buildSectionsWithCriteria(
      parseMeta(sectionsRes, 'sections'),
      parseMeta(criteriaRes, 'criteria')
    );
  });

  sectionsCache.set(phaseId, result);
  return result;
}

// 2.8) Busca avaliações em lote para múltiplas inscrições e fases
async function getEvaluationsForRegistrations(regIds, phaseIds) {
  if (!regIds.length || !phaseIds.length) return {};

  return withClient(async client => {
    const res = await client.query(`
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
    `, [regIds, phaseIds]);

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
  });
}

// 2.9) Busca arquivos para múltiplas inscrições e fases
async function fetchFilesForRegistrations(regIds, phaseIds) {
  if (!regIds.length || !phaseIds.length) return {};

  return withClient(async client => {
    const res = await client.query(`
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
    `, [regIds, phaseIds]);

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
  });
}

// ------------------------------------------------------------
// 3) Leitura dos anexos em disco
// ------------------------------------------------------------
function readAttachmentBuffers(regIdsByPhase, phases) {
  const buffers = [];
  const seen = new Set();

  for (const phase of phases) {
    const rId = regIdsByPhase[phase.id];
    if (!rId) continue;
    const folder = path.join(FILES_DIR, String(rId));
    if (!fs.existsSync(folder)) continue;

    try {
      for (const name of fs.readdirSync(folder).filter(f => f.endsWith('.pdf'))) {
        const p = path.join(folder, name);
        if (!seen.has(p)) {
          seen.add(p);
          buffers.push(fs.readFileSync(p));
        }
      }
    } catch (err) {
      console.warn(`Erro ao ler pasta ${folder}:`, err);
    }
  }

  return buffers;
}

// ------------------------------------------------------------
// 4) Geração de fichas para um parentId
// ------------------------------------------------------------
async function generateFichas(parentId, filterType = 'selected', includeAttachments = true) {
  const generationMode = includeAttachments ? 'ficha + anexos' : 'somente ficha';
  console.log(`\n→ Iniciando geração de fichas para parentId=${parentId} (filtro: ${filterType}, modo: ${generationMode})`);
  const startTime = Date.now();

  // 4.1) Buscar todos os filhos (exceto parentId+1)
  const children = await fetchChildrenExcludingNext(parentId);
  console.log(`→ Filhos encontrados: ${children.length}`);

  // 4.2) Carrega todas as fases relevantes, incluindo recursos após suas fases avaliadas
  let phases = await fetchRelevantPhasesWithAppeals(parentId);
  if (!phases.length) {
    phases = await fetchOpportunityAsSinglePhase(parentId);
  }

  console.log(`→ Fases relevantes: ${phases.map(p => p.name).join(', ')}`);

  // 4.3) Buscar inscrições para todas as fases de uma vez
  const phaseIds = phases.map(p => p.id);
  const registrationsByPhase = await fetchRegistrationsForPhases(phaseIds, parentId, filterType);
  console.log(`→ Inscrições por fase carregadas em lote`);

  // 4.4) Encontrar a fase que tenha inscrições - PRIORIZA A FASE PAI
  let chosenPhaseId = null;
  let registrations = [];

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

  // 4.5) Preparar diretórios
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // 4.6) Pré-carregamento em lote de todos os dados
  console.log(`→ Pré-carregando TODOS os dados em lote...`);

  const allRegIdsSet = new Set();
  for (const phaseId of phaseIds) {
    const regsInPhase = registrationsByPhase[phaseId] || [];
    regsInPhase.forEach(r => allRegIdsSet.add(r.registration_id));
  }
  const allRegIds = Array.from(allRegIdsSet);
  const allPhaseIds = phases.map(p => p.id);

  console.log(`→ Total de IDs únicos para pré-carregar: ${allRegIds.length}`);

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

  console.log(`→ Dados pré-carregados em ${Date.now() - startTime}ms`);

  const pdfFilenames = [];
  const filenameSuffix = includeAttachments ? '' : '_sem_anexos';

  // 4.7) Processar cada inscrição com dados pré-carregados
  for (let i = 0; i < registrations.length; i++) {
    const reg = registrations[i];
    const regNumber = reg.registration_number || reg.registration_id;
    const parentRegId = parentRegIdMap[reg.registration_id];
    const regStartTime = Date.now();

    console.log(`\n→ [${i + 1}/${registrations.length}] Processando ${regNumber}...`);

    // 4.7.1) Metadados do pai (pré-carregados)
    // Se não tem parentRegId, é porque esta É a inscrição pai - usa o próprio ID
    const actualParentRegId = parentRegId || reg.registration_id;

    let parentMetaArray = [];
    if (actualParentRegId && allMetaData[actualParentRegId]) {
      const rawParentArray = allMetaData[actualParentRegId][parentId] || [];
      parentMetaArray = rawParentArray.map(item => ({
        label: item.label,
        value: formatValue(item.value, item.fieldType)
      }));
    }

    // 4.7.2) Determinar IDs de registro por fase
    const regIdsByPhase = {};
    const registrationsByPhaseMatch = {};
    for (const phase of phases) {
      const regsThisPhase = registrationsByPhase[phase.id] || [];
      // Recursos são casados pelo número da inscrição; demais fases, pelo agente
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

    // 4.7.3) Processar dados das fases em paralelo
    const phasePromises = phases.map(async (phase) => {
      const phaseRegistration = registrationsByPhaseMatch[phase.id];
      // Recurso sem inscrição, ou ainda em rascunho, não aparece na ficha
      if (phase.isAppealPhase && (!phaseRegistration || phaseRegistration.registration_status === 0)) {
        return null;
      }

      // Para fase pai usa parentMetaArray, para filhas usa o regId correto de cada fase
      const phaseRegId = regIdsByPhase[phase.id] || reg.registration_id;

      const rowsForThisPhase = (phase.id === parentId)
        ? parentMetaArray
        : ((allMetaData[phaseRegId] && allMetaData[phaseRegId][phase.id]) || []).map(item => ({
            label: item.label,
            value: formatValue(item.value, item.fieldType)
          }));

      const key = `${phaseRegId}_${phase.id}`;
      const evaluationData = allEvaluations[key];
      const files = allFiles[key] || [];

      const evalObj = await processEvaluation(phase.id, evaluationData, getSectionsAndCriteriaForPhase);
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
        evalRegId: phaseRegId
      };
    });

    const dataPhases = (await Promise.all(phasePromises)).filter(Boolean);

    // 4.7.4) Gerar PDF
    let pdfBuffer;
    try {
      pdfBuffer = await renderFichaPdf({
        registration_number: regNumber,
        agent: {
          id: reg.agent_id,
          name: reg.agent_name || '',
        },
        phases: dataPhases
      });
    } catch (err) {
      console.error(`Erro ao gerar PDF para ${regNumber}:`, err);
      continue;
    }

    // 4.7.5) Anexar arquivos PDF
    let finalPdfBuffer = pdfBuffer;
    if (includeAttachments) {
      const attachmentBuffers = readAttachmentBuffers(regIdsByPhase, phases);
      if (attachmentBuffers.length) {
        finalPdfBuffer = await mergeWithAttachments(pdfBuffer, attachmentBuffers);
      }
    }

    // 4.7.6) Salvar PDF
    const filename = `ficha_${parentId}_${regNumber}_${slugifyAgentName(reg.agent_name)}${filenameSuffix}.pdf`;
    const filepath = path.join(OUTPUT_DIR, filename);

    try {
      fs.writeFileSync(filepath, finalPdfBuffer);
      pdfFilenames.push(filename);
      console.log(`   → PDF salvo: ${filename} (${Date.now() - regStartTime}ms)`);
    } catch (err) {
      console.error(`Erro ao salvar PDF ${filename}:`, err);
    }
  }

  // 4.8) Criar ZIP
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

// ------------------------------------------------------------
// 5) Inicia servidor HTTP
// ------------------------------------------------------------
const app = createApp({
  outputDir: OUTPUT_DIR,
  assetsDir: path.join(__dirname, 'assets'),
  logoBase64,
  fetchParentOpportunities,
  fetchOpportunityById,
  generateFichas,
  listGeneratedFilesForOpportunity,
  listResultFilesForGeneration
});

app.listen(SERVER_PORT, () => {
  console.log(`Servidor rodando na porta ${SERVER_PORT}`);
  console.log(`Acesse http://localhost:${SERVER_PORT}/ para gerar fichas.`);
});

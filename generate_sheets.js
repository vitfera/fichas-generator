/**
 * generate_sheets.js
 *
 * Serviço HTTP para gerar fichas de inscrição em PDF de uma oportunidade pai
 * incluindo todas as fases-filhas (exceto “parentId+1”).
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

const pool = new Pool({
  host: DB_HOST,
  port: DB_PORT,
  user: DB_USER,
  password: DB_PASSWORD,
  database: DB_NAME,
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

  // 5.1) Se for string “YYYY-MM-DD”
  if (typeof raw === 'string') {
    const isoDateMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (isoDateMatch) {
      const [, year, month, day] = isoDateMatch;
      return `${day}/${month}/${year}`;
    }
  }
  // 5.2) Se for string “YYYY-MM-DDTHH:MM:SSZ”
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
    // 5.5) Array de objetos: “chave: valor; ...”
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
// 6) Funções de acesso ao banco
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

// 6.4) Busca inscrições para uma fase (phaseId), incluindo o status
async function fetchRegistrationsForPhase(phaseId) {
  const client = await pool.connect();
  try {
    const query = `
      SELECT
        r.id     AS registration_id,
        r.number AS registration_number,
        r.status AS registration_status,
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

// 6.5) Busca a inscrição‐pai associada a uma inscrição‐filho
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

// 6.6) Busca TODAS as respostas (registration_meta) de uma inscrição (regId),
//      para todas as fases listadas em phaseIds
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
// 6.7) BUSCAR SEÇÕES E CRITÉRIOS PARA AVALIAÇÃO TÉCNICA
//
//     Para uma fase (phaseId), precisamos:
//       1) encontrar o registro em evaluation_method_configuration
//          com type = 'technical'
//       2) a partir desse ID, pegar:
//         - meta_key = 'sections'   → array de { id, name }
//         - meta_key = 'criteria'   → array de { id, sid, title, min, max, weight }
//     Retornamos um array de objetos: { id, name, criteria: [ { id, title, sid } … ] }
// ------------------------------------------------------------
async function getSectionsAndCriteriaForPhase(phaseId) {
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
      console.log(`→ Fase ${phaseId}: não encontrou configuração type='technical'.`);
      return [];
    }
    const evalMethodConfigId = r1.rows[0].id;
    console.log(`→ Fase ${phaseId}: encontrou avaliação técnica (id=${evalMethodConfigId}).`);

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
      console.log(`→ Fase ${phaseId}: configuração técnica sem 'sections'.`);
      return [];
    }
    let sectionsRaw = r2.rows[0].value;
    console.log(`→ Fase ${phaseId}: JSON bruto de 'sections':`, sectionsRaw);
    try {
      sectionsRaw = JSON.parse(sectionsRaw);
    } catch (e) {
      console.error(`→ Fase ${phaseId}: falha ao fazer JSON.parse(sectionsRaw).`, e);
      return [];
    }
    if (!Array.isArray(sectionsRaw)) {
      console.warn(`→ Fase ${phaseId}: 'sections' não é array após parse.`);
      return [];
    }

    // 3) Buscar JSON 'criteria'
    const q3 = `
      SELECT value
      FROM evaluationmethodconfiguration_meta
      WHERE object_id = $1
        AND key = 'criteria'
      LIMIT 1;
    `;
    const r3 = await client.query(q3, [evalMethodConfigId]);
    if (r3.rowCount === 0) {
      console.log(`→ Fase ${phaseId}: configuração técnica sem 'criteria'.`);
      // Retorna seções sem critérios associados
      return sectionsRaw.map(sec => ({
        id:       sec.id,
        name:     sec.name,
        criteria: []
      }));
    }
    let criteriaRaw = r3.rows[0].value;
    console.log(`→ Fase ${phaseId}: JSON bruto de 'criteria':`, criteriaRaw);
    try {
      criteriaRaw = JSON.parse(criteriaRaw);
    } catch (e) {
      console.error(`→ Fase ${phaseId}: falha ao fazer JSON.parse(criteriaRaw).`, e);
      criteriaRaw = [];
    }
    if (!Array.isArray(criteriaRaw)) {
      console.warn(`→ Fase ${phaseId}: 'criteria' não é array após parse.`);
      criteriaRaw = [];
    }

    // 4) Montar array final: para cada seção, filtrar apenas critérios cujo sid === seção.id
    const result = sectionsRaw.map(sec => {
      const critsForThisSection = criteriaRaw
        .filter(c => c.sid === sec.id)
        .map(c => ({
          id:    c.id,
          title: c.title,
          sid:   c.sid
        }));
      return {
        id:       sec.id,
        name:     sec.name,
        criteria: critsForThisSection
      };
    });

    console.log(`→ Fase ${phaseId}: seções+critérios parseados:`, JSON.stringify(result, null, 2));
    return result;
  } finally {
    client.release();
  }
}

/**
 * getEvaluationForRegistrationAndPhase(regId, phaseId)
 *
 * Para uma inscrição (ID numérico) e uma fase, carregamos dados de registration_evaluation:
 *   - Se for técnica (seções preenchidas), devolvemos seções + critérios + notas
 *   - Senão, devolvemos total, status e parecer (simplificada)
 *
 * Retorna:
 *   {
 *     sections:      [ { sectionTitle, criteria: [ { label, score } ] } ],
 *     status:        string,     // OBS: não será usado no template para técnica
 *     parecer:       string,
 *     total:         number,
 *     hasTechnical:  boolean,
 *     hasSimplified: boolean
 *   }
 */
async function getEvaluationForRegistrationAndPhase(regId, phaseId) {
  const client = await pool.connect();
  try {
    // 1) Ler o registro de evaluation_data
    const q1 = `
      SELECT
        re.evaluation_data,
        re.result AS total_score
      FROM registration_evaluation re
      JOIN registration r
        ON r.id = re.registration_id
      WHERE re.registration_id = $1
        AND r.opportunity_id = $2
      LIMIT 1;
    `;
    const r1 = await client.query(q1, [regId, phaseId]);
    if (r1.rowCount === 0) {
      console.log(`→ Inscrição ${regId} fase ${phaseId}: não há registro em registration_evaluation.`);
      return {
        sections:      [],
        status:        '',
        parecer:       '',
        total:         0,
        hasTechnical:  false,
        hasSimplified: false
      };
    }

    let rawEval = r1.rows[0].evaluation_data;
    const totalScore = r1.rows[0].total_score || 0;
    if (typeof rawEval === 'string') {
      try {
        rawEval = JSON.parse(rawEval);
      } catch {
        rawEval = {};
      }
    }
    if (!rawEval || typeof rawEval !== 'object') {
      // caso não seja objeto válido, interpretamos como simplificado
      const statusText  = rawEval.status ? String(rawEval.status) : '';
      const parecerText = rawEval.obs ? String(rawEval.obs) : '';
      return {
        sections:      [],
        status:        statusText,
        parecer:       parecerText,
        total:         totalScore,
        hasTechnical:  false,
        hasSimplified: totalScore > 0
      };
    }

    const parecerText = rawEval.obs ? String(rawEval.obs) : '';
    const statusText  = rawEval.status ? String(rawEval.status) : '';
    console.log(`→ Inscrição ${regId} fase ${phaseId}: evaluation_data (parsed):`, rawEval);

    // 2) Carrega seções e critérios desta fase
    const technicalSections = await getSectionsAndCriteriaForPhase(phaseId);
    const sections = [];

    if (technicalSections.length) {
      // para cada seção obtida, montamos { sectionTitle, criteria: [ { label, score } ] }
      for (const sec of technicalSections) {
        const secTitle = sec.name || '';
        const critList = [];

        // percorre cada critério da seção e pega a nota em rawEval[c.id]
        for (const c of sec.criteria) {
          const cid      = c.id;       // ex: "c-1741742846722"
          const ctitle   = c.title || '';
          const rawScore = rawEval[cid];
          const score    = (rawScore !== undefined) ? (Number(rawScore) || 0) : 0;
          critList.push({
            label: ctitle,
            score: score
          });
        }

        sections.push({
          sectionTitle: secTitle,
          criteria: critList
        });
      }
    }

    const hasTechnical  = sections.length > 0;
    const hasSimplified = !hasTechnical && totalScore > 0;

    console.log(`→ Inscrição ${regId} fase ${phaseId}: hasTechnical=${hasTechnical}, hasSimplified=${hasSimplified}, totalScore=${totalScore}`);

    return {
      sections:      sections,
      status:        statusText,   // não será usado para técnica, mas pode ser usado em outro cenário
      parecer:       parecerText,
      total:         totalScore,
      hasTechnical:  hasTechnical,
      hasSimplified: hasSimplified
    };
  } finally {
    client.release();
  }
}

// ------------------------------------------------------------
// 6.9) Busca os anexos (arquivos) enviados para uma inscrição e fase
// ------------------------------------------------------------
async function fetchFilesForRegistrationAndPhase(regId, phaseId) {
  const client = await pool.connect();
  try {
    const res = await client.query(`
      SELECT f.name AS file_name
      FROM registration_file_configuration rfc
      /* pega só o arquivo mais recente para cada campo */
      LEFT JOIN LATERAL (
        SELECT name
        FROM "file"
        WHERE grp       = CONCAT('rfc_', rfc.id)
          AND object_id = $1
        ORDER BY id DESC
        LIMIT 1
      ) f ON TRUE
      WHERE rfc.opportunity_id = $2
      ORDER BY rfc.display_order
    `, [regId, phaseId]);

    // deduplica nomes
    const unique = Array.from(new Set(
      res.rows
        .map(r => r.file_name)
        .filter(n => n)   // remove nulls/undefined
    ));

    return unique;
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

  // 8.2) Encontrar a primeira fase (pai ou filho) que tenha inscrições
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
  console.log(`→ parentId=${parentId}: usando fase ${chosenPhaseId} para buscar inscrições.`);

  // 8.5) Carrega TODAS as fases relevantes (pai + filhos exceto parentId+1)
  let phases = await fetchAllRelevantPhases(parentId);
  if (!phases.length) {
    // fallback: coloca o próprio parentId
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
  console.log(`→ parentId=${parentId}: fases relevantes:`, phases);

  // 8.6) Criar OUTPUT_DIR e index.html placeholder
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
  const placeholder = path.join(OUTPUT_DIR, 'index.html');
  if (!fs.existsSync(placeholder)) {
    fs.writeFileSync(placeholder, '', 'utf-8');
  }

  const pdfFilenames = [];

  // 8.7) Para cada inscrição da fase escolhida, gerar PDF
  for (const reg of registrations) {
    const regNumber = reg.registration_number || reg.registration_id;
    console.log(`\n→ Gerando ficha para registration_number=${regNumber} (id=${reg.registration_id}).`);

    // 8.7.1) Inscrição pai
    const parentRegId = await fetchParentRegistrationId(reg.registration_id);
    console.log(`   → Inscrição pai (previousPhaseRegistrationId) = ${parentRegId}`);

    // 8.7.2) Montar array de metadados do PAI
    let parentMetaArray = [];
    if (parentRegId) {
      const parentGrouped = await fetchOrderedMetaForRegistration(parentRegId, [parentId]);
      const rawParentArray = parentGrouped[parentId] || [];
      parentMetaArray = rawParentArray.map(item => ({
        label: item.label,
        value: formatValue(item.value)
      }));
    }
    console.log(`   → Metadados do PAI:`, parentMetaArray);

    // 8.7.2.5) PARA CADA FASE: determina o registration_id exato (pai ou filha)
    const regIdsByPhase = {};
    for (const phase of phases) {
      const regsThisPhase = await fetchRegistrationsForPhase(phase.id);
      // registra o mesmo agente (pela agent_id)
      const match = regsThisPhase.find(r => r.agent_id === reg.agent_id);
      // para a fase-pai use parentRegId se existir, senão o match
      regIdsByPhase[phase.id] = (phase.id === parentId && parentRegId)
        ? parentRegId
        : (match ? match.registration_id : null);
    }

    // 8.7.3) Buscar meta do CHILD e demais fases-filhas
    const allPhaseIds    = phases.map(p => p.id);
    const allMetaGrouped = await fetchOrderedMetaForRegistration(reg.registration_id, allPhaseIds);

    const childMetaArrays = {};
    for (const phase of phases) {
      if (phase.id === parentId) continue;
      const rawArr = allMetaGrouped[phase.id] || [];
      childMetaArrays[phase.id] = rawArr.map(item => ({
        label: item.label,
        value: formatValue(item.value)
      }));
    }
    console.log(`   → Metadados das fases-filhas:`, childMetaArrays);

    // 8.7.4) Determinar texto do status da inscrição
    const numericStatus = reg.registration_status;
    const regStatusText = STATUS_LABELS[numericStatus] || '';

    // 8.7.5) Montar dataPhases: cada elemento { id, name, rows, evaluation, regStatusText }
    const dataPhases = [];
    for (const phase of phases) {
      const rowsForThisPhase = (phase.id === parentId)
        ? parentMetaArray
        : (childMetaArrays[phase.id] || []);

      // 8.7.5.1) Definir qual registration_id usar para buscar avaliação:
      //        - Se for fase pai, usa parentRegId (se existir)
      //        - Senão, usa o próprio reg.registration_id
      const evalRegId = regIdsByPhase[phase.id] || reg.registration_id;

      const evalObj = await getEvaluationForRegistrationAndPhase(
        evalRegId,
        phase.id
      );
      console.log(`   → Avaliação fetched para inscrição ${evalRegId}, fase ${phase.id}:`, evalObj);

      // carregar arquivos desta inscrição+fase
      const files = await fetchFilesForRegistrationAndPhase(evalRegId, phase.id);
      console.log(`→ [DEBUG] phase.id=${phase.id} (evalRegId=${evalRegId}) → files:`, files);

      dataPhases.push({
        id:             phase.id,
        name:           phase.name,
        rows:           rowsForThisPhase,
        evaluation:     evalObj,
        regStatusText:  regStatusText,
        files:          files,
        evalRegId:      evalRegId
      });
    }

    // 8.7.6) Montar objeto “data” e incluir logoBase64 + bootstrapCSS
    const data = {
      registration_number: regNumber,
      agent: {
        id:   reg.agent_id,
        name: reg.agent_name || '',
      },
      phases:       dataPhases,
      logoBase64:   logoBase64,
      bootstrapCSS: bootstrapCSS
    };

    // 8.7.7) Renderizar HTML via Handlebars
    let html;
    try {
      html = template(data);
    } catch (err) {
      console.error(`Erro ao renderizar template para registration_number=${regNumber}:`, err);
      continue;
    }

    // 8.7.8) Converter HTML em PDF
    let pdfBuffer;
    try {
      pdfBuffer = await htmlToPdfBuffer(html);
    } catch (err) {
      console.error(`Erro ao gerar PDF para registration_number=${regNumber}:`, err);
      continue;
    }

    // 8.7.8.1) Procurar TODOS os PDFs em FILES_DIR/<registration_id> e mesclar
    const attachmentBuffers = [];
    const seen = new Set();

    for (const phase of phases) {
      const rId = regIdsByPhase[phase.id];
      if (!rId) continue;
      const folder = path.join(FILES_DIR, String(rId));
      if (!fs.existsSync(folder)) continue;
      for (const name of fs.readdirSync(folder).filter(f=>f.endsWith('.pdf'))) {
        const p = path.join(folder, name);
        if (!seen.has(p)) {
          seen.add(p);
          attachmentBuffers.push(fs.readFileSync(p));
        }
      }
    }

    console.log(`→ Total de buffers de anexos após dedupe: ${attachmentBuffers.length}`);
    console.log('→ [DEBUG] attachmentBuffers (antes de merge):', attachmentBuffers.map((_, i) => i));
    console.log('→ [DEBUG] arquivos lidos do disco:', Array.from(seen));

    let finalPdfBuffer = pdfBuffer;
    if (attachmentBuffers.length) {
      finalPdfBuffer = await mergeWithAttachments(pdfBuffer, attachmentBuffers);
    }

    // 8.7.9) Salvar o PDF em OUTPUT_DIR
    // Supondo que você tenha disponível em `reg`:
    //   reg.registration_number (ou regNumber)
    //   reg.agent_name

    // 1) Normaliza o nome do agente para remover acentos
    const nomeSemAcento = reg.agent_name
      .normalize('NFD')                   // separa letras de seus diacríticos
      .replace(/[\u0300-\u036f]/g, '')    // remove os diacríticos

    // 2) Substitui espaços e caracteres inválidos por hífens
    const nomeFormatado = nomeSemAcento
      .trim()                             // remove espaços no início/fim
      .toLowerCase()                      // (opcional) força minúsculas
      .replace(/\s+/g, '-')               // espaços → hífen
      .replace(/[^a-z0-9\-]/g, '');       // remove qualquer caractere não alfanumérico ou hífen

    // 3) Monta o filename incluindo parentId, número de inscrição e nome do agente
    const filename = `ficha_${parentId}_${regNumber}_${nomeFormatado}.pdf`;

    const filepath = path.join(OUTPUT_DIR, filename);
    try {
      fs.writeFileSync(filepath, finalPdfBuffer);
      pdfFilenames.push(filename);
      console.log(`   → PDF gerado: ${filename}`);
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
  console.log(`Servidor rodando na porta ${SERVER_PORT}`);
  console.log(`Acesse http://localhost:${SERVER_PORT}/ para gerar fichas.`);
});

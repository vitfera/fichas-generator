/**
 * Interpretação das avaliações (registration_evaluation) do MapasCulturais.
 *
 * Domínio puro: o carregamento de seções/critérios é injetado via
 * `loadSectionsForPhase`, de modo que este módulo não conhece o banco.
 */

const { formatAppealStatus } = require('./status');

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

const EMPTY_EVALUATION_RESULT = {
  evaluations: [],
  hasTechnical: false,
  hasSimplified: false
};

/**
 * @param {number} phaseId
 * @param {Array<{evaluation_data: unknown, total_score: number}>} evaluationDataArray
 * @param {(phaseId: number) => Promise<Array>} loadSectionsForPhase
 */
async function processEvaluation(phaseId, evaluationDataArray, loadSectionsForPhase) {
  if (!Array.isArray(evaluationDataArray) || evaluationDataArray.length === 0) {
    return { ...EMPTY_EVALUATION_RESULT };
  }

  const processedEvaluations = [];
  let technicalSections = null;

  for (let i = 0; i < evaluationDataArray.length; i++) {
    const evaluationData = evaluationDataArray[i];
    const rawEval = parseEvaluationData(evaluationData.evaluation_data);
    const totalScore = evaluationData.total_score || 0;
    const evaluator = `#${i + 1}`;

    const parecer = rawEval.obs ? String(rawEval.obs) : '';
    const status = rawEval.status ? String(rawEval.status) : '';

    // As seções técnicas são iguais para toda a fase: carrega uma única vez.
    if (!technicalSections) {
      technicalSections = await loadSectionsForPhase(phaseId);
    }

    const sections = technicalSections.map(sec => ({
      sectionTitle: sec.name || '',
      criteria: sec.criteria.map(c => ({
        label: c.title || '',
        score: rawEval[c.id] !== undefined ? (Number(rawEval[c.id]) || 0) : 0
      }))
    }));

    const hasTechnical = sections.length > 0;

    processedEvaluations.push({
      evaluator,
      sections,
      status,
      parecer,
      total: totalScore,
      hasTechnical,
      hasSimplified: !hasTechnical && totalScore > 0
    });
  }

  return {
    evaluations: processedEvaluations,
    hasTechnical: processedEvaluations.some(e => e.hasTechnical),
    hasSimplified: processedEvaluations.some(e => e.hasSimplified)
  };
}

/**
 * Resultado de uma fase de recurso: considera sempre a última avaliação.
 */
function processAppealResult(evaluationDataArray, registrationStatus) {
  if (!Array.isArray(evaluationDataArray) || evaluationDataArray.length === 0) {
    return {
      statusText: formatAppealStatus(registrationStatus),
      parecer: ''
    };
  }

  const lastEvaluation = evaluationDataArray[evaluationDataArray.length - 1];
  const rawEval = parseEvaluationData(lastEvaluation.evaluation_data);
  const evaluationStatus = rawEval.status !== undefined && rawEval.status !== ''
    ? rawEval.status
    : lastEvaluation.total_score;

  return {
    statusText: formatAppealStatus(evaluationStatus || registrationStatus),
    parecer: rawEval.obs ? String(rawEval.obs) : ''
  };
}

/**
 * Monta a lista de seções/critérios a partir dos metadados brutos
 * (evaluationmethodconfiguration_meta) de uma fase.
 */
function buildSectionsWithCriteria(sectionsRaw, criteriaRaw) {
  if (!Array.isArray(sectionsRaw)) return [];

  return sectionsRaw.map(sec => ({
    id: sec.id,
    name: sec.name,
    criteria: Array.isArray(criteriaRaw)
      ? criteriaRaw
          .filter(c => c.sid === sec.id)
          .map(c => ({ id: c.id, title: c.title, sid: c.sid }))
      : []
  }));
}

module.exports = {
  parseEvaluationData,
  processEvaluation,
  processAppealResult,
  buildSectionsWithCriteria
};

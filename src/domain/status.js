/**
 * Rótulos de status do MapasCulturais.
 *
 * Domínio puro: sem acesso a banco, sem HTML.
 */

// Status de uma inscrição (registration.status)
const STATUS_LABELS = {
  0:  'Não avaliada',
  1:  'Pendente',
  2:  'Inválida',
  3:  'Não selecionada',
  8:  'Suplente',
  10: 'Selecionada'
};

// Status usado pelo MapasCulturais para marcar uma oportunidade como fase de recurso
const OPPORTUNITY_STATUS_APPEAL_PHASE = -20;

// Status de um recurso interposto pelo proponente
const APPEAL_STATUS_LABELS = {
  1:  'Aguardando resposta',
  2:  'Negado',
  3:  'Indeferido',
  10: 'Deferido'
};

function formatRegistrationStatus(status) {
  return STATUS_LABELS[Number(status)] || '';
}

function formatAppealStatus(status) {
  const numericStatus = Number(status);
  return APPEAL_STATUS_LABELS[numericStatus] || STATUS_LABELS[numericStatus] || '';
}

module.exports = {
  STATUS_LABELS,
  APPEAL_STATUS_LABELS,
  OPPORTUNITY_STATUS_APPEAL_PHASE,
  formatRegistrationStatus,
  formatAppealStatus
};

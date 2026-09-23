/**
 * Opções de geração de fichas.
 *
 * Fonte única de verdade: as mesmas listas alimentam os <select> do formulário
 * e a validação da rota POST /generate.
 */

const REGISTRATION_FILTERS = [
  { value: 'selected',               label: 'Apenas selecionadas (status 10)',            statusFilter: 'r.status = 10' },
  { value: 'selected_and_alternate', label: 'Selecionadas e suplentes (status 8 e 10)',   statusFilter: 'r.status IN (8, 10)' },
  { value: 'pending',                label: 'Pendentes de avaliação (status 1)',          statusFilter: 'r.status = 1' },
  { value: 'all',                    label: 'Todas enviadas (exceto rascunhos)',           statusFilter: 'r.status != 0' }
];

const DEFAULT_FILTER = 'selected';

const RESULT_STATUS_OPTIONS = [
  { value: 'published',   label: 'Publicado',     publishedRegistrations: true },
  { value: 'unpublished', label: 'Não publicado', publishedRegistrations: false },
  { value: 'all',         label: 'Todos',         publishedRegistrations: null }
];

const DEFAULT_RESULT_STATUS = 'published';

const ATTACHMENT_MODES = [
  { value: 'with_attachments', label: 'Ficha + anexos', selected: true,  includesAttachments: true },
  { value: 'sheet_only',       label: 'Somente ficha',  selected: false, includesAttachments: false }
];

const DEFAULT_ATTACHMENT_MODE = 'with_attachments';

function isValidFilterType(filterType) {
  return REGISTRATION_FILTERS.some(filter => filter.value === filterType);
}

function isValidResultStatus(resultStatus) {
  return RESULT_STATUS_OPTIONS.some(option => option.value === resultStatus);
}

function publishedRegistrationsFor(resultStatus) {
  const option = RESULT_STATUS_OPTIONS.find(option => option.value === resultStatus);
  return (option || RESULT_STATUS_OPTIONS[0]).publishedRegistrations;
}

function isValidAttachmentMode(attachmentMode) {
  return ATTACHMENT_MODES.some(mode => mode.value === attachmentMode);
}

/**
 * Cláusula SQL de status para o filtro escolhido. Desconhecido → padrão.
 */
function statusFilterFor(filterType) {
  const filter = REGISTRATION_FILTERS.find(f => f.value === filterType);
  return (filter || REGISTRATION_FILTERS[0]).statusFilter;
}

function includesAttachments(attachmentMode) {
  return attachmentMode === DEFAULT_ATTACHMENT_MODE;
}

module.exports = {
  REGISTRATION_FILTERS,
  RESULT_STATUS_OPTIONS,
  DEFAULT_RESULT_STATUS,
  isValidResultStatus,
  publishedRegistrationsFor,
  ATTACHMENT_MODES,
  DEFAULT_FILTER,
  DEFAULT_ATTACHMENT_MODE,
  isValidFilterType,
  isValidAttachmentMode,
  statusFilterFor,
  includesAttachments
};

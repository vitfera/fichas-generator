/**
 * Formatação dos valores de campo vindos do MapasCulturais
 * (registration_meta.value + registration_field_configuration.field_type).
 *
 * Domínio puro: sem acesso a banco.
 */

const PEOPLE_FIELD_LABELS = {
  name: 'Nome',
  fullName: 'Nome completo',
  socialName: 'Nome social',
  cpf: 'CPF',
  cnpj: 'CNPJ',
  miniCurriculum: 'Mini currículo',
  income: 'Renda',
  education: 'Escolaridade',
  telephone: 'Telefone do representante',
  email: 'Email do representante',
  race: 'Raça/Cor',
  gender: 'Gênero',
  sexualOrientation: 'Orientação sexual',
  deficiencies: 'Informações sobre deficiências',
  comunty: 'Pertencimento a povos ou comunidades tradicionais',
  community: 'Pertencimento a povos ou comunidades tradicionais',
  area: 'Áreas de atuação',
  funcao: 'Funções/Profissões',
  function: 'Função',
  relationship: 'Parentesco'
};

function isBlankValue(value) {
  if (value == null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0 || value.every(isBlankValue);
  if (typeof value === 'object') {
    const entries = Object.entries(value).filter(([key]) => key !== '$$hashKey');
    return entries.length === 0 || entries.every(([, entryValue]) => isBlankValue(entryValue) || entryValue === false);
  }
  return value === false;
}

function formatNestedValue(value) {
  if (isBlankValue(value)) return '';
  if (Array.isArray(value)) {
    return value
      .map(formatNestedValue)
      .filter(Boolean)
      .join(', ');
  }
  if (typeof value === 'object') {
    const truthyKeys = Object.entries(value)
      .filter(([key, entryValue]) => key !== '$$hashKey' && entryValue === true)
      .map(([key]) => key);
    if (truthyKeys.length) return truthyKeys.join(', ');

    return Object.entries(value)
      .filter(([key, entryValue]) => key !== '$$hashKey' && !isBlankValue(entryValue))
      .map(([key, entryValue]) => `${key}: ${formatNestedValue(entryValue)}`)
      .join('; ');
  }
  return String(value).trim();
}

function formatPeopleList(people) {
  if (!Array.isArray(people)) return '';

  return people
    .map(person => {
      if (!person || typeof person !== 'object' || Array.isArray(person)) {
        return formatNestedValue(person);
      }

      const parts = [];
      for (const [key, value] of Object.entries(person)) {
        if (key === '$$hashKey' || isBlankValue(value)) continue;
        const label = PEOPLE_FIELD_LABELS[key] || key;
        const formattedValue = formatNestedValue(value);
        if (formattedValue) parts.push(`${label}: ${formattedValue}`);
      }
      return parts.join('; ');
    })
    .filter(Boolean)
    .join('<br/><br/>');
}

function formatValue(raw, fieldType = null) {
  if (raw == null) return '';

  // String "YYYY-MM-DD"
  if (typeof raw === 'string') {
    const isoDateMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (isoDateMatch) {
      const [, year, month, day] = isoDateMatch;
      return `${day}/${month}/${year}`;
    }
  }
  // String "YYYY-MM-DDTHH:MM:SSZ"
  const isoDateTimeMatch = typeof raw === 'string'
    ? raw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2}:\d{2})/)
    : null;
  if (isoDateTimeMatch) {
    const [, year, month, day, time] = isoDateTimeMatch;
    return `${day}/${month}/${year} ${time}`;
  }
  // Tenta JSON.parse(raw)
  let parsed;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
  } else if (Array.isArray(raw) || (raw && typeof raw === 'object')) {
    parsed = raw;
  }
  if (fieldType === 'persons' && Array.isArray(parsed)) {
    return formatPeopleList(parsed);
  }
  if (Array.isArray(parsed)) {
    // Array de strings/números
    if (parsed.every(x => typeof x === 'string' || typeof x === 'number')) {
      return parsed.map(x => String(x)).join('<br/>');
    }
    // Array de objetos: "chave: valor; ..."
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
  // Senão, converte para string simples
  return String(raw);
}

/**
 * Normaliza o nome do agente para uso em nome de arquivo.
 */
function slugifyAgentName(name) {
  return (name || 'sem-nome')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9\-]/g, '');
}

module.exports = {
  PEOPLE_FIELD_LABELS,
  isBlankValue,
  formatNestedValue,
  formatPeopleList,
  formatValue,
  slugifyAgentName
};

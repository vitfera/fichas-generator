/**
 * Escolhe as inscrições que originam fichas, priorizando a fase principal.
 * As demais inscrições continuam disponíveis para compor os dados das fases.
 */
function selectRegistrationsForGeneration(registrationsByPhase, parentId, children) {
  for (const phaseId of [parentId, ...children.map(child => child.id)]) {
    const registrations = (registrationsByPhase[phaseId] || [])
      .filter(registration => registration.matches_filter);
    if (registrations.length) {
      return { chosenPhaseId: phaseId, registrations };
    }
  }

  return { chosenPhaseId: null, registrations: [] };
}

module.exports = { selectRegistrationsForGeneration };

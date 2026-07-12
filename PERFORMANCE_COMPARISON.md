# Performance Do Gerador Consolidado

O projeto foi consolidado para manter um unico gerador: `generate_sheets.js`.

As antigas variantes foram removidas para evitar divergencia de comportamento. O arquivo principal concentra as otimizacoes e correcoes funcionais mais recentes.

## Otimizacoes Atuais

### Consultas Em Lote

- `fetchRegistrationsForPhases()` busca inscricoes de multiplas fases em uma chamada.
- `fetchParentRegistrationIds()` resolve inscricoes pai em lote.
- `fetchOrderedMetaForRegistrations()` carrega metadados para varias inscricoes/fases.
- `getEvaluationsForRegistrations()` busca avaliacoes em lote.
- `fetchFilesForRegistrations()` busca anexos em lote.

### Pre-Carregamento

Os dados necessarios sao carregados antes do loop principal de geracao, reduzindo consultas repetidas ao banco.

### Processamento Paralelo

Metadados, avaliacoes, anexos e fases sao processados com `Promise.all()` onde isso reduz espera sem mudar o resultado final.

### Cache Local De Secoes

Secoes e criterios tecnicos sao mantidos em memoria durante o processo para evitar consultas repetidas por fase.

## Funcionalidades Mantidas

- Filtro de inscricoes por status.
- Multiplas avaliacoes por inscricao/fase.
- Anexos PDF mesclados ao arquivo final.
- Logo configuravel por `LOGO_PATH`.
- ZIP final com todas as fichas geradas.

## Como Medir

Rode a aplicacao dentro do container e acompanhe os logs:

```bash
docker compose up --build
```

Durante a geracao, o servidor registra etapas como carregamento em lote, processamento por inscricao e geracao do ZIP.

Para validar integridade basica:

```bash
docker compose run --rm fichas-generator npm test
docker compose run --rm fichas-generator node --check generate_sheets.js
```

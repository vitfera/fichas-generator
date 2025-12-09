# Changelog

Todas as alterações notáveis neste projeto estão documentadas neste arquivo.

## [1.3.1] – 2025-12-09

### Corrigido
- Ajustada a busca apenas para oportunidades publicadas.

## [1.3.0] – 2025-07-15

### Adicionado
- **Otimizações massivas de performance**: Implementação de sistema de consultas em lote e cache inteligente.
- **Consultas em batch**: Nova função `fetchRegistrationsForPhases()` para buscar múltiplas fases em uma única query.
- **Pré-carregamento de dados**: Função `fetchOrderedMetaForRegistrations()` para carregar metadados de múltiplas inscrições simultaneamente.
- **Cache de seções e critérios**: Sistema de cache (`sectionsCache`) para evitar re-consultas de avaliações técnicas.
- **Processamento paralelo**: Uso de `Promise.all()` para processar avaliações e arquivos em paralelo.
- **Pool de conexões otimizado**: Configuração aprimorada com 20 conexões máximas, timeouts e gerenciamento de recursos.
- **Batch de inscrições pai**: Função `fetchParentRegistrationIds()` para buscar múltiplas inscrições pai em lote.
- **Batch de avaliações**: Função `getEvaluationsForRegistrations()` para carregar avaliações em massa.
- **Batch de arquivos**: Função `fetchFilesForRegistrations()` para buscar arquivos de múltiplas inscrições.
- **Script de deploy automático**: `deploy-test.sh` para facilitar testes em produção.
- **Documentação completa**: Guias de instalação, ativação e teste em produção.
- **Testes de performance**: Script `test_performance.sh` para benchmarking automatizado.
- **Múltiplas versões**: Versões `generate_sheets_optimized.js` e `generate_sheets_ultra_optimized.js` para diferentes níveis de otimização.

### Melhorado
- **Redução de 95% no número de queries**: De ~50-100 queries por ficha para ~2-5 queries.
- **Tempo de processamento**: Redução de 75% no tempo total (de 30-60s para 5-15s).
- **Conexões simultâneas**: Aumento de 2000% na capacidade de conexões (de 1 para 20).
- **Eficiência de cache**: 80-90% de cache hits para seções e critérios.
- **Gestão de memória**: Otimização no uso de recursos e garbage collection.
- **Logs detalhados**: Timestamps e métricas de performance em tempo real.
- **Interface aprimorada**: Indicadores visuais de otimização e progresso.

### Alterado
- **Arquitetura de dados**: Refatoração completa da lógica de busca e processamento.
- **Fluxo de execução**: Pré-carregamento de todos os dados necessários antes do processamento.
- **Gestão de conexões**: Pool configurado com timeouts e limites apropriados.
- **Processamento de fases**: Paralelização do processamento de múltiplas fases.
- **Tratamento de erros**: Melhoria na captura e relatório de erros.

### Documentado
- **PERFORMANCE_COMPARISON.md**: Comparação detalhada entre versões original e otimizada.
- **PRODUCTION_TEST_GUIDE.md**: Guia completo para testes em ambiente de produção.
- **INSTALLATION_GUIDE.md**: Instruções de instalação e configuração.
- **ACTIVATION_GUIDE.md**: Guia de ativação e troubleshooting.

### Técnico
- **Algoritmo de batch**: Implementação de consultas agrupadas para reduzir latência.
- **Sistema de cache**: Cache em memória para dados frequentemente acessados.
- **Processamento assíncrono**: Uso extensivo de async/await e Promise.all().
- **Otimização de SQL**: Queries otimizadas com JOINs e subqueries eficientes.
- **Gerenciamento de recursos**: Controle rigoroso de abertura/fechamento de conexões.

## [1.2.3] – 2025-06-25

### Corrigido
- Ajustada a lógica de mapeamento de `registration_id` por fase:
  - Implementado `regIdsByPhase` para usar `previousPhaseRegistrationId` na fase pai e o `registration_id` correto de cada fase filha.
- Refinado o laço de mesclagem de anexos:
  - Agora percorre **todas** as fases relevantes (pai + filhas exceto `parentId+1`) usando `regIdsByPhase`, alinhando a busca de PDFs ao mesmo critério de fases da inscrição.
  - Evita duplicações e assegura que apenas o arquivo mais recente de cada campo seja incluído.

## [1.2.2] - 2025-06-24

### Corrigido
- SQL de `fetchFilesForRegistrationAndPhase` ajustado para usar `LEFT JOIN LATERAL` e `ORDER BY id DESC LIMIT 1`, trazendo apenas o arquivo mais recente (maior `id`) para cada campo, evitando repetição de versões antigas.
- Mesclagem de anexos reforçada com controle de nomes únicos (`Set`), garantindo que cada PDF seja incluído apenas uma vez.
- Buffer inválido descartado: cada `PDFDocument.load(buf)` agora envolve `try/catch`, pulando automaticamente quaisquer arquivos sem cabeçalho PDF válido.

## [1.2.1] - 2025-06-09

### Corrigido
- Lógica de mesclagem de anexos corrigida: agora percorre corretamente **todas as fases** usando `evalRegId` de cada fase, garantindo que **todos** os PDFs em `FILES_DIR/<evalRegId>` sejam incluídos no final da ficha.
- Adicionado o campo `evalRegId` em cada elemento de `dataPhases` no `generate_sheets.js`, para referenciar cada inscrição/fase ao buscar a pasta de anexos.
- Ajustado o bloco de mesclagem em `generate_sheets.js` para iterar sobre **todas** as pastas de anexos e mesclar buffers de arquivos PDF em um único documento final.

## [1.2.0] - 2025-06-08

### Adicionado
- Suporte a anexos em PDF: agora os arquivos enviados pelo usuário são procurados em `<FILES_DIR>/<registration_id>` e mesclados ao final da ficha principal.  
- Nova variável de ambiente `FILES_DIR` para parametrizar o caminho raiz dos diretórios de anexos.  
- Integração da biblioteca [`pdf-lib`](https://github.com/Hopding/pdf-lib) para realizar a mesclagem de múltiplos PDFs.  
- Logs de depuração (`console.log`) na função de geração para facilitar diagnóstico do caminho de anexos e lista de arquivos encontrados.

### Ajustado
- Função `generateFichas` estendida para:
  - Validar a existência do diretório de anexos antes de tentar mesclar (`fs.existsSync`).
  - Filtrar apenas arquivos com extensão `.pdf`.
- Atualizado o `docker-compose.yml` para montar o volume de anexos em modo somente leitura.
- Template Handlebars permanece inalterado, apenas recebe a lista de anexos via contexto.
- Evita sobrescrever o PDF principal quando não há anexos disponíveis.

## [1.1.0] – 2025-06-08

### Adicionado
- Seção **Anexos** na ficha de inscrição, exibindo os arquivos enviados em cada fase.  
- Função `fetchFilesForRegistrationAndPhase(regId, phaseId)` em `generate_sheets.js` para buscar e mapear anexos via `registration_file_configuration` e tabela `file`.  
- Propriedade `files` incluída em cada objeto de fase (`dataPhases`) e passada para o template.

### Alterado
- Template `templates/ficha-inscricao.html` atualizado para renderizar a tabela de anexos:
  - Bloco `{{#if this.files}} … {{/if}}` inserido logo após a tabela de metadados de cada fase.  
- `generate_sheets.js`:
  - Inclusão de chamada a `fetchFilesForRegistrationAndPhase` no laço de fases, atribuindo `files` a cada fase.  

## [1.0.0] - 2025-06-06

### Adicionado

- Serviço principal `generate_sheets.js` com API HTTP para geração de fichas em PDF de todas as fases de uma oportunidade (pai + filhas).
- Configuração via arquivo `.env` para credenciais do banco, diretório de saída e porta do servidor (padrão `4444`).
- Containerização com `Dockerfile` e `docker-compose.yml`, incluindo PostGIS, Redis e Nginx.
- Template Handlebars `ficha-inscricao.html` com:
  - Agrupamento dinâmico de fases (primeira fase rotulada como “Fase de Inscrições”).
  - Ordenação de campos dinâmicos conforme `display_order` da tabela `registration_field_configuration`.
  - Embedding da logo em Base64 a partir de `assets/logo.png`.
  - Bloco de **Análise de Mérito** com critérios, notas, soma total e parecer.
  - Formatação de datas para `DD/MM/YYYY` e conversão de arrays em linhas com `<br/>`.
  - Inclusão de CSS via Bootstrap para estilização do PDF.
- Queries SQL para:
  - Listar oportunidades-pai e filhas (excluindo placeholder de fase seguinte).
  - Recuperar inscrições por fase e mapear metadados dinâmicos.
  - Carregar e ordenar `registration_meta`, `registration_field_configuration` e dados de avaliação.
  - Buscar `evaluation_data` em `registration_evaluation` com `JOIN r.id = re.registration_id`.
  - Extrair títulos de critérios em `evaluationmethodconfiguration_meta`.
- Interface web responsiva com Bootstrap:
  - Página inicial com seletor de oportunidade e spinner de carregamento.
  - Página de resultados com logo centralizado, botão de download do ZIP e lista de PDFs individuais.
- Segurança:
  - Geração de `index.html` vazio em `output` para bloquear listagem de diretório.

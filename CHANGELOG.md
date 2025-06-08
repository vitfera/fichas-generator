# Changelog

Todas as alterações notáveis neste projeto estão documentadas neste arquivo.

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

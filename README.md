# Gerador de Fichas de Inscrição - MAPAS Culturais

Aplicacao Node.js para gerar fichas de inscricao em PDF a partir de dados do MAPAS Culturais. O servico consulta o PostgreSQL, compila o template Handlebars em `templates/ficha-inscricao.html`, gera PDFs com Puppeteer e disponibiliza os arquivos individuais e um ZIP para download.

O projeto agora tem um unico ponto de entrada: `generate_sheets.js`.

## Funcionalidades

- Geracao de fichas para uma oportunidade principal e suas fases relacionadas.
- Inclusao de fases de recurso logo apos a fase avaliada, quando configuradas no MapasCulturais.
- Filtro de publicacao do resultado: publicado (padrao), nao publicado ou todos.
- Filtro de inscricoes: selecionadas, selecionadas + suplentes, pendentes de avaliacao ou todas enviadas (exceto rascunhos).
- Pre-carregamento em lote de inscricoes, metadados, avaliacoes e arquivos.
- Suporte a multiplas avaliacoes por inscricao/fase.
- Inclusao opcional de anexos em PDF ao final da ficha gerada, com `Ficha + anexos` como padrao.
- Logo configuravel por variavel de ambiente com fallback para `assets/logo.png`.
- Download de PDFs individuais e ZIP consolidado.

## Requisitos

- Docker e Docker Compose para execucao containerizada.
- PostgreSQL do MAPAS Culturais acessivel pela aplicacao.
- Pasta de arquivos privados das inscricoes, quando houver anexos.
- Node.js 18+ para execucao local.
- Chromium disponivel no ambiente local, caso rode sem Docker.

## Configuracao

Copie `.env.example` para `.env` e ajuste:

```env
DB_HOST=seu_host
DB_PORT=5432
DB_USER=seu_usuario
DB_PASSWORD=sua_senha
DB_NAME=seu_banco

OUTPUT_DIR=./output
SERVER_PORT=4444
LOGO_PATH=assets/logo.png

FILES_DIR=/srv/mapas/docker-data/private-files/registration
CHROMIUM_PATH=/usr/bin/chromium
```

`FILES_DIR` deve apontar para o caminho absoluto da pasta de inscricoes no
servidor, contendo as subpastas `<registration_id>/*.pdf`. Cada instalacao pode
usar um caminho diferente. O Docker Compose monta essa origem automaticamente,
como somente leitura, em `/data/registration` e configura esse caminho interno
para a aplicacao. Quando `FILES_DIR` nao e informado, a origem padrao continua
sendo `/srv/mapas/docker-data/private-files/registration`.

Na execucao local, a aplicacao le diretamente o caminho definido em `FILES_DIR`.

`CHROMIUM_PATH` e opcional e aponta para o executavel do Chromium usado na
geracao dos PDFs. Quando nao informado, o sistema usa `/usr/bin/chromium`.

`LOGO_PATH` e opcional. Quando nao informado, o sistema usa `assets/logo.png`. O caminho pode ser absoluto ou relativo a raiz do projeto.

## Execucao Com Docker

```bash
docker compose up --build
```

Acesse:

```text
http://localhost:4444
```

## Execucao Local

```bash
npm install
npm run generate
```

## Fichas Para Avaliacao

1. Em **Status do resultado**, escolha **Nao publicado** para listar oportunidades cujo resultado ainda nao foi publicado. A lista atualiza ao trocar a opcao; o botao **Filtrar** tambem permite aplicar o filtro.
2. Escolha a oportunidade principal (por exemplo, a oportunidade 34).
3. Em **Filtrar inscricoes**, selecione **Pendentes de avaliacao (status 1)**.
4. Escolha **Ficha + anexos** ou **Somente ficha** e clique em **Gerar Fichas**.

Inscricoes pendentes podem ser exportadas sem avaliacoes cadastradas. Rascunhos
(status 0) ficam fora desse filtro. A tela inicia com resultados publicados e
inscricoes selecionadas, como padrao.

## Testes

Os testes devem ser executados dentro do container:

```bash
docker compose run --rm fichas-generator npm test
```

Para checar sintaxe do servidor principal:

```bash
docker compose run --rm fichas-generator node --check generate_sheets.js
```

## Estrutura

```text
fichas-generator/
├── generate_sheets.js              # acesso ao banco, orquestracao da geracao e bootstrap
├── generated_files.js              # listagem dos arquivos ja gerados
├── logo_loader.js                  # carregamento da logo configuravel
├── src/
│   ├── domain/                     # regras puras, sem banco e sem HTML
│   │   ├── format.js               # formatacao dos valores de campo do MapasCulturais
│   │   ├── status.js               # rotulos de status de inscricao e de recurso
│   │   ├── evaluation.js           # leitura das avaliacoes tecnicas e de recurso
│   │   ├── generation-options.js   # filtros e modos de anexo (formulario + validacao)
│   │   └── registration-selection.js # selecao de inscricoes por fase e filtro
│   ├── web/
│   │   ├── app.js                  # fabrica do app Express, com dependencias injetadas
│   │   ├── views.js                # compilacao dos templates das paginas
│   │   └── views/                  # HTML das paginas (layout, index, result, partials)
│   └── pdf/
│       └── ficha-renderer.js       # template da ficha + conversao HTML -> PDF
├── templates/
│   └── ficha-inscricao.html        # template HTML das fichas
├── assets/
│   ├── css/bootstrap.min.css
│   ├── css/app.css                 # estilos das paginas do gerador
│   ├── js/bootstrap.bundle.min.js
│   ├── js/index-page.js            # comportamento do formulario
│   ├── logo.png
│   └── logo_editais_goias.png
├── test/
│   ├── domain_format.test.js
│   ├── domain_evaluation.test.js
│   ├── domain_generation_options.test.js
│   ├── ficha_template.test.js
│   ├── web_app.test.js
│   ├── generated_files.test.js
│   ├── logo_loader.test.js
│   └── project_consolidation.test.js
└── output/                         # PDFs e ZIPs gerados
```

Nenhum HTML fica embutido em codigo JavaScript: as paginas do gerador vivem em
`src/web/views/*.hbs` e a ficha em `templates/ficha-inscricao.html`. O escape e
responsabilidade do Handlebars, nao das rotas.

## Rotas

- `GET /?resultStatus=published|unpublished|all` - formulario de geracao com filtro de publicacao do resultado; o padrao e `published`.
- `GET /generated-files?parent=<id>` - lista PDFs e ZIPs ja gerados para a oportunidade.
- `POST /generate` - gera fichas para a oportunidade selecionada, podendo incluir anexos ou gerar somente a ficha.
- `GET /downloads/<arquivo>` - baixa PDFs e ZIPs gerados.
- `GET /assets/<arquivo>` - serve arquivos estaticos.

## Troubleshooting

### Erro de conexao com banco

Verifique as variaveis `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD` e `DB_NAME` no `.env`.

### Anexos nao aparecem

Confirme se `FILES_DIR` no `.env` aponta para a pasta de inscricoes existente no
servidor. Depois de alterar essa configuracao ou atualizar o volume do Compose,
recrie o container para aplicar a montagem:

```bash
docker compose up -d --force-recreate fichas-generator
```

Os PDFs gerados antes da correcao precisam ser gerados novamente com **Ficha + anexos**.

### Logo nao aparece

Confirme se `LOGO_PATH` aponta para um arquivo acessivel dentro do ambiente onde a aplicacao esta rodando. Em Docker, caminhos relativos devem existir dentro de `/usr/src/app`.

## Desenvolvimento

- Mantenha `generate_sheets.js` como unico ponto de entrada.
- Nao crie variantes paralelas do gerador; consolide melhorias no arquivo principal.
- Atualize os testes quando mudar configuracao, entrada ou comportamento.
- Rode verificacoes dentro do container antes de commitar.

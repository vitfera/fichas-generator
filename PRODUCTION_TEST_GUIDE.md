# Guia De Teste Em Producao

Este guia valida a aplicacao consolidada `generate_sheets.js`.

## Pre-Requisitos

- Docker e Docker Compose instalados.
- Porta `4444` disponivel.
- `.env` configurado com acesso ao PostgreSQL.
- Volume de `OUTPUT_DIR` persistente.
- `FILES_DIR` montado se a geracao precisar anexar arquivos.

## Deploy Manual

```bash
docker compose up --build -d
docker compose logs -f
```

Verifique a pagina inicial:

```bash
curl http://localhost:4444
```

## Testes Automatizados

Todos os comandos de verificacao devem rodar dentro do container:

```bash
docker compose run --rm fichas-generator npm test
docker compose run --rm fichas-generator node --check generate_sheets.js
```

## Teste Funcional

1. Acesse `http://localhost:4444`.
2. Selecione uma oportunidade principal.
3. Escolha o filtro de inscricoes.
4. Gere as fichas.
5. Baixe o ZIP.
6. Abra alguns PDFs e confirme dados, avaliacoes, anexos e logo.

## Monitoramento

```bash
docker compose logs -f fichas-generator
docker compose ps
docker stats fichas-generator
```

Observe:

- tempo de carregamento em lote;
- quantidade de inscricoes processadas;
- erros de leitura de anexos;
- erros do Puppeteer ou Chromium;
- tamanho final do ZIP.

## Troubleshooting

### Container Nao Inicia

```bash
docker compose logs
docker compose down
docker compose up --build
```

### Erro De Banco

Confira `.env` e teste conectividade a partir do container:

```bash
docker compose exec fichas-generator node -e "const { Pool } = require('pg'); const pool = new Pool(); pool.connect().then(() => { console.log('Conectado'); return pool.end(); }).catch(err => { console.error(err); process.exit(1); });"
```

### Anexos Nao Encontrados

Confira `FILES_DIR` e o volume no `docker-compose.yml`:

```bash
docker compose exec fichas-generator ls -la "$FILES_DIR"
```

### Logo Incorreta

Confirme `LOGO_PATH` no `.env` e se o arquivo existe dentro do container:

```bash
docker compose exec fichas-generator ls -la "$LOGO_PATH"
```

## Rollback

Use o fluxo normal do Git para voltar ao commit anterior e suba o container novamente:

```bash
git log --oneline
git revert <commit>
docker compose up --build -d
```

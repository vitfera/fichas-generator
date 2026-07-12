# Guia de Instalacao

Este projeto usa uma unica aplicacao Node.js: `generate_sheets.js`.

## Docker

1. Crie o arquivo `.env` a partir do exemplo:

   ```bash
   cp .env.example .env
   ```

2. Ajuste banco, diretorio de saida, diretorio de anexos e logo:

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
   ```

3. Suba o servico:

   ```bash
   docker compose up --build
   ```

4. Acesse `http://localhost:4444`.

## Local

Use a execucao local apenas para desenvolvimento:

```bash
npm install
npm run generate
```

O ambiente local precisa ter Chromium instalado e acessivel em `/usr/bin/chromium`.

## Arquivos De Inscricao

Para anexos funcionarem, `FILES_DIR` deve apontar para o diretorio onde o MAPAS armazena arquivos privados de inscricao. Em Docker, monte esse diretorio no container no mesmo caminho configurado.

## Verificacao

Rode testes dentro do container:

```bash
docker compose run --rm fichas-generator npm test
docker compose run --rm fichas-generator node --check generate_sheets.js
```

## Producao

- Configure `OUTPUT_DIR` em volume persistente.
- Monte `FILES_DIR` como somente leitura quando possivel.
- Monitore CPU, memoria, disco e logs do PostgreSQL durante geracoes grandes.
- Ajuste PostgreSQL conforme volume real de inscricoes.

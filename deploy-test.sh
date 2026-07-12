#!/bin/bash

# Script para testar o deploy da aplicacao consolidada.
# Uso: ./deploy-test.sh

set -e

echo "Iniciando deploy de teste do gerador de fichas..."

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

CURRENT_BRANCH=$(git branch --show-current)
log_info "Branch atual: $CURRENT_BRANCH"

if ! git diff --quiet; then
    log_error "Existem mudancas nao commitadas. Faca commit antes do deploy."
    exit 1
fi

if [ ! -f ".env" ]; then
    log_error "Arquivo .env nao encontrado"
    exit 1
fi

REQUIRED_FILES=(
    "generate_sheets.js"
    "docker-compose.yml"
    "Dockerfile"
    "package.json"
    "templates/ficha-inscricao.html"
    "assets/css/bootstrap.min.css"
    "assets/js/bootstrap.bundle.min.js"
)

for file in "${REQUIRED_FILES[@]}"; do
    if [ ! -f "$file" ]; then
        log_error "Arquivo obrigatorio nao encontrado: $file"
        exit 1
    fi
done

log_info "Arquivos obrigatorios encontrados"

log_info "Parando containers existentes..."
docker compose down --remove-orphans || true

log_info "Construindo e iniciando containers..."
docker compose up --build -d

log_info "Aguardando container responder..."
for i in {1..30}; do
    if curl -s http://localhost:4444 > /dev/null; then
        log_info "Aplicacao respondendo na porta 4444"
        break
    fi
    if [ "$i" -eq 30 ]; then
        log_error "Aplicacao nao respondeu apos 30 tentativas"
        docker compose logs
        exit 1
    fi
    sleep 2
done

log_info "Verificando logs recentes..."
docker compose logs --tail=20

HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:4444)
if [ "$HTTP_STATUS" -eq 200 ]; then
    log_info "Endpoint principal funcionando"
else
    log_error "Endpoint principal retornou status $HTTP_STATUS"
    exit 1
fi

log_info "Deploy de teste concluido"
echo ""
echo "Branch: $CURRENT_BRANCH"
echo "Commit: $(git rev-parse --short HEAD)"
echo "URL: http://localhost:4444"
echo ""
echo "Comandos uteis:"
echo "  docker compose logs -f"
echo "  docker compose down"
echo "  docker compose restart"

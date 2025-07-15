#!/bin/bash

# Script para testar o deploy da aplicação otimizada no ambiente de produção
# Uso: ./deploy-test.sh

set -e

echo "🚀 Iniciando deploy de teste da versão otimizada..."

# Cores para output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Função para log colorido
log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Verificar se está na branch correta
CURRENT_BRANCH=$(git branch --show-current)
if [ "$CURRENT_BRANCH" != "performance-optimization-test" ]; then
    log_error "Você deve estar na branch 'performance-optimization-test' para fazer o deploy"
    exit 1
fi

log_info "Branch atual: $CURRENT_BRANCH ✓"

# Verificar se existem mudanças não commitadas
if ! git diff --quiet; then
    log_error "Existem mudanças não commitadas. Faça commit primeiro."
    exit 1
fi

log_info "Repositório limpo ✓"

# Verificar se o .env existe
if [ ! -f ".env" ]; then
    log_error "Arquivo .env não encontrado"
    exit 1
fi

log_info "Arquivo .env encontrado ✓"

# Verificar se os arquivos necessários existem
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
        log_error "Arquivo obrigatório não encontrado: $file"
        exit 1
    fi
done

log_info "Todos os arquivos obrigatórios encontrados ✓"

# Parar containers existentes
log_info "Parando containers existentes..."
docker-compose down --remove-orphans || true

# Limpar imagens antigas
log_info "Limpando imagens antigas..."
docker image prune -f || true

# Construir e iniciar os containers
log_info "Construindo e iniciando containers..."
docker-compose up --build -d

# Aguardar o container estar pronto
log_info "Aguardando container estar pronto..."
for i in {1..30}; do
    if curl -s http://localhost:4444 > /dev/null; then
        log_info "Container está respondendo na porta 4444 ✓"
        break
    fi
    if [ $i -eq 30 ]; then
        log_error "Container não respondeu após 30 tentativas"
        docker-compose logs
        exit 1
    fi
    sleep 2
done

# Verificar logs
log_info "Verificando logs do container..."
docker-compose logs --tail=20

# Teste básico de funcionamento
log_info "Testando endpoint básico..."
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:4444)
if [ "$HTTP_STATUS" -eq 200 ]; then
    log_info "Endpoint principal funcionando ✓"
else
    log_error "Endpoint principal retornou status $HTTP_STATUS"
    exit 1
fi

# Informações finais
log_info "Deploy de teste realizado com sucesso! 🎉"
echo ""
echo "📊 Informações do deploy:"
echo "   Branch: $CURRENT_BRANCH"
echo "   Commit: $(git rev-parse --short HEAD)"
echo "   URL: http://localhost:4444"
echo ""
echo "🔍 Comandos úteis:"
echo "   Ver logs: docker-compose logs -f"
echo "   Parar: docker-compose down"
echo "   Reiniciar: docker-compose restart"
echo ""
echo "📋 Para testar performance:"
echo "   ./test_performance.sh"
echo ""
echo "🌐 Acesse http://localhost:4444 para testar a aplicação"

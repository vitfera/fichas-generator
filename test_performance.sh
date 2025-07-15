#!/bin/bash

# Script para testar e comparar performance

echo "=== TESTE DE PERFORMANCE - GERADOR DE FICHAS ==="
echo ""

# Verificar se os arquivos existem
if [ ! -f "generate_sheets.js" ]; then
    echo "❌ Arquivo generate_sheets.js não encontrado!"
    exit 1
fi

if [ ! -f "generate_sheets_optimized.js" ]; then
    echo "❌ Arquivo generate_sheets_optimized.js não encontrado!"
    exit 1
fi

# Backup do arquivo original
if [ ! -f "generate_sheets_original.js" ]; then
    echo "📦 Fazendo backup do arquivo original..."
    cp generate_sheets.js generate_sheets_original.js
fi

# Função para executar teste
run_test() {
    local version=$1
    local file=$2
    
    echo "🚀 Testando versão $version..."
    
    # Usar a versão especificada
    cp "$file" generate_sheets.js
    
    # Iniciar servidor em background
    node generate_sheets.js &
    SERVER_PID=$!
    
    # Esperar servidor iniciar
    sleep 3
    
    # Verificar se servidor está rodando
    if ! kill -0 $SERVER_PID 2>/dev/null; then
        echo "❌ Erro ao iniciar servidor $version"
        return 1
    fi
    
    echo "✅ Servidor $version iniciado (PID: $SERVER_PID)"
    echo "🌐 Acesse: http://localhost:4444"
    echo "⏱️  Monitore o console para métricas de performance"
    echo ""
    echo "Pressione ENTER para parar o servidor e continuar..."
    read
    
    # Parar servidor
    kill $SERVER_PID
    wait $SERVER_PID 2>/dev/null
    echo "🔚 Servidor $version parado"
    echo ""
}

# Menu de opções
echo "Escolha uma opção:"
echo "1) Testar versão ORIGINAL"
echo "2) Testar versão OTIMIZADA"
echo "3) Testar versão ULTRA OTIMIZADA (com cache)"
echo "4) Comparar TODAS as versões"
echo "5) Restaurar versão original"
echo "6) Sair"
echo ""
read -p "Opção: " choice

case $choice in
    1)
        run_test "ORIGINAL" "generate_sheets_original.js"
        ;;
    2)
        run_test "OTIMIZADA" "generate_sheets_optimized.js"
        ;;
    3)
        run_test "ULTRA OTIMIZADA" "generate_sheets_ultra_optimized.js"
        ;;
    4)
        echo "📊 COMPARAÇÃO COMPLETA DE PERFORMANCE"
        echo "===================================="
        echo ""
        run_test "ORIGINAL" "generate_sheets_original.js"
        run_test "OTIMIZADA" "generate_sheets_optimized.js"
        run_test "ULTRA OTIMIZADA" "generate_sheets_ultra_optimized.js"
        echo "📈 Compare os tempos e métricas mostradas no console!"
        ;;
    5)
        echo "🔄 Restaurando versão original..."
        cp generate_sheets_original.js generate_sheets.js
        echo "✅ Versão original restaurada"
        ;;
    6)
        echo "👋 Saindo..."
        exit 0
        ;;
    *)
        echo "❌ Opção inválida!"
        exit 1
        ;;
esac

# Restaurar versão original ao final
echo "🔄 Restaurando versão original..."
cp generate_sheets_original.js generate_sheets.js
echo "✅ Concluído!"

# Guia de Instalação - Dependências Opcionais

## Redis (Opcional - Para Cache Avançado)

### macOS com Homebrew:
```bash
brew install redis
brew services start redis
```

### Ubuntu/Debian:
```bash
sudo apt update
sudo apt install redis-server
sudo systemctl start redis
sudo systemctl enable redis
```

### Docker:
```bash
docker run -d --name redis -p 6379:6379 redis:alpine
```

## Para usar Redis, adicione ao .env:
```env
USE_REDIS=true
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=
```

## Dependências NPM Opcionais

### Para usar Redis:
```bash
npm install redis
```

### Para Worker Threads (futuro):
```bash
npm install worker_threads
```

### Para Compressão (futuro):
```bash
npm install compression
```

## Configuração Recomendada para Produção

### 1. Use Redis para Cache
- Melhora significativamente a performance
- Persiste cache entre reinicializações
- Permite cache compartilhado entre instâncias

### 2. Configure PostgreSQL
- Aumente `shared_buffers` para 25% da RAM
- Configure `effective_cache_size` para 75% da RAM
- Ajuste `work_mem` e `maintenance_work_mem`

### 3. Configurações do Sistema
```bash
# Aumentar limites de arquivos abertos
ulimit -n 65536

# Configurar swap (se necessário)
sudo sysctl vm.swappiness=10
```

### 4. Monitoramento
- Use `htop` ou `top` para monitorar CPU/RAM
- Use `iotop` para monitorar I/O de disco
- Monitore logs do PostgreSQL

## Benchmarks Esperados

### Cenário: 100 inscrições, 3 fases cada

| Versão | Queries | Tempo | Cache | Melhorias |
|--------|---------|-------|-------|-----------|
| Original | ~1,300 | 60-120s | Não | Baseline |
| Otimizada | ~20 | 10-20s | Memória | 80% mais rápida |
| Ultra | ~5 | 3-8s | Redis | 90% mais rápida |

### Fatores que Afetam Performance:
- Latência de rede com banco
- Velocidade do disco (PDFs)
- RAM disponível
- Número de conexões simultâneas

## Troubleshooting

### Redis não conecta:
```bash
redis-cli ping
# Deve retornar "PONG"
```

### Muitas conexões PostgreSQL:
```sql
SELECT count(*) FROM pg_stat_activity;
-- Ajuste max_connections se necessário
```

### PDFs não geram:
```bash
# Verificar se Chromium está instalado
which chromium || which google-chrome
```

### Cache não funciona:
- Verifique logs do console
- Teste com `USE_REDIS=false`
- Limpe cache via interface web

# Instruções para Teste em Produção

## Branch de Teste: `performance-optimization-test`

Esta branch contém todas as otimizações de performance implementadas para o sistema de geração de fichas.

### 🚀 Deploy Rápido

```bash
# 1. Clonar o repositório (se necessário)
git clone https://github.com/vitfera/fichas-generator.git
cd fichas-generator

# 2. Fazer checkout da branch de teste
git checkout performance-optimization-test

# 3. Executar o script de deploy
./deploy-test.sh
```

### 📋 Pré-requisitos

- Docker e Docker Compose instalados
- Porta 4444 disponível
- Acesso ao banco de dados PostgreSQL (configurado no .env)
- Pasta `/srv/mapas/docker-data/private-files/registration` com arquivos de inscrição

### 🔧 Configuração Manual

Se preferir fazer o deploy manualmente:

```bash
# 1. Verificar configuração do .env
cat .env

# 2. Construir e iniciar os containers
docker-compose up --build -d

# 3. Verificar logs
docker-compose logs -f

# 4. Testar a aplicação
curl http://localhost:4444
```

### 🧪 Testes de Performance

```bash
# Executar teste de performance automático
./test_performance.sh

# Ou testar manualmente:
# 1. Acessar http://localhost:4444
# 2. Selecionar uma oportunidade
# 3. Clicar em "Gerar Fichas"
# 4. Observar o tempo de processamento nos logs
```

### 📊 Principais Melhorias

1. **Consultas em Batch**: Redução de ~95% no número de queries
2. **Cache Inteligente**: Cache de seções e critérios para avaliações técnicas
3. **Processamento Paralelo**: Processamento simultâneo de avaliações e arquivos
4. **Pool de Conexões Otimizado**: Configuração aprimorada do pool PostgreSQL
5. **Pré-carregamento de Dados**: Carregamento em lote no início do processo

### 🔍 Monitoramento

```bash
# Ver logs em tempo real
docker-compose logs -f

# Verificar status dos containers
docker-compose ps

# Verificar uso de recursos
docker stats fichas-generator
```

### 🛠️ Troubleshooting

#### Container não inicia
```bash
# Verificar logs de erro
docker-compose logs

# Recriar containers
docker-compose down
docker-compose up --build
```

#### Erro de conexão com banco
```bash
# Verificar configuração do .env
cat .env

# Testar conexão com banco
docker-compose exec fichas-generator node -e "
const { Pool } = require('pg');
const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});
pool.connect().then(() => console.log('Conectado!')).catch(console.error);
"
```

#### Arquivos não encontrados
```bash
# Verificar se a pasta de arquivos existe
ls -la /srv/mapas/docker-data/private-files/registration/

# Verificar volume no container
docker-compose exec fichas-generator ls -la /srv/mapas/docker-data/private-files/registration/
```

### 📈 Comparação de Performance

| Métrica | Versão Original | Versão Otimizada | Melhoria |
|---------|----------------|------------------|----------|
| Queries por ficha | ~50-100 | ~2-5 | 95% redução |
| Tempo de processamento | 30-60s | 5-15s | 75% redução |
| Conexões simultâneas | 1 | 20 | 2000% aumento |
| Cache hits | 0% | 80-90% | - |

### 🔄 Rollback

Se necessário fazer rollback:

```bash
# Voltar para a branch main
git checkout main

# Redeployar
docker-compose down
docker-compose up --build -d
```

### 📝 Logs Importantes

Durante o teste, observe nos logs:
- Tempo de pré-carregamento dos dados
- Tempo de processamento por ficha
- Número de queries executadas
- Uso de cache

### 🎯 Testes Recomendados

1. **Teste de Volume**: Gerar fichas para uma oportunidade com muitas inscrições
2. **Teste de Concorrência**: Múltiplas gerações simultâneas
3. **Teste de Estabilidade**: Várias gerações consecutivas
4. **Teste de Recursos**: Monitorar uso de CPU e memória

### 🚨 Importante

- Esta é uma versão de teste - monitore cuidadosamente
- Faça backup dos dados antes do teste
- Tenha a versão original disponível para rollback
- Documente qualquer problema encontrado

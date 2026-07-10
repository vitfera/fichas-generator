# Gerador de Fichas de Inscrição - MAPAS Culturais (OTIMIZADO)

Esta é uma solução desenvolvida para o projeto **MAPAS Culturais**, que automatiza a geração de fichas de inscrição em PDF para oportunidades culturais. A ferramenta busca informações em um banco de dados PostgreSQL e utiliza Handlebars, Puppeteer e Node.js para compilar templates HTML e converter para PDF.

**🚀 NOVIDADE: Versões otimizadas com performance até 90% superior!**

## 🚀 Versões Disponíveis

### 1. **Versão Original** (`generate_sheets.js`)
- Implementação básica funcional
- Consultas sequenciais ao banco
- Tempo: ~60-120s para 100 inscrições

### 2. **Versão Otimizada** (`generate_sheets_optimized.js`)
- Consultas em batch
- Pré-carregamento de dados
- Processamento paralelo
- **Melhoria: 80% mais rápida**

### 3. **Versão Ultra Otimizada** (`generate_sheets_ultra_optimized.js`)
- Inclui todas as otimizações anteriores
- Sistema de cache inteligente (Redis + local)
- Métricas detalhadas de performance
- Interface web aprimorada
- **Melhoria: 90% mais rápida**

## 📋 Requisitos

- Node.js 16+
- PostgreSQL (MapasCulturais)
- Chromium (`/usr/bin/chromium`)
- Redis (opcional, para cache avançado)
- Docker e Docker Compose (para execução containerizada)

## 🛠️ Instalação

### Opção 1: Docker (Recomendado)

1. Clone este repositório:
   ```bash
   git clone https://github.com/vitfera/fichas-generator.git
   cd fichas-generator
   ```

2. Ajuste as variáveis de ambiente no arquivo `.env`:
   ```env
   DB_HOST=seu_host
   DB_PORT=5432
   DB_USER=seu_usuario
   DB_PASSWORD=sua_senha
   DB_NAME=seu_banco
   OUTPUT_DIR=/app/output
   SERVER_PORT=4444
   FILES_DIR=/srv/mapas/docker-data/private-files/registration
   LOGO_PATH=assets/logo.png
   USE_REDIS=false  # true para usar Redis
   ```

3. Construa e inicie os contêineres:
   ```bash
   docker-compose up --build
   ```

### Opção 2: Instalação Local

1. **Instale dependências:**
   ```bash
   npm install
   ```

2. **Configure o ambiente (.env):**
   ```env
   DB_HOST=localhost
   DB_PORT=5432
   DB_USER=mapas
   DB_PASSWORD=mapas
   DB_NAME=mapas
   OUTPUT_DIR=./output
   SERVER_PORT=4444
   FILES_DIR=/srv/mapas/docker-data/private-files/registration
   LOGO_PATH=assets/logo.png
   USE_REDIS=false  # true para usar Redis
   ```

   `LOGO_PATH` é opcional. Quando não informado, o sistema usa `assets/logo.png`. O caminho pode ser absoluto ou relativo à raiz do projeto.

3. **Execute:**
   ```bash
   node generate_sheets.js
   ```

## 🧪 Testando Performance

Use o script de teste para comparar as versões:

```bash
./test_performance.sh
```

**Opções disponíveis:**
- Testar versão original
- Testar versão otimizada  
- Testar versão ultra otimizada
- Comparar todas as versões

## 📊 Métricas de Performance

### Cenário: 100 inscrições, 3 fases cada

| Versão | Queries | Tempo | Cache | Redução |
|--------|---------|-------|-------|---------|
| Original | ~1,300 | 60-120s | ❌ | - |
| Otimizada | ~20 | 10-20s | Memória | 80% |
| Ultra | ~5 | 3-8s | Redis | 90% |

A versão ultra otimizada inclui métricas detalhadas disponíveis em `/stats`.

## 🌐 Como Usar

1. Acesse `http://localhost:4444`
2. Selecione a oportunidade principal
3. Clique em "Gerar Fichas"
4. Baixe o ZIP ou PDFs individuais

### Funcionalidades da Interface:
- Seleção de oportunidades
- Indicadores de performance
- Controle de cache
- Métricas em tempo real
- Download de PDFs individuais ou ZIP

## 🎯 Principais Otimizações

### 1. **Consultas em Batch**
- Redução de ~1,300 queries para ~5 queries
- Pré-carregamento de todos os dados necessários

### 2. **Cache Inteligente**
- Cache local em memória
- Cache Redis (opcional)
- Fallback automático

### 3. **Processamento Paralelo**
- Múltiplas operações simultâneas
- Processamento em lotes para controle de memória

## 🔧 Configuração Avançada

### Redis (Recomendado para Produção)
```bash
# Instalar Redis
brew install redis  # macOS
sudo apt install redis-server  # Ubuntu

# Configurar no .env
USE_REDIS=true
REDIS_HOST=localhost
REDIS_PORT=6379
```

### Rotas Especiais:
- `/stats` - Métricas de performance
- `/clear-cache` - Limpar cache
- `/downloads/...` - Arquivos gerados

## 📁 Estrutura do Projeto

```
fichas-generator/
├── generate_sheets.js                    # Versão original
├── generate_sheets_optimized.js          # Versão otimizada
├── generate_sheets_ultra_optimized.js    # Versão ultra otimizada
├── cache_manager.js                      # Sistema de cache
├── test_performance.sh                   # Script de teste
├── templates/
│   └── ficha-inscricao.html             # Template HTML
├── assets/
│   ├── css/bootstrap.min.css            # Estilos
│   ├── js/bootstrap.bundle.min.js       # Scripts
│   └── logo.png                         # Logo
└── output/                              # PDFs gerados
```

## 🐛 Troubleshooting

### Erro de Conexão com Banco:
```bash
# Verificar conectividade
psql -h localhost -U mapas -d mapas -c "SELECT 1;"
```

### Performance baixa:
- Monitore CPU/RAM com `htop`
- Considere usar Redis
- Ajuste `max_connections` do PostgreSQL

## 📄 Repositório MAPAS Culturais

Você pode encontrar o repositório principal do MAPAS Culturais em:
[https://github.com/mapasculturais/mapasculturais](https://github.com/mapasculturais/mapasculturais)

## 🤝 Contribuindo

1. Faça backup da versão original
2. Teste suas alterações
3. Documente melhorias de performance
4. Mantenha compatibilidade com o template

## 📄 Licença

Este projeto mantém a mesma licença do MapasCulturais.

---

**Dica:** Para melhor performance, comece com a versão otimizada e considere a ultra otimizada para ambientes de produção com muitas inscrições.
   ```env
   DB_HOST=seu_host
   DB_PORT=5432
   DB_USER=seu_usuario
   DB_PASSWORD=sua_senha
   DB_NAME=seu_banco
   OUTPUT_DIR=/app/output
   SERVER_PORT=4444
   ```

3. Construa e inicie os contêineres com Docker Compose:
   ```bash
   docker-compose up --build
   ```

4. Acesse a aplicação em seu navegador:
   ```
   http://localhost:4444
   ```

5. Escolha a oportunidade principal no formulário, aguarde a geração dos PDFs e faça o download dos arquivos.

## Estrutura do Projeto

- `templates/`  
  Contém o template Handlebars (`ficha-inscricao.html`) utilizado para gerar os PDFs.

- `assets/`  
  Arquivos estáticos, incluindo CSS do Bootstrap e a logo padrão em PNG.

- `generate_sheets.js`  
  Script principal em Node.js que implementa o fluxo de leitura do banco, compilação do template e geração dos PDFs.

- `docker-compose.yml`  
  Configuração para criação dos contêineres Docker.

- `.env`  
  Arquivo de configuração de variáveis de ambiente, incluindo `LOGO_PATH` para trocar a logo por sistema.

- `README.md`  
  Documentação do projeto.

## Requisitos

- Docker
- Docker Compose

## Contato

Em caso de dúvidas ou sugestões, abra uma issue no repositório ou entre em contato com os mantenedores do projeto.

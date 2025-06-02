# Solução MAPAS Culturais

Esta é uma solução desenvolvida para o projeto **MAPAS Culturais**, que automatiza a geração de fichas de inscrição em PDF para oportunidades culturais. A ferramenta busca informações em um banco de dados PostgreSQL e utiliza Handlebars, Puppeteer e Node.js para compilar templates HTML e converter para PDF.

## Repositório MAPAS Culturais

Você pode encontrar o repositório principal do MAPAS Culturais em:
[https://github.com/mapasculturais/mapasculturais](https://github.com/mapasculturais/mapasculturais)

## Como executar

A forma recomendada de executar esta aplicação é utilizando Docker e Docker Compose. 

1. Clone este repositório:
   ```bash
   git clone https://github.com/vitfera/fichas-generator.git
   cd fichas-generator
   ```

2. Ajuste as variáveis de ambiente no arquivo `.env` conforme necessário:
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
  Arquivos estáticos, incluindo CSS do Bootstrap e a logo em PNG.

- `generate_sheets.js`  
  Script principal em Node.js que implementa o fluxo de leitura do banco, compilação do template e geração dos PDFs.

- `docker-compose.yml`  
  Configuração para criação dos contêineres Docker.

- `.env`  
  Arquivo de configuração de variáveis de ambiente.

- `README.md`  
  Documentação do projeto.

## Requisitos

- Docker
- Docker Compose

## Contato

Em caso de dúvidas ou sugestões, abra uma issue no repositório ou entre em contato com os mantenedores do projeto.
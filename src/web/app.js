/**
 * Fábrica do app Express.
 *
 * As rotas são finas: validam a entrada, chamam as dependências injetadas e
 * delegam todo o HTML para src/web/views.js. Nenhuma dependência de banco,
 * Puppeteer ou filesystem é resolvida aqui — tudo entra por parâmetro, o que
 * torna as rotas testáveis sem infraestrutura.
 */

const express = require('express');

const {
  REGISTRATION_FILTERS,
  ATTACHMENT_MODES,
  DEFAULT_FILTER,
  DEFAULT_ATTACHMENT_MODE,
  isValidFilterType,
  isValidAttachmentMode,
  includesAttachments
} = require('../domain/generation-options');

const {
  renderIndexPage,
  renderResultPage,
  renderGeneratedFilesList
} = require('./views');

function createApp({
  outputDir,
  assetsDir,
  logoBase64 = '',
  fetchParentOpportunities,
  fetchOpportunityById,
  generateFichas,
  listGeneratedFilesForOpportunity,
  listResultFilesForGeneration,
  logger = console
}) {
  const app = express();
  app.use(express.urlencoded({ extended: true }));

  // Estáticos: PDFs/ZIPs gerados e assets da interface
  app.use('/downloads', express.static(outputDir));
  app.use('/assets', express.static(assetsDir));

  app.get('/', async (req, res) => {
    let opportunities = [];
    try {
      opportunities = await fetchParentOpportunities();
    } catch (err) {
      logger.error('Erro ao buscar oportunidades-pai:', err);
    }

    res.send(renderIndexPage({
      opportunities,
      filterOptions: REGISTRATION_FILTERS,
      attachmentOptions: ATTACHMENT_MODES,
      logoBase64
    }));
  });

  app.get('/generated-files', (req, res) => {
    const parentId = parseInt(req.query.parent, 10);
    if (isNaN(parentId)) {
      return res.status(400).json({ error: 'Oportunidade inválida.' });
    }

    try {
      const files = listGeneratedFilesForOpportunity(outputDir, parentId);
      return res.json({ files, html: renderGeneratedFilesList(files) });
    } catch (err) {
      logger.error('Erro ao listar arquivos gerados:', err);
      return res.status(500).json({ error: 'Erro ao listar arquivos gerados.' });
    }
  });

  app.post('/generate', async (req, res) => {
    const parentId = parseInt(req.body.parent, 10);
    const filterType = req.body.filterType || DEFAULT_FILTER;
    const attachmentMode = req.body.attachmentMode || DEFAULT_ATTACHMENT_MODE;

    if (isNaN(parentId)) {
      return res.status(400).send('Oportunidade inválida.');
    }
    if (!isValidFilterType(filterType)) {
      return res.status(400).send('Tipo de filtro inválido.');
    }
    if (!isValidAttachmentMode(attachmentMode)) {
      return res.status(400).send('Tipo de geração inválido.');
    }

    let opportunity;
    let zipFilename;
    try {
      opportunity = await fetchOpportunityById(parentId);
      if (!opportunity) {
        return res.status(400).send('Oportunidade não encontrada.');
      }
      zipFilename = await generateFichas(parentId, filterType, includesAttachments(attachmentMode));
    } catch (err) {
      logger.error('Erro ao gerar fichas:', err);
      return res.status(500).send('Erro ao gerar fichas. Veja o log no servidor.');
    }

    res.send(renderResultPage({
      opportunity,
      zipUrl: `/downloads/${zipFilename}`,
      files: listResultFilesForGeneration(outputDir, parentId, zipFilename),
      logoBase64
    }));
  });

  return app;
}

module.exports = { createApp };

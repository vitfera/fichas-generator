/**
 * Renderização da ficha em PDF.
 *
 * Concentra tudo que é apresentação do PDF: o template Handlebars, o CSS
 * embutido, a logo e a conversão HTML → PDF via Puppeteer. A regra de negócio
 * apenas monta os dados e chama renderFichaPdf().
 */

const fs = require('fs');
const path = require('path');
const Handlebars = require('handlebars');
const puppeteer = require('puppeteer-core');
const { PDFDocument } = require('pdf-lib');
const { loadLogoBase64 } = require('../../logo_loader');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const CHROMIUM_PATH = process.env.CHROMIUM_PATH || '/usr/bin/chromium';

const handlebars = Handlebars.create();
handlebars.registerHelper('get', (obj, key) => (obj && obj[key] !== undefined ? obj[key] : ''));

const templatePath = path.join(PROJECT_ROOT, 'templates', 'ficha-inscricao.html');
if (!fs.existsSync(templatePath)) {
  console.error(`Template PDF não encontrado em ${templatePath}`);
  process.exit(1);
}
const template = handlebars.compile(fs.readFileSync(templatePath, 'utf-8'));

let bootstrapCSS = '';
try {
  bootstrapCSS = fs.readFileSync(path.join(PROJECT_ROOT, 'assets', 'css', 'bootstrap.min.css'), 'utf-8');
} catch (err) {
  console.warn('Atenção: não foi possível ler assets/css/bootstrap.min.css. O PDF poderá ficar sem estilos.');
}

const logoBase64 = loadLogoBase64();

function renderFichaHtml(data) {
  return template({ ...data, logoBase64, bootstrapCSS });
}

async function htmlToPdfBuffer(html) {
  const browser = await puppeteer.launch({
    executablePath: CHROMIUM_PATH,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    return await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '1.5cm', bottom: '1.5cm', left: '1cm', right: '1cm' },
    });
  } finally {
    await browser.close();
  }
}

async function renderFichaPdf(data) {
  return htmlToPdfBuffer(renderFichaHtml(data));
}

/**
 * Junta o PDF da ficha com os buffers dos anexos, num único PDF.
 */
async function mergeWithAttachments(mainBuffer, attachmentBuffers) {
  const mergedPdf = await PDFDocument.load(mainBuffer);
  for (const buf of attachmentBuffers) {
    try {
      const pdf = await PDFDocument.load(buf);
      const pages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
      pages.forEach(page => mergedPdf.addPage(page));
    } catch {
      console.warn('Arquivo anexo inválido, pulando...');
    }
  }
  return mergedPdf.save();
}

module.exports = {
  renderFichaHtml,
  renderFichaPdf,
  mergeWithAttachments,
  logoBase64
};

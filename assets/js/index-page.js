const form = document.getElementById('formGenerate');
const btnSubmit = document.getElementById('btnSubmit');
const btnText = document.getElementById('btnText');
const loadingSpinner = document.getElementById('loadingSpinner');
const parentSelect = document.getElementById('parent');
const generatedFilesBlock = document.getElementById('generatedFilesBlock');
const generatedFilesContent = document.getElementById('generatedFilesContent');
const generatedFilesCount = document.getElementById('generatedFilesCount');

function renderGeneratedFiles(files, html) {
  generatedFilesBlock.style.display = 'block';
  generatedFilesCount.textContent = files.length;

  if (!files.length) {
    generatedFilesContent.className = 'small text-muted';
    generatedFilesContent.textContent = 'Nenhum arquivo gerado encontrado para esta oportunidade.';
    return;
  }

  generatedFilesContent.className = 'generated-files-list list-group';
  generatedFilesContent.innerHTML = html;
}

parentSelect.addEventListener('change', async () => {
  const parentId = parentSelect.value;
  if (!parentId) {
    generatedFilesBlock.style.display = 'none';
    return;
  }

  generatedFilesBlock.style.display = 'block';
  generatedFilesCount.textContent = '...';
  generatedFilesContent.className = 'small text-muted';
  generatedFilesContent.textContent = 'Buscando arquivos gerados...';

  try {
    const response = await fetch('/generated-files?parent=' + encodeURIComponent(parentId));
    if (!response.ok) {
      throw new Error('Erro ao buscar arquivos');
    }
    const data = await response.json();
    renderGeneratedFiles(data.files || [], data.html || '');
  } catch (error) {
    generatedFilesCount.textContent = '0';
    generatedFilesContent.className = 'small text-danger';
    generatedFilesContent.textContent = 'Não foi possível listar os arquivos gerados.';
  }
});

form.addEventListener('submit', () => {
  btnSubmit.disabled = true;
  btnText.textContent = 'Gerando...';
  loadingSpinner.style.display = 'inline-block';
});

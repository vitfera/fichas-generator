const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const test = require('node:test');

const { createApp } = require('../src/web/app');

const silentLogger = { error() {}, warn() {}, log() {} };

function defaultDeps(overrides = {}) {
  return {
    outputDir: fs.mkdtempSync(path.join(os.tmpdir(), 'fichas-out-')),
    assetsDir: path.join(__dirname, '..', 'assets'),
    logoBase64: 'AAAA',
    fetchParentOpportunities: async () => [
      { id: 9, name: 'Edital de Música' },
      { id: 585, name: 'Edital de Artes Cênicas' }
    ],
    fetchOpportunityById: async id => ({ id, name: 'Edital de Música' }),
    generateFichas: async () => 'fichas_9.zip',
    listGeneratedFilesForOpportunity: () => [],
    listResultFilesForGeneration: () => [],
    logger: silentLogger,
    ...overrides
  };
}

/**
 * Sobe o app numa porta efêmera e devolve um `request` já apontado para ele.
 */
async function withServer(deps, run) {
  const app = createApp(defaultDeps(deps));
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    return await run({
      get: (url, init) => fetch(baseUrl + url, init),
      post: (url, body) => fetch(baseUrl + url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(body).toString(),
        redirect: 'manual'
      })
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

// ------------------------------------------------------------
// GET /
// ------------------------------------------------------------

test('GET / lists the parent opportunities in the select', async () => {
  await withServer({}, async request => {
    const response = await request.get('/');
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /<option value="9">Edital de Música<\/option>/);
    assert.match(html, /<option value="585">Edital de Artes Cênicas<\/option>/);
  });
});

test('GET / escapes opportunity names coming from the database', async () => {
  await withServer({
    fetchParentOpportunities: async () => [
      { id: 1, name: '<script>alert("xss")</script>' }
    ]
  }, async request => {
    const html = await (await request.get('/')).text();

    assert.doesNotMatch(html, /<script>alert/);
    assert.match(html, /&lt;script&gt;/);
  });
});

test('GET / still renders when the database is unavailable', async () => {
  await withServer({
    fetchParentOpportunities: async () => { throw new Error('conexão recusada'); }
  }, async request => {
    const response = await request.get('/');
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /Gerar Fichas de Inscrição/);
  });
});

test('GET / offers every registration filter and attachment mode', async () => {
  await withServer({}, async request => {
    const html = await (await request.get('/')).text();

    assert.match(html, /<option value="selected">/);
    assert.match(html, /<option value="selected_and_alternate">/);
    assert.match(html, /<option value="all">/);
    assert.match(html, /<option value="with_attachments" selected>Ficha \+ anexos<\/option>/);
    assert.match(html, /<option value="sheet_only">Somente ficha<\/option>/);
  });
});

test('GET / hides the generated files card until an opportunity is picked', async () => {
  await withServer({}, async request => {
    const html = await (await request.get('/')).text();

    assert.match(html, /id="generatedFilesBlock" class="[^"]*generated-files-block/);
    assert.match(html, /Arquivos já gerados/);
  });
});

// ------------------------------------------------------------
// GET /generated-files
// ------------------------------------------------------------

test('GET /generated-files returns the files and the rendered markup', async () => {
  await withServer({
    listGeneratedFilesForOpportunity: () => [
      { name: 'fichas_9.zip', url: '/downloads/fichas_9.zip', type: 'zip' },
      { name: 'ficha_9_EG1_ana.pdf', url: '/downloads/ficha_9_EG1_ana.pdf', type: 'pdf' }
    ]
  }, async request => {
    const response = await request.get('/generated-files?parent=9');
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.files.length, 2);
    assert.match(body.html, /href="\/downloads\/fichas_9\.zip"/);
    assert.match(body.html, /badge text-bg-light">ZIP</);
    assert.match(body.html, /badge text-bg-light">PDF</);
  });
});

test('GET /generated-files escapes file names in the rendered markup', async () => {
  await withServer({
    listGeneratedFilesForOpportunity: () => [
      { name: 'ficha_9_"><img src=x onerror=alert(1)>.pdf', url: '/downloads/x.pdf', type: 'pdf' }
    ]
  }, async request => {
    const body = await (await request.get('/generated-files?parent=9')).json();

    assert.doesNotMatch(body.html, /<img src=x/);
    assert.match(body.html, /&lt;img/);
  });
});

test('GET /generated-files rejects a non-numeric opportunity', async () => {
  await withServer({}, async request => {
    const response = await request.get('/generated-files?parent=abc');

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'Oportunidade inválida.' });
  });
});

test('GET /generated-files reports a listing failure as 500', async () => {
  await withServer({
    listGeneratedFilesForOpportunity: () => { throw new Error('disco indisponível'); }
  }, async request => {
    const response = await request.get('/generated-files?parent=9');

    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'Erro ao listar arquivos gerados.' });
  });
});

// ------------------------------------------------------------
// POST /generate
// ------------------------------------------------------------

test('POST /generate renders the opportunity name and the download links', async () => {
  await withServer({
    fetchOpportunityById: async () => ({ id: 9, name: 'Edital de Música 2025' }),
    listResultFilesForGeneration: () => [
      { name: 'fichas_9.zip', url: '/downloads/fichas_9.zip', type: 'zip' },
      { name: 'ficha_9_EG1_ana.pdf', url: '/downloads/ficha_9_EG1_ana.pdf', type: 'pdf' }
    ]
  }, async request => {
    const response = await request.post('/generate', { parent: '9', filterType: 'selected' });
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /Edital de Música 2025/);
    assert.match(html, /Oportunidade #9/);
    assert.match(html, /href="\/downloads\/fichas_9\.zip" class="btn btn-success"/);
    assert.match(html, /ficha_9_EG1_ana\.pdf/);
  });
});

test('POST /generate passes the chosen filter and attachment mode to the generator', async () => {
  const calls = [];
  await withServer({
    generateFichas: async (...args) => {
      calls.push(args);
      return 'fichas_9_sem_anexos.zip';
    }
  }, async request => {
    await request.post('/generate', {
      parent: '9',
      filterType: 'selected_and_alternate',
      attachmentMode: 'sheet_only'
    });
  });

  assert.deepEqual(calls, [[9, 'selected_and_alternate', false]]);
});

test('POST /generate defaults to selected registrations with attachments', async () => {
  const calls = [];
  await withServer({
    generateFichas: async (...args) => {
      calls.push(args);
      return 'fichas_9.zip';
    }
  }, async request => {
    await request.post('/generate', { parent: '9' });
  });

  assert.deepEqual(calls, [[9, 'selected', true]]);
});

test('POST /generate rejects invalid input without calling the generator', async () => {
  const cases = [
    { body: { parent: 'abc' },                          expected: 'Oportunidade inválida.' },
    { body: { parent: '9', filterType: 'qualquer' },    expected: 'Tipo de filtro inválido.' },
    { body: { parent: '9', attachmentMode: 'nenhum' },  expected: 'Tipo de geração inválido.' }
  ];

  for (const { body, expected } of cases) {
    let called = false;
    await withServer({
      generateFichas: async () => { called = true; return 'x.zip'; }
    }, async request => {
      const response = await request.post('/generate', body);

      assert.equal(response.status, 400, `esperado 400 para ${JSON.stringify(body)}`);
      assert.equal(await response.text(), expected);
    });
    assert.equal(called, false, `generateFichas não deveria rodar para ${JSON.stringify(body)}`);
  }
});

test('POST /generate returns 400 for an opportunity that does not exist', async () => {
  let called = false;
  await withServer({
    fetchOpportunityById: async () => null,
    generateFichas: async () => { called = true; return 'x.zip'; }
  }, async request => {
    const response = await request.post('/generate', { parent: '999999' });

    assert.equal(response.status, 400);
    assert.equal(await response.text(), 'Oportunidade não encontrada.');
  });
  assert.equal(called, false);
});

test('POST /generate returns 500 when the generation fails', async () => {
  await withServer({
    generateFichas: async () => { throw new Error('Nenhuma inscrição encontrada'); }
  }, async request => {
    const response = await request.post('/generate', { parent: '9' });

    assert.equal(response.status, 500);
    assert.match(await response.text(), /Erro ao gerar fichas/);
  });
});

test('POST /generate escapes the opportunity name on the result page', async () => {
  await withServer({
    fetchOpportunityById: async () => ({ id: 9, name: '<img src=x onerror=alert(1)>' })
  }, async request => {
    const html = await (await request.post('/generate', { parent: '9' })).text();

    assert.doesNotMatch(html, /<img src=x/);
    assert.match(html, /&lt;img/);
  });
});

// ------------------------------------------------------------
// Estáticos
// ------------------------------------------------------------

test('the interface stylesheet and script are served as static assets', async () => {
  await withServer({}, async request => {
    const css = await request.get('/assets/css/app.css');
    const js = await request.get('/assets/js/index-page.js');

    assert.equal(css.status, 200);
    assert.equal(js.status, 200);
    assert.match(await js.text(), /generated-files\?parent=/);
  });
});

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync('extension/popup.js', 'utf8');
const coreSource = fs.readFileSync('extension/export-core.js', 'utf8');
const manifestSource = fs.readFileSync('extension/manifest.json', 'utf8');

function loadHelpers(fetchImpl) {
  const elements = new Map();
  const downloadNames = [];
  const injectedCalls = [];
  const createdBlobs = [];
  const revokedUrls = [];
  const storageAccesses = [];
  class TestURL extends URL {}
  TestURL.createObjectURL = (blob) => {
    const url = URL.createObjectURL(blob);
    createdBlobs.push({ url, blob });
    return url;
  };
  TestURL.revokeObjectURL = (url) => {
    revokedUrls.push(url);
    URL.revokeObjectURL(url);
  };
  const context = {
    document: {
      getElementById: (id) => {
        if (!elements.has(id)) elements.set(id, { textContent: '', className: '', checked: false, addEventListener() {} });
        return elements.get(id);
      },
      createElement: () => ({ style: {}, click() { downloadNames.push(this.download); }, remove() {} }),
      body: { appendChild() {} },
    },
    URL: TestURL,
    Blob,
    atob,
    btoa,
    TextEncoder,
    Uint8Array,
    Uint32Array,
    DataView,
    Map,
    Set,
    Date,
    setTimeout: (callback) => { callback(); return 0; },
    browser: {
      scripting: {
        executeScript: async (details) => {
          injectedCalls.push(details);
          return [{ result: await details.func(...(details.args || [])) }];
        },
      },
      storage: {
        local: new Proxy({}, { get: (_target, key) => (...args) => storageAccesses.push([key, args]) }),
      },
    },
    fetch: fetchImpl || (async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'image/png' },
      arrayBuffer: async () => new Uint8Array([7, 8, 9]).buffer,
    })),
    console,
  };
  vm.createContext(context);
  vm.runInContext(coreSource, context);
  vm.runInContext(`${source}\nthis.testAPI = { safeName, exportFilename: typeof exportFilename === 'undefined' ? null : exportFilename, safeAttachmentName, buildExportReport, buildArchiveMarkdown, addAttachmentsToArchive, excludeSuccessfulPDFPreviews, linkDownloadedAttachments, markSkippedPDFPreviews, fetchImagesForArchive, fetchAttachmentsForArchive, buildZipBlob, downloadFileInPage: typeof downloadFileInPage === 'undefined' ? null : downloadFileInPage, downloadZipFromPopup: typeof downloadZipFromPopup === 'undefined' ? null : downloadZipFromPopup, zipTransferChunkBytes: typeof ZIP_TRANSFER_CHUNK_BYTES === 'undefined' ? null : ZIP_TRANSFER_CHUNK_BYTES, hasPendingZipTransfer: () => Object.prototype.hasOwnProperty.call(globalThis, '__chatgptExporterZipTransfer') };`, context);
  return Object.assign(context.testAPI, { downloadNames, injectedCalls, createdBlobs, revokedUrls, storageAccesses });
}

async function readStoredZipEntries(blob) {
  const bytes = Buffer.from(await blob.arrayBuffer());
  const endOffset = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.notEqual(endOffset, -1);
  const count = bytes.readUInt16LE(endOffset + 10);
  let centralOffset = bytes.readUInt32LE(endOffset + 16);
  const entries = new Map();

  for (let index = 0; index < count; index++) {
    assert.equal(bytes.readUInt32LE(centralOffset), 0x02014b50);
    const nameLength = bytes.readUInt16LE(centralOffset + 28);
    const extraLength = bytes.readUInt16LE(centralOffset + 30);
    const commentLength = bytes.readUInt16LE(centralOffset + 32);
    const name = bytes.subarray(centralOffset + 46, centralOffset + 46 + nameLength).toString('utf8');
    const localOffset = bytes.readUInt32LE(centralOffset + 42);
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const dataLength = bytes.readUInt32LE(localOffset + 22);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    entries.set(name, bytes.subarray(dataOffset, dataOffset + dataLength));
    centralOffset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

test('export filenames use only the sanitized title and requested extension', () => {
  const { exportFilename } = loadHelpers();
  assert.equal(exportFilename('Casos Whatsapp', 'md'), 'Casos Whatsapp.md');
  assert.equal(exportFilename('Casos Whatsapp', 'zip'), 'Casos Whatsapp.zip');
  assert.doesNotMatch(exportFilename('Casos Whatsapp', 'zip'), /\d{4}-\d{2}-\d{2}|\d{2}-\d{2}-\d{2}/);
});

test('conversation title sanitization preserves safe Unicode and replaces filename-special characters', () => {
  const { safeName } = loadHelpers();
  assert.equal(safeName('  Árvore 日本語 😀  '), 'Árvore 日本語 😀');
  assert.equal(safeName('A/B:C*D?E"F<G>H|I\\J'), 'A_B_C_D_E_F_G_H_I_J');
  assert.equal(safeName('.Casos Whatsapp.'), 'Casos Whatsapp');
  assert.equal(safeName(' ... '), 'chatgpt');
  assert.equal([...safeName('é'.repeat(100))].length, 80);
  assert.equal(safeName(`${'x'.repeat(79)}.abc`), 'x'.repeat(79));
  assert.equal(safeName(`${'x'.repeat(79)} abc`), 'x'.repeat(79));
});

test('ZIP download uses the exact page filename and transient bounded chunks without persisting data', async () => {
  const helpers = loadHelpers();
  const { downloadZipFromPopup, zipTransferChunkBytes } = helpers;
  const bytes = new Uint8Array(zipTransferChunkBytes + 7);
  for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
  const zipBlob = new Blob([bytes], { type: 'application/zip' });

  await downloadZipFromPopup(42, 'Casos Whatsapp.zip', zipBlob);

  assert.deepEqual(helpers.downloadNames, ['Casos Whatsapp.zip']);
  assert.doesNotMatch(helpers.downloadNames[0], /Unknown|\d{4}-\d{2}-\d{2}/);
  assert.ok(helpers.injectedCalls.length >= 4);
  assert.ok(helpers.injectedCalls.every((call) => call.target.tabId === 42));
  assert.ok(helpers.injectedCalls.every((call) => !(call.args || []).some((arg) => arg instanceof Blob)));
  assert.ok(helpers.injectedCalls.every((call) => JSON.stringify(call.args || []).length <= 4 * Math.ceil(zipTransferChunkBytes / 3) + 256));
  assert.equal(helpers.createdBlobs.length, 1);
  assert.equal(helpers.createdBlobs[0].blob.size, bytes.length);
  assert.deepEqual(new Uint8Array(await helpers.createdBlobs[0].blob.arrayBuffer()), bytes);
  assert.deepEqual(helpers.revokedUrls, [helpers.createdBlobs[0].url]);
  assert.equal(helpers.hasPendingZipTransfer(), false);
  assert.deepEqual(helpers.storageAccesses, []);
});

test('Markdown keeps its exact title filename in the same active-page download helper', () => {
  const helpers = loadHelpers();
  helpers.downloadFileInPage('Casos Whatsapp.md', '# Casos Whatsapp', 'text/markdown;charset=utf-8');
  assert.deepEqual(helpers.downloadNames, ['Casos Whatsapp.md']);
  assert.doesNotMatch(helpers.downloadNames[0], /Unknown|\d{4}-\d{2}-\d{2}/);
});

test('normal extension permissions remain exactly activeTab and scripting', () => {
  const permissions = JSON.parse(manifestSource).permissions.slice().sort();
  assert.deepEqual(permissions, ['activeTab', 'scripting']);
});

test('ZIP paths share the sanitized conversation root while Markdown links and attachment names stay relative', async () => {
  const { safeName, buildZipBlob, addAttachmentsToArchive } = loadHelpers();
  const root = safeName('Casos Whatsapp');
  const markdown = '![image](images/image-001.png)\n\n[archivo.pdf](attachments/archivo.pdf)';
  const entries = [
    { name: 'conversation.md', data: new TextEncoder().encode(markdown) },
    { name: 'export-report.txt', data: new TextEncoder().encode('aggregate report') },
    { name: 'images/image-001.png', data: new Uint8Array([1, 2, 3]) },
  ];
  addAttachmentsToArchive(entries, [{ fileId: 'pdf-1', name: 'archivo.pdf', bytes: new Uint8Array([4, 5, 6]) }]);

  const zipEntries = await readStoredZipEntries(buildZipBlob(entries, root));
  assert.deepEqual([...zipEntries.keys()].sort(), [
    'Casos Whatsapp/',
    'Casos Whatsapp/attachments/',
    'Casos Whatsapp/attachments/archivo.pdf',
    'Casos Whatsapp/conversation.md',
    'Casos Whatsapp/export-report.txt',
    'Casos Whatsapp/images/',
    'Casos Whatsapp/images/image-001.png',
  ]);
  assert.equal(zipEntries.get('Casos Whatsapp/conversation.md').toString(), markdown);
  assert.ok(zipEntries.has(`${root}/attachments/archivo.pdf`));

  const emptyZipEntries = await readStoredZipEntries(buildZipBlob([
    { name: 'conversation.md', data: new TextEncoder().encode('# Casos Whatsapp') },
    { name: 'export-report.txt', data: new TextEncoder().encode('aggregate report') },
  ], root));
  assert.ok(emptyZipEntries.has('Casos Whatsapp/images/'));
  assert.ok(emptyZipEntries.has('Casos Whatsapp/attachments/'));
});

test('attachment names are sanitized and retain a safe extension', () => {
  const { safeAttachmentName } = loadHelpers();
  assert.equal(safeAttachmentName('../receipt.pdf', 1, 'application/pdf'), 'receipt.pdf');
  assert.equal(safeAttachmentName('   ', 2, 'application/pdf'), 'attachment-002.pdf');
  assert.equal(safeAttachmentName('invoice.exe', 3, 'application/pdf'), 'invoice.pdf');
});

test('report separates image and attachment totals and contains no identifiers or URLs', () => {
  const { buildExportReport } = loadHelpers();
  const report = buildExportReport({
    detected: 2, downloaded: 1, failed: 1,
  }, { detected: 1, downloaded: 1, failed: 0 });
  assert.match(report, /Images detected: 2/);
  assert.match(report, /Images failed: 1/);
  assert.match(report, /Attachments detected: 1/);
  assert.match(report, /Attachments downloaded: 1/);
  assert.match(report, /attachment-content_type: 0/);
  assert.match(report, /image-network: 0/);
  assert.match(report, /Version: 2\.9-private/);
  assert.doesNotMatch(report, /Bearer|https?:\/\/|file-id-123|signed-url|transient-secret-token/);
});

test('successful original attachment is archived separately from image entries', () => {
  const { buildArchiveMarkdown } = loadHelpers();
  const images = [{ fileId: 'image-id', name: 'image-001.png' }];
  const fetchedImages = { files: new Map([['image-id', { name: 'image-001.png', bytes: new Uint8Array([1]) }]]), failed: 0, diagnostics: {} };
  const entries = buildArchiveMarkdown('# Chat\n\n@@IMG@@image-id@@', images, fetchedImages);
  const attachments = [{ fileId: 'private-id', name: 'receipt.pdf', bytes: new Uint8Array([2]) }];
  const { addAttachmentsToArchive } = loadHelpers();
  addAttachmentsToArchive(entries, attachments);
  assert.ok(entries.some((entry) => entry.name === 'images/image-001.png'));
  assert.ok(entries.some((entry) => entry.name === 'attachments/receipt.pdf'));
});

test('attachment links point to the archived local file and duplicate names stay unique', () => {
  const { addAttachmentsToArchive, linkDownloadedAttachments, markSkippedPDFPreviews } = loadHelpers();
  const files = [
    { fileId: 'one', name: 'receipt.pdf', bytes: new Uint8Array([2]) },
    { fileId: 'two', name: 'receipt.pdf', bytes: new Uint8Array([3]) },
  ];
  const entries = [];
  addAttachmentsToArchive(entries, files);
  assert.deepEqual(entries.map((entry) => entry.name), ['attachments/receipt.pdf', 'attachments/receipt-2.pdf']);
  const markdown = linkDownloadedAttachments('_[attachment omitted: receipt.pdf]_ @@IMG@@preview@@', [{ fileId: 'one', name: 'receipt.pdf' }], files);
  assert.match(markdown, /\[receipt\.pdf\]\(attachments\/receipt\.pdf\)/);
  assert.match(markSkippedPDFPreviews(markdown, [{ fileId: 'preview', previewAttachmentId: 'one' }], files), /original PDF: receipt\.pdf/);
});

test('existing signed-image download path still saves image bytes locally', async () => {
  const { fetchImagesForArchive } = loadHelpers();
  const result = await fetchImagesForArchive([
    { fileId: 'img-1', url: 'https://files.oaiusercontent.com/image.png', name: 'image-001.png' },
  ], null);
  assert.equal(result.failed, 0);
  assert.equal(result.diagnostics.direct_ok, 1);
  assert.deepEqual([...result.files.get('img-1').bytes], [7, 8, 9]);
});

test('original PDF bytes are exported while image payloads are rejected as attachments', async () => {
  const { fetchAttachmentsForArchive } = loadHelpers(async (url) => ({
    ok: true,
    status: 200,
    headers: { get: () => url.endsWith('.pdf') ? 'application/pdf' : 'image/png' },
    arrayBuffer: async () => new Uint8Array([37, 80, 68, 70]).buffer,
  }));
  const result = await fetchAttachmentsForArchive([
    { fileId: 'pdf-id', name: 'receipt.pdf', mime: 'application/pdf', url: 'https://files.oaiusercontent.com/receipt.pdf' },
    { fileId: 'image-id', name: 'photo.png', mime: 'image/png', url: 'https://files.oaiusercontent.com/photo.png' },
  ], null);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].name, 'receipt.pdf');
  assert.deepEqual([...result.files[0].bytes], [37, 80, 68, 70]);
  assert.equal(result.failed, 1);
  assert.equal(result.diagnostics.content_type, 1);
});

test('successful original PDF export excludes its rendered preview from image failures', () => {
  const { excludeSuccessfulPDFPreviews } = loadHelpers();
  const result = excludeSuccessfulPDFPreviews([
    { fileId: 'preview-id', previewAttachmentId: 'pdf-id' },
    { fileId: 'photo-id', previewAttachmentId: null },
  ], [{ fileId: 'pdf-id', name: 'receipt.pdf' }]);
  assert.equal(result.images.length, 1);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.images[0].fileId, 'photo-id');
});

test('page export discovers original PDF metadata and associates its rendered page preview', async () => {
  const context = {
    window: {},
    location: { pathname: '/c/12345678-1234-1234-1234-123456789012' },
    AbortController,
    setTimeout,
    clearTimeout,
    fetch: async (url) => {
      const jsonResponse = (value) => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => value });
      if (url === '/api/auth/session') return jsonResponse({ accessToken: 'transient-secret-token' });
      if (url.startsWith('/backend-api/conversation/')) return jsonResponse({
        title: 'PDF chat', current_node: 'node-1', mapping: { 'node-1': { parent: null, message: {
          author: { role: 'user' }, content: { parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'file-service://preview-id' }] },
          metadata: { attachments: [
            { id: 'image-attachment-id', name: 'photo.png', mime_type: 'image/png' },
            { id: 'pdf-id', file_id: 'wrong-file-id', asset_pointer: 'wrong-asset-pointer', name: 'receipt.pdf', mime_type: 'application/pdf' },
          ] },
        } } },
      });
      if (url.includes('preview-id')) return jsonResponse({ download_url: 'https://files.oaiusercontent.com/preview.png', mime_type: 'image/png' });
      if (url.includes('pdf-id')) return jsonResponse({ download_url: 'https://files.oaiusercontent.com/receipt.pdf', mime_type: 'application/pdf', file_name: 'receipt.pdf' });
      if (url.includes('wrong-file-id') || url.includes('wrong-asset-pointer')) throw new Error('non-canonical attachment identifier was used');
      throw new Error('unexpected endpoint');
    },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync('extension/exporter.js', 'utf8'), context);
  const result = await vm.runInContext('pageExport(true, true)', context);
  assert.equal(result.images[0].previewAttachmentId, 'pdf-id');
  assert.equal(result.attachments.length, 1);
  assert.equal(result.attachments[0].fileId, 'pdf-id');
  assert.equal(result.attachments[0].name, 'receipt.pdf');
  assert.equal(result.token, 'transient-secret-token');
});

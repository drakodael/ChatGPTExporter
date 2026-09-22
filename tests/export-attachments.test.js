const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync('extension/popup.js', 'utf8');

function loadHelpers(fetchImpl) {
  const elements = new Map();
  const context = {
    document: {
      getElementById: (id) => {
        if (!elements.has(id)) elements.set(id, { textContent: '', className: '', checked: false, addEventListener() {} });
        return elements.get(id);
      },
    },
    URL,
    Blob,
    TextEncoder,
    Uint8Array,
    Uint32Array,
    DataView,
    Map,
    Set,
    Date,
    fetch: fetchImpl || (async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'image/png' },
      arrayBuffer: async () => new Uint8Array([7, 8, 9]).buffer,
    })),
    console,
  };
  vm.createContext(context);
  vm.runInContext(`${source}\nthis.testAPI = { safeAttachmentName, buildExportReport, buildArchiveMarkdown, addAttachmentsToArchive, excludeSuccessfulPDFPreviews, linkDownloadedAttachments, markSkippedPDFPreviews, fetchImagesForArchive, fetchAttachmentsForArchive };`, context);
  return context.testAPI;
}

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

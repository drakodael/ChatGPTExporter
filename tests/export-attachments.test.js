const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync('extension/popup.js', 'utf8');
const coreSource = fs.readFileSync('extension/export-core.js', 'utf8');
const exporterSource = fs.readFileSync('extension/exporter.js', 'utf8');
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

function createPageExportHarness(attachment, resolveEndpoint, previewFileId = null, conversationId = '12345678-1234-1234-1234-123456789012') {
  const endpointCalls = [];
  const encodedValues = [];
  const attachments = Array.isArray(attachment) ? attachment : [attachment];
  const nativeEncodeURIComponent = encodeURIComponent;
  const jsonResponse = (value, overrides = {}) => ({
    ok: true,
    status: 200,
    redirected: false,
    url: '',
    headers: { get: (name) => name === 'content-type' ? 'application/json' : null },
    json: async () => value,
    ...overrides,
  });
  const context = {
    window: {},
    location: { pathname: `/c/${conversationId}` },
    encodeURIComponent: (value) => {
      encodedValues.push(value);
      return nativeEncodeURIComponent(value);
    },
    AbortController,
    setTimeout,
    clearTimeout,
    fetch: async (url, options) => {
      if (url === '/api/auth/session') return jsonResponse({ accessToken: 'resolver-test-bearer-secret' });
      if (url.startsWith('/backend-api/conversation/')) return jsonResponse({
        title: 'Resolver test', current_node: 'node-1', mapping: { 'node-1': { parent: null, message: {
          author: { role: 'user' },
          content: { parts: previewFileId ? [{ content_type: 'image_asset_pointer', asset_pointer: `file-service://${previewFileId}` }] : [] },
          metadata: { attachments },
        } } },
      });
      endpointCalls.push({ url, authorization: options && options.headers && options.headers.Authorization });
      return resolveEndpoint(url, endpointCalls.length, jsonResponse);
    },
  };
  vm.createContext(context);
  vm.runInContext(exporterSource, context);
  return {
    endpointCalls,
    encodedValues,
    pageExport: (includeImages = false) => vm.runInContext(`pageExport(${includeImages}, true)`, context),
  };
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
  addAttachmentsToArchive(entries, [{ attachmentKey: 'pdf-1', name: 'archivo.pdf', bytes: new Uint8Array([4, 5, 6]) }]);

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
  assert.match(report, /Attachment diagnostics \(downloader stage, aggregate only\):/);
  assert.match(report, /Attachment resolver diagnostics \(aggregate only\):/);
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
  const attachments = [{ attachmentKey: 'private-id', name: 'receipt.pdf', bytes: new Uint8Array([2]) }];
  const { addAttachmentsToArchive } = loadHelpers();
  addAttachmentsToArchive(entries, attachments);
  assert.ok(entries.some((entry) => entry.name === 'images/image-001.png'));
  assert.ok(entries.some((entry) => entry.name === 'attachments/receipt.pdf'));
});

test('attachment links point to the archived local file and duplicate names stay unique', () => {
  const { addAttachmentsToArchive, linkDownloadedAttachments, markSkippedPDFPreviews } = loadHelpers();
  const files = [
    { attachmentKey: 'one', name: 'receipt.pdf', bytes: new Uint8Array([2]) },
    { attachmentKey: 'two', name: 'receipt.pdf', bytes: new Uint8Array([3]) },
  ];
  const entries = [];
  addAttachmentsToArchive(entries, files);
  assert.deepEqual(entries.map((entry) => entry.name), ['attachments/receipt.pdf', 'attachments/receipt-2.pdf']);
  const markdown = linkDownloadedAttachments('_[attachment omitted: receipt.pdf]_ @@IMG@@preview@@', [{ attachmentKey: 'one', name: 'receipt.pdf' }], files);
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
    { attachmentKey: 'pdf-id', name: 'receipt.pdf', mime: 'application/pdf', url: 'https://files.oaiusercontent.com/receipt.pdf' },
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
  ], [{ attachmentKey: 'pdf-id', name: 'receipt.pdf' }]);
  assert.equal(result.images.length, 1);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.images[0].fileId, 'photo-id');
});

test('attachment resolver reports endpoint-specific HTTP and JSON failures without leaking private data', async () => {
  const harness = createPageExportHarness({
    id: 'private-test-file-id',
    name: 'private-customer-contract.pdf',
    mime_type: 'application/pdf',
  }, (_url, call, jsonResponse) => call === 1
    ? jsonResponse({}, { ok: false, status: 403 })
    : jsonResponse({ private_body_marker: 'secret response body content' }));
  const result = await harness.pageExport();
  const diagnostics = result.attachmentResolverDiagnostics;

  assert.equal(harness.endpointCalls.length, 2);
  assert.equal(harness.endpointCalls[0].url, '/backend-api/files/download/private-test-file-id?conversation_id=12345678-1234-1234-1234-123456789012&inline=false');
  assert.equal(harness.endpointCalls[1].url, '/backend-api/files/private-test-file-id/download?conversation_id=12345678-1234-1234-1234-123456789012&inline=false');
  assert.equal(diagnostics.id_source_id, 1);
  assert.equal(diagnostics.attempts, 2);
  assert.equal(diagnostics.resolved, 0);
  assert.equal(diagnostics.endpoint_1_http_403, 1);
  assert.equal(diagnostics.endpoint_2_json_no_url, 1);
  assert.equal(result.attachments[0].url, null);

  const report = loadHelpers().buildExportReport(
    { detected: 0, downloaded: 0, failed: 0 },
    { detected: 1, downloaded: 0, failed: 1, diagnostics: {} },
    true,
    diagnostics,
  );
  for (const privateValue of [
    'resolver-test-bearer-secret',
    'private-test-file-id',
    'private-customer-contract.pdf',
    'secret response body content',
  ]) assert.equal(report.includes(privateValue), false);
  assert.doesNotMatch(report, /Bearer\s+\S+/i);
  assert.match(report, /Attachment resolver diagnostics \(aggregate only\):/);
  assert.match(report, /attachment-id_source-id: 1/);
  assert.match(report, /attachment-resolver-attempts: 2/);
  assert.match(report, /attachment-resolver-http_403: 1/);
  assert.match(report, /attachment-resolver-json_no_url: 1/);
  assert.match(report, /attachment-resolver-endpoint_1-http_403: 1/);
  assert.match(report, /attachment-resolver-endpoint_2-json_no_url: 1/);
});

test('attachment resolution scopes both existing endpoints to the conversation and keeps scope data private', async () => {
  const conversationId = 'abcdefab-cdef-abcd-efab-cdefabcdefab';
  const candidate = 'file/id?private=value';
  const signedURL = 'https://files.oaiusercontent.com/signed-private-scope-url';
  const harness = createPageExportHarness({
    id: candidate,
    name: 'private-receipt.pdf',
    mime_type: 'application/pdf',
  }, (url, _call, jsonResponse) => {
    if (url !== `/backend-api/files/download/${encodeURIComponent(candidate)}?conversation_id=${encodeURIComponent(conversationId)}&inline=false`) {
      throw new Error('unexpected unscoped or reordered resolver request');
    }
    return jsonResponse({ download_url: signedURL, private_body_marker: 'private response body' });
  }, null, conversationId);

  const result = await harness.pageExport();
  assert.deepEqual(harness.endpointCalls.map(({ url }) => url), [
    '/backend-api/files/download/file%2Fid%3Fprivate%3Dvalue?conversation_id=abcdefab-cdef-abcd-efab-cdefabcdefab&inline=false',
  ]);
  assert.ok(harness.encodedValues.includes(candidate));
  assert.ok(harness.encodedValues.includes(conversationId));
  assert.equal(result.attachments[0].attachmentKey, candidate);
  assert.equal(result.attachments[0].url, signedURL);
  assert.equal(result.attachmentResolverDiagnostics.conversation_scoped_attempts, 1);
  assert.equal(result.attachmentResolverDiagnostics.conversation_scoped_resolved, 1);
  assert.equal(result.attachmentResolverDiagnostics.conversation_scoped_http_403, 0);

  const report = loadHelpers().buildExportReport({}, {}, true, result.attachmentResolverDiagnostics);
  for (const privateValue of [conversationId, candidate, 'resolver-test-bearer-secret', signedURL, 'private response body']) {
    assert.equal(report.includes(privateValue), false);
  }
  assert.equal(harness.endpointCalls[0].authorization, 'Bearer resolver-test-bearer-secret');
  assert.match(report, /attachment-resolver-conversation_scoped-attempts: 1/);
  assert.match(report, /attachment-resolver-conversation_scoped-resolved: 1/);
  assert.match(report, /attachment-resolver-conversation_scoped-http_403: 0/);
});

test('attachment resolver falls back from scoped endpoint one to scoped endpoint two after 403', async () => {
  const conversationId = 'abcdefab-cdef-abcd-efab-cdefabcdefab';
  const candidate = 'scoped-file-id';
  const signedURL = 'https://files.oaiusercontent.com/scoped-fallback-url';
  const harness = createPageExportHarness({ id: candidate, name: 'receipt.pdf', mime_type: 'application/pdf' }, (url, _call, jsonResponse) => {
    if (url === `/backend-api/files/download/${candidate}?conversation_id=${conversationId}&inline=false`) {
      return jsonResponse({}, { ok: false, status: 403 });
    }
    if (url === `/backend-api/files/${candidate}/download?conversation_id=${conversationId}&inline=false`) {
      return jsonResponse({ download_url: signedURL });
    }
    throw new Error('unscoped endpoint variant was requested');
  }, null, conversationId);

  const result = await harness.pageExport();
  assert.deepEqual(harness.endpointCalls.map(({ url }) => url), [
    `/backend-api/files/download/${candidate}?conversation_id=${conversationId}&inline=false`,
    `/backend-api/files/${candidate}/download?conversation_id=${conversationId}&inline=false`,
  ]);
  assert.equal(result.attachments[0].url, signedURL);
  assert.equal(result.attachmentResolverDiagnostics.conversation_scoped_attempts, 2);
  assert.equal(result.attachmentResolverDiagnostics.conversation_scoped_resolved, 1);
  assert.equal(result.attachmentResolverDiagnostics.conversation_scoped_http_403, 1);
  assert.equal(result.attachmentResolverDiagnostics.endpoint_1_scoped_http_403, 1);
  assert.equal(result.attachmentResolverDiagnostics.endpoint_2_scoped_resolved, 1);
});

test('attachment resolver falls back from both id endpoints to file_id while retaining the logical key', async () => {
  const harness = createPageExportHarness({
    id: 'logical-id-secret',
    file_id: 'resolver-file-id-secret',
    asset_pointer: 'resolver-asset-pointer-secret',
    name: 'private-receipt.pdf',
    mime_type: 'application/pdf',
  }, (url, _call, jsonResponse) => {
    if (url.includes('logical-id-secret')) return jsonResponse({}, { ok: false, status: 403 });
    if (url === '/backend-api/files/download/resolver-file-id-secret?conversation_id=12345678-1234-1234-1234-123456789012&inline=false') {
      return jsonResponse({ download_url: 'https://files.oaiusercontent.com/signed-url-secret', private_body: 'private response body secret' });
    }
    throw new Error('unexpected resolver candidate or endpoint');
  });
  const result = await harness.pageExport();
  const diagnostics = result.attachmentResolverDiagnostics;

  assert.equal(harness.endpointCalls.length, 3);
  assert.deepEqual(harness.endpointCalls.map((call) => call.url), [
    '/backend-api/files/download/logical-id-secret?conversation_id=12345678-1234-1234-1234-123456789012&inline=false',
    '/backend-api/files/logical-id-secret/download?conversation_id=12345678-1234-1234-1234-123456789012&inline=false',
    '/backend-api/files/download/resolver-file-id-secret?conversation_id=12345678-1234-1234-1234-123456789012&inline=false',
  ]);
  assert.equal(result.attachments[0].attachmentKey, 'logical-id-secret');
  assert.equal(result.attachments[0].url, 'https://files.oaiusercontent.com/signed-url-secret');
  assert.equal(diagnostics.candidate_present_id, 1);
  assert.equal(diagnostics.candidate_present_file_id, 1);
  assert.equal(diagnostics.candidate_present_asset_pointer, 1);
  assert.equal(diagnostics.candidate_attempt_id, 2);
  assert.equal(diagnostics.candidate_attempt_file_id, 1);
  assert.equal(diagnostics.candidate_attempt_asset_pointer, 0);
  assert.equal(diagnostics.candidate_resolved_id, 0);
  assert.equal(diagnostics.candidate_resolved_file_id, 1);
  assert.equal(diagnostics.candidate_resolved_asset_pointer, 0);

  const report = loadHelpers().buildExportReport({}, {}, true, diagnostics);
  for (const secret of [
    'logical-id-secret',
    'resolver-file-id-secret',
    'resolver-asset-pointer-secret',
    'private-receipt.pdf',
    'signed-url-secret',
    'private response body secret',
    'resolver-test-bearer-secret',
  ]) assert.equal(report.includes(secret), false);
  assert.match(report, /attachment-candidate-present-id: 1/);
  assert.match(report, /attachment-candidate-attempt-file_id: 1/);
  assert.match(report, /attachment-candidate-resolved-file_id: 1/);
});

test('attachment resolver falls back through id and file_id to asset_pointer', async () => {
  const harness = createPageExportHarness({
    id: 'logical-id',
    file_id: 'file-id-candidate',
    asset_pointer: 'file-service://asset-pointer-candidate',
    name: 'receipt.pdf',
    mime_type: 'application/pdf',
  }, (url, _call, jsonResponse) => {
    if (url.includes('asset-pointer-candidate') && url.startsWith('/backend-api/files/download/')) return jsonResponse({ download_url: 'https://files.oaiusercontent.com/receipt.pdf' });
    if (!url.includes('asset-pointer-candidate')) return jsonResponse({}, { ok: false, status: 403 });
    throw new Error('unexpected endpoint');
  });
  const result = await harness.pageExport();
  assert.equal(harness.endpointCalls.length, 5);
  assert.equal(result.attachments[0].attachmentKey, 'logical-id');
  assert.equal(result.attachments[0].url, 'https://files.oaiusercontent.com/receipt.pdf');
  assert.equal(result.attachmentResolverDiagnostics.candidate_attempt_id, 2);
  assert.equal(result.attachmentResolverDiagnostics.candidate_attempt_file_id, 2);
  assert.equal(result.attachmentResolverDiagnostics.candidate_attempt_asset_pointer, 1);
  assert.equal(result.attachmentResolverDiagnostics.candidate_resolved_asset_pointer, 1);
});

test('attachment resolver stops at the first successful id candidate', async () => {
  const harness = createPageExportHarness({
    id: 'logical-id', file_id: 'later-file-id', asset_pointer: 'later-asset-pointer',
    name: 'receipt.pdf', mime_type: 'application/pdf',
  }, (_url, _call, jsonResponse) => jsonResponse({ download_url: 'https://files.oaiusercontent.com/receipt.pdf' }));
  const result = await harness.pageExport();
  assert.equal(harness.endpointCalls.length, 1);
  assert.equal(result.attachmentResolverDiagnostics.candidate_attempt_id, 1);
  assert.equal(result.attachmentResolverDiagnostics.candidate_attempt_file_id, 0);
  assert.equal(result.attachmentResolverDiagnostics.candidate_attempt_asset_pointer, 0);
  assert.equal(result.attachmentResolverDiagnostics.candidate_resolved_id, 1);
});

test('resolver candidates duplicated after fileIdOf are attempted once', async () => {
  const harness = createPageExportHarness({
    id: 'file-service://same-normalized-id',
    file_id: 'same-normalized-id',
    asset_pointer: 'sediment://same-normalized-id',
    name: 'receipt.pdf', mime_type: 'application/pdf',
  }, (_url, _call, jsonResponse) => jsonResponse({ download_url: 'https://files.oaiusercontent.com/receipt.pdf' }));
  const result = await harness.pageExport();
  assert.equal(harness.endpointCalls.length, 1);
  assert.equal(result.attachments[0].attachmentKey, 'same-normalized-id');
  assert.equal(result.attachmentResolverDiagnostics.candidate_present_id, 1);
  assert.equal(result.attachmentResolverDiagnostics.candidate_present_file_id, 1);
  assert.equal(result.attachmentResolverDiagnostics.candidate_present_asset_pointer, 1);
  assert.equal(result.attachmentResolverDiagnostics.candidate_attempt_id, 1);
  assert.equal(result.attachmentResolverDiagnostics.candidate_attempt_file_id, 0);
  assert.equal(result.attachmentResolverDiagnostics.candidate_attempt_asset_pointer, 0);
});

test('PDF fallback keeps preview association and replaces the omitted attachment placeholder', async () => {
  const previewURL = 'https://files.oaiusercontent.com/preview.png';
  const pdfURL = 'https://files.oaiusercontent.com/private-signed-receipt.pdf';
  const harness = createPageExportHarness({
    id: 'logical-pdf-key', file_id: 'working-pdf-candidate', asset_pointer: 'unused-pdf-candidate',
    name: 'receipt.pdf', mime_type: 'application/pdf',
  }, (url, _call, jsonResponse) => {
    if (url.includes('preview-image-id')) return jsonResponse({ download_url: previewURL, mime_type: 'image/png' });
    if (url.includes('logical-pdf-key')) return jsonResponse({}, { ok: false, status: 403 });
    if (url === '/backend-api/files/download/working-pdf-candidate?conversation_id=12345678-1234-1234-1234-123456789012&inline=false') return jsonResponse({ download_url: pdfURL, mime_type: 'application/pdf' });
    throw new Error('unexpected resolver candidate or endpoint');
  }, 'preview-image-id');
  const result = await harness.pageExport(true);
  assert.equal(result.images[0].previewAttachmentId, 'logical-pdf-key');
  assert.equal(result.attachments[0].attachmentKey, 'logical-pdf-key');
  assert.equal(result.attachments[0].url, pdfURL);

  const helpers = loadHelpers(async (url) => ({
    ok: true,
    status: 200,
    headers: { get: () => url === pdfURL ? 'application/pdf' : 'image/png' },
    arrayBuffer: async () => new Uint8Array([37, 80, 68, 70]).buffer,
  }));
  const fetchedAttachments = await helpers.fetchAttachmentsForArchive(result.attachments, null);
  assert.equal(fetchedAttachments.failed, 0);
  assert.equal(fetchedAttachments.files[0].attachmentKey, 'logical-pdf-key');
  const imageSelection = helpers.excludeSuccessfulPDFPreviews(result.images, fetchedAttachments.files);
  assert.equal(imageSelection.images.length, 0);
  assert.equal(imageSelection.skipped.length, 1);
  const markdown = result.turns.map((turn) => turn.md).join('\n');
  const linked = helpers.linkDownloadedAttachments(markdown, result.attachments, fetchedAttachments.files);
  const output = helpers.markSkippedPDFPreviews(linked, imageSelection.skipped, fetchedAttachments.files);
  assert.match(output, /\[receipt\.pdf\]\(attachments\/receipt\.pdf\)/);
  assert.match(output, /PDF page preview omitted; original PDF: receipt\.pdf/);
  const fetchedImages = await helpers.fetchImagesForArchive(imageSelection.images, null);
  assert.equal(fetchedImages.failed, 0);
});

test('attachment resolver recognizes top-level and metadata download URLs', async (t) => {
  for (const fixture of [
    { name: 'top-level download_url', payload: { download_url: 'https://files.oaiusercontent.com/signed-top-level-secret' }, key: 'endpoint_1_json_download_url' },
    { name: 'metadata.download_url', payload: { metadata: { download_url: 'https://files.oaiusercontent.com/signed-metadata-secret' } }, key: 'endpoint_1_json_metadata_download_url' },
  ]) {
    await t.test(fixture.name, async () => {
      const harness = createPageExportHarness({ id: 'pdf-id', name: 'receipt.pdf', mime_type: 'application/pdf' }, (_url, _call, jsonResponse) => jsonResponse(fixture.payload));
      const result = await harness.pageExport();
      assert.equal(result.attachmentResolverDiagnostics.attempts, 1);
      assert.equal(result.attachmentResolverDiagnostics.resolved, 1);
      assert.equal(result.attachmentResolverDiagnostics[fixture.key], 1);
      assert.equal(result.attachments[0].url, fixture.payload.download_url || fixture.payload.metadata.download_url);
      const report = loadHelpers().buildExportReport({}, {}, true, result.attachmentResolverDiagnostics);
      assert.equal(report.includes(result.attachments[0].url), false);
    });
  }
});

test('attachment resolver distinguishes timeout, network, and HTML without a URL', async () => {
  const harness = createPageExportHarness({ id: 'pdf-id', name: 'receipt.pdf', mime_type: 'application/pdf' }, (url, _call, jsonResponse) => {
    if (url.includes('/files/download/')) throw Object.assign(new Error('private transport detail'), { name: 'AbortError' });
    if (url.startsWith('/backend-api/files/') && url.includes('/download?conversation_id=')) return jsonResponse({}, { headers: { get: () => 'text/html' } });
    throw new Error('unexpected endpoint');
  });
  const result = await harness.pageExport();
  const diagnostics = result.attachmentResolverDiagnostics;
  assert.equal(diagnostics.attempts, 3);
  assert.equal(diagnostics.endpoint_1_timeout, 2);
  assert.equal(diagnostics.endpoint_2_html_no_url, 1);
  assert.equal(diagnostics.timeout, 2);
  assert.equal(diagnostics.html_no_url, 1);

  const networkHarness = createPageExportHarness({ id: 'pdf-id', name: 'receipt.pdf', mime_type: 'application/pdf' }, () => {
    throw new TypeError('private network detail');
  });
  const networkResult = await networkHarness.pageExport();
  assert.equal(networkResult.attachmentResolverDiagnostics.attempts, 4);
  assert.equal(networkResult.attachmentResolverDiagnostics.network, 4);
  assert.equal(networkResult.attachmentResolverDiagnostics.timeout, 0);
});

test('attachment resolver retries transient HTTP failures on the same endpoint before resolving', async () => {
  let endpointOneCalls = 0;
  const harness = createPageExportHarness({ id: 'pdf-id', name: 'receipt.pdf', mime_type: 'application/pdf' }, (url, _call, jsonResponse) => {
    if (url !== '/backend-api/files/download/pdf-id?conversation_id=12345678-1234-1234-1234-123456789012&inline=false') throw new Error('resolver advanced before bounded retries completed');
    endpointOneCalls++;
    if (endpointOneCalls === 1) return jsonResponse({}, {
      ok: false,
      status: 429,
      headers: { get: (name) => name === 'retry-after' ? '0.001' : 'application/json' },
    });
    if (endpointOneCalls === 2) return jsonResponse({}, { ok: false, status: 503 });
    return jsonResponse({ download_url: 'https://files.oaiusercontent.com/receipt.pdf' });
  });
  const result = await harness.pageExport();
  assert.equal(endpointOneCalls, 3);
  assert.equal(harness.endpointCalls.length, 3);
  assert.equal(result.attachmentResolverDiagnostics.attempts, 3);
  assert.equal(result.attachmentResolverDiagnostics.http_429, 1);
  assert.equal(result.attachmentResolverDiagnostics.http_5xx, 1);
  assert.equal(result.attachmentResolverDiagnostics.candidate_attempt_id, 3);
  assert.equal(result.attachmentResolverDiagnostics.candidate_resolved_id, 1);
});

test('attachment resolver classifies redirects and valid non-HTML responses', async (t) => {
  for (const fixture of [
    {
      name: 'redirect',
      response: () => ({ ok: true, status: 200, redirected: true, url: 'https://files.oaiusercontent.com/private-signed-redirect', headers: { get: () => 'text/html' }, body: { cancel() {} } }),
      key: 'endpoint_1_redirect',
    },
    {
      name: 'non-HTML response',
      response: () => ({ ok: true, status: 200, redirected: false, url: 'https://files.oaiusercontent.com/private-direct-download', headers: { get: () => 'application/octet-stream' }, body: { cancel() {} } }),
      key: 'endpoint_1_non_html_response',
    },
  ]) {
    await t.test(fixture.name, async () => {
      const harness = createPageExportHarness({ id: 'pdf-id', name: 'receipt.pdf', mime_type: 'application/pdf' }, (_url, _call, jsonResponse) => fixture.response(jsonResponse));
      const result = await harness.pageExport();
      assert.equal(result.attachmentResolverDiagnostics[fixture.key], 1);
      assert.equal(result.attachmentResolverDiagnostics.resolved, 1);
      assert.equal(harness.endpointCalls.length, 1);
    });
  }
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
  assert.equal(result.attachments[0].attachmentKey, 'pdf-id');
  assert.equal(result.attachments[0].name, 'receipt.pdf');
  assert.equal(result.token, 'transient-secret-token');
});


test('image resolver diagnostics classify unresolved image assets without leaking private values', async () => {
  const privateImageId = 'private-image-id-do-not-report';
  const privatePdfId = 'private-pdf-id-do-not-report';
  const privateSignedPdf = 'https://files.oaiusercontent.com/private-signed-pdf-do-not-report';
  const harness = createPageExportHarness(
    { id: privatePdfId, name: 'private-receipt-name.pdf', mime_type: 'application/pdf' },
    (url, _call, jsonResponse) => {
      if (url.includes(privateImageId)) return jsonResponse({}, { ok: false, status: 403 });
      if (url.includes(privatePdfId)) return jsonResponse({ download_url: privateSignedPdf });
      throw new Error('unexpected resolver request');
    },
    privateImageId
  );

  const result = await harness.pageExport(true);
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0].url, null);
  assert.equal(result.imageDiscoveryDiagnostics.source_image_asset_pointer, 1);
  assert.equal(result.imageDiscoveryDiagnostics.pointer_normalized, 1);
  assert.equal(result.imageDiscoveryDiagnostics.pointer_missing_or_invalid, 0);
  assert.equal(result.imageDiscoveryDiagnostics.unique_discovered, 1);
  assert.equal(result.imageDiscoveryDiagnostics.preview_associated, 1);
  assert.equal(result.resolutionDiagnostics.attempts, 2);
  assert.equal(result.resolutionDiagnostics.resolved, 0);
  assert.equal(result.resolutionDiagnostics.final_no_url, 1);
  assert.equal(result.resolutionDiagnostics.http_403, 2);
  assert.equal(result.resolutionDiagnostics.endpoint_1_http_403, 1);
  assert.equal(result.resolutionDiagnostics.endpoint_2_http_403, 1);

  const report = loadHelpers().buildExportReport(
    { detected: 1, downloaded: 0, failed: 1, excluded_pdf_previews: 0, diagnostics: { no_url: 1 } },
    { detected: 1, downloaded: 1, failed: 0, diagnostics: { direct_ok: 1 } },
    true,
    result.attachmentResolverDiagnostics,
    result.resolutionDiagnostics,
    result.imageDiscoveryDiagnostics
  );
  assert.match(report, /image-source-image_asset_pointer: 1/);
  assert.match(report, /image-resolver-final_no_url: 1/);
  assert.match(report, /image-resolver-endpoint_1-http_403: 1/);
  assert.match(report, /image-resolver-endpoint_2-http_403: 1/);
  for (const secret of [
    privateImageId,
    privatePdfId,
    privateSignedPdf,
    'private-receipt-name.pdf',
    'resolver-test-bearer-secret',
  ]) assert.equal(report.includes(secret), false);
});

test('file export report distinguishes PDF-preview exclusion from remaining image failures', () => {
  const report = loadHelpers().buildExportReport(
    { detected: 135, downloaded: 133, failed: 2, excluded_pdf_previews: 2, diagnostics: { no_url: 2 } },
    { detected: 1, downloaded: 1, failed: 0, diagnostics: { direct_ok: 1 } },
    true,
    {},
    { attempts: 139, resolved: 135, final_no_url: 2, http_403: 4 },
    {
      source_image_asset_pointer: 137,
      pointer_normalized: 137,
      unique_discovered: 137,
      preview_associated: 2,
    }
  );
  assert.match(report, /Images detected: 135/);
  assert.match(report, /image-preview-excluded-as-exported-pdf: 2/);
  assert.match(report, /image-unique-discovered: 137/);
  assert.match(report, /image-resolver-final_no_url: 2/);
  assert.match(report, /image-no_url: 2/);
});

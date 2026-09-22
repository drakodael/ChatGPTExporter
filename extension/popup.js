const statusEl = document.getElementById("status");
const downloadBtn = document.getElementById("download");
const imagesToggle = document.getElementById("images");
const attachmentsToggle = document.getElementById("attachments");

const CHATGPT_URL = /^https:\/\/chatgpt\.com\//;
const IMAGE_HOST_PERMISSIONS = [
  "https://chatgpt.com/*",
  "https://*.oaiusercontent.com/*",
];
const ZIP_TRANSFER_CHUNK_BYTES = 8 * 1024 * 1024;

function setStatus(message, kind = "") {
  statusEl.textContent = message;
  statusEl.className = kind;
}

function errMsg(e) {
  return e && e.message ? e.message : String(e);
}

async function getActiveChatTab() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !CHATGPT_URL.test(tab.url)) return null;
  return tab;
}

function downloadFileInPage(filename, content, mimeType) {
  const transferKey = "__chatgptExporterZipTransfer";
  const transfer = content === null ? globalThis[transferKey] : null;
  if (content === null && !transfer) throw new Error("The ZIP data is no longer available.");

  let objectURL = null;
  try {
    const blob = transfer
      ? new Blob(transfer.parts, { type: transfer.mimeType })
      : new Blob([content], { type: mimeType });
    objectURL = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectURL;
    anchor.download = filename;
    anchor.rel = "noopener";
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    try {
      anchor.click();
    } finally {
      anchor.remove();
    }
    return true;
  } finally {
    if (transfer) {
      transfer.parts.length = 0;
      delete globalThis[transferKey];
    }
    if (objectURL) setTimeout(() => URL.revokeObjectURL(objectURL), 60000);
  }
}

function beginZipDownloadInPage(mimeType) {
  const transferKey = "__chatgptExporterZipTransfer";
  if (globalThis[transferKey]) throw new Error("A ZIP download is already being prepared.");
  globalThis[transferKey] = { mimeType, parts: [] };
  return true;
}

function appendZipDownloadChunkInPage(base64Chunk) {
  const transfer = globalThis.__chatgptExporterZipTransfer;
  if (!transfer || typeof base64Chunk !== "string") throw new Error("The ZIP transfer is not available.");
  const binary = atob(base64Chunk);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  transfer.parts.push(bytes);
  return bytes.length;
}

function cancelZipDownloadInPage() {
  const transfer = globalThis.__chatgptExporterZipTransfer;
  if (transfer) transfer.parts.length = 0;
  delete globalThis.__chatgptExporterZipTransfer;
}

function bytesToBase64(bytes) {
  let binary = "";
  const blockSize = 0x4000;
  for (let offset = 0; offset < bytes.length; offset += blockSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + blockSize));
  }
  return btoa(binary);
}

async function downloadZipFromPopup(tabId, filename, blob) {
  const target = { tabId };
  const mimeType = blob.type || "application/zip";
  let transferStarted = false;
  try {
    // executeScript arguments must be JSON-serializable; transfer bounded slices
    // instead of serializing the complete ZIP or attempting to pass a Blob.
    await browser.scripting.executeScript({
      target,
      func: beginZipDownloadInPage,
      args: [mimeType],
    });
    transferStarted = true;

    for (let offset = 0; offset < blob.size; offset += ZIP_TRANSFER_CHUNK_BYTES) {
      const end = Math.min(offset + ZIP_TRANSFER_CHUNK_BYTES, blob.size);
      const chunkBytes = new Uint8Array(await blob.slice(offset, end).arrayBuffer());
      const encodedChunk = bytesToBase64(chunkBytes);
      await browser.scripting.executeScript({
        target,
        func: appendZipDownloadChunkInPage,
        args: [encodedChunk],
      });
    }

    const [injection] = await browser.scripting.executeScript({
      target,
      func: downloadFileInPage,
      args: [filename, null, mimeType],
    });
    if (!injection || injection.result !== true) throw new Error("Safari did not start the ZIP download.");
    transferStarted = false;
    return true;
  } finally {
    if (transferStarted) {
      try {
        await browser.scripting.executeScript({ target, func: cancelZipDownloadInPage });
      } catch (_) {
        // The page may have navigated or lost access while the transfer was in progress.
      }
    }
  }
}

function requestFileHostPermissionFromGesture() {
  // Safari requires permissions.request() to be invoked synchronously from
  // the user's click handler, before any await or other async boundary.
  return browser.permissions.request({
    origins: IMAGE_HOST_PERMISSIONS,
  });
}

function isAllowedImageURL(value) {
  try {
    const u = new URL(value);
    const host = u.hostname.toLowerCase();
    return (
      u.protocol === "https:" &&
      (host === "chatgpt.com" || host === "oaiusercontent.com" || host.endsWith(".oaiusercontent.com"))
    );
  } catch (_) {
    return false;
  }
}

function extensionFromContentType(contentType, fallbackName) {
  const type = String(contentType || "").toLowerCase();

  if (type.includes("jpeg") || type.includes("jpg")) return "jpg";
  if (type.includes("webp")) return "webp";
  if (type.includes("gif")) return "gif";
  if (type.includes("avif")) return "avif";
  if (type.includes("png")) return "png";

  const m = String(fallbackName || "").match(/\.([A-Za-z0-9]{2,5})$/);
  if (m) {
    const ext = m[1].toLowerCase();
    if (["png", "jpg", "jpeg", "webp", "gif", "avif"].includes(ext)) {
      return ext === "jpeg" ? "jpg" : ext;
    }
  }

  return "png";
}

function safeAttachmentName(name, index, mime) {
  const basename = String(name || "")
    .replace(/\\/g, "/")
    .split("/").pop()
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 120);
  const mimeExt = /pdf/i.test(mime || "") ? "pdf" : "bin";
  const safe = basename || `attachment-${String(index).padStart(3, "0")}.${mimeExt}`;
  const ext = safe.match(/\.([A-Za-z0-9]{1,8})$/);
  const allowed = new Set(["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "csv", "zip", "json", "png", "jpg", "jpeg", "webp", "gif", "bin"]);
  if (!ext || !allowed.has(ext[1].toLowerCase())) return `${safe.replace(/\.[^.]*$/, "") || `attachment-${String(index).padStart(3, "0")}`}.${mimeExt}`;
  return safe;
}

function crc32(bytes) {
  if (!crc32.table) {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[n] = c >>> 0;
    }
    crc32.table = table;
  }

  let crc = 0xffffffff;
  for (const b of bytes) {
    crc = crc32.table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(view, offset, value) {
  view.setUint16(offset, value, true);
}

function u32(view, offset, value) {
  view.setUint32(offset, value >>> 0, true);
}

function dosTimeDate(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time:
      ((date.getHours() & 0x1f) << 11) |
      ((date.getMinutes() & 0x3f) << 5) |
      (Math.floor(date.getSeconds() / 2) & 0x1f),
    day:
      (((year - 1980) & 0x7f) << 9) |
      (((date.getMonth() + 1) & 0x0f) << 5) |
      (date.getDate() & 0x1f),
  };
}

// Build a stored (uncompressed) ZIP as Blob parts. Images are already compressed,
// so re-compressing PNG/JPEG/WebP would add CPU without meaningful savings.
// Returning a Blob avoids allocating a second full-size copy of the archive.
function buildZipBlob(entries, rootName) {
  const enc = new TextEncoder();
  const now = dosTimeDate(new Date());
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  let centralSize = 0;
  const emptyDirectory = () => new Uint8Array(0);
  const rootedEntries = [
    { name: `${rootName}/`, data: emptyDirectory() },
    { name: `${rootName}/images/`, data: emptyDirectory() },
    { name: `${rootName}/attachments/`, data: emptyDirectory() },
    ...entries.map((entry) => ({ ...entry, name: `${rootName}/${entry.name}` })),
  ];

  for (const entry of rootedEntries) {
    const nameBytes = enc.encode(entry.name);
    const data = entry.data;
    const crc = crc32(data);

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    u32(lv, 0, 0x04034b50);
    u16(lv, 4, 20);
    u16(lv, 6, 0x0800);
    u16(lv, 8, 0);
    u16(lv, 10, now.time);
    u16(lv, 12, now.day);
    u32(lv, 14, crc);
    u32(lv, 18, data.length);
    u32(lv, 22, data.length);
    u16(lv, 26, nameBytes.length);
    u16(lv, 28, 0);
    local.set(nameBytes, 30);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    u32(cv, 0, 0x02014b50);
    u16(cv, 4, 20);
    u16(cv, 6, 20);
    u16(cv, 8, 0x0800);
    u16(cv, 10, 0);
    u16(cv, 12, now.time);
    u16(cv, 14, now.day);
    u32(cv, 16, crc);
    u32(cv, 20, data.length);
    u32(cv, 24, data.length);
    u16(cv, 28, nameBytes.length);
    u16(cv, 30, 0);
    u16(cv, 32, 0);
    u16(cv, 34, 0);
    u16(cv, 36, 0);
    u32(cv, 38, 0);
    u32(cv, 42, localOffset);
    central.set(nameBytes, 46);

    localParts.push(local, data);
    centralParts.push(central);

    localOffset += local.length + data.length;
    centralSize += central.length;
  }

  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  u32(ev, 0, 0x06054b50);
  u16(ev, 4, 0);
  u16(ev, 6, 0);
  u16(ev, 8, rootedEntries.length);
  u16(ev, 10, rootedEntries.length);
  u32(ev, 12, centralSize);
  u32(ev, 16, localOffset);
  u16(ev, 20, 0);

  return new Blob([...localParts, ...centralParts, end], {
    type: "application/zip",
  });
}

function replaceAllLiteral(text, from, to) {
  return String(text).split(from).join(to);
}

async function fetchImagesForArchive(images, accessToken) {
  const files = new Map();
  let failed = 0;

  // Safe aggregate diagnostics only. No URLs, file IDs, response bodies, or
  // bearer token values are stored here.
  const diagnostics = {
    direct_ok: 0,
    auth_ok: 0,
    invalid_host: 0,
    no_url: 0,
    http_401: 0,
    http_403: 0,
    http_404: 0,
    http_429: 0,
    http_5xx: 0,
    http_other: 0,
    content_type: 0,
    network: 0,
    invalid_hostnames: {},
  };

  function recordHTTP(status) {
    if (status === 401) diagnostics.http_401++;
    else if (status === 403) diagnostics.http_403++;
    else if (status === 404) diagnostics.http_404++;
    else if (status === 429) diagnostics.http_429++;
    else if (status >= 500) diagnostics.http_5xx++;
    else diagnostics.http_other++;
  }

  async function attempt(image, authorization) {
    const headers = {};
    if (authorization) headers.Authorization = `Bearer ${authorization}`;

    let response;
    try {
      response = await fetch(image.url, {
        method: "GET",
        headers,
        credentials: "omit",
        cache: "no-store",
        redirect: "follow",
      });
    } catch (_) {
      return { ok: false, reason: "network" };
    }

    if (!response.ok) {
      return { ok: false, reason: "http", status: response.status };
    }

    const contentType = response.headers.get("content-type") || "";
    if (contentType && !contentType.toLowerCase().startsWith("image/")) {
      return { ok: false, reason: "content_type" };
    }

    try {
      const bytes = new Uint8Array(await response.arrayBuffer());
      return { ok: true, bytes, contentType };
    } catch (_) {
      return { ok: false, reason: "network" };
    }
  }

  for (let index = 0; index < (images || []).length; index++) {
    const image = images[index];

    setStatus(`Downloading image ${index + 1} of ${images.length}…`);

    if (!image || !image.fileId || !image.url) {
      if (image && image.fileId) files.set(image.fileId, null);
      diagnostics.no_url++;
      failed++;
      continue;
    }

    if (!isAllowedImageURL(image.url)) {
      files.set(image.fileId, null);
      diagnostics.invalid_host++;

      try {
        const host = new URL(image.url).hostname.toLowerCase();
        if (host) {
          diagnostics.invalid_hostnames[host] =
            (diagnostics.invalid_hostnames[host] || 0) + 1;
        }
      } catch (_) {}

      failed++;
      continue;
    }

    // First try the pre-signed OpenAI CDN URL without authorization.
    let outcome = await attempt(image, null);
    let usedAuth = false;

    // If the signed request fails, retry the SAME validated OpenAI CDN URL with
    // the transient ChatGPT bearer token. The token never goes to another host.
    if (!outcome.ok && accessToken) {
      outcome = await attempt(image, accessToken);
      usedAuth = outcome.ok;
    }

    if (!outcome.ok) {
      files.set(image.fileId, null);
      failed++;

      if (outcome.reason === "http") recordHTTP(outcome.status);
      else if (outcome.reason === "content_type") diagnostics.content_type++;
      else diagnostics.network++;

      continue;
    }

    const ext = extensionFromContentType(outcome.contentType, image.name);
    const name = `image-${String(index + 1).padStart(3, "0")}.${ext}`;

    files.set(image.fileId, { name, bytes: outcome.bytes });

    if (usedAuth) diagnostics.auth_ok++;
    else diagnostics.direct_ok++;
  }

  return { files, failed, diagnostics };
}

async function fetchAttachmentsForArchive(attachments, accessToken) {
  const files = [];
  const diagnostics = { direct_ok: 0, auth_ok: 0, no_url: 0, invalid_host: 0, content_type: 0, network: 0, http_401: 0, http_403: 0, http_404: 0, http_429: 0, http_5xx: 0, http_other: 0 };
  let failed = 0;
  for (let index = 0; index < (attachments || []).length; index++) {
    const attachment = attachments[index];
    setStatus(`Downloading attachment ${index + 1} of ${attachments.length}…`);
    if (!attachment || !attachment.url) { diagnostics.no_url++; failed++; continue; }
    if (!isAllowedImageURL(attachment.url)) { diagnostics.invalid_host++; failed++; continue; }
    const attempt = async (token) => {
      try {
        const response = await fetch(attachment.url, {
          method: "GET", headers: token ? { Authorization: `Bearer ${token}` } : {},
          credentials: "omit", cache: "no-store", redirect: "follow",
        });
        if (!response.ok) return { reason: "http", status: response.status };
        const contentType = response.headers.get("content-type") || attachment.mime || "application/octet-stream";
        if (/^(?:image\/|text\/html)/i.test(contentType)) return { reason: "content_type" };
        return { bytes: new Uint8Array(await response.arrayBuffer()), contentType };
      } catch (_) { return { reason: "network" }; }
    };
    let outcome = await attempt(null);
    let usedAuth = false;
    if (outcome.reason && accessToken) { outcome = await attempt(accessToken); usedAuth = !outcome.reason; }
    if (outcome.reason) {
      failed++;
      if (outcome.reason === "http") {
        const status = outcome.status;
        const key = status === 401 ? "http_401" : status === 403 ? "http_403" : status === 404 ? "http_404" : status === 429 ? "http_429" : status >= 500 ? "http_5xx" : "http_other";
        diagnostics[key]++;
      } else diagnostics[outcome.reason]++;
      continue;
    }
    const name = safeAttachmentName(attachment.name, index + 1, outcome.contentType || attachment.mime);
    files.push({ attachmentKey: attachment.attachmentKey, name, bytes: outcome.bytes });
    diagnostics[usedAuth ? "auth_ok" : "direct_ok"]++;
  }
  return { files, failed, diagnostics };
}

function buildExportReport(imageResult, attachmentResult, hadToken, attachmentResolverDiagnostics, imageResolverDiagnostics, imageDiscoveryDiagnostics) {
  const images = imageResult || {};
  const attachments = attachmentResult || {};
  const resolver = attachmentResolverDiagnostics || {};
  const imageResolver = imageResolverDiagnostics || {};
  const imageDiscovery = imageDiscoveryDiagnostics || {};
  const imageResolverOutcomeKeys = [
    "success_json", "success_response", "json_no_url", "html_rejected",
    "http_401", "http_403", "http_404", "http_429", "http_5xx", "http_other",
    "network", "timeout",
  ];
  const resolverOutcomeKeys = [
    "http_401", "http_403", "http_404", "http_429", "http_5xx", "http_other",
    "network", "timeout", "json_download_url", "json_metadata_download_url",
    "json_no_url", "redirect", "non_html_response", "html_no_url",
  ];
  const candidateSources = ["id", "file_id", "asset_pointer"];
  return [
    "ChatGPT Local Exporter - file export report", "Version: 2.9-private", "",
    `Images detected: ${images.detected || 0}`,
    `Images downloaded: ${images.downloaded || 0}`,
    `Images failed: ${images.failed || 0}`, "",
    "Image failure categories (aggregate only):",
    ...["no_url", "invalid_host", "http_401", "http_403", "http_404", "http_429", "http_5xx", "http_other", "content_type", "network"].map((key) => `image-${key}: ${(images.diagnostics && images.diagnostics[key]) || 0}`), "",
    "Image discovery diagnostics (aggregate only):",
    `image-source-image_asset_pointer: ${imageDiscovery.source_image_asset_pointer || 0}`,
    `image-pointer-normalized: ${imageDiscovery.pointer_normalized || 0}`,
    `image-pointer-missing_or_invalid: ${imageDiscovery.pointer_missing_or_invalid || 0}`,
    `image-unique-discovered: ${imageDiscovery.unique_discovered || 0}`,
    `image-duplicate-pointer: ${imageDiscovery.duplicate_pointer || 0}`,
    `image-preview-associated: ${imageDiscovery.preview_associated || 0}`,
    `image-preview-excluded-as-exported-pdf: ${images.excluded_pdf_previews || 0}`, "",
    "Image resolver diagnostics (aggregate only):",
    `image-resolver-attempts: ${imageResolver.attempts || 0}`,
    `image-resolver-resolved: ${imageResolver.resolved || 0}`,
    `image-resolver-final_no_url: ${imageResolver.final_no_url || 0}`,
    `image-resolver-retries: ${imageResolver.retries || 0}`,
    `image-resolver-scoped-attempts: ${imageResolver.scoped_attempts || 0}`,
    `image-resolver-scoped-resolved: ${imageResolver.scoped_resolved || 0}`,
    `image-resolver-scoped-http_403: ${imageResolver.scoped_http_403 || 0}`,
    ...imageResolverOutcomeKeys.map((key) => `image-resolver-${key}: ${imageResolver[key] || 0}`),
    ...[1, 2].flatMap((endpointNumber) => [
      `image-resolver-endpoint_${endpointNumber}-attempts: ${imageResolver[`endpoint_${endpointNumber}_attempts`] || 0}`,
      `image-resolver-endpoint_${endpointNumber}-resolved: ${imageResolver[`endpoint_${endpointNumber}_resolved`] || 0}`,
      `image-resolver-endpoint_${endpointNumber}-scoped-attempts: ${imageResolver[`endpoint_${endpointNumber}_scoped_attempts`] || 0}`,
      `image-resolver-endpoint_${endpointNumber}-scoped-resolved: ${imageResolver[`endpoint_${endpointNumber}_scoped_resolved`] || 0}`,
      `image-resolver-endpoint_${endpointNumber}-scoped-http_403: ${imageResolver[`endpoint_${endpointNumber}_scoped_http_403`] || 0}`,
      ...imageResolverOutcomeKeys.map((key) => `image-resolver-endpoint_${endpointNumber}-${key}: ${imageResolver[`endpoint_${endpointNumber}_${key}`] || 0}`),
    ]), "",
    `Attachments detected: ${attachments.detected || 0}`,
    `Attachments downloaded: ${attachments.downloaded || 0}`,
    `Attachments failed: ${attachments.failed || 0}`,
    `Attachment direct downloads: ${(attachments.diagnostics && attachments.diagnostics.direct_ok) || 0}`,
    `Attachment authenticated downloads: ${(attachments.diagnostics && attachments.diagnostics.auth_ok) || 0}`,
    `Transient session token available: ${hadToken ? "yes" : "no"}`, "",
    "Attachment diagnostics (downloader stage, aggregate only):",
    ...["direct_ok", "auth_ok", "no_url", "invalid_host", "http_401", "http_403", "http_404", "http_429", "http_5xx", "http_other", "content_type", "network"].map((key) => `attachment-${key}: ${(attachments.diagnostics && attachments.diagnostics[key]) || 0}`), "",
    "Attachment resolver diagnostics (aggregate only):",
    `attachment-id_source-id: ${resolver.id_source_id || 0}`,
    `attachment-id_source-file_id: ${resolver.id_source_file_id || 0}`,
    `attachment-id_source-asset_pointer: ${resolver.id_source_asset_pointer || 0}`,
    ...candidateSources.map((source) => `attachment-candidate-present-${source}: ${resolver[`candidate_present_${source}`] || 0}`),
    ...candidateSources.map((source) => `attachment-candidate-attempt-${source}: ${resolver[`candidate_attempt_${source}`] || 0}`),
    ...candidateSources.map((source) => `attachment-candidate-resolved-${source}: ${resolver[`candidate_resolved_${source}`] || 0}`),
    `attachment-resolver-attempts: ${resolver.attempts || 0}`,
    `attachment-resolver-resolved: ${resolver.resolved || 0}`,
    `attachment-resolver-conversation_scoped-attempts: ${resolver.conversation_scoped_attempts || 0}`,
    `attachment-resolver-conversation_scoped-resolved: ${resolver.conversation_scoped_resolved || 0}`,
    `attachment-resolver-conversation_scoped-http_403: ${resolver.conversation_scoped_http_403 || 0}`,
    ...[1, 2].flatMap((endpointNumber) => [
      `attachment-resolver-endpoint_${endpointNumber}-scoped-attempts: ${resolver[`endpoint_${endpointNumber}_scoped_attempts`] || 0}`,
      `attachment-resolver-endpoint_${endpointNumber}-scoped-resolved: ${resolver[`endpoint_${endpointNumber}_scoped_resolved`] || 0}`,
      `attachment-resolver-endpoint_${endpointNumber}-scoped-http_403: ${resolver[`endpoint_${endpointNumber}_scoped_http_403`] || 0}`,
    ]),
    ...resolverOutcomeKeys.map((key) => `attachment-resolver-${key}: ${resolver[key] || 0}`),
    ...[1, 2].flatMap((endpointNumber) => [
      `attachment-resolver-endpoint_${endpointNumber}-attempts: ${resolver[`endpoint_${endpointNumber}_attempts`] || 0}`,
      ...resolverOutcomeKeys.map((key) => `attachment-resolver-endpoint_${endpointNumber}-${key}: ${resolver[`endpoint_${endpointNumber}_${key}`] || 0}`),
    ]), "",
    "Privacy:", "- Aggregate counts only; no token, ID, private resource name, URL, or response body is included.", "",
  ].join("\n");
}

function buildImageExportReport(images, fetched, hadToken, resolutionDiagnostics) {
  const d = (fetched && fetched.diagnostics) || {};
  const detected = Array.isArray(images) ? images.length : 0;
  const resolvedURLs = (images || []).filter((image) => image && image.url).length;
  const downloaded = fetched
    ? [...fetched.files.values()].filter(Boolean).length
    : 0;
  const failed = fetched ? fetched.failed : detected;
  const r = resolutionDiagnostics || {};

  const lines = [
    "ChatGPT Local Exporter - image export report",
    "Version: 2.7-private",
    "",
    `Images detected: ${detected}`,
    `Images with resolved URL: ${resolvedURLs}`,
    `Images downloaded: ${downloaded}`,
    `Images failed: ${failed}`,
    `Direct signed-URL downloads: ${d.direct_ok || 0}`,
    `Authenticated downloads: ${d.auth_ok || 0}`,
    `Transient session token available: ${hadToken ? "yes" : "no"}`,
    "",
    "Failure categories:",
    `no-url: ${d.no_url || 0}`,
    `invalid-host: ${d.invalid_host || 0}`,
    `401: ${d.http_401 || 0}`,
    `403: ${d.http_403 || 0}`,
    `404: ${d.http_404 || 0}`,
    `429: ${d.http_429 || 0}`,
    `5xx: ${d.http_5xx || 0}`,
    `http-other: ${d.http_other || 0}`,
    `content-type: ${d.content_type || 0}`,
    `network: ${d.network || 0}`,
    "",
    "Rejected hostnames (hostname only; no URL path/query):",
    ...Object.entries(d.invalid_hostnames || {})
      .sort((a, b) => b[1] - a[1])
      .map(([host, count]) => `${host}: ${count}`),
    "",
    "Resolver diagnostics (aggregate only):",
    `success-json: ${r.success_json || 0}`,
    `success-response: ${r.success_response || 0}`,
    `json-no-url: ${r.json_no_url || 0}`,
    `html-rejected: ${r.html_rejected || 0}`,
    `resolver-401: ${r.http_401 || 0}`,
    `resolver-403: ${r.http_403 || 0}`,
    `resolver-404: ${r.http_404 || 0}`,
    `resolver-429: ${r.http_429 || 0}`,
    `resolver-5xx: ${r.http_5xx || 0}`,
    `resolver-http-other: ${r.http_other || 0}`,
    `resolver-network: ${r.network || 0}`,
    `resolver-retries: ${r.retries || 0}`,
    "",
    "Privacy:",
    "- This report contains aggregate counts only.",
    "- It does not contain the ChatGPT access token.",
    "- It does not contain signed URLs or file IDs.",
    "",
  ];

  return lines.join("\n");
}

function buildArchiveMarkdown(markdownTemplate, images, fetched) {
  let markdown = markdownTemplate;
  const entries = [];

  for (const image of images || []) {
    const token = `@@IMG@@${image.fileId}@@`;
    const file = fetched.files.get(image.fileId);

    if (file) {
      markdown = replaceAllLiteral(
        markdown,
        token,
        `![image](images/${file.name})`
      );
      entries.push({
        name: `images/${file.name}`,
        data: file.bytes,
      });
    } else {
      markdown = replaceAllLiteral(
        markdown,
        token,
        "_[image omitted: download failed]_"
      );
    }
  }

  markdown = markdown.replace(
    /@@IMG@@[^@]+@@/g,
    "_[image omitted: unavailable]_"
  );

  entries.unshift({
    name: "conversation.md",
    data: new TextEncoder().encode(markdown),
  });

  return entries;
}

function uniqueAttachmentArchiveNames(attachments) {
  const usedNames = new Set();
  const names = new Map();
  for (const attachment of attachments || []) {
    if (!attachment || !attachment.bytes) continue;
    const original = attachment.name;
    const dot = original.lastIndexOf(".");
    const stem = dot > 0 ? original.slice(0, dot) : original;
    const ext = dot > 0 ? original.slice(dot) : "";
    let name = original;
    let suffix = 2;
    while (usedNames.has(name)) name = `${stem}-${suffix++}${ext}`;
    usedNames.add(name);
    names.set(attachment.attachmentKey, name);
  }
  return names;
}

function addAttachmentsToArchive(entries, attachments) {
  const names = uniqueAttachmentArchiveNames(attachments);
  for (const attachment of attachments || []) {
    const name = names.get(attachment && attachment.attachmentKey);
    if (name) entries.push({ name: `attachments/${name}`, data: attachment.bytes });
  }
}

function linkDownloadedAttachments(markdown, descriptors, files) {
  const byId = new Map((files || []).map((file) => [file.attachmentKey, file]));
  const archiveNames = uniqueAttachmentArchiveNames(files);
  let output = markdown;
  for (const descriptor of descriptors || []) {
    const file = byId.get(descriptor.attachmentKey);
    if (!file) continue;
    const label = descriptor.name || file.name;
    const archiveName = archiveNames.get(file.attachmentKey) || file.name;
    output = replaceAllLiteral(output, `_[attachment omitted: ${label}]_`, `[${label.replace(/\]/g, "\\]")}](attachments/${archiveName})`);
  }
  return output;
}

function markSkippedPDFPreviews(markdown, skipped, downloadedAttachments) {
  const files = new Map((downloadedAttachments || []).map((file) => [file.attachmentKey, file]));
  let output = markdown;
  for (const image of skipped || []) {
    const attachment = files.get(image.previewAttachmentId);
    if (!attachment) continue;
    const token = `@@IMG@@${image.fileId}@@`;
    output = replaceAllLiteral(output, token, `_[PDF page preview omitted; original PDF: ${attachment.name}]_`);
  }
  return output;
}

function excludeSuccessfulPDFPreviews(images, downloadedAttachments) {
  const downloadedIds = new Set((downloadedAttachments || []).map((file) => file && file.attachmentKey).filter(Boolean));
  const skipped = [];
  const remaining = [];
  for (const image of images || []) {
    if (image && image.previewAttachmentId && downloadedIds.has(image.previewAttachmentId)) skipped.push(image);
    else remaining.push(image);
  }
  return { images: remaining, skipped };
}

async function exportConversation(includeImages, includeAttachments, permissionPromise) {

  downloadBtn.disabled = true;
    imagesToggle.disabled = true;
    attachmentsToggle.disabled = true;

  try {
    const tab = await getActiveChatTab();
    if (!tab) {
      setStatus("Open a conversation on chatgpt.com first.", "err");
      return;
    }

    if (includeImages || includeAttachments) {
      setStatus("Requesting temporary access to OpenAI file hosts…");

      let granted = false;
      try {
        granted = !!(await permissionPromise);
      } catch (e) {
        setStatus(
          "Safari could not request temporary file access: " + errMsg(e),
          "err"
        );
        return;
      }

      if (!granted) {
        setStatus(
          "File export was cancelled because Safari did not grant access to the required OpenAI hosts.",
          "err"
        );
        return;
      }
    }

    setStatus(includeImages ? "Reading conversation and locating images…" : "Exporting locally…");

    let injection;
    try {
      [injection] = await browser.scripting.executeScript({
        target: { tabId: tab.id },
        func: pageExport,
        args: [includeImages, includeAttachments],
      });
    } catch (_) {
      setStatus(
        "Safari did not allow access to this tab. Open the extension from the ChatGPT tab and try again.",
        "err"
      );
      return;
    }

    const result = injection && injection.result;
    if (!result) {
      setStatus("No response was returned from the ChatGPT page.", "err");
      return;
    }
    if (result.error) {
      setStatus(result.error, "err");
      return;
    }

    const markdown = buildMarkdown(result);
    const base = safeName(result.title);

    if (!includeImages && !includeAttachments) {
      const filename = exportFilename(result.title, "md");

      try {
        await browser.scripting.executeScript({
          target: { tabId: tab.id },
          func: downloadFileInPage,
          args: [filename, markdown, "text/markdown;charset=utf-8"],
        });
      } catch (e) {
        setStatus("Safari could not start the file download: " + errMsg(e), "err");
        return;
      }

      setStatus(`✓ Download requested: ${filename}`, "ok");
      return;
    }

    const images = result.images || [];
    const attachmentDescriptors = result.attachments || [];
    const accessToken = typeof result.token === "string" ? result.token : null;
    delete result.token;
    if (!images.length && !attachmentDescriptors.length) {
      const filename = exportFilename(result.title, "zip");
      const emptyFetched = {
        files: new Map(),
        failed: 0,
        diagnostics: {},
      };
      const report = buildExportReport(
        { detected: 0, downloaded: 0, failed: 0, excluded_pdf_previews: 0 },
        { detected: 0, downloaded: 0, failed: 0 },
        false,
        result.attachmentResolverDiagnostics,
        result.resolutionDiagnostics,
        result.imageDiscoveryDiagnostics
      );
      const entries = [
        {
          name: "conversation.md",
          data: new TextEncoder().encode(markdown),
        },
        {
          name: "export-report.txt",
          data: new TextEncoder().encode(report),
        },
      ];
      await downloadZipFromPopup(tab.id, filename, buildZipBlob(entries, base));
      setStatus("✓ ZIP requested. No exportable images were found in this chat.", "ok");
      return;
    }

    // Keep the bearer token only in a local variable for the duration of image
    // fetching. Remove it from the result object immediately so it cannot be
    // accidentally included in later processing.
    const fetchedAttachments = await fetchAttachmentsForArchive(attachmentDescriptors, accessToken);
    const imageSelection = excludeSuccessfulPDFPreviews(images, fetchedAttachments.files);
    const fetched = await fetchImagesForArchive(imageSelection.images, accessToken);
    setStatus("Building ZIP locally…");

    const linkedMarkdown = linkDownloadedAttachments(markdown, attachmentDescriptors, fetchedAttachments.files);
    const attachmentMarkdown = markSkippedPDFPreviews(linkedMarkdown, imageSelection.skipped, fetchedAttachments.files);
    const entries = buildArchiveMarkdown(attachmentMarkdown, imageSelection.images, fetched);
    addAttachmentsToArchive(entries, fetchedAttachments.files);
    const imageDownloaded = [...fetched.files.values()].filter(Boolean).length;
    const report = buildExportReport(
      {
        detected: images.length - imageSelection.skipped.length,
        downloaded: imageDownloaded,
        failed: fetched.failed,
        excluded_pdf_previews: imageSelection.skipped.length,
        diagnostics: fetched.diagnostics,
      },
      { detected: attachmentDescriptors.length, downloaded: fetchedAttachments.files.length, failed: fetchedAttachments.failed, diagnostics: fetchedAttachments.diagnostics },
      !!accessToken,
      result.attachmentResolverDiagnostics,
      result.resolutionDiagnostics,
      result.imageDiscoveryDiagnostics
    );
    entries.push({
      name: "export-report.txt",
      data: new TextEncoder().encode(report),
    });

    const filename = exportFilename(result.title, "zip");
    const zipBlob = buildZipBlob(entries, base);

    await downloadZipFromPopup(tab.id, filename, zipBlob);

    const downloaded = [...fetched.files.values()].filter(Boolean).length;
    if (fetched.failed || fetchedAttachments.failed) {
      const d = fetched.diagnostics || {};
      const reasons = [];

      if (d.invalid_host) reasons.push(`invalid-host:${d.invalid_host}`);
      if (d.no_url) reasons.push(`no-url:${d.no_url}`);
      if (d.http_401) reasons.push(`401:${d.http_401}`);
      if (d.http_403) reasons.push(`403:${d.http_403}`);
      if (d.http_404) reasons.push(`404:${d.http_404}`);
      if (d.http_429) reasons.push(`429:${d.http_429}`);
      if (d.http_5xx) reasons.push(`5xx:${d.http_5xx}`);
      if (d.http_other) reasons.push(`http-other:${d.http_other}`);
      if (d.content_type) reasons.push(`content-type:${d.content_type}`);
      if (d.network) reasons.push(`network:${d.network}`);

      setStatus(
        `✓ ZIP requested: ${downloaded} image${downloaded === 1 ? "" : "s"}, ${fetchedAttachments.files.length} attachment${fetchedAttachments.files.length === 1 ? "" : "s"}; ` +
        `${fetched.failed + fetchedAttachments.failed} failed` +
        (reasons.length ? ` (${reasons.join(", ")})` : "") +
        `. Authenticated downloads: ${d.auth_ok || 0}.`,
        "ok"
      );
    } else {
      const authCount = (fetched.diagnostics && fetched.diagnostics.auth_ok) || 0;
      setStatus(
        `✓ ZIP requested: ${downloaded} image${downloaded === 1 ? "" : "s"}, ${fetchedAttachments.files.length} attachment${fetchedAttachments.files.length === 1 ? "" : "s"}. ` +
        `Authenticated downloads: ${authCount}.`,
        "ok"
      );
    }
  } catch (e) {
    setStatus("Export failed: " + errMsg(e), "err");
  } finally {
    downloadBtn.disabled = false;
    imagesToggle.disabled = false;
    attachmentsToggle.disabled = false;
  }
}

function refreshButtonLabel() {
  downloadBtn.textContent = imagesToggle.checked || attachmentsToggle.checked ? "Export ZIP" : "Export Markdown";
}

imagesToggle.addEventListener("change", refreshButtonLabel);
attachmentsToggle.addEventListener("change", refreshButtonLabel);

downloadBtn.addEventListener("click", () => {
  const includeImages = imagesToggle.checked;
  const includeAttachments = attachmentsToggle.checked;

  // IMPORTANT: this call must happen synchronously during the click.
  let permissionPromise = Promise.resolve(true);

  if (includeImages || includeAttachments) {
    try {
      permissionPromise = requestFileHostPermissionFromGesture();
    } catch (e) {
      setStatus(
        "Safari could not start the file permission request: " + errMsg(e),
        "err"
      );
      return;
    }
  }

  void exportConversation(includeImages, includeAttachments, permissionPromise);
});

refreshButtonLabel();

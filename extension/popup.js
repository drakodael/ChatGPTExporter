const statusEl = document.getElementById("status");
const downloadBtn = document.getElementById("download");
const imagesToggle = document.getElementById("images");

const CHATGPT_URL = /^https:\/\/chatgpt\.com\//;
const IMAGE_HOST_PERMISSIONS = [
  "https://chatgpt.com/*",
  "https://*.oaiusercontent.com/*",
];

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

function downloadMarkdownInPage(filename, markdown) {
  const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return true;
}

function requestImageCDNPermissionFromGesture() {
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
function buildZipBlob(entries) {
  const enc = new TextEncoder();
  const now = dosTimeDate(new Date());
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  let centralSize = 0;

  for (const entry of entries) {
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
  u16(ev, 8, entries.length);
  u16(ev, 10, entries.length);
  u32(ev, 12, centralSize);
  u32(ev, 16, localOffset);
  u16(ev, 20, 0);

  return new Blob([...localParts, ...centralParts, end], {
    type: "application/octet-stream",
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

function buildImageExportReport(images, fetched, hadToken) {
  const d = (fetched && fetched.diagnostics) || {};
  const detected = Array.isArray(images) ? images.length : 0;
  const resolvedURLs = (images || []).filter((image) => image && image.url).length;
  const downloaded = fetched
    ? [...fetched.files.values()].filter(Boolean).length
    : 0;
  const failed = fetched ? fetched.failed : detected;

  const lines = [
    "ChatGPT Local Exporter - image export report",
    "Version: 2.6-private",
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

function downloadBlobFromPopup(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();

  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

async function exportConversation(includeImages, permissionPromise) {

  downloadBtn.disabled = true;
  imagesToggle.disabled = true;

  try {
    const tab = await getActiveChatTab();
    if (!tab) {
      setStatus("Open a conversation on chatgpt.com first.", "err");
      return;
    }

    if (includeImages) {
      setStatus("Requesting access to ChatGPT image hosts…");

      let granted = false;
      try {
        granted = !!(await permissionPromise);
      } catch (e) {
        setStatus(
          "Safari could not request image CDN access: " + errMsg(e),
          "err"
        );
        return;
      }

      if (!granted) {
        setStatus(
          "Image export was cancelled because Safari did not grant access to the ChatGPT image hosts.",
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
        args: [includeImages],
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
    const base = `${safeName(result.title)}-${timestamp()}`;

    if (!includeImages) {
      const filename = `${base}.md`;

      try {
        await browser.scripting.executeScript({
          target: { tabId: tab.id },
          func: downloadMarkdownInPage,
          args: [filename, markdown],
        });
      } catch (e) {
        setStatus("Safari could not start the file download: " + errMsg(e), "err");
        return;
      }

      setStatus(`✓ Download requested: ${filename}`, "ok");
      return;
    }

    const images = result.images || [];
    if (!images.length) {
      const filename = `${base}.zip`;
      const emptyFetched = {
        files: new Map(),
        failed: 0,
        diagnostics: {},
      };
      const report = buildImageExportReport(images, emptyFetched, false);
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
      downloadBlobFromPopup(filename, buildZipBlob(entries));
      setStatus("✓ ZIP requested. No exportable images were found in this chat.", "ok");
      return;
    }

    // Keep the bearer token only in a local variable for the duration of image
    // fetching. Remove it from the result object immediately so it cannot be
    // accidentally included in later processing.
    const accessToken = typeof result.token === "string" ? result.token : null;
    delete result.token;

    const fetched = await fetchImagesForArchive(images, accessToken);
    setStatus("Building ZIP locally…");

    const entries = buildArchiveMarkdown(markdown, images, fetched);
    const report = buildImageExportReport(images, fetched, !!accessToken);
    entries.push({
      name: "export-report.txt",
      data: new TextEncoder().encode(report),
    });

    const filename = `${base}.zip`;
    const zipBlob = buildZipBlob(entries);

    downloadBlobFromPopup(filename, zipBlob);

    const downloaded = [...fetched.files.values()].filter(Boolean).length;
    if (fetched.failed) {
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
        `✓ ZIP requested with ${downloaded} image${downloaded === 1 ? "" : "s"}; ` +
        `${fetched.failed} failed` +
        (reasons.length ? ` (${reasons.join(", ")})` : "") +
        `. Authenticated downloads: ${d.auth_ok || 0}.`,
        "ok"
      );
    } else {
      const authCount = (fetched.diagnostics && fetched.diagnostics.auth_ok) || 0;
      setStatus(
        `✓ ZIP requested with ${downloaded} image${downloaded === 1 ? "" : "s"}. ` +
        `Authenticated downloads: ${authCount}.`,
        "ok"
      );
    }
  } catch (e) {
    setStatus("Export failed: " + errMsg(e), "err");
  } finally {
    downloadBtn.disabled = false;
    imagesToggle.disabled = false;
  }
}

function refreshButtonLabel() {
  downloadBtn.textContent = imagesToggle.checked ? "Export ZIP" : "Export Markdown";
}

imagesToggle.addEventListener("change", refreshButtonLabel);

downloadBtn.addEventListener("click", () => {
  const includeImages = imagesToggle.checked;

  // IMPORTANT: this call must happen synchronously during the click.
  let permissionPromise = Promise.resolve(true);

  if (includeImages) {
    try {
      permissionPromise = requestImageCDNPermissionFromGesture();
    } catch (e) {
      setStatus(
        "Safari could not start the image permission request: " + errMsg(e),
        "err"
      );
      return;
    }
  }

  void exportConversation(includeImages, permissionPromise);
});

refreshButtonLabel();

// Privacy-focused ChatGPT export parser.
// Injected only after the user clicks the extension on the active chatgpt.com tab.
// Attachments are resolved only after an explicit user opt-in. Credentials and
// signed URLs stay transient and are never included in the archive/report.
async function pageExport(includeImages, includeAttachments) {
  if (window.__chatgptLocalExporterBusy) {
    return { error: "An export is already running for this chat." };
  }

  window.__chatgptLocalExporterBusy = true;
  try {
    const parts = location.pathname.split("/").filter(Boolean);
    const convId = parts[parts.length - 1];
    if (!convId || !/^[0-9a-f-]{20,}$/i.test(convId)) {
      return { error: "This page is not an open ChatGPT conversation." };
    }

    async function fetchWithTimeout(url, options, timeoutMs) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        return await fetch(url, { ...(options || {}), signal: ctrl.signal });
      } finally {
        clearTimeout(timer);
      }
    }

    async function fetchJSON(url, options, timeoutMs) {
      const response = await fetchWithTimeout(url, options, timeoutMs);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    }

    let session;
    try {
      session = await fetchJSON("/api/auth/session", null, 15000);
    } catch (e) {
      return { error: `Could not read the ChatGPT session (${e.message}).` };
    }

    const accessToken = session && session.accessToken;
    if (!accessToken) {
      return { error: "ChatGPT did not provide a session access token." };
    }

    let convo;
    try {
      convo = await fetchJSON(
        `/backend-api/conversation/${encodeURIComponent(convId)}`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
        60000
      );
    } catch (e) {
      return { error: `Could not fetch the conversation (${e.message}).` };
    }

    const activePath = [];
    for (let id = convo.current_node; id; ) {
      const node = convo.mapping && convo.mapping[id];
      if (!node) break;
      if (node.message) activePath.push({ id, msg: node.message });
      id = node.parent;
    }
    activePath.reverse();

    const citationToken = new RegExp(
      String.fromCharCode(0xe200) + "[\\s\\S]*?" + String.fromCharCode(0xe201),
      "g"
    );

    function cleanText(text) {
      return String(text || "")
        .replace(citationToken, "")
        .replace(/【[^】]*】/g, "")
        .replace(/:::[A-Za-z][\w-]*(?:\{[^}]*\})?/g, "")
        .replace(/^[ \t]*:::[ \t]*$/gm, "")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    }

    const noteByURL = new Map();
    const notes = [];
    function noteNum(url, title) {
      if (noteByURL.has(url)) return noteByURL.get(url);
      const num = notes.length + 1;
      noteByURL.set(url, num);
      notes.push({ num, url, title: title || url });
      return num;
    }

    function fileIdOf(pointer) {
      const value = typeof pointer === "string" ? pointer : "";
      const match = value.match(/^(?:file-service|sediment):\/\/(.+)$/);
      return match ? match[1] : value || null;
    }

    function isImagePart(part) {
      return !!part && typeof part === "object" && part.content_type === "image_asset_pointer";
    }

    function hasImage(message) {
      return ((message.content && message.content.parts) || []).some(isImagePart);
    }

    const imageOrder = [];
    const imageSeen = new Set();
    const imagePreviewAttachment = new Map();
    const attachmentOrder = [];
    const attachmentSeen = new Set();

    function rememberImage(fid, previewAttachmentId) {
      if (!fid || imageSeen.has(fid)) return;
      imageSeen.add(fid);
      imageOrder.push(fid);
      if (previewAttachmentId) imagePreviewAttachment.set(fid, previewAttachmentId);
    }

    function rememberAttachments(message) {
      if (!includeAttachments) return;
      const attachments = (message.metadata && message.metadata.attachments) || [];
      for (const attachment of attachments) {
        if (!attachment || typeof attachment !== "object") continue;
        if (String(attachment.mime_type || "").toLowerCase().startsWith("image/")) continue;
        const pointer = attachment.id || attachment.file_id || attachment.asset_pointer;
        const fileId = fileIdOf(pointer);
        if (!fileId || attachmentSeen.has(fileId)) continue;
        attachmentSeen.add(fileId);
        attachmentOrder.push({
          fileId,
          name: typeof attachment.name === "string" ? attachment.name : "",
          mime: typeof attachment.mime_type === "string" ? attachment.mime_type : "",
        });
      }
    }

    function baseText(message) {
      const content = message && message.content;
      if (!content) return "";
      const pdfAttachments = includeAttachments
        ? ((message.metadata && message.metadata.attachments) || []).filter((a) => a && /pdf/i.test(a.mime_type || a.name || ""))
        : [];
      const previewAttachmentId = pdfAttachments.length
        ? fileIdOf(pdfAttachments[0].id || pdfAttachments[0].file_id || pdfAttachments[0].asset_pointer)
        : null;

      if (typeof content.text === "string") return content.text;

      if (Array.isArray(content.parts)) {
        return content.parts
          .map((part) => {
            if (typeof part === "string") return part;
            if (!part || typeof part !== "object") return "";
            if (typeof part.text === "string") return part.text;

            if (isImagePart(part)) {
              const fid = fileIdOf(part.asset_pointer);
              if (includeImages && fid) {
                rememberImage(fid, previewAttachmentId);
                return `@@IMG@@${fid}@@`;
              }
              return "_[image omitted]_";
            }

            if (part.content_type === "audio_asset_pointer") return "_[audio omitted]_";
            return "";
          })
          .filter(Boolean)
          .join("\n\n");
      }

      return "";
    }

    function renderText(message) {
      let raw = baseText(message);
      const refs = ((message.metadata && message.metadata.content_references) || [])
        .filter((r) =>
          r &&
          r.type === "grouped_webpages" &&
          Number.isInteger(r.start_idx) &&
          Number.isInteger(r.end_idx)
        )
        .sort((a, b) => b.start_idx - a.start_idx);

      for (const ref of refs) {
        const markers = (ref.items || [])
          .filter((item) => item && item.url)
          .map((item) => `[^${noteNum(item.url, item.title)}]`)
          .join("");
        raw = raw.slice(0, ref.start_idx) + markers + raw.slice(ref.end_idx);
      }

      return cleanText(raw);
    }

    function attachmentNote(message) {
      const attachments = (message.metadata && message.metadata.attachments) || [];
      const names = attachments
        .filter((a) => {
          if (!a) return false;
          if (String(a.mime_type || "").toLowerCase().startsWith("image/")) return false;
          return true;
        })
        .map((a) => a && a.name)
        .filter(Boolean);

      if (!names.length) return "";
      return names.map((name) => `_[attachment omitted: ${name}]_`).join("\n");
    }

    const turns = [];
    for (const { id, msg } of activePath) {
      if (msg.metadata && msg.metadata.is_visually_hidden_from_conversation) continue;
      if (msg.recipient && msg.recipient !== "all") continue;

      const role = msg.author && msg.author.role;
      const toolImage = role === "tool" && hasImage(msg);
      if (role !== "user" && role !== "assistant" && !toolImage) continue;

      const speaker = role === "user" ? "User" : "ChatGPT";
      rememberAttachments(msg);
      const text = [renderText(msg), attachmentNote(msg)].filter(Boolean).join("\n\n").trim();
      if (!text) continue;

      turns.push({ id, role: role === "tool" ? "assistant" : role, md: `## ${speaker}\n\n${text}\n` });
    }

    const result = {
      convId,
      title: convo.title || "ChatGPT conversation",
      turns,
      footnotes: notes,
    };

    if (!includeImages && !includeAttachments) return result;

    const auth = { headers: { Authorization: `Bearer ${accessToken}` } };
    const resolutionDiagnostics = {
      success_json: 0,
      success_response: 0,
      json_no_url: 0,
      html_rejected: 0,
      http_401: 0,
      http_403: 0,
      http_404: 0,
      http_429: 0,
      http_5xx: 0,
      http_other: 0,
      network: 0,
      retries: 0,
    };

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    function recordResolverHTTP(status) {
      if (status === 401) resolutionDiagnostics.http_401++;
      else if (status === 403) resolutionDiagnostics.http_403++;
      else if (status === 404) resolutionDiagnostics.http_404++;
      else if (status === 429) resolutionDiagnostics.http_429++;
      else if (status >= 500) resolutionDiagnostics.http_5xx++;
      else resolutionDiagnostics.http_other++;
    }

    async function resolveImage(fid) {
      const endpoints = [
        `/backend-api/files/download/${encodeURIComponent(fid)}`,
        `/backend-api/files/${encodeURIComponent(fid)}/download`,
      ];

      for (const endpoint of endpoints) {
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const response = await fetchWithTimeout(endpoint, auth, 20000);

            if (!response.ok) {
              const transient = response.status === 429 || response.status >= 500;
              if (transient && attempt < 2) {
                const retryAfter = Number(response.headers.get("retry-after")) || 0;
                resolutionDiagnostics.retries++;
                await sleep(Math.min((retryAfter || 2) * 1000 * (attempt + 1), 10000));
                continue;
              }

              recordResolverHTTP(response.status);
              break;
            }

            const contentType = (response.headers.get("content-type") || "").toLowerCase();

            if (contentType.includes("application/json")) {
              const payload = await response.json();
              const url =
                payload.download_url ||
                (payload.metadata && payload.metadata.download_url) ||
                null;

              if (!url) {
                resolutionDiagnostics.json_no_url++;
                break;
              }

              resolutionDiagnostics.success_json++;
              return {
                fileId: fid,
                url,
                mime:
                  (payload.metadata && payload.metadata.mime_type) ||
                  payload.mime_type ||
                  null,
                originalName:
                  (payload.metadata && payload.metadata.file_name) ||
                  payload.file_name ||
                  null,
              };
            }

            // A successful non-HTML response is usable even when ChatGPT labels
            // it as application/octet-stream or omits an image MIME type.
            if (response.redirected || !contentType.includes("text/html")) {
              try {
                if (response.body) response.body.cancel();
              } catch (_) {}

              resolutionDiagnostics.success_response++;
              return {
                fileId: fid,
                url: response.url || endpoint,
                mime: contentType || null,
                originalName: null,
              };
            }

            resolutionDiagnostics.html_rejected++;
            break;
          } catch (_) {
            resolutionDiagnostics.network++;

            if (attempt < 1) {
              resolutionDiagnostics.retries++;
              await sleep(1000);
              continue;
            }
            break;
          }
        }
      }

      return { fileId: fid, url: null, mime: null, originalName: null };
    }

    const resolved = [];
    for (const fid of imageOrder) {
      resolved.push(await resolveImage(fid));
    }

    function extensionFor(image) {
      const name = image.originalName || "";
      const match = name.match(/\.([A-Za-z0-9]{2,5})$/);
      if (match) {
        const ext = match[1].toLowerCase();
        if (["png", "jpg", "jpeg", "webp", "gif", "avif"].includes(ext)) {
          return ext === "jpeg" ? "jpg" : ext;
        }
      }

      const mime = String(image.mime || "").toLowerCase();
      if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
      if (mime.includes("webp")) return "webp";
      if (mime.includes("gif")) return "gif";
      if (mime.includes("avif")) return "avif";
      return "png";
    }

    result.images = resolved.map((image, index) => ({
      fileId: image.fileId,
      previewAttachmentId: imagePreviewAttachment.get(image.fileId) || null,
      url: image.url,
      mime: image.mime,
      name: `image-${String(index + 1).padStart(3, "0")}.${extensionFor(image)}`,
    }));
    result.resolutionDiagnostics = resolutionDiagnostics;

    const attachmentDiagnostics = {
      resolved: 0, no_url: 0, http_401: 0, http_403: 0, http_404: 0,
      http_429: 0, http_5xx: 0, http_other: 0, network: 0,
    };
    const attachments = [];
    if (includeAttachments) {
      for (const attachment of attachmentOrder) {
        let found = null;
        const endpoints = [
          `/backend-api/files/download/${encodeURIComponent(attachment.fileId)}`,
          `/backend-api/files/${encodeURIComponent(attachment.fileId)}/download`,
        ];
        for (const endpoint of endpoints) {
          try {
            const response = await fetchWithTimeout(endpoint, auth, 20000);
            if (!response.ok) {
              const status = response.status;
              const key = status === 401 ? "http_401" : status === 403 ? "http_403" : status === 404 ? "http_404" : status === 429 ? "http_429" : status >= 500 ? "http_5xx" : "http_other";
              attachmentDiagnostics[key]++;
              continue;
            }
            const type = (response.headers.get("content-type") || "").toLowerCase();
            if (type.includes("application/json")) {
              const payload = await response.json();
              const url = payload.download_url || (payload.metadata && payload.metadata.download_url);
              if (url) {
                found = {
                  fileId: attachment.fileId,
                  url,
                  name: (payload.metadata && (payload.metadata.file_name || payload.metadata.name)) || payload.file_name || attachment.name,
                  mime: (payload.metadata && payload.metadata.mime_type) || payload.mime_type || attachment.mime,
                };
                break;
              }
              attachmentDiagnostics.no_url++;
            } else if (response.redirected || !type.includes("text/html")) {
              try { if (response.body) response.body.cancel(); } catch (_) {}
              found = { ...attachment, url: response.url || endpoint };
              break;
            } else {
              attachmentDiagnostics.no_url++;
            }
          } catch (_) {
            attachmentDiagnostics.network++;
          }
        }
        if (found) {
          attachmentDiagnostics.resolved++;
          attachments.push(found);
        } else {
          attachments.push({ ...attachment, url: null });
        }
      }
    }
    result.attachments = attachments;
    result.attachmentDiagnostics = attachmentDiagnostics;

    // Return the bearer token transiently only for an explicitly requested file
    // export. Consumers must restrict authenticated requests to OpenAI hosts.
    // The popup never persists, logs, archives, or forwards this token outside
    // approved OpenAI image CDN hosts.
    result.token = accessToken;

    return result;
  } finally {
    window.__chatgptLocalExporterBusy = false;
  }
}

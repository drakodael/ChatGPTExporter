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

    const accountIdCandidates = [
      session && session.account && session.account.id,
      session && session.account_id,
      session && session.user && session.user.account_id,
    ];
    const accountId =
      accountIdCandidates.find((value) => typeof value === "string" && value.trim()) || null;

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

    const gizmoCandidates = [
      convo && convo.gizmo_id,
      convo && convo.conversation_template_id,
    ];
    const gizmoId =
      gizmoCandidates.find((value) => typeof value === "string" && value.trim()) || null;
    const gizmoIsProject = !!(gizmoId && /^g-p-/i.test(gizmoId));

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
    const imageAttachmentContext = new Map();
    const imageDiscoveryDiagnostics = {
      source_image_asset_pointer: 0,
      pointer_normalized: 0,
      pointer_missing_or_invalid: 0,
      unique_discovered: 0,
      duplicate_pointer: 0,
      preview_associated: 0,
    };
    const attachmentOrder = [];
    const attachmentSeen = new Set();
    const attachmentIdSourceDiagnostics = {
      id_source_id: 0,
      id_source_file_id: 0,
      id_source_asset_pointer: 0,
    };
    const attachmentCandidateDiagnostics = Object.fromEntries(
      ["present", "attempt", "resolved"].flatMap((phase) =>
        ["id", "file_id", "asset_pointer"].map((source) => [`candidate_${phase}_${source}`, 0])
      )
    );

    function collectAttachmentResolverCandidates(attachment) {
      const candidates = [];
      const presentSources = [];
      const seenCandidates = new Set();
      for (const source of ["id", "file_id", "asset_pointer"]) {
        const value = fileIdOf(attachment && attachment[source]);
        if (!value) continue;
        presentSources.push(source);
        if (seenCandidates.has(value)) continue;
        seenCandidates.add(value);
        candidates.push({ value, source });
      }
      return { candidates, presentSources };
    }

    function summarizeSameMessageImageAttachments(message, fid) {
      const attachments = (message && message.metadata && message.metadata.attachments) || [];
      const imageAttachments = attachments.filter((attachment) =>
        attachment &&
        typeof attachment === "object" &&
        String(attachment.mime_type || "").toLowerCase().startsWith("image/")
      );
      const summary = {
        image_attachment_count: imageAttachments.length,
        candidate_id_present: false,
        candidate_file_id_present: false,
        candidate_asset_pointer_present: false,
        pointer_matches_attachment_id: false,
        pointer_matches_attachment_file_id: false,
        pointer_matches_attachment_asset_pointer: false,
        has_distinct_alternate_candidate: false,
      };

      for (const attachment of imageAttachments) {
        for (const source of ["id", "file_id", "asset_pointer"]) {
          const value = fileIdOf(attachment[source]);
          if (!value) continue;
          summary[`candidate_${source}_present`] = true;
          if (value === fid) summary[`pointer_matches_attachment_${source}`] = true;
          else summary.has_distinct_alternate_candidate = true;
        }
      }

      return summary;
    }

    function rememberImage(fid, previewAttachmentId, attachmentContext) {
      if (!fid) return;
      if (imageSeen.has(fid)) {
        imageDiscoveryDiagnostics.duplicate_pointer++;
        return;
      }
      imageSeen.add(fid);
      imageOrder.push(fid);
      imageDiscoveryDiagnostics.unique_discovered++;
      if (attachmentContext) imageAttachmentContext.set(fid, attachmentContext);
      if (previewAttachmentId) {
        imagePreviewAttachment.set(fid, previewAttachmentId);
        imageDiscoveryDiagnostics.preview_associated++;
      }
    }

    function rememberAttachments(message) {
      if (!includeAttachments) return;
      const attachments = (message.metadata && message.metadata.attachments) || [];
      for (const attachment of attachments) {
        if (!attachment || typeof attachment !== "object") continue;
        if (String(attachment.mime_type || "").toLowerCase().startsWith("image/")) continue;
        const { candidates, presentSources } = collectAttachmentResolverCandidates(attachment);
        const attachmentKey = candidates.length ? candidates[0].value : null;
        if (!attachmentKey || attachmentSeen.has(attachmentKey)) continue;
        attachmentSeen.add(attachmentKey);
        for (const source of presentSources) attachmentCandidateDiagnostics[`candidate_present_${source}`]++;
        attachmentIdSourceDiagnostics[`id_source_${candidates[0].source}`]++;
        attachmentOrder.push({
          attachmentKey,
          resolverCandidates: candidates,
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
        ? (collectAttachmentResolverCandidates(pdfAttachments[0]).candidates[0] || {}).value || null
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
              if (includeImages) {
                imageDiscoveryDiagnostics.source_image_asset_pointer++;
                if (fid) imageDiscoveryDiagnostics.pointer_normalized++;
                else imageDiscoveryDiagnostics.pointer_missing_or_invalid++;
              }
              if (includeImages && fid) {
                rememberImage(
                  fid,
                  previewAttachmentId,
                  summarizeSameMessageImageAttachments(message, fid)
                );
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
    const imageResolverOutcomeKeys = [
      "success_json", "success_response", "json_no_url", "html_rejected",
      "http_401", "http_403", "http_404", "http_429", "http_5xx", "http_other",
      "network", "timeout",
    ];
    const resolutionDiagnostics = {
      attempts: 0,
      resolved: 0,
      final_no_url: 0,
      retries: 0,
      ...Object.fromEntries(imageResolverOutcomeKeys.map((key) => [key, 0])),
      endpoint_1_attempts: 0,
      endpoint_2_attempts: 0,
      endpoint_1_resolved: 0,
      endpoint_2_resolved: 0,
      scoped_attempts: 0,
      scoped_resolved: 0,
      scoped_http_403: 0,
      endpoint_1_scoped_attempts: 0,
      endpoint_2_scoped_attempts: 0,
      endpoint_1_scoped_resolved: 0,
      endpoint_2_scoped_resolved: 0,
      endpoint_1_scoped_http_403: 0,
      endpoint_2_scoped_http_403: 0,
      account_id_present: accountId ? 1 : 0,
      gizmo_id_present: gizmoId ? 1 : 0,
      gizmo_is_project: gizmoIsProject ? 1 : 0,
      account_context_attempts: 0,
      account_context_resolved: 0,
      account_context_http_403: 0,
      project_context_attempts: 0,
      project_context_resolved: 0,
      project_context_http_403: 0,
      endpoint_1_account_context_attempts: 0,
      endpoint_2_account_context_attempts: 0,
      endpoint_1_account_context_resolved: 0,
      endpoint_2_account_context_resolved: 0,
      endpoint_1_account_context_http_403: 0,
      endpoint_2_account_context_http_403: 0,
      endpoint_1_project_context_attempts: 0,
      endpoint_2_project_context_attempts: 0,
      endpoint_1_project_context_resolved: 0,
      endpoint_2_project_context_resolved: 0,
      endpoint_1_project_context_http_403: 0,
      endpoint_2_project_context_http_403: 0,
      ...Object.fromEntries([1, 2].flatMap((endpointNumber) =>
        imageResolverOutcomeKeys.map((key) => [`endpoint_${endpointNumber}_${key}`, 0])
      )),
    };

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    function recordResolverHTTP(status, endpointNumber) {
      const key =
        status === 401 ? "http_401" :
        status === 403 ? "http_403" :
        status === 404 ? "http_404" :
        status === 429 ? "http_429" :
        status >= 500 ? "http_5xx" :
        "http_other";
      resolutionDiagnostics[key]++;
      resolutionDiagnostics[`endpoint_${endpointNumber}_${key}`]++;
    }

    async function resolveImageEndpoint(endpoint, endpointNumber, stage, requestOptions) {
      const stagePrefix =
        stage === "conversation_scoped" ? "scoped" :
        stage === "account_context" ? "account_context" :
        stage === "project_context" ? "project_context" :
        null;

      for (let attempt = 0; attempt < 3; attempt++) {
        resolutionDiagnostics.attempts++;
        resolutionDiagnostics[`endpoint_${endpointNumber}_attempts`]++;
        if (stagePrefix) {
          resolutionDiagnostics[`${stagePrefix}_attempts`]++;
          resolutionDiagnostics[`endpoint_${endpointNumber}_${stagePrefix}_attempts`]++;
        }

        try {
          const response = await fetchWithTimeout(endpoint, requestOptions || auth, 20000);

          if (!response.ok) {
            const transient = response.status === 429 || response.status >= 500;
            if (transient && attempt < 2) {
              const retryAfter = Number(response.headers.get("retry-after")) || 0;
              resolutionDiagnostics.retries++;
              await sleep(Math.min((retryAfter || 2) * 1000 * (attempt + 1), 10000));
              continue;
            }

            recordResolverHTTP(response.status, endpointNumber);
            if (stagePrefix && response.status === 403) {
              resolutionDiagnostics[`${stagePrefix}_http_403`]++;
              resolutionDiagnostics[`endpoint_${endpointNumber}_${stagePrefix}_http_403`]++;
            }
            return { image: null, terminal: response.status === 403 ? "http_403" : "other" };
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
              resolutionDiagnostics[`endpoint_${endpointNumber}_json_no_url`]++;
              return { image: null, terminal: "other" };
            }

            resolutionDiagnostics.success_json++;
            resolutionDiagnostics.resolved++;
            resolutionDiagnostics[`endpoint_${endpointNumber}_success_json`]++;
            resolutionDiagnostics[`endpoint_${endpointNumber}_resolved`]++;
            if (stagePrefix) {
              resolutionDiagnostics[`${stagePrefix}_resolved`]++;
              resolutionDiagnostics[`endpoint_${endpointNumber}_${stagePrefix}_resolved`]++;
            }
            return {
              image: {
                url,
                mime:
                  (payload.metadata && payload.metadata.mime_type) ||
                  payload.mime_type ||
                  null,
                originalName:
                  (payload.metadata && payload.metadata.file_name) ||
                  payload.file_name ||
                  null,
              },
              terminal: "success",
            };
          }

          if (response.redirected || !contentType.includes("text/html")) {
            try {
              if (response.body) response.body.cancel();
            } catch (_) {}

            resolutionDiagnostics.success_response++;
            resolutionDiagnostics.resolved++;
            resolutionDiagnostics[`endpoint_${endpointNumber}_success_response`]++;
            resolutionDiagnostics[`endpoint_${endpointNumber}_resolved`]++;
            if (stagePrefix) {
              resolutionDiagnostics[`${stagePrefix}_resolved`]++;
              resolutionDiagnostics[`endpoint_${endpointNumber}_${stagePrefix}_resolved`]++;
            }
            return {
              image: {
                url: response.url || endpoint,
                mime: contentType || null,
                originalName: null,
              },
              terminal: "success",
            };
          }

          resolutionDiagnostics.html_rejected++;
          resolutionDiagnostics[`endpoint_${endpointNumber}_html_rejected`]++;
          return { image: null, terminal: "other" };
        } catch (error) {
          const key = error && error.name === "AbortError" ? "timeout" : "network";
          resolutionDiagnostics[key]++;
          resolutionDiagnostics[`endpoint_${endpointNumber}_${key}`]++;

          if (attempt < 1) {
            resolutionDiagnostics.retries++;
            await sleep(1000);
            continue;
          }
          return { image: null, terminal: "other" };
        }
      }

      return { image: null, terminal: "other" };
    }

    async function resolveImage(fid) {
      const encodedFileId = encodeURIComponent(fid);
      const unscopedEndpoints = [
        `/backend-api/files/download/${encodedFileId}`,
        `/backend-api/files/${encodedFileId}/download`,
      ];
      const unscopedTerminalOutcomes = [];

      for (let endpointIndex = 0; endpointIndex < unscopedEndpoints.length; endpointIndex++) {
        const outcome = await resolveImageEndpoint(
          unscopedEndpoints[endpointIndex],
          endpointIndex + 1,
          "unscoped",
          auth
        );
        if (outcome.image) return { fileId: fid, ...outcome.image };
        unscopedTerminalOutcomes.push(outcome.terminal);
      }

      if (
        unscopedTerminalOutcomes.length === 2 &&
        unscopedTerminalOutcomes.every((outcome) => outcome === "http_403")
      ) {
        const encodedConversationId = encodeURIComponent(convId);
        const conversationScopedEndpoints = [
          `/backend-api/files/download/${encodedFileId}?conversation_id=${encodedConversationId}&inline=false`,
          `/backend-api/files/${encodedFileId}/download?conversation_id=${encodedConversationId}&inline=false`,
        ];
        const conversationScopedTerminalOutcomes = [];

        for (let endpointIndex = 0; endpointIndex < conversationScopedEndpoints.length; endpointIndex++) {
          const outcome = await resolveImageEndpoint(
            conversationScopedEndpoints[endpointIndex],
            endpointIndex + 1,
            "conversation_scoped",
            auth
          );
          if (outcome.image) return { fileId: fid, ...outcome.image };
          conversationScopedTerminalOutcomes.push(outcome.terminal);
        }

        if (
          conversationScopedTerminalOutcomes.length === 2 &&
          conversationScopedTerminalOutcomes.every((outcome) => outcome === "http_403")
        ) {
          let accountContextTerminalOutcomes = null;

          if (accountId) {
            const accountAuth = {
              headers: {
                Authorization: `Bearer ${accessToken}`,
                "chatgpt-account-id": accountId,
              },
            };
            accountContextTerminalOutcomes = [];

            for (let endpointIndex = 0; endpointIndex < conversationScopedEndpoints.length; endpointIndex++) {
              const outcome = await resolveImageEndpoint(
                conversationScopedEndpoints[endpointIndex],
                endpointIndex + 1,
                "account_context",
                accountAuth
              );
              if (outcome.image) return { fileId: fid, ...outcome.image };
              accountContextTerminalOutcomes.push(outcome.terminal);
            }
          }

          const accountContextAllowsProjectFallback =
            !accountContextTerminalOutcomes ||
            (
              accountContextTerminalOutcomes.length === 2 &&
              accountContextTerminalOutcomes.every((outcome) => outcome === "http_403")
            );

          if (gizmoIsProject && accountContextAllowsProjectFallback) {
            const encodedGizmoId = encodeURIComponent(gizmoId);
            const projectScopedEndpoints = [
              `/backend-api/files/download/${encodedFileId}?gizmo_id=${encodedGizmoId}&inline=false`,
              `/backend-api/files/${encodedFileId}/download?gizmo_id=${encodedGizmoId}&inline=false`,
            ];
            const projectAuth = accountId
              ? {
                  headers: {
                    Authorization: `Bearer ${accessToken}`,
                    "chatgpt-account-id": accountId,
                  },
                }
              : auth;

            for (let endpointIndex = 0; endpointIndex < projectScopedEndpoints.length; endpointIndex++) {
              const outcome = await resolveImageEndpoint(
                projectScopedEndpoints[endpointIndex],
                endpointIndex + 1,
                "project_context",
                projectAuth
              );
              if (outcome.image) return { fileId: fid, ...outcome.image };
            }
          }
        }
      }

      resolutionDiagnostics.final_no_url++;
      return { fileId: fid, url: null, mime: null, originalName: null };
    }

    const resolved = [];
    for (const fid of imageOrder) {
      resolved.push(await resolveImage(fid));
    }

    const unresolvedImageAttachmentDiagnostics = {
      same_message_image_attachments: 0,
      with_one_image_attachment: 0,
      with_multiple_image_attachments: 0,
      attachment_candidate_id_present: 0,
      attachment_candidate_file_id_present: 0,
      attachment_candidate_asset_pointer_present: 0,
      pointer_matches_attachment_id: 0,
      pointer_matches_attachment_file_id: 0,
      pointer_matches_attachment_asset_pointer: 0,
      has_distinct_alternate_candidate: 0,
    };

    for (const image of resolved) {
      if (image && image.url) continue;
      const context = image && image.fileId ? imageAttachmentContext.get(image.fileId) : null;
      if (!context) continue;

      if (context.image_attachment_count > 0) {
        unresolvedImageAttachmentDiagnostics.same_message_image_attachments++;
        if (context.image_attachment_count === 1) {
          unresolvedImageAttachmentDiagnostics.with_one_image_attachment++;
        } else {
          unresolvedImageAttachmentDiagnostics.with_multiple_image_attachments++;
        }
      }
      for (const source of ["id", "file_id", "asset_pointer"]) {
        if (context[`candidate_${source}_present`]) {
          unresolvedImageAttachmentDiagnostics[`attachment_candidate_${source}_present`]++;
        }
        if (context[`pointer_matches_attachment_${source}`]) {
          unresolvedImageAttachmentDiagnostics[`pointer_matches_attachment_${source}`]++;
        }
      }
      if (context.has_distinct_alternate_candidate) {
        unresolvedImageAttachmentDiagnostics.has_distinct_alternate_candidate++;
      }
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
    result.imageDiscoveryDiagnostics = imageDiscoveryDiagnostics;
    result.unresolvedImageAttachmentDiagnostics = unresolvedImageAttachmentDiagnostics;

    const attachmentDiagnostics = {
      resolved: 0, no_url: 0, http_401: 0, http_403: 0, http_404: 0,
      http_429: 0, http_5xx: 0, http_other: 0, network: 0,
    };
    const resolverOutcomeKeys = [
      "http_401", "http_403", "http_404", "http_429", "http_5xx", "http_other",
      "network", "timeout", "json_download_url", "json_metadata_download_url",
      "json_no_url", "redirect", "non_html_response", "html_no_url",
    ];
    const attachmentResolverDiagnostics = {
      attempts: 0,
      resolved: 0,
      ...Object.fromEntries(resolverOutcomeKeys.map((key) => [key, 0])),
      endpoint_1_attempts: 0,
      endpoint_2_attempts: 0,
      conversation_scoped_attempts: 0,
      conversation_scoped_resolved: 0,
      conversation_scoped_http_403: 0,
      endpoint_1_scoped_attempts: 0,
      endpoint_1_scoped_resolved: 0,
      endpoint_1_scoped_http_403: 0,
      endpoint_2_scoped_attempts: 0,
      endpoint_2_scoped_resolved: 0,
      endpoint_2_scoped_http_403: 0,
      ...Object.fromEntries([1, 2].flatMap((endpointNumber) =>
        resolverOutcomeKeys.map((key) => [`endpoint_${endpointNumber}_${key}`, 0])
      )),
      ...attachmentIdSourceDiagnostics,
      ...attachmentCandidateDiagnostics,
    };

    function recordAttachmentResolverOutcome(key, endpointNumber) {
      attachmentResolverDiagnostics[key]++;
      attachmentResolverDiagnostics[`endpoint_${endpointNumber}_${key}`]++;
    }

    const attachments = [];
    if (includeAttachments) {
      for (const attachment of attachmentOrder) {
        let found = null;
        let resolvedSource = null;
        let resolvedEndpointNumber = null;
        for (const candidate of attachment.resolverCandidates) {
          const encodedConversationId = encodeURIComponent(convId);
          const endpoints = [
            `/backend-api/files/download/${encodeURIComponent(candidate.value)}?conversation_id=${encodedConversationId}&inline=false`,
            `/backend-api/files/${encodeURIComponent(candidate.value)}/download?conversation_id=${encodedConversationId}&inline=false`,
          ];
          for (let endpointIndex = 0; endpointIndex < endpoints.length; endpointIndex++) {
            const endpoint = endpoints[endpointIndex];
            const endpointNumber = endpointIndex + 1;
            for (let attempt = 0; attempt < 3; attempt++) {
              attachmentResolverDiagnostics.attempts++;
              attachmentResolverDiagnostics[`endpoint_${endpointNumber}_attempts`]++;
              attachmentResolverDiagnostics.conversation_scoped_attempts++;
              attachmentResolverDiagnostics[`endpoint_${endpointNumber}_scoped_attempts`]++;
              attachmentResolverDiagnostics[`candidate_attempt_${candidate.source}`]++;
              try {
                const response = await fetchWithTimeout(endpoint, auth, 20000);
                if (!response.ok) {
                  const status = response.status;
                  const key = status === 401 ? "http_401" : status === 403 ? "http_403" : status === 404 ? "http_404" : status === 429 ? "http_429" : status >= 500 ? "http_5xx" : "http_other";
                  attachmentDiagnostics[key]++;
                  recordAttachmentResolverOutcome(key, endpointNumber);
                  if (status === 403) {
                    attachmentResolverDiagnostics.conversation_scoped_http_403++;
                    attachmentResolverDiagnostics[`endpoint_${endpointNumber}_scoped_http_403`]++;
                  }
                  if ((status === 429 || status >= 500) && attempt < 2) {
                    const retryAfter = Number(response.headers.get("retry-after")) || 0;
                    await sleep(Math.min((retryAfter || 2) * 1000 * (attempt + 1), 10000));
                    continue;
                  }
                  break;
                }

                const type = (response.headers.get("content-type") || "").toLowerCase();
                if (type.includes("application/json")) {
                  const payload = await response.json();
                  const directURL = payload && payload.download_url;
                  const metadataURL = payload && payload.metadata && payload.metadata.download_url;
                  const url = directURL || metadataURL;
                  if (url) {
                    recordAttachmentResolverOutcome(directURL ? "json_download_url" : "json_metadata_download_url", endpointNumber);
                    found = {
                      attachmentKey: attachment.attachmentKey,
                      url,
                      name: (payload.metadata && (payload.metadata.file_name || payload.metadata.name)) || payload.file_name || attachment.name,
                      mime: (payload.metadata && payload.metadata.mime_type) || payload.mime_type || attachment.mime,
                    };
                    resolvedSource = candidate.source;
                    resolvedEndpointNumber = endpointNumber;
                    break;
                  }
                  attachmentDiagnostics.no_url++;
                  recordAttachmentResolverOutcome("json_no_url", endpointNumber);
                  break;
                }

                if (response.redirected || !type.includes("text/html")) {
                  try { if (response.body) response.body.cancel(); } catch (_) {}
                  recordAttachmentResolverOutcome(response.redirected ? "redirect" : "non_html_response", endpointNumber);
                  found = {
                    attachmentKey: attachment.attachmentKey,
                    url: response.url || endpoint,
                    name: attachment.name,
                    mime: attachment.mime,
                  };
                  resolvedSource = candidate.source;
                  resolvedEndpointNumber = endpointNumber;
                  break;
                }

                attachmentDiagnostics.no_url++;
                recordAttachmentResolverOutcome("html_no_url", endpointNumber);
                break;
              } catch (error) {
                attachmentDiagnostics.network++;
                const outcome = error && error.name === "AbortError" ? "timeout" : "network";
                recordAttachmentResolverOutcome(outcome, endpointNumber);
                if (attempt < 1) {
                  await sleep(1000);
                  continue;
                }
                break;
              }
            }
            if (found) break;
          }
          if (found) break;
        }
        if (found) {
          attachmentDiagnostics.resolved++;
          attachmentResolverDiagnostics.resolved++;
          attachmentResolverDiagnostics.conversation_scoped_resolved++;
          attachmentResolverDiagnostics[`endpoint_${resolvedEndpointNumber}_scoped_resolved`]++;
          attachmentResolverDiagnostics[`candidate_resolved_${resolvedSource}`]++;
          attachments.push(found);
        } else {
          attachments.push({
            attachmentKey: attachment.attachmentKey,
            name: attachment.name,
            mime: attachment.mime,
            url: null,
          });
        }
      }
    }
    result.attachments = attachments;
    result.attachmentDiagnostics = attachmentDiagnostics;
    result.attachmentResolverDiagnostics = attachmentResolverDiagnostics;

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

// This function is injected only into the active ChatGPT tab after the user
// clicks the extension. It makes same-origin requests only to chatgpt.com and
// returns Markdown-ready text to the extension. It does not download files,
// return the access token, export raw JSON, use analytics, or contact third-party
// hosts.
async function pageExport() {
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

    async function fetchJSON(url, options, timeoutMs) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const response = await fetch(url, { ...(options || {}), signal: ctrl.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
      } finally {
        clearTimeout(timer);
      }
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
        .replace(/:::[A-Za-z][\\w-]*(?:\\{[^}]*\\})?/g, "")
        .replace(/^[ \\t]*:::[ \\t]*$/gm, "")
        .replace(/[ \\t]+\\n/g, "\\n")
        .replace(/\\n{3,}/g, "\\n\\n")
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

    function baseText(message) {
      const content = message && message.content;
      if (!content) return "";

      if (typeof content.text === "string") return content.text;

      if (Array.isArray(content.parts)) {
        return content.parts
          .map((part) => {
            if (typeof part === "string") return part;
            if (!part || typeof part !== "object") return "";
            if (typeof part.text === "string") return part.text;
            if (part.content_type === "image_asset_pointer") return "_[image omitted]_";
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
      if (role !== "user" && role !== "assistant") continue;

      const speaker = role === "user" ? "User" : "ChatGPT";
      const text = [renderText(msg), attachmentNote(msg)].filter(Boolean).join("\n\n").trim();
      if (!text) continue;

      turns.push({ id, role, md: `## ${speaker}\n\n${text}\n` });
    }

    return {
      convId,
      title: convo.title || "ChatGPT conversation",
      turns,
      footnotes: notes,
    };
  } finally {
    window.__chatgptLocalExporterBusy = false;
  }
}

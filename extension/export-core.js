function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `-${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`
  );
}

function safeName(title) {
  const cleaned = String(title || "ChatGPT conversation")
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/^[.\s]+|[.\s]+$/g, "");
  return [...cleaned].slice(0, 80).join("") || "chatgpt";
}

function appendFootnotes(md, notes) {
  if (!notes || !notes.length) return md;
  const used = new Set([...md.matchAll(/\[\^(\d+)\]/g)].map((m) => Number(m[1])));
  const defs = notes
    .filter((n) => used.has(n.num))
    .map((n) => `[^${n.num}]: [${String(n.title || n.url).replace(/\]/g, "\\]")}](${n.url})`);
  return defs.length ? `${md.trimEnd()}\n\n${defs.join("\n")}\n` : md;
}

function buildMarkdown(result) {
  const body = result.turns.map((t) => t.md).join("\n");
  const md = `# ${result.title}\n\n${body}`;
  return appendFootnotes(md, result.footnotes);
}

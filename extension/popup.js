const statusEl = document.getElementById("status");
const downloadBtn = document.getElementById("download");
const CHATGPT_URL = /^https:\/\/chatgpt\.com\//;

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

// Safari temporary extensions may open a Blob from the popup as a new
// safari-web-extension page instead of honoring <a download>. Run the actual
// Blob download inside the user-activated ChatGPT tab instead. No data is sent
// anywhere: the Markdown string is passed directly from the extension process
// to the already-open tab via Safari's scripting API.
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

async function exportMarkdown() {
  downloadBtn.disabled = true;
  setStatus("Exporting locally…");

  try {
    const tab = await getActiveChatTab();
    if (!tab) {
      setStatus("Open a conversation on chatgpt.com first.", "err");
      return;
    }

    let injection;
    try {
      [injection] = await browser.scripting.executeScript({
        target: { tabId: tab.id },
        func: pageExport,
      });
    } catch (e) {
      setStatus("Safari did not allow access to this tab. Open the extension from the ChatGPT tab and try again.", "err");
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
    const filename = `${safeName(result.title)}-${timestamp()}.md`;

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
  } catch (e) {
    setStatus("Export failed: " + errMsg(e), "err");
  } finally {
    downloadBtn.disabled = false;
  }
}

downloadBtn.addEventListener("click", exportMarkdown);

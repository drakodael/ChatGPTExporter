# Image Export WIP

Current working branch: `feature/image-export`

Stable baseline remains on `main` at commit `397d894` ("Add privacy-focused no-Xcode Markdown exporter").

## Stable baseline

The `main` branch is the known-working privacy-focused Safari temporary extension:

- no Xcode required
- Markdown export works
- normal permissions: `activeTab` + `scripting`
- no native messaging
- no analytics or telemetry
- no clipboard access
- no persistent ChatGPT host permission
- citations/footnotes are preserved
- images and attachments are omitted

Do not merge the experimental image branch into `main` until image export is verified.

## Image export experiments

### v2

Added optional image export to a local ZIP:

```text
conversation.md
images/
  image-001.png
  ...
```

Result from a real test chat:

- 137 images were detected
- all 137 image byte downloads failed
- generated ZIP contained only `conversation.md`

This proved image detection was working and the failure was in cross-origin byte fetching.

### v2.1

Added optional host permission:

```text
https://*.oaiusercontent.com/*
```

Safari rejected the permission request with:

```text
Invalid call to permissions.request(). Must be called during a user gesture.
```

### v2.2

Moved `permissions.request()` directly into the synchronous Export button click.

Result:

- Safari got past the user-gesture error
- a valid ZIP was produced
- Safari named the file `Unknown`
- `file Unknown` identified it as a ZIP archive
- `unzip -l Unknown` showed only:
  - `conversation.md`
- the tested `conversation.md` size was 240480 bytes
- images still did not enter the ZIP

Known independent bug: ZIP download initiated from the extension popup can lose its filename in Safari and appear as `Unknown`.

### v2.3 — current WIP on this branch

The current branch adds a privacy-bounded authenticated retry for image byte downloads.

For image export only:

1. `pageExport()` resolves the image file URLs using the authenticated ChatGPT session.
2. The ChatGPT access token is returned transiently to the popup.
3. The popup validates that every image URL is HTTPS and belongs to `oaiusercontent.com` or a subdomain.
4. It first tries the signed CDN URL without authorization.
5. If that fails, it retries the same validated OpenAI CDN URL with:
   `Authorization: Bearer <token>`.
6. The token is removed from the result object immediately after capture.
7. The token is not written to disk, ZIP, browser storage, logs, analytics, or third-party hosts.

The popup also reports aggregate diagnostics only, for example:

- `401:N`
- `403:N`
- `404:N`
- `429:N`
- `5xx:N`
- `network:N`
- `invalid-host:N`
- authenticated download count

No signed URLs or token values are included in diagnostics.

## Current permissions

Normal:

```text
activeTab
scripting
```

Optional, requested only when `Include images` is selected:

```text
https://*.oaiusercontent.com/*
```

## What still needs testing

v2.3 has been saved to GitHub as a WIP but has not yet been verified on Safari.

Test:

1. Load `extension/` as a Safari temporary extension.
2. Open a ChatGPT conversation containing images.
3. Enable `Include images`.
4. Click `Export ZIP`.
5. Record the popup diagnostics.
6. Inspect the resulting file:
   ```bash
   file Unknown*
   unzip -l Unknown* | head -40
   ```
7. Confirm whether an `images/` directory is present.
8. If successful, verify that `conversation.md` references the exported files with relative paths such as:
   ```markdown
   ![image](images/image-001.png)
   ```

After image bytes work, fix the Safari `Unknown` ZIP filename separately.

## Resume from another Mac

Clone the repository:

```bash
mkdir -p ~/Developer/Drakodael
cd ~/Developer/Drakodael

git clone https://github.com/drakodael/ChatGPTExporter.git
cd ChatGPTExporter

git switch feature/image-export
git status
```

If the repository already exists:

```bash
cd ~/Developer/Drakodael/ChatGPTExporter
git fetch origin
git switch feature/image-export
git pull --ff-only origin feature/image-export
```

Then load this folder as the Safari temporary extension:

```text
~/Developer/Drakodael/ChatGPTExporter/extension
```

## Git discipline

- `main`: stable Markdown-only version
- `feature/image-export`: experimental image work
- do not merge to `main` until v2.3 or a later revision successfully exports real image files
- backup folders created by patch scripts should remain local and should not be committed


### v2.4 — persistent diagnostics inside the ZIP

Safari closes the extension popup when the download UI appears, so the final diagnostic message cannot be read reliably.

v2.4 adds a privacy-safe `export-report.txt` inside every image-export ZIP. It contains aggregate counts only:

- images detected
- images with a resolved URL
- images downloaded
- images failed
- direct signed-URL downloads
- authenticated downloads
- whether a transient session token was available
- failure totals for no-url, invalid-host, 401, 403, 404, 429, 5xx, other HTTP, content-type, and network

The report does **not** contain:

- the ChatGPT access token
- signed image URLs
- image file IDs
- message text

This makes the next Safari test diagnosable even if the popup disappears during download.

Test the branch, then inspect:

```bash
unzip -p Unknown export-report.txt
```

or upload the resulting ZIP for inspection.


### v2.6 — allow the actual ChatGPT image endpoint

The v2.5 report showed that 135 image URLs resolved successfully but all were
rejected because their hostname was `chatgpt.com`.

v2.6 keeps normal permissions unchanged:

```text
activeTab
scripting
```

When **Include images** is selected, Safari now requests temporary host access to:

```text
https://chatgpt.com/*
https://*.oaiusercontent.com/*
```

The popup accepts only those HTTPS hosts. ChatGPT image endpoints are tried
without credentials first and, if needed, retried with the transient bearer
token. The token is never persisted.


### v2.7 — Safari filename workaround + resolver hardening

Based on the read-only KDES/Superpower-style audit and the successful v2.6 export
(135/137 images), v2.7 makes two targeted changes while keeping `main` untouched.

#### ZIP filename workaround

Safari was saving popup-originated Blob downloads as `Unknown-N` even though the
anchor's `download` attribute contained the intended filename.

v2.7 now:

- builds the ZIP Blob with MIME type `application/zip`;
- wraps that Blob in a named `File` object before creating the object URL;
- keeps the anchor `download` attribute set to the same conversation-derived name;
- sets the anchor type to `application/zip`.

This is intentionally a no-Xcode workaround. Safari still needs a manual verification
because WebExtension Blob download behavior is browser-specific.

#### Image resolver hardening

The two v2.6 failures were `no-url`, so v2.7 broadens only the resolver stage:

- retries 429 and 5xx responses with bounded backoff;
- retries one timeout/network failure;
- accepts successful non-HTML responses such as `application/octet-stream`, matching
  the upstream exporter's tolerant behavior;
- retains the existing endpoint allowlist in the popup;
- preserves unauthenticated-first download behavior and transient-token retry.

The ZIP report now includes aggregate resolver diagnostics only:

- success-json
- success-response
- json-no-url
- html-rejected
- resolver HTTP status buckets
- resolver network failures
- resolver retry count

No response body, URL, file ID, or token is written to the report.

#### Manual verification

After pulling v2.7 and reloading the temporary Safari extension:

```bash
grep '"version"' extension/manifest.json
```

Expected:

```text
"version": "2.7-private",
```

Export the same image-heavy chat, then inspect the newest download. Verify both:

1. whether Safari now uses the conversation-derived `.zip` filename instead of
   `Unknown-N`;
2. whether `Images downloaded` improves from 135/137.

If unresolved images remain, inspect `export-report.txt` for the new resolver
diagnostic counters before changing endpoint parsing further.

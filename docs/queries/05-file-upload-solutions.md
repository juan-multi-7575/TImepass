# File Upload to Gemini via Chrome Extension — Complete Guide

## Root Cause of Previous Failures

**`DOM.setFileInputFiles` is blocked by `chrome.debugger` (Chromium bug #928255).** Since Chrome 72, the `chrome.debugger` extension API rejects this CDP command with `-32000 "Not allowed"` for security reasons (prevents extensions from reading arbitrary local files). This is why:

1. Synthetic `DataTransfer` events fail — `isTrusted` is `false`, browsers reject them
2. `chrome.scripting.executeScript` in MAIN world — same `isTrusted` issue
3. `chrome.debugger` + `Runtime.evaluate` — can't set files on the input
4. `chrome.debugger` + `DOM.setFileInputFiles` — **blocked by Chrome**

## What Actually Works (Verified Live on Gemini)

There are **two viable approaches**, tested and confirmed:

---

### Approach 1: Direct CDP Connection (RECOMMENDED)

**Prerequisite:** Launch Chrome with `--remote-debugging-port=9222` instead of using the extension relay.

```bash
# Launch Chrome with remote debugging
google-chrome --remote-debugging-port=9222
```

**Step-by-step CDP sequence:**

```javascript
// Step 1: Enable file chooser interception (prevents native dialog)
await cdp("Page.setInterceptFileChooserDialog", { enabled: true });

// Step 2: Click the "+" button to open menu
// Find button: button[aria-label="Upload and tools"]
// Use DOM.querySelector + DOM.getBoxModel + Input.dispatchMouseEvent
// OR use Accessibility.getFullAXTree to find it

// Step 3: Click "Upload files" in the menu
// The native dialog does NOT open because interception is enabled

// Step 4: Find the file input
const { root } = await cdp("DOM.getDocument");
const { nodeId } = await cdp("DOM.querySelector", {
  nodeId: root.nodeId,
  selector: 'input[type="file"].hidden-file-input'
});

// Step 5: Set the file (MUST be absolute path on disk)
await cdp("DOM.setFileInputFiles", {
  files: ["/absolute/path/to/your/file.txt"],
  nodeId: nodeId
});

// Step 6: Gemini automatically processes the file
// The change event fires internally and the file appears in the input area

// Step 7: Click send button
// Find button with aria-label="Send message"
```

**Why this works:** Direct CDP connections (via `--remote-debugging-port`) are NOT subject to the `chrome.debugger` restriction. The file must exist on disk at the absolute path.

---

### Approach 2: `chrome.debugger` with "Allow access to file URLs" (Extension)

**This is the fix discovered by the Claude in Chrome team** ([issue #32561](https://github.com/anthropics/claude-code/issues/32561)):

1. Go to `chrome://extensions`
2. Find your extension
3. Click "Details"
4. Enable **"Allow access to file URLs"**
5. `DOM.setFileInputFiles` now works through `chrome.debugger`

**Then use the same CDP sequence as Approach 1.**

---

### Approach 3: In-Page File Reconstruction (Fallback)

If neither CDP approach works, reconstruct the file **inside the page** (used by [chrome-use v1.5.8+](https://github.com/leeguooooo/chrome-use/issues/13)):

```javascript
// Step 1: Read file bytes from disk via WebSocket/CLI
// Step 2: Stream base64 chunks to the page (<1 MiB each)
// Step 3: Build a File object IN the page context

await cdp("Runtime.evaluate", {
  expression: `
    (async function() {
      // base64Data is the file content sent from your CLI
      const bytes = Uint8Array.from(atob('${base64Data}'), c => c.charCodeAt(0));
      const file = new File([bytes], 'upload.txt', { type: 'text/plain' });

      const dt = new DataTransfer();
      dt.items.add(file);

      const input = document.querySelector('input[type="file"].hidden-file-input');
      input.files = dt.files;

      // Fire change event
      input.dispatchEvent(new Event('change', { bubbles: true }));
    })()
  `,
  awaitPromise: true
});
```

**Warning:** This may not work on Google services if they check `isTrusted` on the `change` event. It works on most sites.

---

## Gemini-Specific DOM Details

From live testing on `gemini.google.com/app`:

| Element | Details |
|---------|---------|
| Upload trigger | `button[aria-label="Upload and tools"]` — the "+" button |
| Menu items | "Upload files", "Add from Drive", "More uploads" |
| File inputs | 2x `<input type="file" class="hidden-file-input" multiple>` |
| Parent components | `<IMAGES-FILES-UPLOADER>`, `<UPLOADER>` (Angular custom elements) |
| Accept list | Massive: `.txt,.pdf,.doc,.docx,.json,.py,.js,.ts,.csv,...` (code + data files) |
| Input visibility | `display:none` / `0x0` size — hidden, triggered by button click |

## Complete Working Sequence (Tested & Verified)

```
1. Navigate to gemini.google.com/app
2. cdp("Page.setInterceptFileChooserDialog", { enabled: true })
3. Click button[aria-label="Upload and tools"]
4. Wait 1s for menu to render
5. Click button with text "Upload files"
6. Wait 1s for file inputs to appear
7. cdp("DOM.getDocument") → get root nodeId
8. cdp("DOM.querySelector", { nodeId: root, selector: 'input[type="file"]' })
9. cdp("DOM.setFileInputFiles", { files: ["/path/to/file"], nodeId: fileNodeId })
10. File appears as thumbnail in Gemini input area
11. Click button[aria-label="Send message"]
12. Gemini reads and processes the file
```

## Key CDP Commands Reference

| Command | Purpose |
|---------|---------|
| `Page.setInterceptFileChooserDialog` | Block native file dialog, keep page responsive |
| `DOM.getDocument` | Get root nodeId for queries |
| `DOM.querySelector` | Find the hidden file input by CSS selector |
| `DOM.setFileInputFiles` | Set file(s) on the input — **the core command** |
| `Accessibility.getFullAXTree` | Find buttons by accessible name (alternative to CSS selectors) |
| `DOM.getBoxModel` | Get element coordinates for clicking |
| `Input.dispatchMouseEvent` | Click elements programmatically |

## Why Previous Approaches Failed

| Approach | Failure Reason |
|----------|---------------|
| Synthetic DataTransfer events | `isTrusted=false`, browsers/Gemini reject |
| `chrome.scripting.executeScript` MAIN world | Same `isTrusted` issue |
| `chrome.debugger` + `Runtime.evaluate` | Can't write to `<input type="file">` via JS |
| `chrome.debugger` + `DOM.setFileInputFiles` | **Blocked by Chromium since Chrome 72** (bug #928255) |
| `chrome.debugger` + `Input.dispatchMouseEvent` | Opens native dialog, can't interact with it |

## Quick Fix for Your Extension

If you want `DOM.setFileInputFiles` to work through your extension's `chrome.debugger`:

1. Add `"file_url_patterns": ["file:///*"]` to your manifest's permissions (or enable via `chrome://extensions`)
2. OR launch Chrome with `--remote-debugging-port=9222` and connect directly instead of using the extension relay

## Chromium Bug References

- **Chromium bug #928255**: [DOM.setFileInputFiles returning error "Not allowed"](https://bugs.chromium.org/p/chromium/issues/detail?id=928255) — The original bug, marked Won't Fix, requires file URL permission
- **Chromium issue #40090289**: Security: DevTools protocol clients can read arbitrary local files via DOM.setFileInputFiles — The security concern that caused the restriction
- **chrome-use issue #13**: Extension-relay session upload always fails — Documents the workaround
- **Claude in Chrome issue #32561**: "Allow access to file URLs" fixes the `chrome.debugger` path
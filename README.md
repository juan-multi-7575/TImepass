# Timepass - Standalone Gemini Web Automation CLI & SDK

Timepass is a zero-dependency, deep module designed to bridge local terminal execution and scripts with Google Gemini (`gemini.google.com`) running inside your active Chrome session. It utilizes a custom Manifest V3 Chrome Extension and a local WebSocket server to achieve stealth control, remote logging, and browser state synchronization.

---

## Features

- **Stealth Automation**: Avoids Chromium guest tabs and bot detection by automating your real active Chrome profile.
- **Remote Console Redirection**: Directs all service worker and content script logs, warnings, errors, and unhandled window exceptions directly to your CLI terminal.
- **Maximized Screenshot Capturing**: Programmatically activates the Gemini tab, maximizes the window, and captures a PNG screenshot of the viewport.
- **CSP-Safe DOM Inspection**: Generates computed-style-inclusive JSON subtree outlines of targeted element tags without violating Content Security Policies.
- **Cookie Synchronization**: Backs up and restores active browser cookies (including HttpOnly and Secure flags) to disk JSON files.
- **Drag-and-Drop File Upload**: Programmatically injects local files (text, images, PDFs, CSVs) directly into the Gemini prompt editor using simulated HTML5 `DragEvent` drops.

---

## Directory Layout

```
timepass/
├── package.json                   # Standalone node package configuration
├── tsconfig.json                  # ES2022 TypeScript configuration
├── README.md                      # This documentation
├── extension/                     # Lightweight Chrome MV3 Extension
│   ├── manifest.json              # Extension permission gates (<all_urls>, cookies, storage)
│   ├── background.js              # Service worker & WS client orchestrator
│   └── content.js                 # Target page text injector & MutationObserver
└── src/
    ├── index.ts                   # Public API exports
    ├── cli.ts                     # Executable CLI program
    ├── adapter/
    │   └── gemini-adapter.ts      # Core GeminiAdapter facade
    └── driver/
        └── extension-driver.ts    # WebSocket driver bridge
```

---

## Setup & Installation

1. **Build the CLI & SDK**:
   ```bash
   cd timepass
   npm run build
   ```

2. **Load the Chrome Extension**:
   - Open Chrome and navigate to `chrome://extensions/`.
   - Enable **Developer mode** (toggle in top right).
   - Click **Load unpacked** (top left) and choose the `/timepass/extension/` folder.

---

## CLI Usage

Run any command using `npx tsx src/cli.ts` from the `timepass` directory.

### 1. Send Prompts
- **Stream Response** (real-time token output):
  ```bash
  npx tsx src/cli.ts stream "Explain Shor's algorithm in one sentence."
  ```
- **Static Output** (print response once complete):
  ```bash
  npx tsx src/cli.ts ask "What is the capital of France?"
  ```
*Both commands save the complete generated output to `timepass/response.md`.*

### 2. Capture Viewport Screenshot
```bash
npx tsx src/cli.ts screenshot
```
*Maximizes the window, focuses the Gemini tab, captures the active screen, and saves the image to `timepass/screenshot.png`.*

### 3. Dump DOM Subtree
```bash
npx tsx src/cli.ts dom-dump "rich-textarea"
```
*Saves the computed element tree JSON outline to `timepass/dom-tree.json`.*

### 4. Backup & Restore Cookies
- **Backup**:
  ```bash
  npx tsx src/cli.ts cookies-get gemini.google.com
  ```
  *Saves active cookies to `timepass/cookies.json`.*
- **Restore**:
  ```bash
  npx tsx src/cli.ts cookies-restore gemini.google.com
  ```
  *Wipes and restores cookies from `timepass/cookies.json` back to the browser.*

### 5. Programmatic File Upload
```bash
npx tsx src/cli.ts file-upload test.txt
```
*Injects the file content programmatically into the Gemini composer dropzone.*

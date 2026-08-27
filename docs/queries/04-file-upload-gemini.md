# File Upload to Gemini via Chrome Extension

## Problem
We need to upload files to Gemini (gemini.google.com) using a Chrome MV3 Extension. The extension uses a WebSocket bridge to communicate between a CLI tool and the extension's background service worker.

## What We Tried
1. **Synthetic DataTransfer events** - Created a File object, put it in a DataTransfer, and dispatched 'change'/'input' events on the file input. Result: File input shows 0 files attached (browser validates isTrusted).
2. **chrome.scripting.executeScript with world: 'MAIN'** - Same DataTransfer approach but in MAIN world. Result: Same failure.
3. **chrome.debugger.attach() + Runtime.evaluate** - Used CDP to evaluate JS that creates File and sets it. Result: File input not found after clicking upload button (debugger attach disrupts page state).
4. **chrome.debugger + Input.dispatchMouseEvent** - Tried to simulate real mouse click. Result: Not yet tested.

## What We Know
- Gemini has a button `button[aria-label='Upload and tools']` that opens a menu
- After clicking, file inputs appear in the DOM (we confirmed this earlier: "File inputs: 2")
- The file inputs are likely `<input type='file'>` elements
- All major browser automation tools (browser-use, Playwright, Puppeteer) use CDP's `DOM.setFileInputFiles` for file uploads - NOT synthetic events

## Questions to Research

### Q1: How does Gemini's file upload work?
- What happens when you click the "Upload and tools" button?
- Does it open a dropdown menu with options like "Upload from device", "Upload from URL", etc.?
- Do we need to click a specific option to reveal the file input?
- Or does the file input appear directly after clicking the button?

### Q2: Can chrome.debugger.attach() be used without disrupting the page?
- Does attaching the debugger cause dynamic UI elements (dropdowns, menus) to close?
- Is there a way to attach the debugger BEFORE opening the menu, then click and set file in one session?

### Q3: What's the correct CDP method for file uploads?
- Is it `DOM.setFileInputFiles` with a `nodeId` or `objectId`?
- Does it require the file to be on disk, or can we pass base64 data?
- What's the exact CDP command sequence?

### Q4: Are there alternative approaches?
- Can we use `chrome.downloads.download` to save the file to disk, then use CDP to set it?
- Can we use a different CDP method like `Page.handleJavaScriptDialog` or `Input.dispatchKeyEvent`?
- Is there a way to use `chrome.fileSystem` API?

### Q5: How do other extensions handle file uploads?
- Are there any Chrome extensions that successfully upload files to Gemini?
- What approach do they use?

## Context
- Extension manifest has: tabs, tabGroups, activeTab, scripting, storage, cookies, contextMenus, debugger permissions
- Content script is loaded on gemini.google.com
- Background service worker communicates with CLI via WebSocket on port 9876
- We can use chrome.scripting.executeScript, chrome.debugger, chrome.tabs.sendMessage

## Expected Output
A step-by-step guide on how to upload files to Gemini using a Chrome Extension, with specific CDP commands or alternative approaches that work.

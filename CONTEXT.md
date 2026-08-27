# CONTEXT.md - timepass Domain Model & Glossary

This document defines the ubiquitous language and domain concepts for the **`timepass`** standalone Gemini web adapter package.

---

## Ubiquitous Language

### 1. Adapter & Driver Infrastructure

* **GeminiAdapter**: The top-level programmatic facade in `timepass` that accepts user prompts, manages execution options, and streams or returns Gemini web responses.
* **BrowserDriver**: The abstract interface representing the underlying browser transport. `timepass` supports dual drivers:
  * **ExtensionDriver**: Uses a local WebSocket bridge to talk to the dedicated `timepass` Chrome MV3 extension.
  * **CdpDriver**: Uses Chrome DevTools Protocol / Playwright to launch or attach to Chrome headlessly or headfully.
* **WebSocketBridge**: A lightweight server inside `timepass` running on localhost (`ws://127.0.0.1:9222` by default) that maintains heartbeat keep-alives with the Chrome extension service worker.

### 2. Tab & Group Management

* **TabGroupBarrier**: A Chrome Tab Group (`chrome.tabGroups`) titled `"🤖 Timepass Gemini"` that isolates automation tabs from the user's personal browsing tabs.
* **PinnedBackgroundTab**: A `gemini.google.com` tab opened with `active: false, pinned: true` so automation runs silently without stealing user window focus.

### 3. Stealth & Bot Detection Evasion Engine

* **TieredStealthEngine**: Multi-layered stealth system combining:
  1. **Extension In-Context Execution**: Runs actions inside authentic user Chrome profile with `isTrusted` event dispatching and zero `navigator.webdriver` flags.
  2. **HumanizedTimingDispatcher**: Simulates natural human keystroke delays (15ms-45ms chunks) and randomized cursor path curves.
  3. **CdpStealthPatcher**: Overrides navigator properties (`webdriver`, `plugins`, `languages`) when running via `CdpDriver`.

### 4. Component & DOM Interaction Engine

* **ComponentRegistry**: The extensible registry of UI element handlers in `timepass`. Allows adding new component triggers without mutating core adapter code.
* **ComponentHandler**: An isolated module defining DOM query strategies, Shadow DOM traversal, and action triggers for a specific Gemini UI element (e.g. `PromptInput`, `SendButton`, `ModelPicker`, `DeepResearchToggle`, `ImageUploader`, `HistorySidebar`).
* **HybridDomInjector**: A DOM interaction technique that combines multi-tiered fallback selectors (`ql-editor`, `[contenteditable="true"]`, `[aria-label*="Prompt"]`) with native JavaScript event dispatching (`execCommand('insertText')`, `input`/`change` events) to reliably enable Gemini's send button.

### 5. Conversation & State Engine

* **StatefulConversationSession**: Tracks active Gemini conversation URL (`https://gemini.google.com/app/1a2b3c4d5e6f`) across multi-turn prompts while supporting explicit `--new-chat` resets or `--chat-id` targeted navigation.
* **MutationStreamer**: A `MutationObserver` wrapper attached to active `<model-response>` DOM nodes that emits text deltas over WebSocket in real-time.
* **DualResponsePayload**: A response container offering both real-time delta callbacks (`onChunk`) and a promise resolving to the final complete formatted Markdown response.
* **AutoRetryHandler**: Error recovery logic that catches Gemini error toasts ("Something went wrong") or UI stalls, triggers Gemini's native "Retry" button up to 2 times, and falls back to a structured timeout error if unresolvable.

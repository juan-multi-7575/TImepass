# ADR 0003: Tiered Stealth Engine and Chrome Tab Group Barrier

## Context and Problem Statement

Automating web applications like `gemini.google.com` can trigger Google bot detection mechanisms (e.g., `navigator.webdriver` checks, `isTrusted` event validation, rapid mechanical typing patterns). Additionally, opening automation tabs in a user's active browser can clutter the tab strip and interfere with user browsing.

## Decision Drivers

* **Stealth & Evasion**: Actions must bypass bot detection seamlessly by mimicking natural human behavior.
* **Workspace Isolation**: Automation tabs must be grouped and isolated using Chrome's native Tab Groups API.

## Decision Outcome

Chosen Options:
1. **Tiered Stealth Engine**:
   - **In-Context Execution**: Extension content script runs within user Chrome profile context where `navigator.webdriver` is `false`.
   - **Humanized Typing**: Dispatch inputs with `execCommand('insertText')` and randomized per-character delay intervals (15ms-45ms).
   - **CDP Stealth Patching**: Inject evasion scripts overriding `navigator.plugins`, `languages`, and `chrome.runtime` when using Playwright CDP driver.
2. **Chrome Tab Group Isolation Barrier**:
   - Assign all Gemini tabs managed by `timepass` to a dedicated group titled `"🤖 Timepass Gemini"` with a purple theme color via `chrome.tabGroups`.

### Positive Consequences

* Extremely high resilience against bot detection and CAPTCHAs.
* Visual and operational isolation of automation tabs from personal tabs.

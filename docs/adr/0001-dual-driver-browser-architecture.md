# ADR 0001: Dual-Driver Browser Architecture for timepass

## Context and Problem Statement

`timepass` requires a robust mechanism to automate `gemini.google.com`. Browser automation frameworks like Playwright or Puppeteer excel in headless automation, but may require authenticating fresh sessions or handling bot detection. Conversely, a Chrome MV3 Extension leverages the user's existing logged-in browser session seamlessly, but requires an active Chrome instance.

## Decision Drivers

* Must support zero-login-friction execution using user's active Chrome browser.
* Must support headless / automated script execution via standard dev tools protocols.
* Must avoid single-vendor or single-driver lock-in.

## Considered Options

1. **Extension-Only**: WebSocket bridge to custom MV3 Chrome extension.
2. **Playwright-Only**: Headless CDP automation driver.
3. **Dual-Driver Architecture**: Abstract `BrowserDriver` interface supporting both `ExtensionDriver` and `CdpDriver`.

## Decision Outcome

Chosen Option: **Dual-Driver Architecture**.

### Positive Consequences

* Developers can use `ExtensionDriver` during local development to leverage their live Chrome session and saved logins.
* Server/CI scripts can use `CdpDriver` for automated headless runs.
* Clean separation of browser transport logic from Gemini DOM interaction logic.

# Query 1: Chrome Extension Validation Tools

## Prompt to ask Gemini

What are the best tools or frameworks to validate/lint Chrome extension code (Manifest V3) BEFORE loading it into chrome://extensions? I want to catch syntax errors, duplicate variable declarations, missing permissions, and API misuse at build/CI time — not at runtime. Options I know: ESLint with plugins, tsc for TypeScript, web-ext lint. Are there others? Which is the most comprehensive?

## QWEN.CHAT Answer

<!-- Paste Gemini's response here -->

---

To catch syntax errors, duplicate declarations, missing permissions, and API misuse at build/CI time for Manifest V3 (MV3) Chrome extensions, **no single tool does everything perfectly**. However, by combining a few specialized tools, you can create a highly comprehensive validation pipeline that catches issues long before `chrome://extensions` or Web Store submission.

Here is the breakdown of the best tools available, including the ones you mentioned and the newer, highly specialized options you should consider.

---

### 1. For Syntax Errors & Duplicate Declarations

* **TypeScript (`tsc`)**: The absolute best tool for this. Configure it with `"noUnusedVariables": true`, `"noImplicitAny": true`, and `"noEmitOnError": true`. It will instantly catch syntax errors, duplicate variable declarations, and unreachable code.
* **ESLint**: Use alongside `tsc` for stylistic and structural rules. Ensure you have `@typescript-eslint/eslint-plugin` enabled with rules like `no-redeclare` and `no-dupe-keys`.

### 2. For API Misuse (MV3 Specific)

* **`tsc` + `@types/chrome`**: This is your strongest defense against API misuse. The `@types/chrome` package is actively maintained and knows the exact signatures of MV3 APIs. It will throw type errors if you try to use deprecated MV2 APIs (e.g., `chrome.extension.getBackgroundPage()`), forget to `await` a promise-returning MV3 API, or misuse the `chrome.scripting` API.
* **`eslint-plugin-mv3`**: A niche but valuable plugin that enforces statically analyzable and self-contained code for cross-world script injections, helping prevent common MV3 messaging and injection pitfalls. [[10]]

### 3. For Missing/Excessive Permissions & Policy Violations

This is where general linters fall short. You need tools that cross-reference your `manifest.json` with your actual source code.

* **`webstore-lint`** (Highly Recommended): A specialized CLI tool that checks an unpacked extension against Chrome Web Store program policies before submission. [[43]] It maps findings directly to Google’s actual rejection codenames (e.g., "Purple Potassium" for excessive/unused permissions, "Blue Argon" for remotely hosted code). [[44]] Crucially, it features a **"permission ledger"** that scans your code to tell you exactly which API calls require a declared permission, and suggests narrower alternatives (e.g., suggesting `activeTab` instead of `<all_urls>`). [[44]]
* **`tabsmith-lint`**: Another excellent pre-submission compliance linter built specifically for MV3. [[45]] It statically analyzes your code against your manifest to flag unused permissions, missing permissions, MV3 violations, and broken file references, validated against a corpus of real-world open-source extensions. [[1]]

### 4. For Manifest Structure & Cross-Browser Validity

* **`web-ext lint`**: Mozilla’s official tool (which wraps `addons-linter`). It is excellent for catching structural manifest errors, invalid permission strings, and basic MV3 compliance. [[78]] However, because it is designed primarily for Firefox/AMO, it may miss Chrome Web Store-specific policy nuances that `webstore-lint` will catch. [[79]]
* **VS Code JSON Schema**: Install the "Chrome Extension Manifest JSON Schema" extension in VS Code to get real-time autocomplete and validation for `manifest.json` directly in your editor. [[84]]

---

### Which is the Most Comprehensive?

The **most comprehensive setup** is a layered CI/build pipeline. Relying on just one tool will leave blind spots. Here is the recommended gold-standard combination:

1. **`tsc`** (with `@types/chrome`) → Catches syntax, duplicates, and API signature misuse.
2. **`ESLint`** → Catches code quality and anti-patterns.
3. **`webstore-lint`** (or `tabsmith-lint`) → Catches permission mismatches and Chrome Web Store policy violations.

#### Example CI / `package.json` Script Setup:

```json
{
  "scripts": {
    "lint:code": "eslint src/ && tsc --noEmit",
    "lint:manifest": "web-ext lint --source-dir ./dist",
    "lint:policy": "npx webstore-lint ./dist --fail-on fail",
    "validate": "npm run lint:code && npm run build && npm run lint:policy"
  }
}
```

*(Note: Always point policy linters like `webstore-lint` at your **built output directory** (e.g., `./dist`), not your source root, because that is what the Chrome Web Store actually evaluates.)* [[44]]

---

### Pro-Tip: Consider a Modern Extension Framework

If you are starting fresh or can migrate, consider using a build framework like **[WXT](https://wxt.dev/)** or **[Plasmo](https://plasmo.com/)**. These frameworks natively support MV3, automatically generate and validate your `manifest.json` based on your code, inject the correct types, and have built-in linting hooks that prevent many of these issues by design. [[79]]

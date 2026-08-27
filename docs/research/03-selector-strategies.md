# DOM Selector Strategies — Research Findings

Source: https://playwright.dev/docs/locators

## Playwright's Locator Hierarchy (Recommended Priority)

| Priority | Strategy | Resilience | Example |
|----------|----------|------------|---------|
| 1 (Best) | `getByRole` | Survives all UI changes | `page.getByRole('button', {name: 'Submit'})` |
| 2 | `getByLabel` | Survives class/ID changes | `page.getByLabel('Email')` |
| 3 | `getByTestId` | Explicit stability contract | `page.getByTestId('checkout-btn')` |
| 4 | `getByText` | Breaks on text changes | `page.getByText('Add to cart')` |
| 5 (Worst) | CSS/XPath | Breaks on any DOM change | `page.locator('.btn-primary')` |

## Key Principles

### 1. Semantic First, CSS Last
```js
// GOOD — semantic, survives DOM changes
page.getByRole('button', { name: 'Send' })
page.getByLabel('Prompt')

// BAD — fragile, breaks on any CSS change
page.locator('button.send-button')
page.locator('.ql-editor')
```

### 2. Fallback Chains
```js
// Playwright .or() for fallback
const sendBtn = page.getByRole('button', { name: 'Send' })
  .or(page.getByRole('button', { name: 'Submit' }))
  .or(page.locator('button[aria-label*="Send"]'));
```

### 3. Auto-Recovery
- Locators find elements lazily (re-evaluate on each action)
- If DOM changes between calls, new element is found automatically
- No stale reference issues

## Chrome Extension Context

Since content scripts can't use Playwright directly, we need to implement the same priority in vanilla JS:

```js
const SELECTORS = {
  sendButton: [
    // Priority 1: Role/ARIA (most resilient)
    'button[aria-label*="Send"]',
    'button[role="button"][aria-label*="Send"]',
    // Priority 2: Data attributes (explicit contract)
    '[data-testid="send-button"]',
    // Priority 3: Text content
    'button:has-text("Send")',
    // Priority 4: CSS classes (fragile)
    'button.send-button',
    'button[mattooltip*="Send"]',
  ]
};

function findElement(selectorList) {
  for (const sel of selectorList) {
    try {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) return el;
    } catch {}
  }
  return null;
}
```

## Gemini-Specific Selector Research

From DOM inspection (browser-use):

```js
const GEMINI_SELECTORS = {
  promptInput: [
    'rich-textarea .ql-editor',                    // Quill editor
    'rich-textarea [contenteditable="true"]',       // Fallback
    '[aria-label*="Enter a prompt"]',               // ARIA
    'div[role="textbox"]',                          // Role
  ],
  sendButton: [
    'button[aria-label*="Send"]',                   // ARIA
    'button[aria-label*="send"]',                   // Case variant
    'button[mattooltip*="Send"]',                   // Angular Material
    'button[aria-label*="Submit"]',                 // Alt label
  ],
  responseContainer: [
    'model-response',                               // Custom element
    '[class*="model-response"]',                    // Class fallback
    'response-container',                           // Custom element
    '.markdown',                                    // Content area
  ],
  excludeFromResponse: [
    '[class*="tts"]',                               // Text-to-speech
    '[class*="visually-hidden"]',                   // Accessibility
    '.cdk-describedby-message-container',           // Angular CDK
  ],
  fileInput: 'input[type="file"]',
  uploadButton: "button[aria-label='Upload and tools']",
};
```

## Selector Reliability Scoring

Based on research from LocatorPro and production extensions:

| Selector Type | Reliability | Breaks When |
|---------------|-------------|-------------|
| `id` | 0.98 | ID is changed |
| `data-testid` | 0.95 | Test attribute removed |
| `aria-label` | 0.90 | Label text changes |
| `role` + name | 0.85 | Role or name changes |
| Text content | 0.80 | Button text changes |
| CSS class | 0.60-0.80 | Any style refactor |
| XPath | 0.50-0.70 | DOM structure changes |

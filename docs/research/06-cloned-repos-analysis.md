# Cloned Repos Analysis — Architecture Patterns

## Repos Analyzed

| Repo | Purpose | Key Pattern |
|------|---------|-------------|
| browser-use | LLM-driven browser automation | Element indexing, no hardcoded selectors |
| crawl4ai | Web crawling | CSS selectors, no DOM interaction |
| Scrapling | Web scraping | CSS selectors, no interactive DOM |
| ego-lite | CDP browser harness for AI agents | **Per-site skills + element resolver** |
| browserless | Browser-as-a-service | WebSocket API, no DOM interaction |

## ego-lite: The Winning Pattern

### Architecture
```
skills/ego-browser/learnings/
├── google/
│   ├── manifest.json      # Site definition
│   ├── notes/             # Documentation
│   ├── tools/             # Node-side operations
│   └── browser-tools/     # Client-side operations
└── x-com/
    ├── manifest.json
    ├── notes/
    ├── tools/
    └── browser-tools/
```

### manifest.json Structure
```json
{
  "id": "google",
  "name": "Google Search",
  "domains": ["google.com", "*.google.com"],
  "notes": ["notes/overview.md"],
  "nodeTools": {
    "search_and_extract": {
      "description": "Perform a Google search and extract top organic results.",
      "path": "tools/search-extract.js",
      "callable": "searchAndExtract",
      "args": { "query": {"type": "string", "required": true} },
      "returns": {"type": "array"}
    }
  },
  "browserTools": {
    "get_autocomplete_suggestions": {
      "description": "Get autocomplete suggestions for the current search query.",
      "path": "browser-tools/autocomplete.js",
      "args": {},
      "returns": {"type": "array"}
    }
  }
}
```

### Element Resolver
- Resolves all target forms: `@N` refs, `loc=css:`, `loc=role:`, `loc=href:`, `xpath=`, raw CSS
- Numeric `backendNodeId`s (`@21`) rebuilt on every snapshot
- Classifies failures as `transient` (retryable) or `permanent`

### Key Insight
**Node tools** = server-side operations (CDP, file upload, debugger)
**Browser tools** = client-side operations (DOM queries, clicks, typing)

This separates CDP-required operations from content script operations!

## browser-use: Alternative Pattern

### Element Detection
- Uses accessibility tree (`Accessibility.getFullAXTree`)
- Elements indexed numerically for LLM interaction
- No CSS selectors — LLM sees `[1]<button>Submit</button>`

### Action Model
```python
class ClickElementAction(BaseModel):
    index: int | None = Field(default=None, ge=1, description='Element index from browser_state')
    coordinate_x: int | None = Field(default=None)
    coordinate_y: int | None = Field(default=None)
```

### Key Insight
LLM provides the intelligence — it reads the numbered element list and decides which one to click. Completely site-agnostic but requires API calls per step.

## Recommendation for timepass

### Adopt ego-lite's Per-Site Skills Pattern

```
extension/skills/gemini/
├── manifest.json      # Gemini-specific config
├── notes/
│   └── overview.md    # Gemini DOM documentation
├── tools/             # Node-side operations
│   ├── file-upload.js
│   └── cookie-restore.js
└── browser-tools/     # Content script operations
    ├── prompt-input.js
    ├── send-button.js
    └── response-streamer.js
```

### manifest.json for Gemini
```json
{
  "id": "gemini",
  "name": "Google Gemini",
  "domains": ["gemini.google.com", "*.gemini.google.com"],
  "notes": ["notes/overview.md"],
  "nodeTools": {
    "file_upload": {
      "description": "Upload file to Gemini via CDP",
      "path": "tools/file-upload.js",
      "callable": "fileUpload",
      "args": { "filePaths": {"type": "array", "required": true} }
    }
  },
  "browserTools": {
    "inject_and_send": {
      "description": "Type prompt and click send",
      "path": "browser-tools/inject-and-send.js",
      "callable": "injectAndSend",
      "args": { "text": {"type": "string", "required": true} }
    },
    "stream_response": {
      "description": "Observe and stream model response",
      "path": "browser-tools/stream-response.js",
      "callable": "streamResponse",
      "args": { "id": {"type": "string", "required": true} }
    }
  }
}
```

### Selector Config (in notes/overview.md or separate config)
```json
{
  "selectors": {
    "promptInput": [
      "rich-textarea .ql-editor",
      "rich-textarea [contenteditable='true']",
      "[aria-label*='Enter a prompt']",
      "div[role='textbox']"
    ],
    "sendButton": [
      "button[aria-label*='Send']",
      "button[aria-label*='send']",
      "button[mattooltip*='Send']"
    ],
    "responseContainer": [
      "model-response",
      "[class*='model-response']",
      "response-container"
    ],
    "excludeFromResponse": [
      "[class*='tts']",
      "[class*='visually-hidden']",
      ".cdk-describedby-message-container"
    ]
  }
}
```

### Benefits
1. **Extension is universal** — loads skills dynamically based on domain
2. **Selectors live in CLI/skill config** — npm update to fix broken selectors
3. **CDP operations separated** — file upload stays in nodeTools
4. **Per-site documentation** — notes/ directory explains DOM structure
5. **Hot-reloadable** — skill manifests can be updated without extension reload

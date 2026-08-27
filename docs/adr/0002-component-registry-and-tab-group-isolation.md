# ADR 0002: Component Registry and Tab Group Isolation

## Context and Problem Statement

`gemini.google.com` is a complex Google Web Component application that periodically updates UI element classes, add new features (e.g., Deep Research, Thinking Mode, Canvas), and uses complex DOM hierarchies. 

Additionally, automating tabs in a user's active Chrome browser can create clutter or accidentally interfere with personal browsing tabs.

## Decision Drivers

* **Extensibility**: Adding new Gemini UI component triggers must not break existing handlers or require refactoring core framework code.
* **Isolation**: Automation tabs must be clearly segregated from the user's personal browsing session.

## Decision Outcome

Chosen Options:
1. **Extensible Component Registry**: Implement a modular `ComponentRegistry` where individual `ComponentHandler` modules define DOM query strategies (with Shadow DOM traversal) and action triggers independently.
2. **Tab Group Isolation Barrier**: Create and manage Gemini automation tabs inside a dedicated Chrome Tab Group (`chrome.tabGroups`) named `"🤖 Timepass Gemini"`.

### Positive Consequences

* New UI element triggers (e.g. Canvas, Code Execution, Export) can be added as standalone component handler files.
* User's personal Chrome workspace stays completely clean and isolated from automated tab lifecycle management.

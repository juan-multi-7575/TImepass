/**
 * The timepass Gemini bridge as a DeepSeek Harness plugin.
 *
 * The default export surface of a DSH plugin module is the set of named exports
 * Cordis reads: `name`, `inject`, `apply`, and the Schemastery `Config` it
 * validates the profile's configuration with. This file re-exports exactly
 * those, so `name: 'dsh-timepass-gemini'` in a patch row loads the plugin and
 * `name: 'dsh-timepass-gemini/tools'` loads the same plugin directly.
 * @module dsh-timepass-gemini
 */

export { name, inject, apply, Config } from './tools.js'
export { BRIDGE_PORT, PACKAGE_ROOT, PROJECT_ROOT, normalizeConfig } from './config.js'
export { createBridge } from './bridge.js'

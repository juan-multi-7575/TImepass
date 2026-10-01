/**
 * Audit of the gap between what this plugin registers and what the adapter can do.
 *
 * The retest that produced issue #10 was run against a DSH session whose tool
 * list did not include `gemini_collect`, even though the adapter implemented it
 * and the plugin source registered it. The cause was an ordinary stale process:
 * the session started before the tool was added, and nothing anywhere said so.
 * A tool that is registered but absent from the model-facing list is invisible
 * by construction — the model cannot report a tool it cannot see.
 *
 * This module closes that gap at the point where both facts are knowable: the
 * names the plugin just registered, and the methods the loaded adapter actually
 * has.
 * @module dsh-timepass-gemini/lib/registry
 */

/**
 * Which adapter method each tool drives.
 *
 * Kept beside the tools rather than beside the adapter on purpose: the question
 * being asked is "does every tool have something to call", which is a statement
 * about the tool layer, and a tool added without an entry here is immediately
 * visible as an unverified tool in the audit.
 */
export const TOOL_ADAPTER_METHODS = {
  gemini_ask: 'ask',
  gemini_ask_with_files: 'askWithFiles',
  gemini_collect: 'collectLastResponse',
  gemini_screenshot: 'captureScreenshot',
  gemini_dom_snapshot: 'dumpDom',
  gemini_page_info: 'getPageInfo',
  gemini_tabs: 'listTabs',
  gemini_session: 'listTabs',
  gemini_history: 'listHistory',
  gemini_open_chat: 'selectHistory',
  gemini_click: 'clickButton',
  gemini_cookies_backup: 'getCookies',
  gemini_cookies_restore: 'restoreCookies',
  gemini_status: 'connect',
}

/** Methods an adapter must have for the bridge to be usable at all. */
export const REQUIRED_ADAPTER_METHODS = ['connect', 'ask', 'close']

/**
 * What the audit found.
 * @typedef {{ ok: boolean, unverifiedTools: string[], missingMethods: string[], missingRequired: string[], unregisteredMethods: string[] }} RegistryAudit
 */

/**
 * Compare registered tools against the loaded adapter.
 *
 * Pure, so it is unit-tested directly rather than through a live bridge.
 *
 * @param {string[]} toolNames - Names the plugin just registered.
 * @param {object | null | undefined} adapter - The adapter instance, or its class/prototype.
 * @returns {RegistryAudit} What lines up and what does not.
 */
export function auditToolRegistry(toolNames, adapter) {
  const methods = adapterMethods(adapter)
  const unverifiedTools = []
  const missingMethods = []

  for (const tool of toolNames) {
    const method = TOOL_ADAPTER_METHODS[tool]
    // A tool with no declared method is not broken, only undeclared. Saying so
    // is the point: an undeclared tool is one this audit cannot vouch for.
    if (!method) {
      unverifiedTools.push(tool)
      continue
    }
    if (!methods.has(method)) missingMethods.push(tool + ' -> ' + method)
  }

  const missingRequired = REQUIRED_ADAPTER_METHODS.filter(method => !methods.has(method))
  const declared = new Set(Object.values(TOOL_ADAPTER_METHODS))
  const unregisteredMethods = [...methods].filter(method => !declared.has(method)).sort()

  return {
    ok: missingMethods.length === 0 && missingRequired.length === 0 && unverifiedTools.length === 0,
    unverifiedTools,
    missingMethods,
    missingRequired,
    unregisteredMethods,
  }
}

/**
 * Every method the adapter exposes, prototype included.
 *
 * @param {any} adapter - An instance or a class.
 * @returns {Set<string>} Method names.
 */
function adapterMethods(adapter) {
  if (!adapter) return new Set()
  const proto = typeof adapter === 'function' ? adapter.prototype : adapter
  const names = new Set()
  let cursor = proto
  while (cursor && cursor !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(cursor)) {
      if (name !== 'constructor') names.add(name)
    }
    cursor = Object.getPrototypeOf(cursor)
  }
  return names
}

/**
 * Render an audit as lines an operator can act on.
 *
 * @param {RegistryAudit} audit - What the audit found.
 * @returns {string[]} One line per finding; empty when everything lines up.
 */
export function describeRegistryAudit(audit) {
  const lines = []
  for (const entry of audit.missingMethods) {
    lines.push(
      'Tool ' + entry + ' has no matching adapter method. The tool was registered against an adapter that '
      + 'predates it — restart the DSH session so it loads the current adapter.'
    )
  }
  for (const method of audit.missingRequired) {
    lines.push('The adapter is missing ' + method + '(), which the bridge cannot work without.')
  }
  if (audit.unverifiedTools.length > 0) {
    lines.push(
      'Unverified tools (no adapter method declared for them): ' + audit.unverifiedTools.join(', ')
      + '. Add them to TOOL_ADAPTER_METHODS in dsh-plugin/src/lib/registry.js so the audit covers them.'
    )
  }
  if (audit.unregisteredMethods.length > 0) {
    lines.push(
      'Adapter methods with no tool (fine — the tool layer does not have to expose all of them): '
      + audit.unregisteredMethods.join(', ')
    )
  }
  return lines
}
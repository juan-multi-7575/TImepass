import { describe, expect, it } from 'vitest';
import {
  auditToolRegistry,
  describeRegistryAudit,
  REQUIRED_ADAPTER_METHODS,
  TOOL_ADAPTER_METHODS,
} from './registry.js';

/**
 * The retest that produced issue #10 ran against a DSH session whose tool list
 * did not include `gemini_collect`, though the adapter implemented it and the
 * plugin registered it. The cause was an ordinary stale process, and nothing
 * reported it. These tests pin the check that makes that state visible instead.
 */

/** An adapter stand-in with the methods a current build has. */
class CurrentAdapter {
  connect() {}
  ask() {}
  askWithFiles() {}
  collectLastResponse() {}
  captureScreenshot() {}
  dumpDom() {}
  getPageInfo() {}
  listTabs() {}
  listHistory() {}
  selectHistory() {}
  clickButton() {}
  getCookies() {}
  restoreCookies() {}
  close() {}
  /** Not exposed as a tool; must not be reported as a problem. */
  registerComponent() {}
}

/**
 * The adapter a session gets when it started before `gemini_collect` existed.
 *
 * Declared standalone rather than by extending CurrentAdapter, because
 * inheriting the method would defeat the point: the whole condition is a process
 * loaded from code that predates the method.
 */
class StaleAdapter {
  connect() {}
  ask() {}
  askWithFiles() {}
  captureScreenshot() {}
  dumpDom() {}
  getPageInfo() {}
  listTabs() {}
  listHistory() {}
  selectHistory() {}
  clickButton() {}
  getCookies() {}
  restoreCookies() {}
  close() {}
}

describe('auditToolRegistry', () => {
  it('passes when every registered tool has a method to call', () => {
    const audit = auditToolRegistry(Object.keys(TOOL_ADAPTER_METHODS), CurrentAdapter);

    expect(audit.ok).toBe(true);
    expect(audit.missingMethods).toEqual([]);
    expect(audit.unverifiedTools).toEqual([]);
  });

  it('names the tool whose adapter method is missing', () => {
    // The retest's exact situation: the tool is registered, the method is not.
    const audit = auditToolRegistry(['gemini_ask', 'gemini_collect'], StaleAdapter);

    expect(audit.ok).toBe(false);
    expect(audit.missingMethods).toEqual(['gemini_collect -> collectLastResponse']);
    expect(audit.missingRequired).toEqual([]);
  });

  it('flags a tool the audit cannot vouch for', () => {
    // A tool added without a TOOL_ADAPTER_METHODS entry is not broken, but it
    // is unchecked, and that is worth saying out loud.
    const audit = auditToolRegistry(['gemini_ask', 'gemini_future_thing'], CurrentAdapter);

    expect(audit.ok).toBe(false);
    expect(audit.unverifiedTools).toEqual(['gemini_future_thing']);
    expect(audit.missingMethods).toEqual([]);
  });

  it('separates a broken adapter from a tool-layer gap', () => {
    const audit = auditToolRegistry(['gemini_ask'], { ask() {} });

    expect(audit.ok).toBe(false);
    expect(audit.missingRequired).toEqual(REQUIRED_ADAPTER_METHODS.filter(m => m !== 'ask'));
  });

  it('reports adapter methods with no tool without calling them a problem', () => {
    const audit = auditToolRegistry(['gemini_ask'], CurrentAdapter);

    // registerComponent and registerComponent's sibling are not tool-facing.
    expect(audit.unregisteredMethods).toContain('registerComponent');
    expect(audit.ok).toBe(true);
  });

  it('survives an adapter that failed to load', () => {
    // The plugin must still mount when the adapter cannot be imported; the
    // bridge reports that in its own words on the first real call.
    const audit = auditToolRegistry(['gemini_ask'], null);

    expect(audit.missingRequired).toEqual(REQUIRED_ADAPTER_METHODS);
    expect(audit.missingMethods).toEqual(['gemini_ask -> ask']);
  });

  it('reads methods off a class as well as an instance', () => {
    expect(auditToolRegistry(['gemini_ask'], CurrentAdapter).ok).toBe(true);
  });
});

describe('describeRegistryAudit', () => {
  it('says nothing when everything lines up', () => {
    const audit = auditToolRegistry(['gemini_ask'], CurrentAdapter);

    const lines = describeRegistryAudit(audit);

    expect(lines.join('\n')).not.toMatch(/restart/i);
  });

  it('names the tool and the fix for a missing adapter method', () => {
    const lines = describeRegistryAudit(auditToolRegistry(['gemini_collect'], StaleAdapter));

    const text = lines.join('\n');
    expect(text).toContain('gemini_collect -> collectLastResponse');
    expect(text).toMatch(/restart the DSH session/i);
  });

  it('tells the reader where to declare a tool it cannot check', () => {
    const lines = describeRegistryAudit(auditToolRegistry(['gemini_future'], CurrentAdapter));

    expect(lines.join('\n')).toContain('TOOL_ADAPTER_METHODS');
  });
});
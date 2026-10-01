import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * The shipped background.js is a classic MV3 service-worker script, so it is
 * evaluated here rather than imported (same shape as answer-root.test.js). Every
 * side effect the file has at load time is stubbed out through injected
 * parameters -- chrome, WebSocket, fetch, setInterval and console -- so loading
 * it neither touches the real globals nor leaves live timers behind. The pure
 * freeze-watchdog helpers are read back off the `__timepassInternals` seam the
 * file publishes.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(path.join(HERE, 'background.js'), 'utf8');

let api;

/**
 * Evaluate the shipped background.js with every load-time side effect stubbed,
 * and return the scope it built. `new Function` body vars are function-scoped,
 * so background.js's top-level `const`s cannot collide with this module.
 */
function evaluate(src) {
  const scope = {};
  const chromeStub = {
    runtime: {
      onMessage: { addListener() {} },
      getManifest: () => ({ version: '1.0.0' })
    },
    storage: { local: { set() {} } },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {}, setTitle() {} }
  };
  const websocketStub = function WebSocketStub() {};
  websocketStub.OPEN = 1;
  websocketStub.CONNECTING = 0;
  const fetchStub = () => Promise.reject(new Error('offline in test'));
  // setInterval is neutralised so the file's two load-time intervals never
  // schedule anything, but setTimeout/clearTimeout stay REAL: withBudget
  // depends on a genuine timer, and stubbing it to a no-op would make its
  // timeout path untestable (and silently wrong) rather than slow.
  const intervalStub = () => 0;
  const consoleStub = { log() {}, warn() {}, error() {}, info() {} };

  const load = new Function(
    'globalThis', 'chrome', 'WebSocket', 'fetch',
    'setInterval', 'setTimeout', 'clearTimeout', 'console',
    src
  );
  load(scope, chromeStub, websocketStub, fetchStub,
    intervalStub, setTimeout, clearTimeout, consoleStub);
  return scope;
}

beforeAll(() => {
  api = evaluate(SOURCE).__timepassInternals;
});

const T0 = 1_700_000_000_000;

function turn(overrides = {}) {
  return {
    id: 'act_1',
    tabId: 7,
    startedAt: T0,
    lastBeatAt: T0,
    budgetMs: 60000,
    handled: false,
    ...overrides
  };
}

describe('freezeWindowMs', () => {
  it('scales the window with the turn budget (budget / 4)', () => {
    expect(api.freezeWindowMs(turn({ budgetMs: 60000 }))).toBe(15000);
    expect(api.freezeWindowMs(turn({ budgetMs: 40000 }))).toBe(10000);
    expect(api.freezeWindowMs(turn({ budgetMs: 80000 }))).toBe(20000);
  });

  it('clamps the window to the policy floor for very short budgets', () => {
    expect(api.freezeWindowMs(turn({ budgetMs: 4000 }))).toBe(api.FREEZE_POLICY.minWindowMs);
    expect(api.freezeWindowMs(turn({ budgetMs: 1000 }))).toBe(api.FREEZE_POLICY.minWindowMs);
  });

  it('clamps the window to the policy cap for very long budgets', () => {
    expect(api.freezeWindowMs(turn({ budgetMs: 600000 }))).toBe(api.FREEZE_POLICY.maxWindowMs);
  });

  it('falls back to the default budget when none is usable', () => {
    expect(api.freezeWindowMs(turn({ budgetMs: undefined }))).toBe(15000);
    expect(api.freezeWindowMs(turn({ budgetMs: NaN }))).toBe(15000);
    expect(api.freezeWindowMs(turn({ budgetMs: -5 }))).toBe(15000);
  });

  it('keeps 2 windows inside the caller budget so recovery beats the driver giving up', () => {
    // The whole point of sizing from the budget: at the default the verdict
    // (2 windows) lands well before the caller stops listening.
    const window = api.freezeWindowMs(turn({ budgetMs: 60000 }));
    expect(2 * window).toBeLessThan(60000);
  });
});

describe('decideFreezeAction', () => {
  it('does nothing when there is no turn', () => {
    expect(api.decideFreezeAction(null, T0).action).toBe('none');
  });

  it('does nothing when the turn is already handled', () => {
    const d = api.decideFreezeAction(turn({ handled: true }), T0 + 999999);
    expect(d.action).toBe('none');
    expect(d.reason).toBe('no-turn');
  });

  it('a single missed window does NOT reload (suspicion is not a verdict)', () => {
    const windowMs = api.freezeWindowMs(turn());          // 15000
    const d = api.decideFreezeAction(turn(), T0 + windowMs + 500);
    expect(d.action).toBe('none');
    expect(d.reason).toBe('awaiting-corroboration');
    expect(d.missedWindows).toBe(1);
  });

  it('two consecutive missed windows DO reload', () => {
    const windowMs = api.freezeWindowMs(turn());          // 15000
    const d = api.decideFreezeAction(turn(), T0 + 2 * windowMs + 10);
    expect(d.action).toBe('reload');
    expect(d.reason).toBe('confirmed-freeze');
    expect(d.missedWindows).toBe(2);
  });

  it('is quiet just under the two-window boundary and reloads just over it', () => {
    const windowMs = api.freezeWindowMs(turn());
    expect(api.decideFreezeAction(turn(), T0 + 2 * windowMs - 1).action).toBe('none');
    expect(api.decideFreezeAction(turn(), T0 + 2 * windowMs).action).toBe('reload');
  });

  it('a heartbeat inside the window keeps the turn safe', () => {
    // This is the #3 regression: a healthy long turn that keeps beating must
    // never be reloaded, however long the turn runs.
    for (let elapsed = 0; elapsed <= 600000; elapsed += 3000) {
      const beating = turn({ lastBeatAt: T0 + elapsed - 500 });
      expect(api.decideFreezeAction(beating, T0 + elapsed).action).toBe('none');
    }
  });
});

describe('noteHeartbeat', () => {
  it('uses the emitted ts, not the received time, so real freezes surface sooner', () => {
    // Beat emitted at T0 but not delivered until T0+30s: the page was only
    // proven alive at T0, so that is the liveness we record.
    const receivedAt = T0 + 30000;
    const next = api.noteHeartbeat(turn(), { type: 'turn_heartbeat', ts: T0 }, receivedAt);
    expect(next.lastBeatAt).toBe(T0);
    expect(next.lastBeatLagMs).toBe(30000);
  });

  it('ignores an implausibly stale ts and falls back to receive time', () => {
    const receivedAt = T0;
    const ancient = T0 - (api.FREEZE_POLICY.maxBeatSkewMs + 60000);
    const next = api.noteHeartbeat(turn(), { type: 'turn_heartbeat', ts: ancient }, receivedAt);
    expect(next.lastBeatAt).toBe(receivedAt);
  });

  it('clamps a future ts to receive time so a bogus clock cannot mute the watchdog', () => {
    const receivedAt = T0;
    const future = T0 + 60000;
    const next = api.noteHeartbeat(turn(), { type: 'turn_heartbeat', ts: future }, receivedAt);
    expect(next.lastBeatAt).toBe(receivedAt);
    // And the watchdog stays armed rather than being silenced for the turn.
    expect(api.decideFreezeAction(next, receivedAt + 40000).action).toBe('reload');
  });

  it('treats a missing or non-numeric ts as receive time', () => {
    for (const message of [{}, { ts: undefined }, { ts: 'soon' }, { ts: null }]) {
      const next = api.noteHeartbeat(turn(), message, T0 + 1000);
      expect(next.lastBeatAt).toBe(T0 + 1000);
    }
  });

  it('out-of-order beats cannot walk lastBeatAt backwards', () => {
    const fresh = api.noteHeartbeat(turn({ lastBeatAt: T0 - 5000 }), { ts: T0 }, T0);
    expect(fresh.lastBeatAt).toBe(T0);
    // A late delivery of an OLDER beat must not reset liveness backwards.
    const stale = api.noteHeartbeat(fresh, { ts: T0 - 9000 }, T0 + 50);
    expect(stale.lastBeatAt).toBe(T0);
  });

  it('is a no-op on a null turn', () => {
    expect(api.noteHeartbeat(null, { ts: T0 }, T0)).toBeNull();
  });
});

describe('turnBudgetMs', () => {
  it('prefers the payload timeoutMs', () => {
    expect(api.turnBudgetMs({ timeoutMs: 90000 }, { timeoutMs: 30000 })).toBe(90000);
  });

  it('falls back to the envelope timeoutMs', () => {
    expect(api.turnBudgetMs({}, { timeoutMs: 30000 })).toBe(30000);
  });

  it('falls back to the default when neither is usable', () => {
    expect(api.turnBudgetMs(null, null)).toBe(api.FREEZE_POLICY.defaultBudgetMs);
    expect(api.turnBudgetMs({ timeoutMs: 0 }, { timeoutMs: -1 })).toBe(api.FREEZE_POLICY.defaultBudgetMs);
  });
});

describe('clamp', () => {
  it('bounds a value to the range', () => {
    expect(api.clamp(5, 10, 20)).toBe(10);
    expect(api.clamp(15, 10, 20)).toBe(15);
    expect(api.clamp(25, 10, 20)).toBe(20);
  });
});

/* ------------------------------------------------------------------ *
 * Harness integrity.
 *
 * The whole suite drives background.js by evaluating the shipped file
 * and reading `__timepassInternals` back off it. If that seam ever went
 * missing or empty, every assertion below would throw on `undefined`
 * and fail loudly — but if it were ever replaced by a *copy* of the
 * logic living in this test file, the suite would pass while proving
 * nothing. These assertions pin the seam to the real implementations.
 * ------------------------------------------------------------------ */

describe('harness reaches the shipped implementation', () => {
  it('publishes every helper the suite drives', () => {
    for (const name of [
      'decideFreezeAction', 'freezeWindowMs', 'noteHeartbeat', 'turnBudgetMs',
      'clamp', 'tabIsReady', 'compareGeminiTabs', 'pickGeminiTab', 'describeTabState'
    ]) {
      expect(typeof api[name], `${name} must be reachable from the shipped file`).toBe('function');
    }
    expect(typeof api.FREEZE_POLICY).toBe('object');
  });

  it('the evaluated functions are defined in background.js, not in this test file', () => {
    // Anything the harness returns must trace back to the real source. Every
    // needle here is assembled from parts so this test's own source cannot
    // match itself, which would make the negative assertions meaningless.
    const fromSource = evaluate(SOURCE).__timepassInternals;
    expect(typeof fromSource.decideFreezeAction).toBe('function');
    expect(typeof fromSource.pickGeminiTab).toBe('function');

    const definitionOf = name => new RegExp(['function', name].join('\\s+'));
    const selfSource = readFileSync(path.join(HERE, 'background.test.js'), 'utf8');
    for (const name of ['decideFreezeAction', 'pickGeminiTab', 'noteHeartbeat']) {
      expect(selfSource, `${name} must not be re-implemented in the test file`)
        .not.toMatch(definitionOf(name));
    }
  });
});

/* ------------------------------------------------------------------ *
 * #6 — tab selection and load-wait
 * ------------------------------------------------------------------ */

describe('tabIsReady', () => {
  const gemini = { id: 1, url: 'https://gemini.google.com/app', status: 'complete' };

  it('accepts a loaded, live, committed Gemini tab', () => {
    expect(api.tabIsReady({ ...gemini })).toBe(true);
  });

  it('rejects a discarded tab even when it still reports complete', () => {
    // The defect that made tabs[0] unsafe: a discarded tab keeps its URL and
    // can report status "complete", so a status-only check waves a dead tab
    // through and every later message send fails.
    expect(api.tabIsReady({ ...gemini, discarded: true })).toBe(false);
  });

  it('rejects a tab that is still loading', () => {
    expect(api.tabIsReady({ ...gemini, status: 'loading' })).toBe(false);
  });

  it('rejects a tab committed somewhere other than Gemini', () => {
    expect(api.tabIsReady({ ...gemini, url: 'https://example.com/' })).toBe(false);
    expect(api.tabIsReady({ ...gemini, url: undefined })).toBe(false);
  });

  it('rejects nothing at all', () => {
    expect(api.tabIsReady(null)).toBe(false);
    expect(api.tabIsReady(undefined)).toBe(false);
  });
});

describe('pickGeminiTab', () => {
  it('returns null when there are no Gemini tabs', () => {
    expect(api.pickGeminiTab([])).toBeNull();
    expect(api.pickGeminiTab(null)).toBeNull();
  });

  it('prefers a live tab over a discarded one', () => {
    const discarded = { id: 1, url: 'https://gemini.google.com/app', status: 'complete', discarded: true };
    const live = { id: 2, url: 'https://gemini.google.com/app', status: 'complete' };
    expect(api.pickGeminiTab([discarded, live]).id).toBe(2);
    expect(api.pickGeminiTab([live, discarded]).id).toBe(2);
  });

  it('prefers the loaded tab over one still loading', () => {
    const loading = { id: 1, url: 'https://gemini.google.com/app', status: 'loading' };
    const loaded = { id: 2, url: 'https://gemini.google.com/app', status: 'complete' };
    expect(api.pickGeminiTab([loading, loaded]).id).toBe(2);
  });

  it('prefers our own pinned tab among equals', () => {
    const plain = { id: 1, url: 'https://gemini.google.com/app', status: 'complete' };
    const pinned = { id: 2, url: 'https://gemini.google.com/app', status: 'complete', pinned: true };
    expect(api.pickGeminiTab([plain, pinned]).id).toBe(2);
  });

  it('leaves the operator foreground tab alone when a background one exists', () => {
    const foreground = { id: 1, url: 'https://gemini.google.com/app', status: 'complete', active: true };
    const background = { id: 2, url: 'https://gemini.google.com/app', status: 'complete', active: false };
    expect(api.pickGeminiTab([foreground, background]).id).toBe(2);
  });

  it('falls back to recency, then to the first tab', () => {
    const older = { id: 1, url: 'https://gemini.google.com/app', status: 'complete', lastAccessed: 1000 };
    const newer = { id: 2, url: 'https://gemini.google.com/app', status: 'complete', lastAccessed: 2000 };
    expect(api.pickGeminiTab([older, newer]).id).toBe(2);

    const a = { id: 10, url: 'https://gemini.google.com/app', status: 'complete' };
    const b = { id: 11, url: 'https://gemini.google.com/app', status: 'complete' };
    expect(api.pickGeminiTab([a, b]).id).toBe(10);
  });

  it('uses a live tab even when it sits behind a discarded one in the list', () => {
    // Exactly the retest scenario: a discarded Gemini tab plus a live one.
    const tabs = [
      { id: 1, url: 'https://gemini.google.com/app', status: 'complete', discarded: true, pinned: true },
      { id: 2, url: 'https://gemini.google.com/app', status: 'complete', pinned: false }
    ];
    expect(api.pickGeminiTab(tabs).id).toBe(2);
  });

  it('does not mutate the array it is given', () => {
    const tabs = [
      { id: 2, url: 'https://gemini.google.com/app', status: 'complete' },
      { id: 1, url: 'https://gemini.google.com/app', status: 'complete', discarded: true }
    ];
    api.pickGeminiTab(tabs);
    expect(tabs.map(t => t.id)).toEqual([2, 1]);
  });
});

describe('describeTabState', () => {
  it('says so honestly when no tab was obtained', () => {
    // The old suffix printed "No Tab found" merely because getOrCreateGeminiTab
    // had thrown. It never claimed anything about the absence of tabs.
    const text = api.describeTabState(null);
    expect(text).toContain('resolution failed');
    expect(text).not.toContain('No Tab found');
  });

  it('reports the tab id, url, status and notable flags', () => {
    const text = api.describeTabState({
      id: 42, url: 'https://gemini.google.com/app', status: 'loading', discarded: true, pinned: true
    });
    expect(text).toContain('tab 42');
    expect(text).toContain('https://gemini.google.com/app');
    expect(text).toContain('status=loading');
    expect(text).toContain('discarded');
    expect(text).toContain('pinned');
  });

  it('copes with a tab that has no url yet', () => {
    expect(api.describeTabState({ id: 1, status: 'loading' })).toContain('(no url)');
  });
});

/* ------------------------------------------------------------------ *
 * #9 — the capture budget
 * ------------------------------------------------------------------ */

describe('withBudget', () => {
  it('returns the value when the task finishes in time', async () => {
    expect(await api.withBudget(() => 'png', 1000, 'capture')).toBe('png');
  });

  it('rejects when the task outlives its budget instead of hanging forever', async () => {
    // This is the #9 hang: captureVisibleTab never settling used to burn the
    // driver's full 75s. A bounded wrapper makes the action always answer.
    const never = () => new Promise(() => {});
    await expect(api.withBudget(never, 20, 'captureVisibleTab')).rejects.toThrow(/did not complete within 20ms/);
  });

  it('propagates a real rejection from the task', async () => {
    await expect(api.withBudget(() => Promise.reject(new Error('no debugger')), 1000, 'capture'))
      .rejects.toThrow('no debugger');
  });

  it('accepts an async task', async () => {
    const value = await api.withBudget(async () => {
      await new Promise(r => setTimeout(r, 5));
      return 'async-png';
    }, 1000, 'capture');
    expect(value).toBe('async-png');
  });
});

/* ------------------------------------------------------------------ *
 * #10 — the bridge handshake
 * ------------------------------------------------------------------ */

describe('bridge handshake', () => {
  it('advertises a protocol version and every action it can serve', () => {
    expect(api.BRIDGE_PROTOCOL_VERSION).toBe(1);
    expect(api.KNOWN_ACTIONS.length).toBeGreaterThan(0);
    expect(new Set(api.KNOWN_ACTIONS).size).toBe(api.KNOWN_ACTIONS.length);
  });

  it('includes recover_last_response, which is how a stale worker gets caught', () => {
    expect(api.KNOWN_ACTIONS).toContain('recover_last_response');
    expect(api.ASYNC_ACTIONS.has('recover_last_response')).toBe(true);
  });

  it('covers exactly the dispatch if-chain, so it cannot drift', () => {
    // The handshake is only worth sending if the advertised list is true. If a
    // new `if (action === ...)` branch is added without updating DISPATCH_ACTIONS,
    // the host would be told this build can do something it cannot -- which is
    // the one failure mode that makes the handshake worse than no handshake.
    const branchPattern = /if \(action === "([^"]+)"\)/g;
    const inSource = [...SOURCE.matchAll(branchPattern)].map(m => m[1]);
    expect(inSource.length).toBeGreaterThan(0);
    for (const action of inSource) {
      expect(api.DISPATCH_ACTIONS, `dispatch branch "${action}" is missing from DISPATCH_ACTIONS`)
        .toContain(action);
    }
    // And nothing advertised as a dispatch action that has no branch.
    for (const action of api.DISPATCH_ACTIONS) {
      expect(inSource, `DISPATCH_ACTIONS claims "${action}" but no branch handles it`).toContain(action);
    }
  });

  it('separates chain actions from content-forwarded and internal ones', () => {
    // These three are served differently, which is why a test can keep them honest.
    expect(api.CONTENT_FORWARDED_ACTIONS).toContain('read_history');
    expect(api.CONTENT_FORWARDED_ACTIONS).toContain('select_history');
    expect(api.INTERNAL_ACTIONS).toContain('recover_last_response');

    const overlap = api.DISPATCH_ACTIONS.filter(a => api.CONTENT_FORWARDED_ACTIONS.includes(a));
    expect(overlap).toEqual([]);
  });

  it('reads its build id from the manifest, not a hardcoded constant', () => {
    // A hardcoded id would report the NEW build while an OLD worker runs it,
    // which is precisely the skew this exists to catch.
    const manifest = JSON.parse(readFileSync(path.join(HERE, 'manifest.json'), 'utf8'));
    expect(typeof manifest.version).toBe('string');
    expect(SOURCE).toContain('chrome.runtime.getManifest().version');
  });
});
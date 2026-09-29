/**
 * Classify a Gemini tab URL into the kind of session it represents.
 *
 * The agent routinely skips this check and then asks into the wrong tab: a
 * sign-in page returns no answer, a different conversation returns a reply that
 * looks right but answers the wrong thread. The URL is the only authoritative
 * signal — Gemini encodes the conversation in it — so classify the URL, not
 * the tab title.
 *
 * Pure: no DOM, no bridge, no I/O. This is what makes it unit-testable.
 *
 * @module dsh-timepass-gemini/lib/session
 */

/** URL prefix that identifies a conversation page, as opposed to a sign-in or
 * consent page. */
export const APP_PREFIX = 'https://gemini.google.com/app'

/** The kinds a tab URL can resolve to. */
export const KIND_NONE = 'none'
export const KIND_NON_CHAT = 'nonChat'
export const KIND_NEW = 'new'
export const KIND_EXISTING = 'existing'

/**
 * Classify a tab URL.
 *
 * @param {string|null|undefined} url - A tab URL.
 * @returns {string} One of {@link KIND_NONE}, {@link KIND_NON_CHAT}, {@link KIND_NEW}, {@link KIND_EXISTING}.
 */
export function sessionKind(url) {
  if (!url) return KIND_NONE
  if (url.indexOf(APP_PREFIX) !== 0) return KIND_NON_CHAT
  // The bare app page, or /app with only a query string or fragment after it,
  // has no conversation id: it is a fresh chat.
  const after = url.slice(APP_PREFIX.length)
  if (after === '' || after === '/' || after.indexOf('?') === 0 || after.indexOf('#') === 0) return KIND_NEW
  return KIND_EXISTING
}

/**
 * Pull the conversation id out of a conversation URL, or '' for a fresh chat.
 *
 * @param {string|null|undefined} url - A tab URL.
 * @returns {string}
 */
export function conversationIdFromUrl(url) {
  if (!url || url.indexOf(APP_PREFIX) !== 0) return ''
  // Slice past the prefix, drop the leading separator, then take the first path
  // segment. Splitting the raw remainder on / would yield ['', id] instead of id.
  return url.slice(APP_PREFIX.length).replace(/^[/]/, '').split(/[/?#]/)[0]
}

/**
 * Whether an ask may proceed into this session.
 *
 * @param {string} kind - A value returned by {@link sessionKind}.
 * @returns {boolean}
 */
export function sessionOk(kind) {
  return kind === KIND_NEW || kind === KIND_EXISTING
}

/**
 * Plain-language guidance for what to do next, given an inspection result.
 *
 * `wantNew` is only meaningful when the session is `existing`: it means the
 * agent asked for a fresh conversation and the open tab is not one, which is
 * the case where `newChat` is silently ignored (see troubleshooting).
 *
 * @param {Object} opts - Inspection result.
 * @param {string} opts.kind - See {@link sessionKind}.
 * @param {string} opts.url - The tab URL.
 * @param {boolean} opts.wantNew - Whether the agent asked for a fresh conversation.
 * @param {boolean} opts.opened - Whether this call opened a tab.
 * @param {boolean} opts.ok - Whether an ask may proceed.
 * @returns {string}
 */
export function sessionGuidance({ kind, url, wantNew, opened, ok }) {
  if (kind === KIND_NONE) {
    return opened
      ? 'Opened a new Gemini tab (pinned, in the background); it is a fresh conversation. gemini_ask will use it.'
      : 'No Gemini tab is open. Call gemini_session(ensure: true) to open one — gemini_ask opens one itself, '
        + 'but you will not know which conversation it landed in.'
  }
  if (kind === KIND_NON_CHAT) {
    return 'The Gemini tab is on ' + url + ', which is not a conversation page. It looks like a sign-in or '
      + 'consent wall. Complete it in the browser, then re-run gemini_session before asking.'
  }
  if (kind === KIND_NEW) {
    return opened
      ? 'Opened a new Gemini tab; the conversation is fresh and empty.'
      : 'A fresh Gemini conversation is open. Your next ask starts it.'
  }
  // existing
  if (wantNew === true) {
    return 'You asked for a new chat, but the open tab is an existing conversation (' + url + '). The newChat '
      + 'flag is not yet wired through to the tab, so it will not navigate. Pass newChat: false to continue this '
      + 'conversation, or open a new tab yourself and re-check.'
  }
  return 'An existing Gemini conversation is open (' + url + '). Your ask will continue it — if that is not the '
    + 'one the user was looking at, say so before asking.'
}
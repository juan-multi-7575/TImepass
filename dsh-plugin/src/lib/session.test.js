import { describe, expect, it } from 'vitest'
import { sessionGuidance, sessionKind, conversationIdFromUrl, sessionOk } from './session.js'

/**
 * Classifying a tab URL is the check the agent routinely skips — asking into a
 * sign-in page, or into a conversation the user did not mean, and then
 * presenting the reply as though it continued the right thread. The URL is the
 * only authoritative signal, so this is the part that is pure and therefore
 * worth pinning.
 */

const APP = 'https://gemini.google.com/app'

describe('sessionKind', () => {
  it('treats a bare app page as a fresh chat', () => {
    expect(sessionKind(APP)).toBe('new')
    expect(sessionKind(APP + '/')).toBe('new')
  })

  it('treats a query-string-only app page as a fresh chat', () => {
    expect(sessionKind(APP + '?gmb=1')).toBe('new')
    expect(sessionKind(APP + '#section')).toBe('new')
  })

  it('treats a conversation URL as existing', () => {
    expect(sessionKind(APP + '/abc123')).toBe('existing')
    expect(sessionKind(APP + '/abc123?foo=bar')).toBe('existing')
    expect(sessionKind(APP + '/abc123#frag')).toBe('existing')
  })

  it('treats anything not on the app path as non-chat', () => {
    expect(sessionKind('https://accounts.google.com/...')).toBe('nonChat')
    expect(sessionKind('https://gemini.google.com/consent')).toBe('nonChat')
    expect(sessionKind('https://example.com/')).toBe('nonChat')
  })

  it('returns none for a missing or empty URL', () => {
    expect(sessionKind(undefined)).toBe('none')
    expect(sessionKind(null)).toBe('none')
    expect(sessionKind('')).toBe('none')
  })
})

describe('conversationIdFromUrl', () => {
  it('extracts the id from a conversation URL', () => {
    expect(conversationIdFromUrl(APP + '/abc123')).toBe('abc123')
    expect(conversationIdFromUrl(APP + '/abc123?foo=bar')).toBe('abc123')
  })

  it('returns empty for a fresh chat or a non-chat page', () => {
    expect(conversationIdFromUrl(APP)).toBe('')
    expect(conversationIdFromUrl(APP + '?gmb=1')).toBe('')
    expect(conversationIdFromUrl('https://accounts.google.com')).toBe('')
    expect(conversationIdFromUrl(undefined)).toBe('')
  })
})

describe('sessionOk', () => {
  it('allows asking into a fresh or existing conversation', () => {
    expect(sessionOk('new')).toBe(true)
    expect(sessionOk('existing')).toBe(true)
  })

  it('forbids asking into nothing or a non-chat page', () => {
    expect(sessionOk('none')).toBe(false)
    expect(sessionOk('nonChat')).toBe(false)
  })
})

describe('sessionGuidance', () => {
  it('tells the agent to open a tab when none exists and none was opened', () => {
    const guidance = sessionGuidance({ kind: 'none', url: '', wantNew: false, opened: false, ok: false })
    expect(guidance).toContain('No Gemini tab is open')
    expect(guidance).toContain('gemini_session(ensure: true)')
  })

  it('says a tab was opened when one was opened', () => {
    const guidance = sessionGuidance({ kind: 'new', url: APP, wantNew: false, opened: true, ok: true })
    expect(guidance).toContain('Opened a new Gemini tab')
  })

  it('points at a sign-in wall for a non-chat page', () => {
    const guidance = sessionGuidance({ kind: 'nonChat', url: 'https://accounts.google.com', wantNew: false, opened: false, ok: false })
    expect(guidance).toContain('sign-in or consent wall')
    expect(guidance).toContain('accounts.google.com')
  })

  it('warns that newChat is not wired through when asked for a new chat into an existing one', () => {
    const guidance = sessionGuidance({ kind: 'existing', url: APP + '/abc123', wantNew: true, opened: false, ok: true })
    expect(guidance).toContain('newChat')
    expect(guidance).toContain('not yet wired')
  })

  it('says the ask will continue the open conversation otherwise', () => {
    const guidance = sessionGuidance({ kind: 'existing', url: APP + '/abc123', wantNew: false, opened: false, ok: true })
    expect(guidance).toContain('continue it')
  })
})
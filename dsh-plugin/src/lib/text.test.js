import { describe, expect, it } from 'vitest'
import { boundJson, boundText, formatBytes, summarize } from './text.js'

describe('boundText', () => {
  it('passes a short string through untouched', () => {
    expect(boundText('hello', 100)).toEqual({ text: 'hello', truncated: false, originalChars: 5 })
  })

  it('cuts at the limit and records the original length', () => {
    expect(boundText('abcdefghij', 4)).toEqual({ text: 'abcd', truncated: true, originalChars: 10 })
  })

  it('treats a non-positive or non-finite limit as no bound', () => {
    expect(boundText('abcdef', 0)).toEqual({ text: 'abcdef', truncated: false, originalChars: 6 })
    expect(boundText('abcdef', Number.POSITIVE_INFINITY).truncated).toBe(false)
  })

  it('stringifies non-strings and treats null as empty', () => {
    expect(boundText(42, 10).text).toBe('42')
    expect(boundText(null, 10)).toEqual({ text: '', truncated: false, originalChars: 0 })
  })
})

describe('boundJson', () => {
  it('pretty-prints and bounds a large value', () => {
    const value = { nodes: Array.from({ length: 50 }, (_, i) => ({ i })) }
    const result = boundJson(value, 120)
    expect(result.truncated).toBe(true)
    expect(result.text.length).toBe(120)
    expect(result.text.startsWith('{\n  "nodes": [')).toBe(true)
    expect(result.originalChars).toBe(JSON.stringify(value, null, 2).length)
  })
})

describe('summarize', () => {
  it('collapses whitespace onto one line', () => {
    expect(summarize('  a\n\t b   c ')).toBe('a b c')
  })

  it('marks a cut with an ellipsis inside the budget', () => {
    const result = summarize('x'.repeat(50), 10)
    expect(result).toHaveLength(10)
    expect(result.endsWith('…')).toBe(true)
  })

  it('handles missing values', () => {
    expect(summarize(undefined)).toBe('')
  })
})

describe('formatBytes', () => {
  it('scales the unit', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(formatBytes(-1)).toBe('0 B')
  })
})

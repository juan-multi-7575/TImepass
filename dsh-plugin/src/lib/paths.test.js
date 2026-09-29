import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { artifactPath, resolveDir, resolveOutputPath, slugify, stamp } from './paths.js'

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('Final Screenshot!')).toBe('final-screenshot')
  })

  it('never yields a path separator or a parent reference', () => {
    expect(slugify('../../etc/passwd')).toBe('etc-passwd')
    expect(slugify('a/b\\c')).toBe('a-b-c')
  })

  it('falls back when nothing usable survives', () => {
    expect(slugify('***')).toBe('artifact')
    expect(slugify(undefined, 'gemini')).toBe('gemini')
  })

  it('bounds the length', () => {
    expect(slugify('a'.repeat(200))).toHaveLength(48)
  })
})

describe('stamp', () => {
  it('formats a sortable filesystem-safe instant', () => {
    expect(stamp(new Date('2026-09-17T18:56:00.123Z'))).toBe('2026-09-17T18-56-00-123Z')
  })
})

describe('artifactPath', () => {
  const date = new Date('2026-09-17T18:56:00.123Z')

  it('joins a stamped, sanitized name into the directory', () => {
    expect(artifactPath('/tmp/shots', 'My Capture', { ext: 'png', date }))
      .toBe(path.join('/tmp/shots', '2026-09-17T18-56-00-123Z-my-capture.png'))
  })

  it('defaults the extension and the label', () => {
    const result = artifactPath('/tmp/out', undefined, { date })
    expect(result.endsWith('-gemini.txt')).toBe(true)
  })
})

describe('resolveDir', () => {
  it('anchors a relative directory at the project root', () => {
    expect(resolveDir('/proj', '.timepass/shots')).toBe(path.resolve('/proj/.timepass/shots'))
  })

  it('keeps an absolute directory', () => {
    expect(resolveDir('/proj', '/var/tmp/shots')).toBe('/var/tmp/shots')
  })
})

describe('resolveOutputPath', () => {
  it('anchors a relative model-supplied path at the project root', () => {
    expect(resolveOutputPath('/proj', 'out/answer.md')).toBe(path.resolve('/proj/out/answer.md'))
  })

  it('keeps an absolute path and ignores blank input', () => {
    expect(resolveOutputPath('/proj', '/tmp/answer.md')).toBe('/tmp/answer.md')
    expect(resolveOutputPath('/proj', '   ')).toBeNull()
    expect(resolveOutputPath('/proj')).toBeNull()
  })
})

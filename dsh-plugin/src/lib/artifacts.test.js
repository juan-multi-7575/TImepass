import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readJsonFile, writeArtifact } from './artifacts.js'

let root

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'timepass-artifacts-'))
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('writeArtifact', () => {
  it('creates missing parent directories and reports the byte count', async () => {
    const target = path.join(root, 'nested', 'deeper', 'answer.md')
    const result = await writeArtifact(target, 'hello')

    expect(result).toEqual({ path: target, bytes: 5 })
    expect(await fs.readFile(target, 'utf-8')).toBe('hello')
  })

  it('writes binary content as given', async () => {
    const target = path.join(root, 'shot.png')
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    const result = await writeArtifact(target, bytes)

    expect(result.bytes).toBe(4)
    expect([...await fs.readFile(target)]).toEqual([...bytes])
  })

  it('overwrites an existing artifact', async () => {
    const target = path.join(root, 'answer.md')
    await writeArtifact(target, 'first')
    await writeArtifact(target, 'second')
    expect(await fs.readFile(target, 'utf-8')).toBe('second')
  })
})

describe('readJsonFile', () => {
  it('parses a stored value', async () => {
    const target = path.join(root, 'cookies.json')
    await writeArtifact(target, JSON.stringify([{ name: 'a' }]))
    expect(await readJsonFile(target)).toEqual([{ name: 'a' }])
  })

  it('names a missing file', async () => {
    await expect(readJsonFile(path.join(root, 'nope.json'))).rejects.toThrow('No such file:')
  })

  it('names a file that is not JSON', async () => {
    const target = path.join(root, 'broken.json')
    await writeArtifact(target, '{ not json')
    await expect(readJsonFile(target)).rejects.toThrow('is not valid JSON')
  })
})

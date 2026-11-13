import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccessError } from './access.js'
import { AgentNamesStore, normalizeAgentId, normalizeDisplayName } from './agent-names.js'

const remove = (dir: string) => rmSync(dir, { recursive: true, force: true })

describe('AgentNamesStore', () => {
  it('stores an alias and loads it back, also for an id the server has not discovered', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'space-agent-names-'))
    try {
      const store = new AgentNamesStore(dir)
      await expect(store.set('coder', 'Coder')).resolves.toEqual({ coder: 'Coder' })
      await expect(store.load()).resolves.toEqual({ coder: 'Coder' })
      await expect(store.set('opencode', 'The install')).resolves.toEqual({ coder: 'Coder', opencode: 'The install' })
      await expect(store.load()).resolves.toEqual({ coder: 'Coder', opencode: 'The install' })
    } finally { remove(dir) }
  })

  it('returns {} when the file is missing or cannot be parsed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'space-agent-names-'))
    try {
      const store = new AgentNamesStore(dir)
      await expect(store.load()).resolves.toEqual({})
      writeFileSync(join(dir, 'agent-names.json'), 'not json', 'utf8')
      await expect(store.load()).resolves.toEqual({})
      writeFileSync(join(dir, 'agent-names.json'), JSON.stringify({ version: 2, names: {} }), 'utf8')
      await expect(store.load()).resolves.toEqual({})
    } finally { remove(dir) }
  })

  it('treats an empty name as a reset, and reset deletes the key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'space-agent-names-'))
    try {
      const store = new AgentNamesStore(dir)
      await store.set('coder', 'Coder')
      await expect(store.set('coder', '')).resolves.toEqual({})
      await expect(store.load()).resolves.toEqual({})
      await expect(store.set('coder', '   ')).resolves.toEqual({})
      await store.set('coder', 'Coder')
      await expect(store.reset('coder')).resolves.toEqual({})
      await expect(store.load()).resolves.toEqual({})
      await expect(store.reset('never')).resolves.toEqual({})
    } finally { remove(dir) }
  })

  it('rejects ids that look like options or paths, and rejects bad names', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'space-agent-names-'))
    try {
      const store = new AgentNamesStore(dir)
      for (const bad of ['-x', '../x', '', 'a/b', 'a:b', 'a'.repeat(65), '🙂']) await expect(store.set(bad, 'Name')).rejects.toMatchObject({ status: 400 })
      await expect(store.set('x', '')).resolves.toEqual({})
      await expect(store.load()).resolves.toEqual({})
      await expect(store.set('x', '\u0000bad')).rejects.toMatchObject({ status: 400 })
      await expect(store.set('x', 'a'.repeat(65))).rejects.toMatchObject({ status: 400 })
      await expect(store.set('x', 'Good One')).resolves.toEqual({ x: 'Good One' })
      await expect(store.load()).resolves.toEqual({ x: 'Good One' })
    } finally { remove(dir) }
  })

  it('honours the 512 entry cap', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'space-agent-names-'))
    try {
      const store = new AgentNamesStore(dir)
      const names: Record<string, string> = {}
      for (let i = 0; i < 513; i++) names[`agent-${i}`] = `Name ${i}`
      for (const [id, name] of Object.entries(names)) await store.set(id, name)
      await expect(store.load()).resolves.toHaveProperty('agent-0', 'Name 0')
      await expect(store.load()).resolves.not.toHaveProperty('agent-512')
    } finally { remove(dir) }
  })
})

describe('normalizeAgentId', () => {
  it('accepts plain ids and rejects options, paths, and oversize ids', () => {
    expect(normalizeAgentId('coder')).toBe('coder')
    expect(normalizeAgentId('  coder  ')).toBe('coder')
    expect(normalizeAgentId('agent-2.name_v3')).toBe('agent-2.name_v3')
    for (const bad of ['', '-x', '../x', 'a/b', 'a:b', 'a'.repeat(65), '🙂'])
      expect(() => normalizeAgentId(bad)).toThrow()
  })
  it('throws an AccessError with status 400', () => {
    try { normalizeAgentId('../x') } catch (error) { expect(error).toBeInstanceOf(AccessError); expect((error as AccessError).status).toBe(400); return }
    throw new Error('should have thrown')
  })
})

describe('normalizeDisplayName', () => {
  it('trims and collapses whitespace, within 1..64 characters', () => {
    expect(normalizeDisplayName('Coder')).toBe('Coder')
    expect(normalizeDisplayName('  Coder   Two  ')).toBe('Coder Two')
    expect(normalizeDisplayName('a'.repeat(64))).toHaveLength(64)
  })
  it('rejects empty, whitespace-only, control characters, and oversize names', () => {
    for (const bad of ['', '   ', '\u0000', '\u001f', '\u007f', 'a\u007fb', 'a'.repeat(65), 42, undefined])
      expect(() => normalizeDisplayName(bad)).toThrow()
  })
  it('throws an AccessError with status 400', () => {
    try { normalizeDisplayName('') } catch (error) { expect(error).toBeInstanceOf(AccessError); expect((error as AccessError).status).toBe(400); return }
    throw new Error('should have thrown')
  })
})

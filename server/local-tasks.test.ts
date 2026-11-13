import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccessError } from './access.js'
import { LocalTasksStore, normalizeLocalTaskId, normalizeLocalTaskTitle, type LocalTaskStatus } from './local-tasks.js'

const remove = (dir: string) => rmSync(dir, { recursive: true, force: true })

describe('LocalTasksStore', () => {
  it('stores a task and loads it back, also for an id the server has not discovered', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'space-local-tasks-'))
    try {
      const store = new LocalTasksStore(dir)
      await expect(store.set('sobirin', 'Fix login', 'running')).resolves.toEqual({ sobirin: { id: 'sobirin', title: 'Fix login', status: 'running' } })
      await expect(store.load()).resolves.toEqual({ sobirin: { id: 'sobirin', title: 'Fix login', status: 'running' } })
      await expect(store.set('opencode', 'Review the office', 'review')).resolves.toEqual({
        sobirin: { id: 'sobirin', title: 'Fix login', status: 'running' },
        opencode: { id: 'opencode', title: 'Review the office', status: 'review' },
      })
      expect(JSON.parse(readFileSync(store.path, 'utf8'))).toEqual({
        version: 1,
        tasks: {
          sobirin: { id: 'sobirin', title: 'Fix login', status: 'running' },
          opencode: { id: 'opencode', title: 'Review the office', status: 'review' },
        },
      })
    } finally { remove(dir) }
  })

  it('returns {} when the file is missing or cannot be parsed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'space-local-tasks-'))
    try {
      const store = new LocalTasksStore(dir)
      await expect(store.load()).resolves.toEqual({})
      writeFileSync(join(dir, 'local-tasks.json'), 'not json', 'utf8')
      await expect(store.load()).resolves.toEqual({})
      writeFileSync(join(dir, 'local-tasks.json'), JSON.stringify({ version: 2, tasks: {} }), 'utf8')
      await expect(store.load()).resolves.toEqual({})
    } finally { remove(dir) }
  })

  it('treats an empty title as clear, and clear deletes the key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'space-local-tasks-'))
    try {
      const store = new LocalTasksStore(dir)
      await store.set('sobirin', 'Fix login', 'running')
      await expect(store.set('sobirin', '', 'running')).resolves.toEqual({})
      await expect(store.load()).resolves.toEqual({})
      await expect(store.set('sobirin', '   ', 'review')).resolves.toEqual({})
      await store.set('sobirin', 'Fix login', 'running')
      await expect(store.clear('sobirin')).resolves.toEqual({})
      await expect(store.load()).resolves.toEqual({})
      await expect(store.clear('never')).resolves.toEqual({})
    } finally { remove(dir) }
  })

  it('rejects bad ids, titles, and statuses', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'space-local-tasks-'))
    try {
      const store = new LocalTasksStore(dir)
      for (const bad of ['-x', '../x', '', 'a/b', 'a:b', 'a'.repeat(65), '🙂']) await expect(store.set(bad, 'Fix login', 'running')).rejects.toMatchObject({ status: 400 })
      await expect(store.set('x', '', 'running')).resolves.toEqual({})
      await expect(store.load()).resolves.toEqual({})
      await expect(store.set('x', '\u0000bad', 'running')).rejects.toMatchObject({ status: 400 })
      await expect(store.set('x', 'a'.repeat(65), 'running')).rejects.toMatchObject({ status: 400 })
      await expect(store.set('x', 'Fix login', 'done' as unknown as LocalTaskStatus)).rejects.toMatchObject({ status: 400 })
      await expect(store.set('x', 'Fix login', 'running')).resolves.toEqual({ x: { id: 'x', title: 'Fix login', status: 'running' } })
      await expect(store.load()).resolves.toEqual({ x: { id: 'x', title: 'Fix login', status: 'running' } })
    } finally { remove(dir) }
  })
})

describe('normalizeLocalTaskId', () => {
  it('accepts plain ids and rejects options, paths, and oversize ids', () => {
    expect(normalizeLocalTaskId('sobirin')).toBe('sobirin')
    expect(normalizeLocalTaskId('  sobirin  ')).toBe('sobirin')
    expect(normalizeLocalTaskId('agent-2.name_v3')).toBe('agent-2.name_v3')
    for (const bad of ['', '-x', '../x', 'a/b', 'a:b', 'a'.repeat(65), '🙂']) expect(() => normalizeLocalTaskId(bad)).toThrow()
  })
  it('throws an AccessError with status 400', () => {
    try { normalizeLocalTaskId('../x') } catch (error) { expect(error).toBeInstanceOf(AccessError); expect((error as AccessError).status).toBe(400); return }
    throw new Error('should have thrown')
  })
})

describe('normalizeLocalTaskTitle', () => {
  it('trims and collapses whitespace, within 1..64 characters', () => {
    expect(normalizeLocalTaskTitle('Fix login')).toBe('Fix login')
    expect(normalizeLocalTaskTitle('  Fix   login  ')).toBe('Fix login')
    expect(normalizeLocalTaskTitle('a'.repeat(64))).toHaveLength(64)
  })
  it('rejects empty, whitespace-only, control characters, and oversize titles', () => {
    for (const bad of ['', '   ', '\u0000', '\u001f', '\u007f', 'a\u007fb', 'a'.repeat(65), 42, undefined])
      expect(() => normalizeLocalTaskTitle(bad)).toThrow()
  })
  it('throws an AccessError with status 400', () => {
    try { normalizeLocalTaskTitle('') } catch (error) { expect(error).toBeInstanceOf(AccessError); expect((error as AccessError).status).toBe(400); return }
    throw new Error('should have thrown')
  })
})

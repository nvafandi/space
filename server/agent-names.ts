import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import express, { type Express, type NextFunction, type Request, type Response } from 'express'
import { AccessError, accessConfigDir } from './access.js'

// Display names: a local alias per agent id, kept in Space's own config next to the access
// code and the profile lock. It only changes what the UI shows: the agent's id, and with it
// its folder, memory, cron jobs and identity, are never touched. No secret is stored, so the
// file is plain JSON with the same atomic write and 0600 mode the other config files use.

export type AgentNames = Record<string, string>
export interface AgentNamesFile { version: 1; names: AgentNames }

/** Ids are map keys only, so the same rule as a Hermes profile name keeps them plain. */
export const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/
export const MAX_NAME_LENGTH = 64
/** The crew of one machine; anything beyond this is ignored, not grown without bound. */
const MAX_ENTRIES = 512

export function normalizeAgentId(id: unknown): string {
  if (typeof id !== 'string' || !AGENT_ID.test(id.trim())) throw new AccessError('That agent id cannot be used here.', 400)
  return id.trim()
}

export function normalizeDisplayName(name: unknown): string {
  if (typeof name !== 'string') throw new AccessError('Enter a display name.', 400)
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name.trim())) throw new AccessError('A display name cannot contain control characters.', 400)
  const display = name.trim().replace(/\s+/g, ' ')
  if (!display) throw new AccessError('Enter a display name.', 400)
  if (display.length > MAX_NAME_LENGTH) throw new AccessError(`A display name has at most ${MAX_NAME_LENGTH} characters.`, 400)
  return display
}

function isNamesFile(value: unknown): value is AgentNamesFile {
  const record = value as Record<string, unknown> | null
  if (!record || record.version !== 1 || !record.names || typeof record.names !== 'object') return false
  return Object.entries(record.names as Record<string, unknown>).every(([id, name]) => AGENT_ID.test(id) && typeof name === 'string' && name.trim().length > 0)
}

export class AgentNamesStore {
  private cache?: { key: string; names: AgentNames }
  constructor(readonly dir: string = accessConfigDir()) {}

  get path(): string { return join(this.dir, 'agent-names.json') }

  /** Re-read whenever the file changes, so a write from the CLI or another Space is picked up. */
  async load(): Promise<AgentNames> {
    let key: string
    try {
      const info = await stat(this.path)
      key = `${info.ino}:${info.size}:${info.mtimeMs}`
    } catch {
      return {}
    }
    if (this.cache?.key === key) return this.cache.names
    let names: AgentNames = {}
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, 'utf8'))
      names = isNamesFile(parsed) ? parsed.names : {}
    } catch {
      names = {}
    }
    this.cache = { key, names }
    return names
  }

  /** An empty or whitespace name removes the alias, which resets that agent to its id. */
  async set(id: string, name: unknown): Promise<AgentNames> {
    const agentId = normalizeAgentId(id)
    const alias = typeof name === 'string' && name.trim() ? normalizeDisplayName(name) : undefined
    if (alias === undefined) return this.reset(agentId)
    const current = await this.load()
    const next = { ...current, [agentId]: alias }
    if (Object.keys(next).length > MAX_ENTRIES) return current
    return this.write(next)
  }

  async reset(id: string): Promise<AgentNames> {
    const agentId = normalizeAgentId(id)
    const current = await this.load()
    if (!(agentId in current)) return current
    const next = { ...current }
    delete next[agentId]
    return this.write(next)
  }

  async clear(): Promise<void> {
    await rm(this.path, { force: true })
    this.cache = undefined
  }

  private async write(names: AgentNames): Promise<AgentNames> {
    const file: AgentNamesFile = { version: 1, names }
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, this.path)
    this.cache = undefined
    return names
  }
}

/**
 * The agent display name routes. Declared after `installAccess`, so they sit behind the
 * access-code lock; writes additionally need the `x-space-request` header, and `onChange`
 * drops the shared snapshot cache so the new names show up without waiting for it.
 */
export function installAgentNames(app: Express, store = new AgentNamesStore(), onChange: () => void = () => {}): void {
  const body = (request: Request) => (request.body && typeof request.body === 'object' ? request.body as Record<string, unknown> : {})
  const route = (handler: (request: Request) => Promise<unknown>) => async (request: Request, response: Response) => {
    try {
      response.json(await handler(request))
    } catch (error) {
      if (!(error instanceof AccessError)) throw error
      response.status(error.status).json({ error: error.message })
    }
  }

  // Changes must come from this page: a custom header cannot be sent cross-site without a CORS
  // preflight, which Space never answers, and the JSON parser ignores form posts.
  app.use('/api/agent-names', express.json({ limit: '4kb' }), (request: Request, response: Response, next: NextFunction) => {
    if (request.method === 'POST' && request.get('x-space-request') !== '1') { response.status(403).json({ error: 'Forbidden.' }); return }
    next()
  })
  app.post('/api/agent-names', route(async (request) => {
    const { id, name } = body(request)
    const names = await store.set(id as string, name)
    onChange()
    return { names }
  }))
}
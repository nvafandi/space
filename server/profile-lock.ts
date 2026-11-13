import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import express, { type Express, type NextFunction, type Request, type Response } from 'express'
import { AccessError, accessConfigDir, cookieValue, derive, Throttle } from './access.js'

// Profile lock: one 6-digit PIN guards the private data of the agents the owner picks (folder,
// memory, tasks, cron job names, live activity, session titles, logs). Locked agents stay in the
// office; their private data is withheld by the server until the PIN unlocks that one agent in
// this browser for UNLOCK_MS. Only a scrypt hash of the PIN is stored, in Ruang's own config.
// Forgotten PIN: `ruang profile-lock off`.

export const PIN_LENGTH = 6
export const UNLOCK_MS = 15 * 60 * 1000
const COOKIE = 'ruang_profiles'
const AGENT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/

interface LockFile { version: 1; salt: string; hash: string; secret: string; agents: string[]; createdAt: string }
/** `broken`: the file exists but cannot be read, so every agent stays locked (fail closed). */
type LockState = { enabled: false } | { enabled: true; file?: LockFile; broken?: true }

export function normalizePin(pin: unknown): string {
  if (typeof pin !== 'string' || !new RegExp(`^\\d{${PIN_LENGTH}}$`).test(pin.trim())) throw new AccessError(`The PIN has ${PIN_LENGTH} digits.`, 400)
  return pin.trim()
}

function normalizeAgents(agents: unknown): string[] {
  if (!Array.isArray(agents) || agents.some((agent) => typeof agent !== 'string' || !AGENT.test(agent))) throw new AccessError('Pick agents by their names.', 400)
  return [...new Set(agents as string[])].sort()
}

function isLockFile(value: unknown): value is LockFile {
  const record = value as Record<string, unknown> | null
  return Boolean(record) && record!.version === 1 && ['salt', 'hash', 'secret', 'createdAt'].every((key) => typeof record![key] === 'string' && (record![key] as string).length > 0)
    && Array.isArray(record!.agents) && (record!.agents as unknown[]).every((agent) => typeof agent === 'string')
}

export class ProfileLockStore {
  private cache?: { key: string; state: LockState }
  constructor(readonly dir: string = accessConfigDir()) {}

  get path(): string { return join(this.dir, 'profile-lock.json') }

  async state(): Promise<LockState> {
    let key: string
    try {
      const info = await stat(this.path)
      key = `${info.ino}:${info.size}:${info.mtimeMs}`
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { enabled: false }
      return { enabled: true, broken: true }
    }
    if (this.cache?.key === key) return this.cache.state
    let state: LockState
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, 'utf8'))
      state = isLockFile(parsed) ? { enabled: true, file: parsed } : { enabled: true, broken: true }
    } catch {
      state = { enabled: true, broken: true }
    }
    this.cache = { key, state }
    return state
  }

  private async write(file: LockFile): Promise<LockFile> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, this.path)
    this.cache = undefined
    return file
  }

  /** A new PIN (and a new signing secret, which ends every unlock). */
  async setPin(pin: string, agents: string[]): Promise<LockFile> {
    const salt = randomBytes(16)
    return this.write({ version: 1, salt: salt.toString('base64'), hash: (await derive(normalizePin(pin), salt)).toString('base64'), secret: randomBytes(32).toString('base64'), agents: normalizeAgents(agents), createdAt: new Date().toISOString() })
  }

  async setAgents(agents: string[]): Promise<LockFile> {
    const state = await this.state()
    if (!state.enabled || !state.file) throw new AccessError('Profile lock is not set up.', 409)
    return this.write({ ...state.file, agents: normalizeAgents(agents) })
  }

  async clear(): Promise<void> {
    await rm(this.path, { force: true })
    this.cache = undefined
  }

  async verify(pin: unknown): Promise<boolean> {
    const state = await this.state()
    if (!state.enabled || !state.file || typeof pin !== 'string') return false
    const expected = Buffer.from(state.file.hash, 'base64')
    const actual = await derive(pin.trim(), Buffer.from(state.file.salt, 'base64'))
    return expected.length === actual.length && timingSafeEqual(expected, actual)
  }
}

function signature(secret: string, payload: string): string {
  return createHmac('sha256', Buffer.from(secret, 'base64')).update(payload).digest('base64url')
}

export function issueUnlock(file: LockFile, agent: string, now = Date.now()): string {
  const payload = `p1.${Buffer.from(agent).toString('base64url')}.${now + UNLOCK_MS}`
  return `${payload}.${signature(file.secret, payload)}`
}

/** The agents this cookie value unlocks (valid signature, not expired). */
export function unlockedAgents(file: LockFile, cookie: string | undefined, now = Date.now()): Set<string> {
  const agents = new Set<string>()
  for (const token of (cookie ?? '').split('~')) {
    const match = token.match(/^(p1\.([A-Za-z0-9_-]{1,120})\.(\d{1,15}))\.([A-Za-z0-9_-]{43})$/)
    if (!match || Number(match[3]) <= now) continue
    const expected = Buffer.from(signature(file.secret, match[1]))
    const actual = Buffer.from(match[4])
    if (expected.length === actual.length && timingSafeEqual(expected, actual)) agents.add(Buffer.from(match[2], 'base64url').toString())
  }
  return agents
}

/** Who may not be seen in this request: locked agents not unlocked here. `all` when the lock file is damaged. */
export interface Privacy { hidden: Set<string>; locked: Set<string>; all: boolean }
export const OPEN: Privacy = { hidden: new Set(), locked: new Set(), all: false }

export function isHidden(privacy: Privacy, agent: string | undefined): boolean {
  if (!agent) return false
  const name = agent.trim().toLowerCase()
  if (privacy.all) return true
  for (const hidden of privacy.hidden) {
    const id = hidden.toLowerCase()
    if (name === id || (id === 'opencode' && name === 'open-code')) return true
  }
  return false
}

export interface ProfileLockStatus { enabled: boolean; agents: string[]; unlocked: string[]; pinLength: number; unlockMinutes: number }

export function installProfileLock(app: Express, store = new ProfileLockStore(), throttle = new Throttle({ free: 5, maxWaitMs: 5 * 60_000, hardLimit: 10, hardWaitMs: 60 * 60_000 })): (request: Request) => Promise<Privacy> {
  const privacy = async (request: Request): Promise<Privacy> => {
    const state = await store.state()
    if (!state.enabled) return OPEN
    if (!state.file) return { hidden: new Set(), locked: new Set(), all: true }
    const unlocked = unlockedAgents(state.file, cookieValue(request, COOKIE))
    const locked = new Set(state.file.agents)
    return { hidden: new Set([...locked].filter((agent) => !unlocked.has(agent))), locked, all: false }
  }
  const status = async (request: Request): Promise<ProfileLockStatus> => {
    const state = await store.state()
    const view = await privacy(request)
    return { enabled: state.enabled, agents: [...view.locked], unlocked: [...view.locked].filter((agent) => !view.hidden.has(agent)), pinLength: PIN_LENGTH, unlockMinutes: UNLOCK_MS / 60_000 }
  }
  const client = (request: Request) => request.socket.remoteAddress ?? 'unknown'
  const checkPin = async (request: Request, pin: unknown) => {
    const wait = throttle.waitMs(client(request))
    if (wait > 0) throw new AccessError(`Too many wrong PINs. Try again in ${wait >= 120_000 ? `${Math.ceil(wait / 60_000)} min` : `${Math.ceil(wait / 1000)} s`}.`, 429, wait)
    if (!(await store.verify(pin))) { throttle.fail(client(request)); throw new AccessError('Wrong PIN.', 401) }
    throttle.succeed(client(request))
  }
  const setCookie = (request: Request, response: Response, tokens: string[]) => {
    const attributes = ['Path=/', 'HttpOnly', 'SameSite=Strict', ...(request.secure ? ['Secure'] : [])]
    response.append('Set-Cookie', tokens.length ? `${COOKIE}=${tokens.join('~')}; ${attributes.join('; ')}` : `${COOKIE}=; ${[...attributes, 'Max-Age=0'].join('; ')}`)
  }
  /** The valid unlock tokens in this request's cookie, by agent. */
  const currentTokens = (request: Request, file: LockFile) => {
    const tokens = new Map<string, string>()
    for (const token of (cookieValue(request, COOKIE) ?? '').split('~')) {
      const [agent] = [...unlockedAgents(file, token)]
      if (agent && file.agents.includes(agent)) tokens.set(agent, token)
    }
    return tokens
  }
  const body = (request: Request) => (request.body && typeof request.body === 'object' ? request.body as Record<string, unknown> : {})
  const route = (handler: (request: Request, response: Response) => Promise<unknown>) => async (request: Request, response: Response) => {
    try {
      response.json(await handler(request, response))
    } catch (error) {
      if (!(error instanceof AccessError)) throw error
      if (error.retryAfterMs) response.set('Retry-After', String(Math.ceil(error.retryAfterMs / 1000)))
      response.status(error.status).json({ error: error.message })
    }
  }

  app.use('/api/profile-lock', express.json({ limit: '4kb' }), (request: Request, response: Response, next: NextFunction) => {
    if (request.method === 'POST' && request.get('x-ruang-request') !== '1') { response.status(403).json({ error: 'Forbidden.' }); return }
    next()
  })
  app.get('/api/profile-lock', route(status))
  /** First setup: a PIN and the agents to lock. */
  app.post('/api/profile-lock/setup', route(async (request) => {
    if ((await store.state()).enabled) throw new AccessError('Profile lock is already set up. Change it with the current PIN.', 409)
    const { pin, agents } = body(request)
    await store.setPin(normalizePin(pin), normalizeAgents(agents))
    return status(request)
  }))
  /** Change the locked agents and/or the PIN; needs the current PIN. */
  app.post('/api/profile-lock/update', route(async (request, response) => {
    const { pin, agents, newPin } = body(request)
    await checkPin(request, pin)
    const state = await store.state()
    const list = agents === undefined ? state.enabled && state.file ? state.file.agents : [] : normalizeAgents(agents)
    if (newPin !== undefined) {
      await store.setPin(normalizePin(newPin), list)
      setCookie(request, response, [])
    } else {
      await store.setAgents(list)
    }
    return status(request)
  }))
  app.post('/api/profile-lock/disable', route(async (request, response) => {
    if (!(await store.state()).enabled) return status(request)
    await checkPin(request, body(request).pin)
    await store.clear()
    setCookie(request, response, [])
    return status(request)
  }))
  /** Unlock one agent in this browser for UNLOCK_MS. */
  app.post('/api/profile-lock/unlock', route(async (request, response) => {
    const { agent, pin } = body(request)
    const state = await store.state()
    if (!state.enabled || !state.file) throw new AccessError(state.enabled ? 'The profile lock file cannot be read. Run: ruang profile-lock off' : 'Profile lock is not set up.', 409)
    if (typeof agent !== 'string' || !state.file.agents.includes(agent)) throw new AccessError('That agent is not locked.', 400)
    await checkPin(request, pin)
    const tokens = currentTokens(request, state.file)
    tokens.set(agent, issueUnlock(state.file, agent))
    setCookie(request, response, [...tokens.values()])
    request.headers.cookie = `${COOKIE}=${[...tokens.values()].join('~')}`
    return status(request)
  }))
  /** Lock one agent again (or all, without `agent`) in this browser. */
  app.post('/api/profile-lock/lock', route(async (request, response) => {
    const state = await store.state()
    const { agent } = body(request)
    const tokens = state.enabled && state.file ? currentTokens(request, state.file) : new Map<string, string>()
    if (typeof agent === 'string') tokens.delete(agent); else tokens.clear()
    setCookie(request, response, [...tokens.values()])
    request.headers.cookie = `${COOKIE}=${[...tokens.values()].join('~')}`
    return status(request)
  }))
  return privacy
}

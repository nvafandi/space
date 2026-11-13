import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import express, { type Express, type NextFunction, type Request, type Response } from 'express'
import { AccessError, accessConfigDir } from './access.js'

// Locally assigned per-agent tasks: a testing override kept in Space's own config next to
// the access code and the profile lock. It changes an agent's office station to Working /
// Reviewing with a chosen title, never touches Hermes or OpenCode, and is never written by
// any CLI. Plain JSON with the same atomic write and 0600 mode the other config files use.

export type LocalTaskStatus = 'running' | 'review'
export interface LocalTask { id: string; title: string; status: LocalTaskStatus }
export interface LocalTasksFile { version: 1; tasks: Record<string, LocalTask> }

export const LOCAL_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/
const MAX_TITLE_LENGTH = 64
/** The crew of one machine; anything beyond this is ignored, not grown without bound. */
const MAX_ENTRIES = 512

export function normalizeLocalTaskId(id: unknown): string {
  if (typeof id !== 'string' || !LOCAL_TASK_ID.test(id.trim())) throw new AccessError('That task id cannot be used here.', 400)
  return id.trim()
}

export function normalizeLocalTaskTitle(title: unknown): string {
  if (typeof title !== 'string') throw new AccessError('Enter a task title.', 400)
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(title.trim())) throw new AccessError('A task title cannot contain control characters.', 400)
  const taskTitle = title.trim().replace(/\s+/g, ' ')
  if (!taskTitle) throw new AccessError('Enter a task title.', 400)
  if (taskTitle.length > MAX_TITLE_LENGTH) throw new AccessError(`A task title has at most ${MAX_TITLE_LENGTH} characters.`, 400)
  return taskTitle
}

function isLocalTasksFile(value: unknown): value is LocalTasksFile {
  const record = value as Record<string, unknown> | null
  if (!record || record.version !== 1 || !record.tasks || typeof record.tasks !== 'object') return false
  return Object.entries(record.tasks as Record<string, unknown>).every(([id, task]) => {
    if (!LOCAL_TASK_ID.test(id) || !task || typeof task !== 'object') return false
    const recordTask = task as Record<string, unknown>
    return typeof recordTask.id === 'string' && LOCAL_TASK_ID.test(recordTask.id) && typeof recordTask.title === 'string' && recordTask.title.trim().length > 0 && (recordTask.status === 'running' || recordTask.status === 'review')
  })
}

export class LocalTasksStore {
  private cache?: { key: string; tasks: Record<string, LocalTask> }
  constructor(readonly dir: string = accessConfigDir()) {}

  get path(): string { return join(this.dir, 'local-tasks.json') }

  /** Re-read whenever the file changes, so a write from another Space is picked up. */
  async load(): Promise<Record<string, LocalTask>> {
    let key: string
    try {
      const info = await stat(this.path)
      key = `${info.ino}:${info.size}:${info.mtimeMs}`
    } catch {
      return {}
    }
    if (this.cache?.key === key) return this.cache.tasks
    let tasks: Record<string, LocalTask> = {}
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, 'utf8'))
      tasks = isLocalTasksFile(parsed) ? parsed.tasks : {}
    } catch {
      tasks = {}
    }
    this.cache = { key, tasks }
    return tasks
  }

  /** An empty or whitespace title removes the task, resetting the agent to board and Idle. */
  async set(id: string, title: string, status: LocalTaskStatus): Promise<Record<string, LocalTask>> {
    const taskId = normalizeLocalTaskId(id)
    if (!title || !title.trim()) return this.clear(taskId)
    if (status !== 'running' && status !== 'review') throw new AccessError('That task status cannot be used here.', 400)
    const taskTitle = normalizeLocalTaskTitle(title)
    const current = await this.load()
    const next = { ...current, [taskId]: { id: taskId, title: taskTitle, status } }
    if (Object.keys(next).length > MAX_ENTRIES) return current
    return this.write(next)
  }

  async clear(id: string): Promise<Record<string, LocalTask>> {
    const taskId = normalizeLocalTaskId(id)
    const current = await this.load()
    if (!(taskId in current)) return current
    const next = { ...current }
    delete next[taskId]
    return this.write(next)
  }

  async clearAll(): Promise<void> {
    await rm(this.path, { force: true })
    this.cache = undefined
  }

  private async write(tasks: Record<string, LocalTask>): Promise<Record<string, LocalTask>> {
    const file: LocalTasksFile = { version: 1, tasks }
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, this.path)
    this.cache = undefined
    return tasks
  }
}

const store = new LocalTasksStore()

/** The locally assigned tasks routes. Declared after `installAccess`, so they sit behind the
 * access-code lock; writes additionally need the `x-space-request` header, and `onChange`
 * drops the shared snapshot cache so the new tasks show up without waiting for it. */
export function installLocalTasks(app: Express, onChange: () => void = () => {}): void {
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
  app.use('/api/local-tasks', express.json({ limit: '4kb' }), (request: Request, response: Response, next: NextFunction) => {
    if (request.method === 'POST' && request.get('x-space-request') !== '1') { response.status(403).json({ error: 'Forbidden.' }); return }
    next()
  })
  app.post('/api/local-tasks', route(async (request) => {
    const { id, title, status } = body(request)
    const nextTasks = await store.set(normalizeLocalTaskId(id), String(title ?? ''), status as LocalTaskStatus)
    onChange()
    return nextTasks
  }))
  app.delete('/api/local-tasks/:id', route(async (request) => {
    const nextTasks = await store.clear(String(request.params.id))
    onChange()
    return nextTasks
  }))
}

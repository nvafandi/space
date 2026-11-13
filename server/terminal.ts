import { execFile as execFileCallback, type ExecFileOptions } from 'node:child_process'
import express, { type Express, type NextFunction, type Request, type Response } from 'express'

// Read-only inspection commands only: nothing destructive, no shell, no env writes, no sudo/rm.
// Command names are an allowlist; every argument is validated per command before execution.
const ALLOWED = new Set([
  'ls','dir','pwd','echo','cat','type','where','ver','hostname','uname',
  'node','npm','npx','git'
])
const ALLOWED_GIT_ARGS = new Set(['status','log','--version','--no-pager'])
// node/npm/npx are allowed for version-style inspection, but these flags run arbitrary code.
const NO_EXEC_FLAGS = new Set(['-e','--eval','-p','--print'])

const COMMAND_TIMEOUT_MS = 8_000
const MAX_OUTPUT_BYTES = 1_000_000
const MAX_CMD_BODY_BYTES = 4_096

export type TerminalResult =
  | { ok: true; stdout: string; stderr: string; code: number; durationMs: number }
  | { ok: false; error: string }

function unsafeArg(arg: string): boolean {
  return /[;$&|`<>()]/.test(arg)
}

function runFile(file: string, args: string[], options: ExecFileOptions): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    execFileCallback(file, args, options, (error, stdout, stderr) => {
      if (error) { reject(error); return }
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code: 0 })
    })
  })
}

/** Mounted after `installAccess`, so `/api/terminal/exec` inherits the access-code lock. */
export function installTerminal(app: Express, onChange?: () => void): void {
  app.use('/api/terminal/exec', express.json({ limit: MAX_CMD_BODY_BYTES }), (request: Request, response: Response, next: NextFunction) => {
    if (request.method === 'POST' && request.get('x-space-request') !== '1') { response.status(403).json({ error: 'Forbidden.' }); return }
    next()
  })
  app.post('/api/terminal/exec', async (request: Request, response: Response) => {
    const { cmd } = request.body as { cmd?: unknown }
    if (typeof cmd !== 'string' || !cmd.trim()) { response.status(400).json({ ok: false, error: 'cmd required.' }); return }
    // First token is the command, the rest are args. No shell is ever involved.
    const tokens = cmd.trim().split(/\s+/)
    const name = tokens[0]
    if (!ALLOWED.has(name)) { response.status(400).json({ ok: false, error: `Command '${name}' not allowed.` }); return }
    const args = tokens.slice(1)
    if (name === 'git') {
      const sub = args[0]
      if (!sub || !ALLOWED_GIT_ARGS.has(sub)) { response.status(400).json({ ok: false, error: 'Only read-only git subcommands allowed.' }); return }
      if (args.some((arg) => arg.startsWith('--exec') || unsafeArg(arg))) { response.status(400).json({ ok: false, error: 'Unsafe git args.' }); return }
    }
    if ((name === 'node' || name === 'npm' || name === 'npx') && args.some((arg) => NO_EXEC_FLAGS.has(arg) || arg.startsWith('--eval='))) {
      response.status(400).json({ ok: false, error: 'That flag cannot be used here.' }); return
    }
    if (args.some(unsafeArg)) { response.status(400).json({ ok: false, error: 'Unsafe characters in arguments.' }); return }
    // cwd is fixed to the project root and is never client-controlled.
    const options: ExecFileOptions = { cwd: process.cwd(), timeout: COMMAND_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' } }
    const start = Date.now()
    try {
      const { stdout, stderr } = await runFile(name, args, options)
      const result: TerminalResult = { ok: true, stdout, stderr, code: 0, durationMs: Date.now() - start }
      response.json(result)
      onChange?.()
    } catch (error: unknown) {
      const err = error as Error & { code?: string; killed?: boolean; stdout?: unknown; stderr?: unknown }
      const stdout = err.stdout ? String(err.stdout) : ''
      const stderr = err.stderr ? String(err.stderr) : ''
      response.status(err.code === 'ETIMEDOUT' ? 504 : 500).json({ ok: false, error: err.killed ? 'Command timed out.' : (err.message || 'Command failed.') + (stderr ? ` | ${stderr.slice(0, 200)}` : '') + (stdout ? ` | stdout: ${stdout.slice(0, 200)}` : '') })
    }
  })
}

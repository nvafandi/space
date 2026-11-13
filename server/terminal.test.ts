import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AddressInfo } from 'node:net'
import { createServer } from 'node:http'
import { execFile, type ChildProcess, type ExecFileOptions } from 'node:child_process'
import express from 'express'
import { installTerminal } from './terminal.js'

vi.mock('node:child_process', () => ({ execFile: vi.fn() }))

const app = express()
app.use(express.json())
installTerminal(app)
const server = createServer(app)
let port = 0

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})
beforeEach(() => {
  vi.mocked(execFile).mockReset()
})

type TerminalBody = { ok?: boolean; error?: string; stdout?: string; stderr?: string; code?: number; durationMs?: number }

const post = async (body: unknown, extraHeaders: Record<string, string> = {}, withSpaceHeader = true) => {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (withSpaceHeader) headers['x-space-request'] = '1'
  Object.assign(headers, extraHeaders)
  const res = await fetch(`http://127.0.0.1:${port}/api/terminal/exec`, { method: 'POST', headers, body: JSON.stringify(body) })
  return { status: res.status, body: (await res.json()) as TerminalBody }
}

type TerminalCallback = (error: unknown, stdout?: unknown, stderr?: unknown) => void

const succeeds = (stdout = '', stderr = '') => {
  vi.mocked(execFile).mockImplementation((..._args: unknown[]) => {
    const callback = _args[3] as TerminalCallback | undefined
    callback?.(null, stdout, stderr)
    return null as unknown as ChildProcess
  })
}

const failsWith = (error: Error & { stdout?: string; stderr?: string }) => {
  vi.mocked(execFile).mockImplementation((..._args: unknown[]) => {
    const callback = _args[3] as TerminalCallback | undefined
    callback?.(error, error.stdout, error.stderr)
    return null as unknown as ChildProcess
  })
}

describe('/api/terminal/exec', () => {
  it('runs an allowed command and returns stdout, stderr, exit code, and duration', async () => {
    succeeds('hello\n', '')
    const { status, body } = await post({ cmd: 'echo hello' })
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.stdout).toBe('hello\n')
    expect(body.stderr).toBe('')
    expect(typeof body.code).toBe('number')
    expect(typeof body.durationMs).toBe('number')
    const [file, args, options] = vi.mocked(execFile).mock.calls[0] as unknown as [string, string[], ExecFileOptions]
    expect(file).toBe('echo')
    expect(args).toEqual(['hello'])
    expect(options.cwd).toBe(process.cwd())
    expect(options.timeout).toBe(8_000)
    expect(options.maxBuffer).toBe(1_000_000)
    expect(options.env?.NO_COLOR).toBe('1')
    expect(options.env?.TERM).toBe('dumb')
  })

  it.each([
    'rm -rf /',
    'sudo',
    'curl http://example.com',
    'del /q *',
    'wget http://example.com',
  ])('rejects disallowed command %s with 400', async (cmd) => {
    const { status, body } = await post({ cmd })
    expect(status).toBe(400)
    expect(body.ok).toBe(false)
    expect(typeof body.error).toBe('string')
    expect(vi.mocked(execFile)).not.toHaveBeenCalled()
  })

  it('rejects node flags that execute arbitrary code', async () => {
    for (const cmd of ['node -e "console.log(1)"', 'node --eval "1"', 'node -p "1"', 'npx --eval=1', 'npm --eval=1']) {
      const { status, body } = await post({ cmd })
      expect(status).toBe(400)
      expect(body.ok).toBe(false)
    }
    expect(vi.mocked(execFile)).not.toHaveBeenCalled()
  })

  it('rejects empty or missing cmd', async () => {
    for (const body of [{}, { cmd: '' }, { cmd: '   ' }, { cmd: 42 }]) {
      const { status, body: result } = await post(body)
      expect(status).toBe(400)
      expect(result.ok).toBe(false)
    }
    expect(vi.mocked(execFile)).not.toHaveBeenCalled()
  })

  it.each([
    'echo hi ; ls',
    'echo a|b',
    'echo a&b',
    'echo a`b',
    'echo a<b',
    'echo a>b',
    'echo hi & ls',
  ])('rejects shell metacharacters in %s', async (cmd) => {
    const { status, body } = await post({ cmd })
    expect(status).toBe(400)
    expect(body.ok).toBe(false)
    expect(body.error).toBe('Unsafe characters in arguments.')
    expect(vi.mocked(execFile)).not.toHaveBeenCalled()
  })

  it('only allows read-only git subcommands', async () => {
    succeeds('on branch main\n', '')
    const ok = await post({ cmd: 'git status' })
    expect(ok.status).toBe(200)
    expect(ok.body.ok).toBe(true)

    for (const cmd of ['git commit -m x', 'git rm file', 'git push origin main', 'git checkout -b x']) {
      const { status, body } = await post({ cmd })
      expect(status).toBe(400)
      expect(body.ok).toBe(false)
    }
  })

  it('requires the x-space-request header', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/terminal/exec`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cmd: 'echo hi' }),
    })
    expect(res.status).toBe(403)
  })

  it('returns 504 on timeout with no stack trace', async () => {
    failsWith(Object.assign(new Error('Command timed out.'), { code: 'ETIMEDOUT', killed: true, stdout: '', stderr: '' }))
    const { status, body } = await post({ cmd: 'echo slow' })
    expect(status).toBe(504)
    expect(body.ok).toBe(false)
    expect(body.error).toBe('Command timed out.')
    expect(String(body.error)).not.toContain('at ')
  })

  it('returns 500 for a failing command, echoing truncated output, no stack trace', async () => {
    failsWith(Object.assign(new Error('Command failed.'), { code: 1, stdout: 'some stdout', stderr: 'no such file' }))
    const { status, body } = await post({ cmd: 'ls nope' })
    expect(status).toBe(500)
    expect(body.ok).toBe(false)
    expect(String(body.error)).toContain('no such file')
    expect(String(body.error)).toContain('stdout: some stdout')
    expect(String(body.error)).not.toContain('at ')
  })
})

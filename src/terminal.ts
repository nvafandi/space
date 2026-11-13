export type TerminalResult =
  | { ok: true; stdout: string; stderr: string; code: number; durationMs: number }
  | { ok: false; error: string }

export async function execTerminal(cmd: string, request = fetch): Promise<TerminalResult> {
  const res = await request('/api/terminal/exec', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-space-request': '1' },
    body: JSON.stringify({ cmd }),
    credentials: 'same-origin',
  })
  return (await res.json()) as TerminalResult
}

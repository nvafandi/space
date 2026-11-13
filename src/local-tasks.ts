// Client side of locally assigned tasks (see server/local-tasks.ts). A saved task is a
// testing override kept in Space's own config: it makes an agent's office station show
// Working or Reviewing with the given title, never touches OpenCode or any CLI, and never
// calls a CLI.

export const LOCAL_TASKS_EVENT = 'space:local-tasks'

export type LocalTaskStatus = 'running' | 'review'

export type LocalTasksResult = { ok: true } | { ok: false; message: string }

/** POST {id, title, status} to /api/local-tasks. An empty title clears the task.
 * A successful save fires LOCAL_TASKS_EVENT so every open view reloads at once. */
export async function saveLocalTask(id: string, title: string, status: LocalTaskStatus, request: typeof fetch = fetch): Promise<LocalTasksResult> {
  try {
    const response = await request('/api/local-tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-space-request': '1' },
      body: JSON.stringify({ id, title, status }),
      credentials: 'same-origin',
    })
    const data = await response.json().catch(() => undefined) as { error?: string } | undefined
    if (!response.ok) return { ok: false, message: data?.error ?? `The Space server answered HTTP ${response.status}.` }
    window.dispatchEvent(new Event(LOCAL_TASKS_EVENT))
    return { ok: true }
  } catch {
    return { ok: false, message: 'The Space server could not be reached.' }
  }
}

/** Removes the locally assigned task so the agent falls back to the board and Idle. */
export async function clearLocalTask(id: string, request: typeof fetch = fetch): Promise<LocalTasksResult> {
  return saveLocalTask(id, '', 'running', request)
}

export function localTaskStatusText(status?: LocalTaskStatus): string {
  return status === 'running' ? 'Working' : status === 'review' ? 'Reviewing' : ''
}

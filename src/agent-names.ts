// Client side of the agent display names (see server/agent-names.ts). A saved name is a
// local alias kept in Space's own config: it changes what every view shows, never the
// agent id, its folder, its memory or its identity.

export const AGENT_NAMES_EVENT = 'space:agent-names'

export type AgentNamesResult = { ok: true } | { ok: false; message: string }

/** POST {id, name} to /api/agent-names. An empty name resets the alias to the agent id.
 * A successful save fires AGENT_NAMES_EVENT so every open view reloads at once. */
export async function saveAgentName(id: string, name: string, request: typeof fetch = fetch): Promise<AgentNamesResult> {
  try {
    const response = await request('/api/agent-names', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-space-request': '1' },
      body: JSON.stringify({ id, name }),
      credentials: 'same-origin',
    })
    const data = await response.json().catch(() => undefined) as { error?: string } | undefined
    if (!response.ok) return { ok: false, message: data?.error ?? `The Space server answered HTTP ${response.status}.` }
    window.dispatchEvent(new Event(AGENT_NAMES_EVENT))
    return { ok: true }
  } catch {
    return { ok: false, message: 'The Space server could not be reached.' }
  }
}

/** Removes the alias so the agent shows under its id again. */
export async function resetAgentName(id: string, request: typeof fetch = fetch): Promise<AgentNamesResult> {
  return saveAgentName(id, '', request)
}

/** What a view shows for an agent: its local alias, or the id itself. */
export function displayName(id: string, alias?: string): string {
  const shown = (alias ?? '').trim()
  return shown ? shown : id
}

import { useState } from 'react'
import type { OfficeSnapshot, RuntimeSnapshot } from '../types.ts'
import { usePolling } from '../polling.ts'
import { displayName, resetAgentName, saveAgentName } from '../agent-names.ts'
import { clearLocalTask, localTaskStatusText, saveLocalTask, type LocalTaskStatus } from '../local-tasks.ts'
import { EmptyState, LoadingState, PageTitle, RuntimeBadge } from '../ui.tsx'
import { PixelCharacter } from './Office.tsx'

/** Every local agent profile on this machine is an agent, plus every OpenCode agent and the install itself. */
export function Agents({ runtime, pending = false }: { runtime: RuntimeSnapshot | null; pending?: boolean }) {
  const office = usePolling<OfficeSnapshot>('/api/office', 15_000)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string>()
  if (pending) return <><PageTitle eyebrow="CREW" title="Agents"/><LoadingState message="Reading runtime details..."/></>
  if (!runtime || runtime.profiles.availability === 'unavailable') return <><PageTitle eyebrow="CREW" title="Agents"/><EmptyState title="Not Available">The agent profile list could not be read.</EmptyState></>
  const states = new Map(office.status === 'ready' ? office.data.stations.map((station) => [station.id, station]) : [])
  const openCode = runtime.openCode.availability === 'available' ? runtime.openCode.data : undefined
  const openCodeAgents = runtime.openCodeAgents ?? []
  const cards = [
    ...runtime.profiles.data.map((profile) => ({ id: profile.name, kind: 'Local profile', model: profile.model, gateway: profile.gateway })),
    ...openCodeAgents.map((agent) => ({ id: agent.id, kind: agent.mode ? `OpenCode ${agent.mode}` : 'OpenCode agent', model: agent.role, gateway: undefined })),
    ...(openCode ? [{ id: 'opencode', kind: 'OpenCode (install)', model: openCode, gateway: undefined }] : []),
  ]
  const aliasOf = (id: string) => runtime.agentNames?.[id]
  const lockedOf = (id: string) => states.get(id)?.privacy === 'locked'
  const localTaskOf = (id: string) => runtime.localTasks?.[id]
  const setTaskDraft = (id: string, value: string) => setDrafts((previous) => ({ ...previous, [id]: value }))
  const clearTaskDraft = (id: string) => setDrafts((previous) => { const next = { ...previous }; delete next[id]; return next })

  const saveTask = async (id: string, status: LocalTaskStatus) => {
    setError(undefined)
    setBusy((set) => new Set([...set, id]))
    try {
      const result = await saveLocalTask(id, drafts[id] ?? '', status)
      if (result.ok) clearTaskDraft(id)
      else setError(result.message)
    } finally { setBusy((set) => { const next = new Set(set); next.delete(id); return next }) }
  }

  const clearTask = async (id: string) => {
    setError(undefined)
    setBusy((set) => new Set([...set, id]))
    try {
      const result = await clearLocalTask(id)
      if (result.ok) clearTaskDraft(id)
      else setError(result.message)
    } finally { setBusy((set) => { const next = new Set(set); next.delete(id); return next }) }
  }
  const startEdit = (id: string) => { setError(undefined); setDraft(aliasOf(id) ?? id); setEditingId(id) }
  const cancelEdit = () => { setEditingId(null); setDraft(''); setError(undefined) }
  const saveEdit = async () => {
    if (!editingId) return
    setError(undefined); setBusy((set) => new Set([...set, editingId]))
    try {
      const result = await saveAgentName(editingId, draft)
      if (result.ok) { setEditingId(null); setDraft('') }
      else setError(result.message)
    } finally { setBusy((set) => { const next = new Set(set); next.delete(editingId!); return next }) }
  }
  const resetCard = async (id: string) => {
    setError(undefined); setBusy((set) => new Set([...set, id]))
    try {
      const result = await resetAgentName(id)
      if (result.ok && editingId === id) { setEditingId(null); setDraft('') }
      else if (!result.ok) setError(result.message)
    } finally { setBusy((set) => { const next = new Set(set); next.delete(id); return next }) }
  }
  return <><PageTitle eyebrow="CREW" title="Agents">The crew are the OpenCode agents defined in OpenCode's agents folder (their description and mode), plus the OpenCode install. Each agent shares the OpenCode install folder, and new agents appear here and in the office automatically.</PageTitle>
    <section className="agent-grid">{cards.map((card) => {
      const station = states.get(card.id)
      const alias = aliasOf(card.id)
      const locked = lockedOf(card.id)
      const localTask = localTaskOf(card.id)
      return <article className="agent-card" key={card.id}>
        <span className="folder-glyph" aria-hidden="true"><PixelCharacter agent={card.id}/></span>
        <div className="agent-card-body">
          {editingId === card.id ? (
            <div className="agent-name-edit">
              <input className="text-input" autoFocus value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void saveEdit() } if (event.key === 'Escape') cancelEdit() }}/>
              <button type="button" className="primary-button" disabled={busy.has(card.id)} onClick={saveEdit}>{busy.has(card.id) ? 'Saving…' : 'SAVE'}</button>
              <button type="button" className="refresh-button" onClick={cancelEdit}>CANCEL</button>
              {error && <p className="form-error" role="alert">{error}</p>}
            </div>
          ) : (
            <>
              <h2>{locked ? '🔒 ' : ''}{displayName(card.id, alias)}</h2>
              {alias && <button type="button" className="refresh-button" onClick={(event) => { event.stopPropagation(); void resetCard(card.id) }} title={`Reset ${card.id} to its id`}>RESET</button>}
              <button type="button" className="refresh-button" aria-label={`Rename ${card.id}`} onClick={(event) => { event.stopPropagation(); startEdit(card.id) }}>NAME</button>
            </>
          )}
          <p className="muted">{card.kind}</p>
          <dl>
            <div><dt>Model</dt><dd>{card.model}</dd></div>
            <div><dt>Gateway</dt><dd>{card.gateway ? <RuntimeBadge source={{ availability: 'available', data: card.gateway }}/> : <span className="muted">None (CLI tool)</span>}</dd></div>
            <div><dt>In the office</dt><dd>{station ? `${station.state}${station.activity ? ` · ${station.activity}` : ''}` : '—'}</dd></div>
          </dl>
          <div className="agent-task">
            {localTask ? (
              <>
                <p className="muted">Local task: {localTask.title} · {localTaskStatusText(localTask.status)}</p>
                <button type="button" className="refresh-button" disabled={busy.has(card.id)} onClick={(event) => { event.stopPropagation(); void clearTask(card.id) }}>CLEAR</button>
              </>
            ) : (
              <>
                <input className="text-input" value={drafts[card.id] ?? ''} onChange={(event) => setTaskDraft(card.id, event.target.value)} placeholder="Task title" aria-label={`Assign a task to ${card.id}`}/>
                <button type="button" className="primary-button" disabled={busy.has(card.id) || !drafts[card.id]?.trim()} onClick={(event) => { event.stopPropagation(); void saveTask(card.id, 'running') }}>RUNNING</button>
                <button type="button" className="primary-button" disabled={busy.has(card.id) || !drafts[card.id]?.trim()} onClick={(event) => { event.stopPropagation(); void saveTask(card.id, 'review') }}>REVIEW</button>
                {error && <p className="form-error" role="alert">{error}</p>}
              </>
            )}
          </div>
        </div>
      </article>
    })}</section>
  </>
}

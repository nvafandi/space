import { agentLabel } from '../format.ts'
import type { OfficeSnapshot, RuntimeSnapshot } from '../types.ts'
import { usePolling } from '../polling.ts'
import { EmptyState, LoadingState, PageTitle, RuntimeBadge } from '../ui.tsx'
import { PixelCharacter } from './Office.tsx'

/** Every local agent profile on this machine is an agent, plus every OpenCode agent and the install itself. */
export function Agents({ runtime, pending = false }: { runtime: RuntimeSnapshot | null; pending?: boolean }) {
  const office = usePolling<OfficeSnapshot>('/api/office', 15_000)
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
  return <><PageTitle eyebrow="CREW" title="Agents">The crew are the OpenCode agents defined in OpenCode's agents folder (their description and mode), plus the OpenCode install. Each agent shares the OpenCode install folder, and new agents appear here and in the office automatically.</PageTitle>
    <section className="agent-grid">{cards.map((card) => {
      const station = states.get(card.id)
      return <article className="agent-card" key={card.id}>
        <span className="folder-glyph" aria-hidden="true"><PixelCharacter agent={card.id}/></span>
        <div className="agent-card-body">
          <h2>{station?.privacy === 'locked' ? '🔒 ' : ''}{agentLabel(card.id)}</h2>
          <p className="muted">{card.kind}</p>
          <dl>
            <div><dt>Model</dt><dd>{card.model}</dd></div>
            <div><dt>Gateway</dt><dd>{card.gateway ? <RuntimeBadge source={{ availability: 'available', data: card.gateway }}/> : <span className="muted">None (CLI tool)</span>}</dd></div>
            <div><dt>In the office</dt><dd>{station ? `${station.state}${station.activity ? ` · ${station.activity}` : ''}` : '—'}</dd></div>
          </dl>
        </div>
      </article>
    })}</section>
  </>
}

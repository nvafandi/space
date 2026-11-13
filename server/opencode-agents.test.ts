import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { discoverOpenCodeAgents, openCodeBaseDirs } from './opencode-agents.js'
import { agentRoster, buildOfficeSnapshot, type RuntimeSnapshot } from './mission-control.js'

const homes: string[] = []

afterAll(() => { for (const home of homes) rmSync(home, { recursive: true, force: true }) })

/** An isolated fake home, with the given files under <home>/.config/opencode/agents. */
function fakeHome(files: Record<string, string>): string {
  const home = mkdtempSync(path.join(tmpdir(), 'space-agents-'))
  homes.push(home)
  mkdirSync(path.join(home, '.config', 'opencode', 'agents'), { recursive: true })
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(home, '.config', 'opencode', 'agents', name), content, 'utf8')
  return home
}

const agentFile = (description: string, mode: string, body = 'You are the agent.\n') => `---\ndescription: ${description}\nmode: ${mode}\n---\n\n${body}`
const at = '2026-09-27T12:00:00.000Z'

describe('OpenCode agents', () => {
  it('reads every agent markdown file, keeps the role and mode, and ignores other files', () => {
    const home = fakeHome({
      'analyst.md': agentFile('Senior system analyst who analyzing problems', 'subagent'),
      'developer.md': agentFile('Senior software developer ships code', 'all'),
      'notes.txt': 'not an agent',
    })

    expect(discoverOpenCodeAgents({}, home)).toEqual([
      { id: 'analyst', role: 'Senior system analyst who analyzing problems', mode: 'subagent' },
      { id: 'developer', role: 'Senior software developer ships code', mode: 'all' },
    ])
  })

  it('falls back to the file name as the role and skips what it cannot read', () => {
    const home = fakeHome({ 'nameless.md': '---\nmode: primary\n---\n\nNo description here.\n' })
    expect(discoverOpenCodeAgents({}, home)).toMatchObject([{ id: 'nameless', role: 'nameless', mode: 'primary' }])
  })

  it('returns nothing when the install has no agents folder', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'space-agents-'))
    homes.push(home)
    expect(discoverOpenCodeAgents({}, home)).toEqual([])
  })

  it('honours the OpenCode directory override exactly as the folder agent does', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'space-agents-'))
    homes.push(home)
    expect(openCodeBaseDirs({ SPACE_OPENCODE_DIR: '/x' }, home)).toEqual([path.resolve('/x')])
    expect(openCodeBaseDirs({ MISSION_CONTROL_OPENCODE_DIR: '/x' }, home)).toEqual([path.resolve('/x')])
    expect(openCodeBaseDirs({}, home)).toEqual([path.join(home, '.opencode'), path.join(home, '.config', 'opencode')])
  })
})

describe('office roster', () => {
  const runtime: RuntimeSnapshot = {
    profiles: { availability: 'available', data: [] },
    openCode: { availability: 'available', data: '0.1.0' },
    fetchedAt: at,
  }
  const emptyBoard = { tasks: { availability: 'available' as const, data: [] }, fetchedAt: at }
  const emptyActivity = { sessions: { availability: 'available' as const, data: [] }, fetchedAt: at }
  const long = 'x'.repeat(160)

  it('lists every discovered agent, and keeps the single OpenCode install as the fallback', () => {
    expect(agentRoster({ ...runtime, openCodeAgents: [{ id: 'analyst', role: 'x' }, { id: 'developer', role: 'y' }] })).toMatchObject([
      { id: 'analyst', role: 'x' },
      { id: 'developer', role: 'y' },
    ])
    expect(agentRoster(runtime)).toMatchObject([{ id: 'opencode', role: 'OpenCode' }])
  })

  it('opens the shared OpenCode install for every discovered agent and clips a long role', () => {
    const office = buildOfficeSnapshot({ ...runtime, openCodeAgents: [{ id: 'analyst', role: long, mode: 'subagent' }] }, emptyBoard, emptyActivity, { now: at })

    expect(office.stations).toMatchObject([{ id: 'analyst', name: 'analyst', role: `${'x'.repeat(120)}…`, folderAgent: 'opencode', memoryAgent: 'opencode' }])
  })

  it('keeps every Hermes profile pointed at its own folder', () => {
    const office = buildOfficeSnapshot({
      ...runtime,
      profiles: { availability: 'available', data: [{ name: 'default', model: 'm', gateway: 'Running' }] },
    }, emptyBoard, emptyActivity, { now: at })

    expect(office.stations.map((station) => [station.id, station.role, station.folderAgent, station.memoryAgent])).toEqual([
      ['default', 'Hermes profile', 'default', 'default'],
      ['opencode', 'OpenCode', 'opencode', 'opencode'],
    ])
  })

  describe('agent display names', () => {
    it('shows the alias instead of the id, without changing the id', () => {
      const specs = agentRoster({
        ...runtime,
        profiles: { availability: 'available', data: [{ name: 'default', model: 'm', gateway: 'Running' }] },
        agentNames: { default: 'Default', opencode: 'The install' },
      })
      expect(specs.map((spec) => [spec.id, spec.displayName])).toEqual([['default', 'Default'], ['opencode', 'The install']])
    })

    it('sets displayName on every office station while name stays the agent id', () => {
      const office = buildOfficeSnapshot({
        ...runtime,
        profiles: { availability: 'available', data: [{ name: 'default', model: 'm', gateway: 'Running' }] },
        openCodeAgents: [{ id: 'analyst', role: 'Analyst' }],
        agentNames: { default: 'Default', analyst: 'The Analyst' },
      }, emptyBoard, emptyActivity, { now: at })

      expect(office.stations.map((station) => [station.id, station.name, station.displayName])).toEqual([
        ['default', 'default', 'Default'],
        ['analyst', 'analyst', 'The Analyst'],
      ])
      // No alias: the station falls back to its id.
      const plain = buildOfficeSnapshot({
        ...runtime,
        profiles: { availability: 'available', data: [{ name: 'default', model: 'm', gateway: 'Running' }] },
      }, emptyBoard, emptyActivity, { now: at })
      expect(plain.stations.map((station) => [station.id, station.name, station.displayName])).toEqual([
        ['default', 'default', undefined],
        ['opencode', 'opencode', undefined],
      ])
    })
  })
})
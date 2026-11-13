import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

// OpenCode defines its agents as markdown files in <install>/agents/<id>.md, each with YAML
// frontmatter holding the role text and the mode (subagent / primary / all). They all share
// one OpenCode install, so folders and memory stay keyed to that install (id `opencode`).

/** One agent defined in the OpenCode install. `id` is the file name without `.md`. */
export interface OpenCodeAgent { id: string; role: string; mode?: string }

/** The candidate OpenCode install folders, in order (SPACE_OPENCODE_DIR overrides, as in folders.ts). */
export function openCodeBaseDirs(env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
  const override = env.SPACE_OPENCODE_DIR ?? env.MISSION_CONTROL_OPENCODE_DIR
  return override ? [path.resolve(override)] : [path.join(home, '.opencode'), path.join(home, '.config', 'opencode')]
}

const DESCRIPTION = /^\s*description:\s*(.+)$/
const MODE = /^\s*mode:\s*(.+)$/

/** The frontmatter lines of a markdown file: everything between the leading `---` and the next one. */
function frontMatter(content: string): string[] {
  const all = content.split('\n')
  if (all[0]?.trim() !== '---') return []
  const block: string[] = []
  for (const line of all.slice(1)) {
    if (line.trim() === '---') break
    block.push(line.replace(/\r$/, ''))
  }
  return block
}

function parseAgent(id: string, content: string): OpenCodeAgent {
  let role: string | undefined
  let mode: string | undefined
  for (const line of frontMatter(content)) {
    role ??= line.match(DESCRIPTION)?.[1].trim() || undefined
    mode ??= line.match(MODE)?.[1].trim() || undefined
  }
  return { id, role: role ?? id, ...(mode ? { mode } : {}) }
}

/**
 * Every agent defined in the OpenCode install shares the markdown frontmatter format. Read from
 * disk only: no OpenCode CLI is run. Never throws: an unreadable folder or file is skipped, so
 * this is safe on any machine, with or without agents defined.
 */
export function discoverOpenCodeAgents(env: NodeJS.ProcessEnv = process.env, home = homedir()): OpenCodeAgent[] {
  const found = new Map<string, OpenCodeAgent>()
  for (const base of openCodeBaseDirs(env, home)) {
    const directory = path.join(base, 'agents')
    let files: string[]
    try {
      if (!statSync(directory).isDirectory()) continue
      files = readdirSync(directory).filter((name) => name.endsWith('.md')).sort()
    } catch { continue } // no install here, or it cannot be read
    for (const file of files) {
      const id = file.slice(0, -'.md'.length)
      if (found.has(id)) continue // first install with the agent wins
      let content: string
      try { content = readFileSync(path.join(directory, file), 'utf8') } catch { continue }
      found.set(id, parseAgent(id, content))
    }
  }
  return [...found.values()]
}
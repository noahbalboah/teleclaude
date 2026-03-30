import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { RemoteSessionConfig, Session } from '../shared/types.ts'

const PREFIX_RE = /^\/([a-zA-Z0-9_@.-]+)\s+(.+)$/s

export function parsePrefix(text: string): { name: string; body: string } | null {
  const match = text.match(PREFIX_RE)
  if (!match?.[1] || !match[2]) return null
  // Strip @botname suffix that Telegram appends in groups (e.g., /session@mybotname)
  const name = match[1].replace(/@.*$/, '')
  const body = match[2].trim()
  if (!body) return null
  return { name, body }
}

export function discoverProjects(projectsDir: string): Array<{ name: string; cwd: string }> {
  try {
    return readdirSync(projectsDir)
      .filter((entry) => {
        try {
          return statSync(join(projectsDir, entry)).isDirectory()
        } catch {
          return false
        }
      })
      .map((name) => ({ name, cwd: join(projectsDir, name) }))
  } catch {
    return []
  }
}

export type RouteResult =
  | { type: 'routed'; session: Session }
  | { type: 'ambiguous'; names: string[] }
  | { type: 'not_found'; name: string; available: string[] }

export class SessionRegistry {
  private sessions = new Map<string, Session>()

  constructor(
    defaultName: string,
    remoteSessions: RemoteSessionConfig[],
    defaultCwd: string,
    projectsDir?: string,
  ) {
    // If projectsDir is set, auto-discover project directories as sessions
    if (projectsDir) {
      const projects = discoverProjects(projectsDir)
      for (const project of projects) {
        this.sessions.set(project.name, {
          name: project.name,
          type: 'local',
          busy: false,
          cwd: project.cwd,
          queue: [],
        })
      }
    }

    // If no projects discovered (or no projectsDir), add the default session
    if (this.sessions.size === 0) {
      this.sessions.set(defaultName, {
        name: defaultName,
        type: 'local',
        busy: false,
        cwd: defaultCwd,
        queue: [],
      })
    }

    // Add remote sessions
    for (const rs of remoteSessions) {
      this.sessions.set(rs.name, {
        name: rs.name,
        type: 'remote',
        remoteHost: rs.host,
        remotePort: rs.port,
        busy: false,
        cwd: defaultCwd,
        queue: [],
      })
    }
  }

  refresh(projectsDir?: string): string[] {
    if (!projectsDir) return []
    const projects = discoverProjects(projectsDir)
    const added: string[] = []
    for (const project of projects) {
      if (!this.sessions.has(project.name)) {
        this.sessions.set(project.name, {
          name: project.name,
          type: 'local',
          busy: false,
          cwd: project.cwd,
          queue: [],
        })
        added.push(project.name)
      }
    }
    return added
  }

  get count(): number {
    return this.sessions.size
  }

  get names(): string[] {
    return [...this.sessions.keys()]
  }

  get(name: string): Session | undefined {
    // Try exact match first, then try with underscores converted to hyphens
    return this.sessions.get(name) ?? this.sessions.get(name.replace(/_/g, '-'))
  }

  route(targetName: string | null): RouteResult {
    if (targetName !== null) {
      const session = this.get(targetName)
      if (session) return { type: 'routed', session }
      return { type: 'not_found', name: targetName, available: this.names }
    }

    if (this.sessions.size === 1) {
      const session = [...this.sessions.values()][0]!
      return { type: 'routed', session }
    }
    return { type: 'ambiguous', names: this.names }
  }
}

import type { PendingQuestion, ResolvedQuestion, SessionEventView } from './events.ts'
import { removePendingQuestion, upsertPendingQuestion } from './pending-questions.ts'

/** Minimal session.list row needed by the side-panel picker. */
export interface SessionPickerEntry {
  sessionId: string
  updatedAt: number
  running: boolean
  blank: boolean
  /** Working directory shown in the picker, when the host reported one. */
  cwd?: string
  /** The agent preset this session actually runs, when the deployment composes one. */
  agentPreset?: string
  origin?: 'subagent'
  projections?: {
    asOfSeq: number
    values: Record<string, unknown>
  }
}

/** Only ordinary, started conversations can be resumed through session.prompt. */
export function resumableSessions(items: readonly SessionPickerEntry[]): SessionPickerEntry[] {
  return items.filter((entry) => !entry.blank && entry.origin !== 'subagent')
}

/** Prefer the explicit recent-session hint, then durable sessions in host recency order. */
export function sessionResumeCandidates(
  hint: string | null,
  entries: readonly SessionPickerEntry[],
): string[] {
  return [
    ...(hint === null || hint.trim() === '' ? [] : [hint]),
    ...resumableSessions(entries).map((entry) => entry.sessionId).filter((id) => id !== hint),
  ]
}

/** Match dsh's display-title fallback without loading a session's history. */
export function sessionDisplayTitle(entry: SessionPickerEntry): string {
  const projectedTitle = projectedSessionTitle(entry)
  if (projectedTitle !== undefined) return projectedTitle

  const normalizedCwd = entry.cwd?.replace(/[\\/]+$/u, '')
  const directoryName = normalizedCwd?.split(/[\\/]/u).at(-1)
  return directoryName === undefined || directoryName === '' ? entry.sessionId : directoryName
}

/** Read the durable title column carried by dsh's session.list projection. */
export function projectedSessionTitle(entry: SessionPickerEntry): string | undefined {
  return normalizeSessionTitle(entry.projections?.values.title)
}

/** Read one durable title update from the ordinary session event stream. */
export function sessionTitleFromEvent(event: SessionEventView): string | undefined {
  return event.type === 'session/title' ? normalizeSessionTitle(event.data?.title) : undefined
}

/** Recover the newest valid title while replaying session.history. */
export function latestSessionTitle(events: readonly SessionEventView[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const title = sessionTitleFromEvent(events[index])
    if (title !== undefined) return title
  }
  return undefined
}

function normalizeSessionTitle(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const title = value.trim()
  return title === '' ? undefined : title
}

/** A prompt target exists only after the current session transition settles. */
export function sessionAcceptsPrompts(
  connected: boolean,
  changing: boolean,
  sessionId: string | null,
): boolean {
  return connected && !changing && sessionId !== null
}

export interface SessionRuntimeSnapshot {
  running: boolean
  questions: PendingQuestion[]
}

interface StoredSessionRuntime {
  running?: boolean
  questions: PendingQuestion[]
}

/** Live, per-session state that session.history cannot reconstruct. */
export class SessionRuntimeCache {
  private readonly sessions = new Map<string, StoredSessionRuntime>()

  rememberQuestion(question: PendingQuestion): void {
    const current = this.sessions.get(question.sessionId) ?? { questions: [] }
    this.sessions.set(question.sessionId, {
      ...current,
      questions: upsertPendingQuestion(current.questions, question),
    })
  }

  resolveQuestion(question: ResolvedQuestion): void {
    const current = this.sessions.get(question.sessionId)
    if (current === undefined) return
    this.sessions.set(question.sessionId, {
      ...current,
      questions: removePendingQuestion(current.questions, question),
    })
  }

  seedRunning(sessionId: string, running: boolean): void {
    const current = this.sessions.get(sessionId) ?? { questions: [] }
    if (current.running !== undefined) return
    this.sessions.set(sessionId, { ...current, running })
  }

  startTurn(sessionId: string): void {
    const current = this.sessions.get(sessionId) ?? { questions: [] }
    this.sessions.set(sessionId, { ...current, running: true })
  }

  finishTurn(sessionId: string): void {
    this.sessions.set(sessionId, { running: false, questions: [] })
  }

  snapshot(sessionId: string, fallbackRunning = false): SessionRuntimeSnapshot {
    const current = this.sessions.get(sessionId)
    return {
      running: current?.running ?? fallbackRunning,
      questions: current?.questions.slice() ?? [],
    }
  }

  clear(): void {
    this.sessions.clear()
  }
}

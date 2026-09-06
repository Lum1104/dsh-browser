/**
 * Side panel application: chat with the local dsh agent, plus a settings
 * view. Renders conversation from session history and live session events;
 * browser actions are driven by the model through the bridge tools (the panel
 * only shows tool activity cards).
 *
 * @module
 */

import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { BRIDGE_SESSION_PURGE_METHOD, DEFAULT_SNAPSHOT_MAX_CHARS } from '@yuxianglin/dsh-bridge-browser/src/protocol.ts'
import type { BridgeCaps } from '@yuxianglin/dsh-bridge-browser/src/protocol.ts'
import type { ServerFrame } from '@yuxianglin/dsh-bridge-browser/src/protocol.ts'
import type { BridgeState } from '../background/bridge.ts'
import type { AffinityTab, TabAffinityDecision, TabAffinityState } from '../background/tab-affinity.ts'
import { connectPanel, PanelRpcError, type PanelApi, type PanelSettings } from './api.ts'
import { renderMarkdown } from './markdown.ts'
import whaleUrl from '../../assets/icons/deepseek-256.png'
import type { ApprovalDecision, ApprovalRequest } from '../security/approval.ts'
import { getUiLocale } from '../i18n.ts'
import { PANEL_COPY, type PanelCopy } from './strings.ts'
import {
  applyUiScale,
  DEFAULT_UI_SCALE,
  formatUiScale,
  loadUiScale,
  saveUiScale,
  stepUiScale,
  uiScaleAtLimit,
} from './ui-scale.ts'
import { QuestionCard } from './QuestionCard.tsx'
import { UpdateCard } from './UpdateCard.tsx'
import { MessageImages } from './MessageImages.tsx'
import type { QuestionAnswer } from './questions.ts'
import {
  hasPendingQuestion,
  questionReceiptDisposition,
  removePendingQuestion,
  upsertPendingQuestion,
} from './pending-questions.ts'
import { normalizeTrustedOrigin } from '../security/trusted-origins.ts'
import type { PageSelection } from '../selection.ts'
import {
  selectionPromptText,
  selectionSourceLabel,
  splitSelectionMessage,
} from './selection.ts'
import { approvalReadyForSession, approvalSessionToFocus } from './approvals.ts'
import {
  browserTimeZone,
  draftImageDataUrl,
  parseImageAttachmentLimits,
  prepareImageFiles,
  promptContent,
  type DraftImage,
  type ImageAttachmentLimits,
} from './attachments.ts'
import { imageErrorMessage } from './image-errors.ts'
import {
  canAcceptImageSelection,
  emptyComposerDraft,
  restoreSubmittedDraft,
  type ComposerDraft,
} from './composer.ts'
import {
  latestSessionTitle,
  projectedSessionTitle,
  resumableSessions,
  sessionAcceptsPrompts,
  sessionDisplayTitle,
  sessionTitleFromEvent,
  SessionRuntimeCache,
  type SessionPickerEntry,
} from './sessions.ts'

/** One rendered conversation row. */
import {
  appendLiveRow,
  completeLastTool,
  mergeHistoryRows,
  pendingQuestionFromFrame,
  resolvedQuestionFromFrame,
  rowFromEvent,
  toolSummary,
  type Row,
  type PendingQuestion,
  type ResolvedQuestion,
  type SessionEventView,
} from './events.ts'

function normalizeWebOrigin(value: string): string | null {
  return normalizeTrustedOrigin(value) ?? null
}

/** One editable API-relay profile in the settings view. */
interface RelayProfileDraft {
  /** Stable llm-pi-ai provider-route key; empty until first save mints it. */
  key: string
  name: string
  protocol: 'anthropic-messages' | 'openai-completions' | 'openai-codex-responses'
  baseUrl: string
  /** Typed token; empty means keep whatever is already stored. */
  token: string
  tokenConfigured: boolean
  modelsText: string
  setDefault: boolean
}

/** Route keys managed by the relay editor; core-owned routes are never touched. */
const RELAY_ROUTE_PREFIX = 'relay-'

/**
 * Display names are free-form (CJK included); the route key needs the
 * ASCII shape the wire and credential refs expect, so CJK-heavy names
 * collapse to a stable name hash instead of being rejected.
 */
function relayRouteKey(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (slug !== '') return `${RELAY_ROUTE_PREFIX}${slug}`
  let hash = 5381
  for (let index = 0; index < name.length; index += 1) {
    hash = ((hash << 5) + hash + name.charCodeAt(index)) | 0
  }
  return `${RELAY_ROUTE_PREFIX}n${(hash >>> 0).toString(36)}`
}

function relayTokenRef(routeKey: string): string {
  const suffix = routeKey.slice(RELAY_ROUTE_PREFIX.length).replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()
  return `DSH_RELAY_${suffix}_TOKEN`
}

function parseRelayModels(text: string): Array<{ id: string; contextWindow?: number }> {
  return text.split('\n').map((line) => line.trim()).filter((line) => line !== '').map((line) => {
    const [id, contextWindow] = line.split(',').map((part) => part.trim())
    const parsed = contextWindow === undefined || contextWindow === '' ? undefined : Number(contextWindow)
    return {
      id,
      ...(parsed !== undefined && Number.isFinite(parsed) && parsed > 0 ? { contextWindow: parsed } : {}),
    }
  }).filter((model) => model.id !== '')
}

/** Gateways report failures with the endpoint named; surface everything we got. */
function relayErrorText(cause: unknown): string {
  if (cause instanceof PanelRpcError) {
    const detailKeys = Object.keys(cause.details ?? {})
    const details = detailKeys.length > 0 ? ` ${JSON.stringify(cause.details).slice(0, 220)}` : ''
    return `${cause.message}${details}`
  }
  return cause instanceof Error ? cause.message : String(cause)
}

type DiscoveredModel = { id: string; contextWindow?: number }

/**
 * Anthropic-protocol routes have no native listing; the gateway still fails
 * them with a "no model listing" message whose wording varies, so match the
 * known phrasings instead of one brittle code.
 */
function isManualOnlyDiscovery(cause: unknown): boolean {
  if (!(cause instanceof PanelRpcError)) return false
  return cause.code.includes('unsupported')
    || /no model listing|models by hand/i.test(cause.message)
}

function isAuthFailure(cause: unknown): boolean {
  return cause instanceof PanelRpcError
    && (cause.code.includes('credential') || /\b401\b|\b403\b|invalid[ _-]?key/i.test(cause.message))
}

async function discoverOnce(
  api: PanelApi,
  profile: RelayProfileDraft,
  attempt: { api: string; baseURL: string },
): Promise<DiscoveredModel[]> {
  const result = await api.rpc<{ models?: DiscoveredModel[] }>('llm.discoverModels', {
    settingsNs: 'llm-pi-ai',
    provider: profile.key !== '' ? profile.key : relayRouteKey(profile.name),
    api: attempt.api,
    baseURL: attempt.baseURL,
    ...(profile.token.trim() === '' ? {} : { apiKey: profile.token.trim() }),
  })
  return result.models ?? []
}

/**
 * Build the ordered discovery attempts for one draft. Anthropic-protocol
 * profiles have no native listing, so fall back to the relay's own
 * OpenAI-compatible listing endpoint (`<base>/v1/models`) — New API / One API
 * style stations serve it with the same token, and the returned ids are the
 * ones the Anthropic route accepts.
 */
async function discoverWithFallback(
  api: PanelApi,
  profile: RelayProfileDraft,
): Promise<{ models: DiscoveredModel[]; viaOpenaiListing: boolean }> {
  const base = profile.baseUrl.trim().replace(/\/+$/, '')
  const attempts: Array<{ api: string; baseURL: string; viaOpenaiListing: boolean }> = []
  if (profile.protocol === 'anthropic-messages') {
    attempts.push({ api: 'openai-completions', baseURL: `${base}/v1`, viaOpenaiListing: true })
    attempts.push({ api: 'openai-completions', baseURL: base, viaOpenaiListing: true })
  } else {
    attempts.push({ api: profile.protocol, baseURL: base, viaOpenaiListing: false })
    if (!base.includes('/v1')) {
      attempts.push({ api: profile.protocol, baseURL: `${base}/v1`, viaOpenaiListing: false })
    }
  }

  let lastCause: unknown
  for (const attempt of attempts) {
    try {
      const models = await discoverOnce(api, profile, attempt)
      if (models.length > 0) {
        return { models, viaOpenaiListing: attempt.viaOpenaiListing }
      }
      lastCause = new PanelRpcError('model-discovery-failed', 'the endpoint listed no models', {
        baseURL: attempt.baseURL,
      })
    } catch (cause) {
      lastCause = cause
      if (isAuthFailure(cause)) break
    }
  }
  throw lastCause ?? new PanelRpcError('model-discovery-failed', 'model discovery failed', {})
}

function SettingsIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M10 7.35A2.65 2.65 0 1 0 10 12.65 2.65 2.65 0 0 0 10 7.35Z" />
      <path d="M16.15 11.2a6.4 6.4 0 0 0 0-2.4l1.18-.91-1.5-2.6-1.4.57a6.3 6.3 0 0 0-2.08-1.2L12.15 3h-3l-.2 1.66a6.3 6.3 0 0 0-2.08 1.2l-1.4-.57-1.5 2.6 1.18.91a6.4 6.4 0 0 0 0 2.4l-1.18.91 1.5 2.6 1.4-.57a6.3 6.3 0 0 0 2.08 1.2l.2 1.66h3l.2-1.66a6.3 6.3 0 0 0 2.08-1.2l1.4.57 1.5-2.6-1.18-.91Z" />
    </svg>
  )
}

function PlusIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M10 4.5v11M4.5 10h11" />
    </svg>
  )
}

function TrashIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M4 6h12M8 6V4.5A1.5 1.5 0 0 1 9.5 3h1A1.5 1.5 0 0 1 12 4.5V6m-7 0 .7 9.1A2 2 0 0 0 7.7 17h4.6a2 2 0 0 0 2-1.9L15 6M8.25 9v4.5M11.75 9v4.5" />
    </svg>
  )
}

function ChevronDownIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="m5.5 7.5 4.5 4.5 4.5-4.5" />
    </svg>
  )
}

function SendIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M10 15.5v-11M5.5 9 10 4.5 14.5 9" />
    </svg>
  )
}

function AttachmentIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="m7.25 10.75 4.9-4.9a2.3 2.3 0 0 1 3.25 3.25l-6.2 6.2a3.55 3.55 0 1 1-5.02-5.02l6.2-6.2" />
    </svg>
  )
}

function QuoteIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M8.4 5.5 6.9 8.2h1.9v4.8H4.5V8.5l2-3h1.9Zm7 0L13.9 8.2h1.9v4.8h-4.3V8.5l2-3h1.9Z" />
    </svg>
  )
}

function ToolIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M12.1 3.35a4 4 0 0 0-4.75 5.27l-4.1 4.1a1.85 1.85 0 1 0 2.62 2.62l4.1-4.1a4 4 0 0 0 5.25-4.78l-2.45 2.45-1.9-.5-.5-1.9 2.45-2.45a4 4 0 0 0-.72-.71Z" />
    </svg>
  )
}

function BackIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="m12.5 4.5-5.5 5.5 5.5 5.5" />
    </svg>
  )
}

function TextSizeIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M2.5 14.5 6.25 5h1.5l3.75 9.5M4.1 11.4h5.8" />
      <path d="M12.4 14.5 15 7.6h1.1l2.6 6.9M13.5 12.4h4.1" />
    </svg>
  )
}

function MinusIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M5 10h10" />
    </svg>
  )
}

function ShieldIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M10 2.5 16 5v4.2c0 3.8-2.45 6.45-6 8.3-3.55-1.85-6-4.5-6-8.3V5l6-2.5Z" />
      <path d="M10 6.5v4M10 13.5h.01" />
    </svg>
  )
}

/** Stepper for the panel-wide text scale; see `ui-scale.ts` for the model. */
function TextSizePanel({
  scale,
  copy,
  onStep,
  onReset,
}: {
  scale: number
  copy: PanelCopy
  onStep: (direction: 1 | -1) => void
  onReset: () => void
}): React.JSX.Element {
  return (
    <section className="text-size-panel" aria-label={copy.textSize.title}>
      <strong>{copy.textSize.title}</strong>
      <div className="text-size-stepper">
        <button type="button" disabled={uiScaleAtLimit(scale, -1)}
          onClick={() => onStep(-1)}
          aria-label={copy.textSize.smaller} title={copy.textSize.smaller}>
          <MinusIcon />
        </button>
        <span className="text-size-value" role="status"
          aria-label={copy.textSize.value(formatUiScale(scale))}>{formatUiScale(scale)}</span>
        <button type="button" disabled={uiScaleAtLimit(scale, 1)}
          onClick={() => onStep(1)}
          aria-label={copy.textSize.larger} title={copy.textSize.larger}>
          <PlusIcon />
        </button>
      </div>
      <button type="button" className="text-size-reset" disabled={scale === DEFAULT_UI_SCALE}
        onClick={onReset}>{copy.textSize.reset}</button>
    </section>
  )
}

function tabLabel(tab: AffinityTab | null, unknownTab: string): string {
  const title = tab?.title.trim()
  if (title !== undefined && title !== '') return title
  try {
    const hostname = new URL(tab?.url ?? '').hostname
    return hostname === '' ? unknownTab : hostname
  } catch {
    return unknownTab
  }
}

function TabAffinityBanner({
  state,
  copy,
  onDecision,
}: {
  state: TabAffinityState | null
  copy: PanelCopy
  onDecision: (decision: TabAffinityDecision) => void
}): React.JSX.Element | null {
  if (state === null || state.status === 'unbound' || state.status === 'following') return null
  const controlled = tabLabel(state.controlled, copy.tabHandoff.closedTab)
  const active = tabLabel(state.active, copy.tabHandoff.unknownTab)
  const lost = state.status === 'lost'
  const handoff = state.status === 'handoff'
  const title = lost
    ? copy.tabHandoff.lostTitle
    : handoff
      ? copy.tabHandoff.questionTitle
      : copy.tabHandoff.backgroundTitle(controlled)
  const body = lost
    ? copy.tabHandoff.lostBody
    : handoff
      ? copy.tabHandoff.questionBody(controlled, active)
      : state.pinned
        ? copy.tabHandoff.pinnedBody(active)
        : copy.tabHandoff.backgroundBody(active)

  return (
    <section className={`tab-affinity ${state.status}`} role={handoff || lost ? 'alert' : 'status'}>
      <div className="tab-affinity-heading">
        <span className="eyebrow">{copy.tabHandoff.eyebrow}</span>
        <strong>{title}</strong>
      </div>
      <div className="tab-affinity-route" aria-hidden="true">
        <span className={`tab-affinity-node ${lost ? 'closed' : 'controlled'}`}>
          <small>{copy.tabHandoff.assistant}</small>
          <span title={controlled}>{controlled}</span>
        </span>
        <span className="tab-affinity-arrow">→</span>
        <span className="tab-affinity-node active">
          <small>{copy.tabHandoff.you}</small>
          <span title={active}>{active}</span>
        </span>
      </div>
      <p>{body}</p>
      <div className="tab-affinity-actions">
        {handoff && <button className="keep" onClick={() => onDecision('keep')}>{copy.tabHandoff.keep}</button>}
        {state.active !== null && (
          <button className="follow" onClick={() => onDecision('follow')}>
            {lost ? copy.tabHandoff.useCurrent : handoff ? copy.tabHandoff.follow : copy.tabHandoff.followCurrent}
          </button>
        )}
        {handoff && (
          <button className="keep-always" onClick={() => onDecision('keep-always')}>
            {copy.tabHandoff.keepAlways}
          </button>
        )}
        {!handoff && !lost && state.pinned && (
          <button className="keep-always" onClick={() => onDecision('ask-again')}>
            {copy.tabHandoff.askAgain}
          </button>
        )}
      </div>
    </section>
  )
}

function ApprovalDialog({
  request,
  onDecision,
  copy,
}: {
  request: ApprovalRequest
  onDecision: (decision: ApprovalDecision) => void
  copy: PanelCopy
}): React.JSX.Element {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onDecision('deny')
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, [request.id, onDecision])

  return (
    <div className="approval-backdrop">
      <section className="approval-dialog" role="alertdialog" aria-modal="true" aria-labelledby="approval-title">
        <div className="approval-rail" aria-hidden="true" />
        <div className="approval-heading">
          <span className="approval-shield"><ShieldIcon /></span>
          <div>
            <span className="eyebrow">{copy.approval.eyebrow}</span>
            <h2 id="approval-title">{request.kind === 'read' ? copy.approval.readTitle : copy.approval.actionTitle}</h2>
          </div>
        </div>
        <div className="approval-detail">
          <span>{copy.approval.request}</span>
          <strong>{request.summary}</strong>
        </div>
        <div className="approval-origins">
          <span>{copy.approval.origins}</span>
          {request.origins.length === 0
            ? <code className="unknown">{copy.approval.unknownOrigin}</code>
            : request.origins.map((origin) => <code key={origin}>{origin}</code>)}
        </div>
        <div className="approval-actions">
          <button className="deny" autoFocus onClick={() => onDecision('deny')}>{copy.approval.deny}</button>
          <button className="allow" onClick={() => onDecision('allow-once')}>{copy.approval.allowOnce}</button>
          {request.kind === 'read' && (
            <button className="read-always" onClick={() => onDecision('always-allow-reads')}>{copy.approval.alwaysAllowReads}</button>
          )}
          {request.kind === 'action' && request.canTrust && request.origins.length === 1 && (
            <button className="session-trust" onClick={() => onDecision('trust-session')}>{copy.approval.trustSession}</button>
          )}
        </div>
        <small className="approval-footnote">
          {request.kind === 'read'
            ? copy.approval.readFootnote
            : copy.approval.actionFootnote}
        </small>
      </section>
    </div>
  )
}

/**
 * A page quote: the highlighted text plus where it came from. The quote is
 * page-authored, so it renders as plain text and never as markdown.
 */
function SelectionQuote({
  selection,
  copy,
  label,
  onRemove,
}: {
  selection: { title: string; url: string; quote: string; truncated: boolean }
  copy: PanelCopy
  label: string
  onRemove?: () => void
}): React.JSX.Element {
  const source = selectionSourceLabel(selection)
  return (
    <div className="page-selection">
      <blockquote className="page-selection-quote" title={selection.quote}>
        {selection.quote}
        {selection.truncated && <span className="page-selection-truncated"> {copy.app.selectionTruncated}</span>}
      </blockquote>
      <div className="page-selection-meta">
        <span className="page-selection-chip">
          <QuoteIcon />
          <span>{label}</span>
          {onRemove !== undefined && (
            <button
              type="button"
              aria-label={copy.app.removeSelection}
              title={copy.app.removeSelection}
              onClick={onRemove}
            >×</button>
          )}
        </span>
        {source !== '' && <span className="page-selection-source" title={selection.url}>{source}</span>}
      </div>
    </div>
  )
}

/**
 * One conversation row body. Memoized: rows are immutable (append/merge copy
 * the array but reuse row objects), so markdown is re-parsed only when a
 * row's text actually changes — typing must not re-render every message.
 */
const MessageBody = memo(function MessageBody({
  row,
  sessionId,
  api,
  copy,
}: {
  row: Row
  sessionId: string
  api: PanelApi
  copy: PanelCopy
}): React.JSX.Element {
  if (row.kind === 'user' || row.kind === 'assistant') {
    // A user message may carry a page quote; show the quote, not its fence.
    const attached = row.kind === 'user' ? splitSelectionMessage(row.text) : null
    const text = attached === null ? row.text : attached.message
    return (
      <div className="body message-body md">
        <MessageImages
          images={row.images ?? []}
          sessionId={sessionId}
          api={api}
          align={row.kind === 'user' ? 'end' : 'start'}
          copy={copy}
        />
        {attached !== null && (
          <SelectionQuote
            selection={attached.selection}
            copy={copy}
            label={copy.app.selectionAttached}
          />
        )}
        {text.trim() !== '' && <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />}
      </div>
    )
  }
  return <pre>{row.text}</pre>
})

interface HistoryPage {
  events: { event: SessionEventView }[]
  projections?: {
    asOfSeq: number
    values: Record<string, unknown>
  }
}

const ToolActivity = memo(function ToolActivity({ row, copy }: { row: Row; copy: PanelCopy }): React.JSX.Element {
  const running = row.status === 'running'
  return (
    <div className={`tool-activity ${running ? 'running' : 'complete'}`} role="status">
      <span className="tool-icon"><ToolIcon /></span>
      <span className="tool-copy">
        <span className="tool-label">{running ? copy.tool.running : copy.tool.complete}</span>
        <span className="tool-summary">{row.text}</span>
      </span>
      <span className="tool-state" aria-label={running ? copy.tool.inProgress : copy.tool.completed}>
        {running ? <span className="spinner" /> : copy.tool.done}
      </span>
    </div>
  )
})

export function App(): React.JSX.Element {
  const locale = useMemo(() => getUiLocale(), [])
  const copy = PANEL_COPY[locale]
  const [api] = useState<PanelApi>(() => connectPanel())
  const [state, setState] = useState<BridgeState>('stopped')
  const [caps, setCaps] = useState<BridgeCaps | null>(null)
  const [settings, setSettings] = useState<PanelSettings | null>(null)
  const [rows, setRows] = useState<Row[]>([])
  const [draft, setDraft] = useState<ComposerDraft<DraftImage>>(() => emptyComposerDraft())
  const input = draft.text
  const draftImages = draft.images
  const [selection, setSelection] = useState<PageSelection | null>(null)
  const [imageLimits, setImageLimits] = useState<ImageAttachmentLimits | null>(null)
  const [addingImages, setAddingImages] = useState(false)
  const [busy, setBusy] = useState(false)
  const [working, setWorking] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [uiScale, setUiScale] = useState(DEFAULT_UI_SCALE)
  const uiScaleRef = useRef(DEFAULT_UI_SCALE)
  const uiScaleChosenRef = useRef(false)
  const [showTextSize, setShowTextSize] = useState(false)
  const [approvalQueue, setApprovalQueue] = useState<ApprovalRequest[]>([])
  const [tabAffinity, setTabAffinity] = useState<TabAffinityState | null>(null)
  const [trustedOriginInput, setTrustedOriginInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [showSessionPicker, setShowSessionPicker] = useState(false)
  const [loadingSessions, setLoadingSessions] = useState(false)
  const [sessionChanging, setSessionChanging] = useState(false)
  const [sessionList, setSessionList] = useState<SessionPickerEntry[]>([])
  const [relayProfiles, setRelayProfiles] = useState<RelayProfileDraft[]>([])
  const [relayLoaded, setRelayLoaded] = useState(false)
  const [relayNotice, setRelayNotice] = useState<string | null>(null)
  const [relayBusy, setRelayBusy] = useState(false)
  const [sessionTitle, setSessionTitle] = useState<string | null>(null)
  const [resumeHint, setResumeHint] = useState<{ ready: boolean; sessionId: string | null }>({ ready: false, sessionId: null })
  const [questions, setQuestions] = useState<PendingQuestion[]>([])
  const [questionSubmissions, setQuestionSubmissions] = useState<ResolvedQuestion[]>([])
  const approvalQueueRef = useRef<ApprovalRequest[]>([])
  const questionsRef = useRef<PendingQuestion[]>([])
  const questionSubmissionsRef = useRef<ResolvedQuestion[]>([])
  const stoppingRef = useRef(false)
  const addingImagesRef = useRef(false)
  const sendingRef = useRef(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const imageProjectionRef = useRef<{
    sessionId: string | null
    seq: number
    limits: ImageAttachmentLimits | null
  }>({ sessionId: null, seq: Number.NEGATIVE_INFINITY, limits: null })
  const sessionChangingRef = useRef(false)
  const sessionTransitionRef = useRef(0)
  const sessionInitializationRef = useRef(false)
  const sessionRuntimeRef = useRef(new SessionRuntimeCache())
  const seqRef = useRef(0)
  const sessionRef = useRef<string | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const nextSeq = (): number => { seqRef.current += 1; return seqRef.current }
  const question = questions[0] ?? null
  const questionSubmitting = question !== null && hasPendingQuestion(questionSubmissions, question)
  const sessionSwitchBlocked = sessionChanging || busy || addingImages || stopping
    || questions.length > 0 || approvalQueue.length > 0
  const sessionReady = sessionAcceptsPrompts(
    state === 'connected',
    sessionChanging,
    sessionRef.current,
  )

  function replaceQuestions(next: PendingQuestion[]): void {
    questionsRef.current = next
    setQuestions(next)
  }

  function updateApprovalQueue(update: (current: ApprovalRequest[]) => ApprovalRequest[]): void {
    setApprovalQueue((current) => {
      const next = update(current)
      approvalQueueRef.current = next
      return next
    })
  }

  function removeQuestion(target: ResolvedQuestion): void {
    sessionRuntimeRef.current.resolveQuestion(target)
    replaceQuestions(removePendingQuestion(questionsRef.current, target))
    setQuestionBusy(target, false)
  }

  function clearQuestions(): void {
    replaceQuestions([])
    questionSubmissionsRef.current = []
    setQuestionSubmissions([])
  }

  function setQuestionBusy(target: PendingQuestion | ResolvedQuestion, next: boolean): void {
    const current = questionSubmissionsRef.current
    const updated = next
      ? hasPendingQuestion(current, target)
        ? current
        : [...current, { sessionId: target.sessionId, rpcId: target.rpcId }]
      : removePendingQuestion(current, target)
    questionSubmissionsRef.current = updated
    setQuestionSubmissions(updated)
  }

  // Text size: the stylesheet reads --ui-scale, so seed the document from
  // storage before the first paint the user notices, then keep the two in step.
  // A choice made while the read is still in flight has already been persisted,
  // so the late seed must not overwrite it and revert what the user sees.
  useEffect(() => {
    void loadUiScale().then((stored) => {
      if (uiScaleChosenRef.current) return
      uiScaleRef.current = stored
      setUiScale(stored)
      applyUiScale(stored)
    })
  }, [])

  // The stepper emits a direction, not a value: resolving the next step against
  // the ref keeps a fast double-click from computing both steps off the same
  // stale render and silently collapsing them into one.
  function changeUiScale(next: number): void {
    uiScaleChosenRef.current = true
    uiScaleRef.current = next
    setUiScale(next)
    applyUiScale(next)
    saveUiScale(next)
  }

  // Settings: seed from storage, then let the panel own the form.
  useEffect(() => {
    void chrome.storage.local.get('dshSettings').then((stored) => {
      const raw = stored.dshSettings as Partial<PanelSettings> | undefined
      setSettings({
        bridgeUrl: raw?.bridgeUrl ?? '',
        token: raw?.token ?? '',
        sharePageContent: raw?.sharePageContent ?? 'auto',
        unrestrictedBrowserAccess: raw?.unrestrictedBrowserAccess ?? false,
        trustedActionOrigins: raw?.trustedActionOrigins ?? [],
        approvalNotifications: raw?.approvalNotifications ?? true,
        autoResumeSession: raw?.autoResumeSession ?? true,
      })
    })
  }, [])

  // 每次连接重启（连接配置变更/断线重连）都新建会话。状态消息逐条监听：
  // React 会把 stopped/connecting 等瞬时状态合并进同一帧渲染，依赖渲染
  // 状态无法可靠观察到"连接已重置"，因此在这里按消息粒度判定。
  const [sessionEpoch, setSessionEpoch] = useState(0)
  const lastStateRef = useRef<BridgeState | null>(null)
  useEffect(() => {
    const offStatus = api.onStatus((next, nextCaps) => {
      setState(next)
      setCaps(nextCaps)
      const previous = lastStateRef.current
      lastStateRef.current = next
      if (previous !== null && next !== previous && next === 'stopped') {
        sessionTransitionRef.current += 1
        sessionInitializationRef.current = false
        sessionChangingRef.current = false
        sessionRef.current = null
        setResumeHint({ ready: false, sessionId: null })
        sessionRuntimeRef.current.clear()
        setRows([])
        setDraft((current) => ({ ...current, images: [] }))
        setImageLimits(null)
        imageProjectionRef.current = { sessionId: null, seq: Number.NEGATIVE_INFINITY, limits: null }
        setSessionTitle(null)
        setWorking(false)
        setStopping(false)
        setSessionChanging(false)
        setShowSessionPicker(false)
        stoppingRef.current = false
        clearQuestions()
        setSessionEpoch((epoch) => epoch + 1)
      }
    })
    const offEvent = api.onEvent((frame) => { void onFrame(frame) })
    const offApproval = api.onApprovalRequest((request) => {
      updateApprovalQueue((current) => current.some((entry) => entry.id === request.id) ? current : [...current, request])
    })
    const offApprovalResolved = api.onApprovalResolved((id) => {
      updateApprovalQueue((current) => current.filter((request) => request.id !== id))
    })
    const offTabAffinity = api.onTabAffinity(setTabAffinity)
    const offSelection = api.onSelection(setSelection)
    // A side panel has no sender.tab, so it reports its own window; the
    // background answers with whatever that window already had selected.
    void Promise.resolve(chrome.windows.getCurrent())
      .then((window) => { if (window.id !== undefined) return api.registerWindow(window.id) })
      .catch(() => {})
    const offResumeHint = api.onSessionResumeHint((sessionId) => {
      setResumeHint({ ready: true, sessionId })
    })
    void api.requestStatus().catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause))
    })
    return () => {
      offStatus(); offEvent(); offApproval(); offApprovalResolved()
      offTabAffinity(); offSelection(); offResumeHint()
    }
  }, [api])

  useEffect(() => {
    if (state === 'connected' && settings !== null && resumeHint.ready && sessionRef.current === null) {
      void initializeSession()
    }
  }, [state, sessionEpoch, settings, resumeHint])

  const queuedApproval = approvalQueue[0]
  useEffect(() => {
    const sessionId = approvalSessionToFocus(
      queuedApproval,
      sessionRef.current,
      sessionChangingRef.current,
      state === 'connected',
    )
    if (sessionId !== undefined && queuedApproval !== undefined) void focusApprovalSession(queuedApproval)
  }, [queuedApproval?.id, queuedApproval?.sessionId, sessionChanging, state])

  // Auto-scroll to the newest row.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [rows, working])

  function applyImageProjection(sessionId: string, seq: number, value: unknown): void {
    if (sessionRef.current !== sessionId || !Number.isSafeInteger(seq)) return
    const previous = imageProjectionRef.current
    if (previous.sessionId === sessionId && seq <= previous.seq) return
    const limits = parseImageAttachmentLimits(value)
    imageProjectionRef.current = { sessionId, seq, limits }
    setImageLimits(limits)
  }

  function applyHistoryImageProjection(sessionId: string, projections: HistoryPage['projections']): void {
    if (projections === undefined) {
      applyImageProjection(sessionId, -1, undefined)
      return
    }
    const values = projections.values
    applyImageProjection(
      sessionId,
      projections.asOfSeq,
      typeof values === 'object' && values !== null ? values.imageLimits : undefined,
    )
  }

  /** Live frame handling: session events append rows; turn/end reconciles with history. */
  async function onFrame(frame: ServerFrame): Promise<void> {
    if (frame.t !== 'event') return
    const pendingQuestion = pendingQuestionFromFrame(frame.frame)
    if (pendingQuestion !== null) {
      sessionRuntimeRef.current.rememberQuestion(pendingQuestion)
      if (pendingQuestion.sessionId === sessionRef.current) {
        const wasEmpty = questionsRef.current.length === 0
        replaceQuestions(upsertPendingQuestion(questionsRef.current, pendingQuestion))
        if (wasEmpty) setError(null)
      }
      return
    }
    const resolvedQuestion = resolvedQuestionFromFrame(frame.frame)
    if (resolvedQuestion !== null) {
      removeQuestion(resolvedQuestion)
      return
    }
    if (frame.frame.method === 'session/projection'
      && typeof frame.frame.payload === 'object'
      && frame.frame.payload !== null) {
      const projection = frame.frame.payload as {
        sessionId?: unknown
        key?: unknown
        value?: unknown
        seq?: unknown
      }
      if (typeof projection.sessionId === 'string'
        && projection.key === 'imageLimits'
        && typeof projection.seq === 'number') {
        applyImageProjection(projection.sessionId, projection.seq, projection.value)
      }
      return
    }
    const payload = frame.frame.payload as { sessionId?: string; event?: SessionEventView } | undefined
    if (payload?.sessionId === undefined || payload.event === undefined) return
    const nextTitle = sessionTitleFromEvent(payload.event)
    if (nextTitle !== undefined && payload.sessionId === sessionRef.current) {
      setSessionTitle(nextTitle)
      return
    }
    if (payload.event.type === 'turn/start') {
      sessionRuntimeRef.current.startTurn(payload.sessionId)
      if (payload.sessionId !== sessionRef.current) return
      stoppingRef.current = false
      setStopping(false)
      setWorking(true)
      return
    }
    if (payload.event.type === 'turn/end') {
      sessionRuntimeRef.current.finishTurn(payload.sessionId)
      if (payload.sessionId !== sessionRef.current) return
      stoppingRef.current = false
      setStopping(false)
      setWorking(false)
      clearQuestions()
      await refreshHistory(payload.sessionId)
      return
    }
    if (payload.sessionId !== sessionRef.current) return
    const row = rowFromEvent(payload.event)
    if (row !== null) {
      setRows((prev) => appendLiveRow(prev, row.kind, row.text, nextSeq(), row.images))
      return
    }
    if (payload.event.type === 'tool/call') {
      setWorking(true)
      const summary = toolSummary(payload.event.data?.name ?? 'tool', payload.event.data?.arguments, locale)
      setRows((prev) => appendLiveRow(prev, 'tool', summary, nextSeq()))
      return
    }
    if (payload.event.type === 'tool/result') {
      // 并入最后一行工具行：调用已完成（不新增行）。
      setRows((prev) => completeLastTool(prev, nextSeq()))
      return
    }
  }

  async function answerQuestion(target: PendingQuestion, answers: QuestionAnswer[]): Promise<void> {
    if (hasPendingQuestion(questionSubmissionsRef.current, target)
      || !hasPendingQuestion(questionsRef.current, target)) return
    setQuestionBusy(target, true)
    setError(null)
    try {
      const receipt = await api.respond(target.rpcId, {
        ok: true,
        value: { sessionId: target.sessionId, answer: { answers } },
      })
      settleQuestionReceipt(target, receipt)
    } catch (cause) {
      if (hasPendingQuestion(questionsRef.current, target)) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
      setQuestionBusy(target, false)
    }
  }

  async function dismissQuestion(target: PendingQuestion): Promise<void> {
    if (hasPendingQuestion(questionSubmissionsRef.current, target)
      || !hasPendingQuestion(questionsRef.current, target)) return
    setQuestionBusy(target, true)
    setError(null)
    try {
      const receipt = await api.respond(target.rpcId, {
        ok: false,
        error: { code: 'cancelled', message: 'the user dismissed this question request', details: {} },
      })
      settleQuestionReceipt(target, receipt)
    } catch (cause) {
      if (hasPendingQuestion(questionsRef.current, target)) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
      setQuestionBusy(target, false)
    }
  }

  function settleQuestionReceipt(target: PendingQuestion, receipt: unknown): void {
    const disposition = questionReceiptDisposition(receipt)
    if (disposition === 'accepted') {
      removeQuestion(target)
      return
    }
    if (disposition === 'not-pending') {
      setError(copy.question.alreadyAnswered)
      removeQuestion(target)
      return
    }
    setError(copy.question.answerRejected)
    setQuestionBusy(target, false)
  }

  async function readHistory(id: string): Promise<HistoryPage> {
    return api.rpc<HistoryPage>('session.history', { sessionId: id })
  }

  function applyHistory(id: string, history: HistoryPage): void {
    if (sessionRef.current !== id) return
    const events = history.events.map((entry) => entry.event)
    applyHistoryImageProjection(id, history.projections)
    const historyTitle = latestSessionTitle(events)
    if (historyTitle !== undefined) setSessionTitle(historyTitle)
    setRows(mergeHistoryRows(events, nextSeq, locale))
  }

  async function refreshHistory(requestedId: string | null = sessionRef.current): Promise<void> {
    const id = requestedId
    if (id === null) return
    try {
      applyHistory(id, await readHistory(id))
    } catch (cause) {
      if (sessionRef.current === id) setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  async function createSession(transition: number): Promise<void> {
    const created = await api.rpc<{ sessionId: string }>('session.create', {})
    if (sessionTransitionRef.current !== transition) return
    sessionRef.current = created.sessionId
    await api.setActiveSession(created.sessionId, true)
    setSessionTitle(null)
    sessionRuntimeRef.current.seedRunning(created.sessionId, false)
    applyHistory(created.sessionId, await readHistory(created.sessionId))
  }

  /** Load the raw host index plus workspace archive state once. */
  async function loadSessionCatalog(): Promise<{
    items: SessionPickerEntry[]
    archived: Set<string>
  }> {
    const [listed, workspaces] = await Promise.all([
      api.rpc<{ items: SessionPickerEntry[] }>('session.list', {}),
      api.rpc<{ archivedSessionIds?: string[] }>('workspace.list', {}).catch(() => ({ archivedSessionIds: [] as string[] })),
    ])
    const archived = new Set(workspaces.archivedSessionIds ?? [])
    for (const entry of listed.items ?? []) {
      sessionRuntimeRef.current.seedRunning(entry.sessionId, entry.running)
    }
    return { items: listed.items ?? [], archived }
  }

  /** Filter the raw catalog for the manual history picker. */
  async function loadVisibleSessions(): Promise<SessionPickerEntry[]> {
    const { items, archived } = await loadSessionCatalog()
    return resumableSessions(items).filter((entry) => !archived.has(entry.sessionId))
  }

  /** Restore only the exact current-page conversation, otherwise create a chat. */
  async function initializeSession(): Promise<void> {
    if (sessionInitializationRef.current || sessionChangingRef.current || sessionRef.current !== null) return
    sessionInitializationRef.current = true
    const transition = beginSessionTransition()
    try {
      const hinted = settings?.autoResumeSession === true ? resumeHint.sessionId : null
      if (hinted !== null && hinted.trim() !== '') {
        try {
          const { items, archived } = await loadSessionCatalog()
          // A contextual hint may identify a live provisional/blank session,
          // which is intentionally hidden only from the manual history picker.
          const entry = archived.has(hinted)
            ? undefined
            : items.find((candidate) => candidate.sessionId === hinted && candidate.origin !== 'subagent')
          if (entry !== undefined) {
            const history = await readHistory(hinted)
            if (sessionTransitionRef.current !== transition) return
            const runtime = sessionRuntimeRef.current.snapshot(hinted, entry.running)
            // A highlight captured while startup history is loading belongs to
            // the still-open page, so automatic restoration must not erase it.
            prepareSessionSwitch(runtime.running, runtime.questions, true)
            sessionRef.current = hinted
            await api.setActiveSession(hinted)
            setSessionTitle(projectedSessionTitle(entry) ?? sessionDisplayTitle(entry))
            applyHistory(hinted, history)
            return
          }
        } catch {
          // Missing, archived, or unreadable contextual sessions start fresh.
        }
      }
      await createSession(transition)
    } catch (cause) {
      if (sessionTransitionRef.current === transition) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    } finally {
      sessionInitializationRef.current = false
      finishSessionTransition(transition)
    }
  }

  /** 打开历史会话选择器：拉取持久化会话列表（已过滤空白会话），供恢复。 */
  async function openSessionPicker(): Promise<void> {
    if (showSessionPicker) {
      setShowSessionPicker(false)
      return
    }
    if (state !== 'connected' || sessionSwitchBlocked || sessionChangingRef.current) return
    setShowSessionPicker(true)
    setLoadingSessions(true)
    try {
      const items = await loadVisibleSessions()
      const current = items.find((entry) => entry.sessionId === sessionRef.current)
      const currentTitle = current === undefined ? undefined : projectedSessionTitle(current)
      if (currentTitle !== undefined) setSessionTitle(currentTitle)
      setSessionList(items)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoadingSessions(false)
    }
  }

  /** 恢复历史会话：切换当前 session 并加载其历史。 */
  async function resumeSession(entry: SessionPickerEntry): Promise<void> {
    if (sessionSwitchBlocked || sessionChangingRef.current) return
    const transition = beginSessionTransition()
    try {
      await api.setActiveSession(entry.sessionId)
      if (sessionTransitionRef.current !== transition) return
      const runtime = sessionRuntimeRef.current.snapshot(entry.sessionId, entry.running)
      prepareSessionSwitch(runtime.running, runtime.questions)
      sessionRef.current = entry.sessionId
      setSessionTitle(projectedSessionTitle(entry) ?? sessionDisplayTitle(entry))
      await refreshHistory(entry.sessionId)
    } catch (cause) {
      if (sessionTransitionRef.current === transition) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    } finally {
      finishSessionTransition(transition)
    }
  }

  /** 删除历史会话：先走官方归档更新索引，再经桥接清理磁盘文件。 */
  async function deleteSession(entry: SessionPickerEntry): Promise<void> {
    if (entry.running || sessionSwitchBlocked || sessionChangingRef.current) return
    const title = projectedSessionTitle(entry) ?? sessionDisplayTitle(entry)
    if (!window.confirm(copy.app.deleteSessionConfirm(title))) return
    try {
      await api.rpc('workspace.archiveSession', { sessionId: entry.sessionId })
      let purgeFailure: string | null = null
      try {
        await api.rpc(BRIDGE_SESSION_PURGE_METHOD, { sessionId: entry.sessionId })
      } catch (cause) {
        purgeFailure = cause instanceof Error ? cause.message : String(cause)
      }
      setSessionList((prev) => prev.filter((item) => item.sessionId !== entry.sessionId))
      if (purgeFailure !== null) {
        // 归档已生效（列表不再显示），但磁盘清理失败需要用户知道。
        setError(copy.app.deletePurgeFailed(purgeFailure))
      }
      if (sessionRef.current === entry.sessionId) {
        setShowSessionPicker(false)
        await startNewSession()
      }
    } catch (cause) {
      setError(copy.app.deleteSessionFailed(cause instanceof Error ? cause.message : String(cause)))
    }
  }

  /** Load the session that owns an approval before exposing its decision UI. */
  async function focusApprovalSession(request: ApprovalRequest): Promise<void> {
    const sessionId = request.sessionId
    if (sessionId === undefined || sessionChangingRef.current || sessionRef.current === sessionId) return
    const transition = beginSessionTransition()
    let history: HistoryPage | undefined
    let historyError: unknown
    try {
      try {
        history = await readHistory(sessionId)
      } catch (cause) {
        historyError = cause
      }
      if (sessionTransitionRef.current !== transition
        || !approvalQueueRef.current.some((entry) => entry.id === request.id)) return
      const runtime = sessionRuntimeRef.current.snapshot(sessionId)
      prepareSessionSwitch(runtime.running, runtime.questions)
      sessionRef.current = sessionId
      await api.setActiveSession(sessionId)
      setSessionTitle(sessionId)
      if (history !== undefined) applyHistory(sessionId, history)
      else setError(historyError instanceof Error ? historyError.message : String(historyError))
    } finally {
      finishSessionTransition(transition)
    }
  }

  /** 新建会话：创建后由 session.active(isNew) 将其绑定到当前标签页。 */
  async function startNewSession(): Promise<void> {
    if (sessionSwitchBlocked || sessionChangingRef.current) return
    const transition = beginSessionTransition()
    try {
      sessionRef.current = null
      setSessionTitle(null)
      prepareSessionSwitch(false)
      await createSession(transition)
    } catch (cause) {
      if (sessionTransitionRef.current === transition) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    } finally {
      finishSessionTransition(transition)
    }
  }

  function beginSessionTransition(): number {
    sessionChangingRef.current = true
    setSessionChanging(true)
    sessionTransitionRef.current += 1
    return sessionTransitionRef.current
  }

  function finishSessionTransition(transition: number): void {
    if (sessionTransitionRef.current !== transition) return
    sessionChangingRef.current = false
    setSessionChanging(false)
  }

  /** Drop the attached quote here and in every other open panel. */
  function dismissSelection(): void {
    const dismissed = selection
    setSelection(null)
    if (dismissed !== null) void api.clearSelection(dismissed).catch(() => {})
  }

  function prepareSessionSwitch(
    nextWorking: boolean,
    nextQuestions: PendingQuestion[] = [],
    preserveSelection = false,
  ): void {
    setRows([])
    setDraft(emptyComposerDraft())
    if (!preserveSelection) {
      setSelection(null)
      // An explicit conversation switch abandons whatever attachment is
      // current when the background processes it, rather than a stale render.
      void api.clearSelection().catch(() => {})
    }
    setImageLimits(null)
    imageProjectionRef.current = { sessionId: null, seq: Number.NEGATIVE_INFINITY, limits: null }
    setWorking(nextWorking)
    setStopping(false)
    stoppingRef.current = false
    replaceQuestions(nextQuestions)
    questionSubmissionsRef.current = []
    setQuestionSubmissions([])
    setError(null)
    setShowSessionPicker(false)
  }

  async function addImageFiles(files: readonly File[]): Promise<void> {
    const limits = imageLimits
    const sessionId = sessionRef.current
    if (files.length === 0 || limits === null || sessionId === null
      || !canAcceptImageSelection(addingImagesRef.current, sendingRef.current)) return
    addingImagesRef.current = true
    setAddingImages(true)
    setError(null)
    const existing = draftImages
    try {
      const prepared = await prepareImageFiles(files, existing, limits)
      if (sessionRef.current === sessionId) {
        setDraft((current) => ({ ...current, images: [...current.images, ...prepared] }))
      }
    } catch (cause) {
      if (sessionRef.current === sessionId) setError(imageErrorMessage(cause, copy, limits))
    } finally {
      addingImagesRef.current = false
      setAddingImages(false)
    }
  }

  async function send(textOverride?: string): Promise<void> {
    const text = (textOverride ?? input).trim()
    const submittedImages = textOverride === undefined ? draftImages : []
    // A quick-start prompt asks about the whole page, not about a quote.
    const submittedSelection = textOverride === undefined ? selection : null
    const id = sessionRef.current
    // busy state 是异步的：连续回车可能都通过 state 检查——用 ref 同步锁。
    if ((text === '' && submittedImages.length === 0 && submittedSelection === null)
      || busy || addingImagesRef.current || sendingRef.current || sessionChangingRef.current || id === null) return
    sendingRef.current = true
    const submittedDraft: ComposerDraft<DraftImage> = { text, images: submittedImages }
    if (textOverride === undefined) {
      setDraft(emptyComposerDraft())
    }
    setBusy(true)
    setWorking(true)
    setError(null)
    // 不渲染乐观行：live user/message 事件即时回显，避免同一消息出现两行。
    try {
      const clientTimeZone = browserTimeZone()
      await api.rpc('session.prompt', {
        sessionId: id,
        mode: 'queue',
        content: promptContent(
          submittedSelection === null ? text : selectionPromptText(submittedSelection, text),
          submittedImages,
        ),
        ...(clientTimeZone === undefined ? {} : { clientTimeZone }),
      })
      if (submittedSelection !== null) {
        // Keep the background authoritative while the prompt is in flight.
        // Conditional clearing cannot consume a newer highlight captured in
        // the meantime, and its broadcast updates every panel together.
        void api.clearSelection(submittedSelection).then(() => {
          setSelection((current) => current?.capturedAt === submittedSelection.capturedAt ? null : current)
        }).catch(() => {})
      }
    } catch (cause) {
      if (sessionRef.current === id) {
        setError(imageErrorMessage(cause, copy, imageLimits ?? undefined))
        setWorking(false)
        if (textOverride === undefined) {
          setDraft((current) => restoreSubmittedDraft(current, submittedDraft))
        }
      }
    } finally {
      setBusy(false)
      sendingRef.current = false
    }
  }

  /** Cancel the active turn while keeping the sidebar session available. */
  async function stopTurn(): Promise<void> {
    const id = sessionRef.current
    if (id === null || stoppingRef.current || sessionChangingRef.current) return
    stoppingRef.current = true
    setStopping(true)
    setError(null)
    try {
      await api.rpc('session.cancel', { sessionId: id })
      if (sessionRef.current === id) {
        sessionRuntimeRef.current.finishTurn(id)
        setWorking(false)
        clearQuestions()
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      stoppingRef.current = false
      setStopping(false)
    }
  }

  async function saveSettings(): Promise<void> {
    if (settings === null) return
    try {
      const relaySaved = await saveRelayProfiles()
      if (!relaySaved) return
      await api.updateSettings(settings)
      setShowSettings(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  /** Load relay profiles from the llm-pi-ai settings namespace once per settings visit. */
  useEffect(() => {
    if (!showSettings || relayLoaded) return
    let cancelled = false
    void (async () => {
      try {
        const described = await api.rpc<{
          namespaces?: Array<{ ns: string; value?: Record<string, unknown> }>
        }>('settings.describe', {})
        const ns = described.namespaces?.find((candidate) => candidate.ns === 'llm-pi-ai')
        const providers = (ns?.value?.providers ?? {}) as Record<string, {
          displayName?: string
          api?: string
          baseURL?: string
          apiKeyEnv?: string
          models?: Array<{ id: string; contextWindow?: number }>
        }>
        const defaults = (described.namespaces?.find((candidate) => candidate.ns === 'agent-default-model')
          ?.value ?? {}) as { provider?: unknown }
        const refs = Object.entries(providers)
          .filter(([key]) => key.startsWith(RELAY_ROUTE_PREFIX))
          .map(([, route]) => typeof route.apiKeyEnv === 'string' ? route.apiKeyEnv : '')
          .filter((ref) => ref !== '')
        let configuredRefs = new Set<string>()
        if (refs.length > 0) {
          try {
            const creds = await api.rpc<{ credentials?: Record<string, { configured?: boolean }> }>(
              'credentials.describe',
              { refs },
            )
            configuredRefs = new Set(
              Object.entries(creds.credentials ?? {})
                .filter(([, view]) => view.configured === true)
                .map(([ref]) => ref),
            )
          } catch {
            // Credential visibility is cosmetic here; treat every token as unconfigured.
          }
        }
        const drafts = Object.entries(providers)
          .filter(([key]) => key.startsWith(RELAY_ROUTE_PREFIX))
          .map(([key, route]) => ({
            key,
            name: typeof route.displayName === 'string' && route.displayName !== '' ? route.displayName : key,
            protocol: (route.api === 'anthropic-messages' || route.api === 'openai-codex-responses'
              ? route.api
              : 'openai-completions') as RelayProfileDraft['protocol'],
            baseUrl: typeof route.baseURL === 'string' ? route.baseURL : '',
            token: '',
            tokenConfigured: route.apiKeyEnv !== undefined && configuredRefs.has(route.apiKeyEnv),
            modelsText: (route.models ?? []).map((model) => [
              model.id,
              model.contextWindow === undefined ? '' : String(model.contextWindow),
            ].filter((part) => part !== '').join(', ')).join('\n'),
            setDefault: defaults.provider === key,
          }))
        if (!cancelled) setRelayProfiles(drafts)
      } catch {
        // The namespace may not exist yet; an empty list still allows creating profiles.
      }
      if (!cancelled) setRelayLoaded(true)
    })()
    return () => { cancelled = true }
  }, [api, showSettings, relayLoaded])

  function updateRelayProfile(index: number, patch: Partial<RelayProfileDraft>): void {
    setRelayProfiles((current) => current.map((profile, at) => at === index ? { ...profile, ...patch } : profile))
  }

  function addRelayProfile(): void {
    setRelayNotice(null)
    setRelayProfiles((current) => [...current, {
      key: '',
      name: '',
      protocol: 'openai-completions',
      baseUrl: '',
      token: '',
      tokenConfigured: false,
      modelsText: '',
      setDefault: false,
    }])
  }

  async function removeRelayProfile(index: number): Promise<void> {
    const profile = relayProfiles[index]
    setRelayProfiles((current) => current.filter((_, at) => at !== index))
    setRelayNotice(null)
    if (profile === undefined || profile.key === '') return
    try {
      await api.rpc('settings.mutate', {
        ns: 'llm-pi-ai',
        ops: [{ op: 'unset', path: ['providers', profile.key] }],
      })
      try {
        await api.rpc('credentials.unset', { ref: relayTokenRef(profile.key) })
      } catch {
        // The route is gone either way; a stale credential reference harms nothing.
      }
    } catch (cause) {
      setRelayNotice(copy.settings.relaySaveFailed(cause instanceof Error ? cause.message : String(cause)))
    }
  }

  async function testRelayConnection(index: number): Promise<void> {
    const profile = relayProfiles[index]
    if (profile === undefined || relayBusy) return
    setRelayBusy(true)
    setRelayNotice(copy.settings.relayTesting)
    try {
      const { models, viaOpenaiListing } = await discoverWithFallback(api, profile)
      const ids = models.map((model) => model.id)
      if (ids.length === 0) {
        setRelayNotice(copy.settings.relayTestManualOnly)
        return
      }
      setRelayNotice(copy.settings.relayTestOk(ids.length, ids.slice(0, 4).join(', ')
        + (ids.length > 4 ? ' …' : ''))
        + (viaOpenaiListing ? copy.settings.relayOpenaiListingNote : ''))
    } catch (cause) {
      setRelayNotice(isManualOnlyDiscovery(cause)
        ? copy.settings.relayTestManualOnly
        : copy.settings.relayTestFailed(relayErrorText(cause)))
    } finally {
      setRelayBusy(false)
    }
  }

  /** Discover models from the drafted endpoint and fill the textarea in place. */
  async function fetchRelayModels(index: number): Promise<void> {
    const profile = relayProfiles[index]
    if (profile === undefined || relayBusy) return
    if (profile.baseUrl.trim() === '') {
      setRelayNotice(copy.settings.relayNeedBaseUrl)
      return
    }
    setRelayBusy(true)
    setRelayNotice(copy.settings.relayFetching)
    try {
      const { models, viaOpenaiListing } = await discoverWithFallback(api, profile)
      if (models.length === 0) {
        setRelayNotice(copy.settings.relayTestManualOnly)
        return
      }
      updateRelayProfile(index, {
        modelsText: models.map((model) => [
          model.id,
          model.contextWindow === undefined ? '' : String(model.contextWindow),
        ].filter((part) => part !== '').join(', ')).join('\n'),
      })
      setRelayNotice(copy.settings.relayFetchOk(models.length)
        + (viaOpenaiListing ? copy.settings.relayOpenaiListingNote : ''))
    } catch (cause) {
      setRelayNotice(isManualOnlyDiscovery(cause)
        ? copy.settings.relayTestManualOnly
        : copy.settings.relayTestFailed(relayErrorText(cause)))
    } finally {
      setRelayBusy(false)
    }
  }

  /**
   * Persist every relay draft: token to the credential store, route to the
   * llm-pi-ai namespace, optional default to agent-default-model.
   * @returns false when validation failed and the outer save must abort.
   */
  async function saveRelayProfiles(): Promise<boolean> {
    for (const profile of relayProfiles) {
      if (profile.name.trim() === '') {
        setRelayNotice(copy.settings.relayInvalidName)
        return false
      }
    }
    try {
      const usedKeys = new Set<string>()
      let defaultApplied = false
      for (const profile of relayProfiles) {
        let key = profile.key !== '' ? profile.key : relayRouteKey(profile.name)
        while (usedKeys.has(key)) key += '-x'
        usedKeys.add(key)
        const ref = relayTokenRef(key)
        if (profile.token.trim() !== '') {
          await api.rpc('credentials.set', { ref, value: profile.token.trim() })
        }
        const models = parseRelayModels(profile.modelsText)
        const firstModel = models[0]
        const routeValue: Record<string, unknown> = {
          displayName: profile.name.trim(),
          apiKeyEnv: ref,
          baseURL: profile.baseUrl.trim(),
          models,
          api: profile.protocol,
        }
        await api.rpc('settings.mutate', {
          ns: 'llm-pi-ai',
          ops: [{ op: 'set', path: ['providers', key], value: routeValue }],
        })
        if (profile.setDefault && !defaultApplied && models.length > 0) {
          await api.rpc('settings.mutate', {
            ns: 'agent-default-model',
            ops: [
              { op: 'set', path: ['provider'], value: key },
              { op: 'set', path: ['model'], value: firstModel?.id ?? '' },
              { op: 'unset', path: ['reasoningEffort'] },
            ],
          })
          defaultApplied = true
          // Model selection is remembered per session; the active one would
          // otherwise stay on its old provider until a new chat is started.
          const activeSessionId = sessionRef.current
          if (activeSessionId !== null && firstModel?.id !== undefined) {
            try {
              await api.rpc('session.selectModel', {
                sessionId: activeSessionId,
                provider: key,
                model: firstModel.id,
              })
            } catch {
              // Best effort: the default still applies to every new session.
            }
          }
        }
      }
      if (relayProfiles.length > 0) setRelayNotice(copy.settings.relaySavedOk)
      return true
    } catch (cause) {
      setRelayNotice(copy.settings.relaySaveFailed(cause instanceof Error ? cause.message : String(cause)))
      return false
    }
  }

  async function decideApproval(decision: ApprovalDecision): Promise<void> {
    const request = approvalQueue[0]
    if (request === undefined) return
    try {
      await api.respondToApproval(request.id, decision)
      if (decision === 'always-allow-reads') {
        setSettings((current) => current === null ? current : { ...current, sharePageContent: 'auto' })
      }
      updateApprovalQueue((current) => current.filter((entry) => entry.id !== request.id))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  async function decideTabAffinity(decision: TabAffinityDecision): Promise<void> {
    if (tabAffinity === null) return
    try {
      await api.resolveTabAffinity(tabAffinity.revision, decision, sessionRef.current)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  function addTrustedOrigin(): void {
    const origin = normalizeWebOrigin(trustedOriginInput)
    if (origin === null) return
    setSettings((current) => current === null
      ? current
      : { ...current, trustedActionOrigins: [...new Set([...current.trustedActionOrigins, origin])].sort() })
    setTrustedOriginInput('')
  }

  function removeTrustedOrigin(origin: string): void {
    setSettings((current) => current === null
      ? current
      : { ...current, trustedActionOrigins: current.trustedActionOrigins.filter((candidate) => candidate !== origin) })
  }

  // 状态栏只显示连接状态；快照上限是技术细节，在设置页说明（见 hint）。
  const statusText = copy.status[state]
  const sessionMenuTitle = sessionTitle ?? copy.app.newSession
  const approvalDialog = !approvalReadyForSession(queuedApproval, sessionRef.current, sessionChanging)
    ? null
    : <ApprovalDialog request={queuedApproval!} onDecision={decideApproval} copy={copy} />

  if (showSettings) {
    return (
      <><div className="settings">
        <div className="settings-heading">
          <button className="icon-button" onClick={() => setShowSettings(false)} aria-label={copy.settings.back}><BackIcon /></button>
          <div>
            <span className="eyebrow">{copy.settings.eyebrow}</span>
            <h1>{copy.settings.title}</h1>
          </div>
        </div>
        <UpdateCard copy={copy.update} />
        <div className="settings-panel">
          <label>
            <span>{copy.settings.bridgeAddress}</span>
            <small>{copy.settings.bridgeHelp}</small>
            <input
              value={settings?.bridgeUrl ?? ''}
              onChange={(e) => setSettings((prev) => prev === null ? prev : { ...prev, bridgeUrl: e.target.value })}
              placeholder={copy.settings.bridgePlaceholder}
            />
          </label>
          <label>
            <span>Token</span>
            <small>{copy.settings.tokenHelp}</small>
            <input
              type="password"
              value={settings?.token ?? ''}
              onChange={(e) => setSettings((prev) => prev === null ? prev : { ...prev, token: e.target.value })}
              placeholder={copy.settings.tokenPlaceholder}
            />
          </label>
          <label>
            <span>{copy.settings.pageSharing}</span>
            <small>{copy.settings.pageSharingHelp}</small>
            <select
              value={settings?.sharePageContent ?? 'auto'}
              disabled={settings?.unrestrictedBrowserAccess ?? false}
              onChange={(e) => setSettings((prev) => prev === null ? prev : { ...prev, sharePageContent: e.target.value as PanelSettings['sharePageContent'] })}
            >
              <option value="auto">{copy.settings.sharingAuto}</option>
              <option value="ask">{copy.settings.sharingAsk}</option>
              <option value="off">{copy.settings.sharingOff}</option>
            </select>
          </label>
        </div>
        <div className="settings-panel preference-toggles">
          <label className="setting-toggle">
            <span className="setting-toggle-copy">
              <strong>{copy.settings.unrestrictedBrowserAccess}</strong>
              <small>{copy.settings.unrestrictedBrowserAccessHelp}</small>
            </span>
            <input
              className="setting-toggle-input"
              type="checkbox"
              checked={settings?.unrestrictedBrowserAccess ?? false}
              onChange={(event) => setSettings((current) => current === null
                ? current
                : { ...current, unrestrictedBrowserAccess: event.target.checked })}
            />
            <span className="setting-toggle-control" aria-hidden="true"><span /></span>
          </label>
          <label className="setting-toggle">
            <span className="setting-toggle-copy">
              <strong>{copy.settings.approvalNotifications}</strong>
              <small>{copy.settings.approvalNotificationsHelp}</small>
            </span>
            <input
              className="setting-toggle-input"
              type="checkbox"
              checked={settings?.approvalNotifications ?? true}
              onChange={(event) => setSettings((current) => current === null
                ? current
                : { ...current, approvalNotifications: event.target.checked })}
            />
            <span className="setting-toggle-control" aria-hidden="true"><span /></span>
          </label>
          <label className="setting-toggle">
            <span className="setting-toggle-copy">
              <strong>{copy.settings.autoResumeSession}</strong>
              <small>{copy.settings.autoResumeSessionHelp}</small>
            </span>
            <input
              className="setting-toggle-input"
              type="checkbox"
              checked={settings?.autoResumeSession ?? true}
              onChange={(event) => setSettings((current) => current === null
                ? current
                : { ...current, autoResumeSession: event.target.checked })}
            />
            <span className="setting-toggle-control" aria-hidden="true"><span /></span>
          </label>
        </div>
        <section className="relay-config" aria-labelledby="relay-title">
          <div className="relay-heading">
            <span id="relay-title">
              <strong>{copy.settings.relaySection}</strong>
              <small>{copy.settings.relayHelp}</small>
            </span>
            <button className="secondary" onClick={addRelayProfile}>{copy.settings.relayAdd}</button>
          </div>
          {relayProfiles.length === 0 && <p>{copy.settings.relayEmpty}</p>}
          {relayProfiles.map((profile, index) => (
            <div className="relay-profile" key={profile.key === '' ? `new-${index}` : profile.key}>
              <label>
                <span>{copy.settings.relayName}</span>
                <input
                  value={profile.name}
                  onChange={(event) => updateRelayProfile(index, { name: event.target.value })}
                  placeholder={copy.settings.relayNamePlaceholder}
                />
              </label>
              <label>
                <span>{copy.settings.relayProtocol}</span>
                <select
                  value={profile.protocol}
                  onChange={(event) => updateRelayProfile(index, {
                    protocol: event.target.value as RelayProfileDraft['protocol'],
                  })}
                >
                  <option value="openai-completions">{copy.settings.relayProtocolOpenai}</option>
                  <option value="openai-codex-responses">{copy.settings.relayProtocolCodex}</option>
                  <option value="anthropic-messages">{copy.settings.relayProtocolClaude}</option>
                </select>
              </label>
              <label>
                <span>{copy.settings.relayBaseUrl}</span>
                <input
                  value={profile.baseUrl}
                  onChange={(event) => updateRelayProfile(index, { baseUrl: event.target.value })}
                  placeholder="https://api.example.com/v1"
                />
              </label>
              <label>
                <span>{copy.settings.relayToken}</span>
                <input
                  type="password"
                  value={profile.token}
                  onChange={(event) => updateRelayProfile(index, { token: event.target.value })}
                  placeholder={copy.settings.relayTokenPlaceholder(profile.tokenConfigured)}
                />
              </label>
              <div className="relay-models">
                <div className="relay-label-row">
                  <span>{copy.settings.relayModels}</span>
                  <button className="relay-fetch" disabled={profile.baseUrl.trim() === '' || relayBusy}
                    onClick={() => { void fetchRelayModels(index) }}>
                    {copy.settings.relayFetchModels}
                  </button>
                </div>
                <small>{copy.settings.relayModelsHelp}</small>
                <textarea
                  rows={3}
                  aria-label={copy.settings.relayModels}
                  value={profile.modelsText}
                  onChange={(event) => updateRelayProfile(index, { modelsText: event.target.value })}
                  placeholder={copy.settings.relayModelsPlaceholder}
                />
              </div>
              <label className="setting-toggle">
                <span className="setting-toggle-copy">
                  <strong>{copy.settings.relaySetDefault}</strong>
                  <small>{copy.settings.relaySetDefaultHelp}</small>
                </span>
                <input
                  className="setting-toggle-input"
                  type="checkbox"
                  checked={profile.setDefault}
                  onChange={(event) => setRelayProfiles((current) => current.map((candidate, at) => at === index
                    ? { ...candidate, setDefault: event.target.checked }
                    : candidate))}
                />
                <span className="setting-toggle-control" aria-hidden="true"><span /></span>
              </label>
              <div className="relay-profile-actions">
                <button
                  disabled={profile.name.trim() === '' || profile.baseUrl.trim() === ''}
                  onClick={() => { void testRelayConnection(index) }}
                >
                  {copy.settings.relayTest}
                </button>
                <button className="secondary" onClick={() => { void removeRelayProfile(index) }}>
                  {copy.settings.relayRemove}
                </button>
              </div>
            </div>
          ))}
          {relayNotice !== null && <p className="hint">{relayNotice}</p>}
        </section>
        <section className="trusted-origins" aria-labelledby="trusted-origins-title">
          <div>
            <span id="trusted-origins-title">{copy.settings.trustedOrigins}</span>
            <small>{copy.settings.trustedOriginsHelp}</small>
          </div>
          <div className="trusted-origin-add">
            <input
              aria-label={copy.settings.trustedOriginInput}
              value={trustedOriginInput}
              onChange={(event) => setTrustedOriginInput(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') addTrustedOrigin() }}
              placeholder="https://example.com / https://*.example.com"
            />
            <button disabled={normalizeWebOrigin(trustedOriginInput) === null} onClick={addTrustedOrigin}>{copy.settings.add}</button>
          </div>
          {trustedOriginInput.trim() !== '' && normalizeWebOrigin(trustedOriginInput) === null && (
            <p className="origin-error">{copy.settings.invalidOrigin}</p>
          )}
          {settings?.trustedActionOrigins.length === 0 && <p>{copy.settings.noTrustedOrigins}</p>}
          {settings?.trustedActionOrigins.map((origin) => (
            <div className="trusted-origin" key={origin}>
              <code>{origin}</code>
              <button onClick={() => removeTrustedOrigin(origin)} aria-label={copy.settings.removeOrigin(origin)}>{copy.settings.remove}</button>
            </div>
          ))}
        </section>
        <div className="settings-actions">
          <button className="primary" onClick={saveSettings}>{copy.settings.save}</button>
          <button className="secondary" onClick={() => setShowSettings(false)}>{copy.settings.cancel}</button>
        </div>
        <p className="hint">{copy.settings.snapshotHint(caps?.snapshotMaxChars ?? DEFAULT_SNAPSHOT_MAX_CHARS)}</p>
      </div>{approvalDialog}</>
    )
  }

  return (
    <><div className="app">
      <header className="topbar">
        <span className="connection" role="status">
          <span className={`dot ${state}`} />
          <span className="connection-label">{statusText}</span>
        </span>
        <button className="session-menu-trigger" disabled={state !== 'connected' || sessionSwitchBlocked}
          aria-expanded={showSessionPicker} aria-label={copy.app.openSessions}
          onClick={() => { void openSessionPicker() }} title={sessionMenuTitle}>
          <span>{sessionMenuTitle}</span>
          <ChevronDownIcon />
        </button>
        <div className="topbar-actions">
          <button className="icon-button new-session-trigger" disabled={state !== 'connected' || sessionSwitchBlocked}
            onClick={() => { void startNewSession() }}
            aria-label={copy.app.newSession} title={copy.app.newSession}>
            <PlusIcon />
          </button>
          <button className="icon-button text-size-trigger" onClick={() => setShowTextSize((open) => !open)}
            aria-expanded={showTextSize} aria-label={copy.textSize.open} title={copy.textSize.open}>
            <TextSizeIcon />
          </button>
          <button className="icon-button settings-trigger" onClick={() => setShowSettings(true)}
            aria-label={copy.app.openSettings} title={copy.app.settings}><SettingsIcon /></button>
        </div>
      </header>
      {showTextSize && (
        <TextSizePanel scale={uiScale} copy={copy}
          onStep={(direction) => changeUiScale(stepUiScale(uiScaleRef.current, direction))}
          onReset={() => changeUiScale(DEFAULT_UI_SCALE)} />
      )}
      <TabAffinityBanner state={tabAffinity} copy={copy} onDecision={decideTabAffinity} />
      {showSessionPicker && (
        <section className="session-picker" aria-label={copy.app.sessions}>
          <div className="session-picker-head">
            <strong>{copy.app.sessions}</strong>
            <button className="session-new" disabled={state !== 'connected' || sessionSwitchBlocked}
              onClick={() => { void startNewSession() }}>
              {copy.app.newSession}
            </button>
          </div>
          {loadingSessions
            ? <p className="session-empty">{copy.app.sessionPickerLoading}</p>
            : sessionList.length === 0
              ? <p className="session-empty">{copy.app.sessionPickerEmpty}</p>
              : (
                <ul className="session-list">
                  {sessionList.map((entry) => {
                    const title = sessionDisplayTitle(entry)
                    return (
                      <li key={entry.sessionId}>
                        <button disabled={sessionSwitchBlocked}
                          aria-current={entry.sessionId === sessionRef.current ? 'true' : undefined}
                          onClick={() => { void resumeSession(entry) }}>
                          <span className="session-title" title={title}>{title}</span>
                          <span className="session-meta">
                            <span className="session-time">{new Date(entry.updatedAt).toLocaleString()}</span>
                            {entry.cwd !== undefined && <span className="session-cwd" title={entry.cwd}>{entry.cwd}</span>}
                          </span>
                        </button>
                        {!entry.running && (
                          <button className="icon-button session-delete" disabled={sessionSwitchBlocked}
                            aria-label={copy.app.deleteSession} title={copy.app.deleteSession}
                            onClick={() => { void deleteSession(entry) }}>
                            <TrashIcon />
                          </button>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}
        </section>
      )}
      <div className="messages" ref={scrollRef}>
        {rows.length === 0 && !working && (
          <div className="empty">
            <span className="empty-logo"><img src={whaleUrl} alt="" /></span>
            <div>
              <h1>{copy.app.emptyTitle}</h1>
              <p>{copy.app.emptyDescription}</p>
            </div>
            <button disabled={!sessionReady}
              onClick={() => { void send(copy.app.overviewPrompt) }}>
              {copy.app.overviewPage}
            </button>
          </div>
        )}
        {rows.map((row) => (
          <div key={row.seq} className={`row ${row.kind}`}>
            {row.kind === 'assistant' && <span className="assistant-avatar"><img src={whaleUrl} alt={copy.app.assistant} /></span>}
            {row.kind === 'tool'
              ? <ToolActivity row={row} copy={copy} />
              : <MessageBody row={row} sessionId={sessionRef.current ?? ''} api={api} copy={copy} />}
          </div>
        ))}
        {working && question === null && rows[rows.length - 1]?.status !== 'running' && (
          <div className="ai-progress" role="status" aria-label={copy.app.assistantWorking}>
            <span className="assistant-avatar"><img src={whaleUrl} alt="" /></span>
            <span className="progress-dots" aria-hidden="true"><i /><i /><i /></span>
            <span>{rows[rows.length - 1]?.kind === 'tool' ? copy.app.organizingResults : copy.app.thinking}</span>
          </div>
        )}
      </div>
      {question !== null && (
        <QuestionCard
          key={`${question.sessionId}:${question.rpcId}`}
          question={question}
          copy={copy}
          submitting={questionSubmitting}
          onAnswer={(answers) => { void answerQuestion(question, answers) }}
          onDismiss={() => { void dismissQuestion(question) }}
        />
      )}
      {error !== null && <div className="error">{error}</div>}
      <footer className="composer">
        <div className="composer-box">
          {selection !== null && (
            <SelectionQuote
              selection={{ ...selection, quote: selection.text }}
              copy={copy}
              label={copy.app.selectionChip}
              onRemove={dismissSelection}
            />
          )}
          {draftImages.length > 0 && (
            <div className="draft-images" aria-label={copy.app.addImages}>
              {draftImages.map((image) => {
                const name = image.name ?? copy.app.image
                return (
                  <span className="draft-image" key={image.id}>
                    <img src={draftImageDataUrl(image)} alt={name} />
                    <button
                      type="button"
                      disabled={busy || addingImages}
                      aria-label={copy.app.removeImage(name)}
                      title={copy.app.removeImage(name)}
                      onClick={() => setDraft((current) => ({
                        ...current,
                        images: current.images.filter((item) => item.id !== image.id),
                      }))}
                    >×</button>
                  </span>
                )
              })}
            </div>
          )}
          <textarea
            value={input}
            onChange={(e) => {
              if (!sendingRef.current) setDraft((current) => ({ ...current, text: e.target.value }))
            }}
            onKeyDown={(e) => {
              // isComposing：输入法组词中的回车是确认选字，不是发送。
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void send()
              }
            }}
            placeholder={state === 'connected' ? copy.app.connectedPlaceholder : copy.app.disconnectedPlaceholder}
            disabled={!sessionReady || busy}
            rows={2}
          />
          <div className="composer-actions">
            <span className="composer-actions-start">
              <input
                ref={fileInputRef}
                className="image-file-input"
                type="file"
                accept={imageLimits?.mediaTypes.join(',')}
                multiple
                tabIndex={-1}
                onChange={(event) => {
                  const files = [...(event.target.files ?? [])]
                  event.target.value = ''
                  void addImageFiles(files)
                }}
              />
              <button
                type="button"
                className="attachment-button"
                disabled={!sessionReady || busy || addingImages || imageLimits === null
                  || draftImages.length >= imageLimits.maxImagesPerMessage}
                aria-label={copy.app.addImages}
                title={imageLimits === null ? copy.app.imageUnavailable : copy.app.addImages}
                onClick={() => fileInputRef.current?.click()}
              ><AttachmentIcon /></button>
              <span>{copy.app.composerHelp}</span>
            </span>
            {working ? (
              <button
                className="stop-button"
                onClick={() => { void stopTurn() }}
                disabled={!sessionReady || stopping}
                aria-label={stopping ? copy.app.stoppingTurn : copy.app.stopTurn}
                title={stopping ? copy.app.stoppingTurn : copy.app.stopTurn}
              >
                <span className="stop-glyph" aria-hidden="true" />
              </button>
            ) : (
              <button onClick={() => void send()}
                disabled={!sessionReady || busy || addingImages
                  || (input.trim() === '' && draftImages.length === 0 && selection === null)}
                aria-label={copy.app.sendMessage}><SendIcon /></button>
            )}
          </div>
        </div>
      </footer>
    </div>{approvalDialog}</>
  )
}

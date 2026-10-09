/**
 * Presentation layer for the developer-tools tools: turn CDP-derived view
 * models into the single bounded text payload each tool returns.
 *
 * Page-authored values are passed through {@link wrapUntrustedContent} by the
 * caller that owns the budget, so these renderers stay pure and test-free of
 * Chrome APIs.
 *
 * @module
 */

import {
  formatBytes,
  formatHeaders,
  formatTiming,
  isSensitiveBodyUrl,
  REDACTED,
  truncateText,
} from './devtools-serialization.ts'
import type { ConsoleEntry, ConsoleLevel, NetworkEntry } from './devtools-network.ts'
import type { ElementView } from './devtools-elements.ts'
/** Render one inspected element report. */
export function renderElement(view: ElementView): string {
  const lines: string[] = [`Element: ${view.identity}`]
  lines.push(`DOM path: ${view.domPath}`)
  if (view.inventoryIndex !== undefined) lines.push(`Snapshot inventory index: ${view.inventoryIndex}`)
  lines.push(`Child nodes: ${view.childNodeCount}`)
  if (view.box !== undefined) {
    lines.push(`Box: x ${view.box.x} y ${view.box.y} ${view.box.width}×${view.box.height}`)
  }
  if (view.boxModel !== undefined) {
    lines.push(`Box model (content / padding / border / margin): ${view.boxModel.content} / ${view.boxModel.padding} / ${view.boxModel.border} / ${view.boxModel.margin}`)
  }
  lines.push('', 'Computed style:')
  for (const [name, value] of Object.entries(view.computed)) lines.push(`  ${name}: ${value}`)
  lines.push('', 'Inline style:')
  lines.push(...view.inlineStyle.length === 0 ? ['  (none)'] : view.inlineStyle.map((declaration) => `  ${declaration}`))
  lines.push('', 'Matched CSS rules (most specific first):')
  if (view.matchedRules.length === 0) lines.push('  (no stylesheet rules matched)')
  for (const rule of view.matchedRules) {
    const media = rule.media === undefined ? '' : ` @media ${rule.media}`
    lines.push(`  ${rule.selector} [${rule.origin}]${media}`)
    lines.push(...rule.declarations.length === 0
      ? ['    (empty rule)']
      : rule.declarations.map((declaration) => `    ${declaration}`))
  }
  lines.push('', 'Attributes:')
  lines.push(...view.attributes.length === 0
    ? ['  (none)']
    : view.attributes.map((attribute) => `  ${attribute.name}="${attribute.value}"`))
  return lines.join('\n')
}

/** Render one element-list header, shared by inspection and edits. */
export function renderElementHeader(identity: string, note?: string): string {
  return note === undefined ? `Element: ${identity}` : `Element: ${identity}\n${note}`
}

/** Render the result of a style edit. */
export function renderStyleEdit(
  identity: string,
  mode: 'inline' | 'rule',
  target: string,
  declarations: readonly string[],
): string {
  const lines = [renderElementHeader(identity, mode === 'inline'
    ? 'Applied to the inline style attribute (a page reload reverts it).'
    : `Applied to the matching stylesheet rule: ${target} (reverts when the page replaces its stylesheets).`)]
  lines.push('', 'Declarations now applied:')
  lines.push(...declarations.length === 0 ? ['  (empty)' ] : declarations.map((declaration) => `  ${declaration}`))
  return lines.join('\n')
}

/** Render an attribute read/write result. */
export function renderAttributeResult(
  identity: string,
  name: string,
  before: string | undefined,
  after: string | undefined,
  action: 'read' | 'set' | 'removed',
): string {
  const lines = [`Element: ${identity}`, `Attribute: ${name}`]
  lines.push(`Before: ${before === undefined ? '(absent)' : before}`)
  if (action === 'read') return lines.join('\n')
  lines.push(`After: ${after === undefined ? '(removed)' : after}`)
  return lines.join('\n')
}

/** Render one console-log query result. */
export function renderConsoleLogs(entries: readonly ConsoleEntry[], sinceIndex: number): string {
  if (entries.length === 0) {
    return `No console entries recorded${sinceIndex > 0 ? ` after index ${sinceIndex}` : ''}. `
      + 'The extension records output from the moment the developer-tools session attached; reload the page to capture startup logs.'
  }
  const lines = [`Console entries (${entries.length}):`]
  for (const entry of entries) {
    lines.push(`[${entry.index}] ${entry.level}: ${entry.text}`)
  }
  return lines.join('\n')
}

/** Render one evaluation result, already formatted by the serialization layer. */
export function renderEvaluation(text: string, ok: boolean): string {
  return `${ok ? 'Evaluation result:' : 'Evaluation failed:'}\n${text}`
}

/** Render the capture control answer. */
export function renderCaptureState(state: { attached: boolean; tabId?: number; entries: number; generation: number }, action: string): string {
  const lines = [`Network capture ${state.attached ? 'active' : 'inactive'}.`]
  if (state.tabId !== undefined) lines.push(`Tab: ${state.tabId}`)
  lines.push(`Captured requests: ${state.entries}`)
  lines.push(`Capture generation: ${state.generation} (increments whenever the log resets, for example after a navigation)`)
  if (action === 'start') {
    lines.push('', 'Trigger the requests you want to inspect, then call browser_devtools_list_requests.')
  }
  if (action === 'stop') {
    lines.push('', 'The debugger detached; captured entries remain listed until the next capture or navigation.')
  }
  return lines.join('\n')
}

/** One line per captured request, without bodies. */
export function renderRequestList(entries: readonly NetworkEntry[], generation: number, limit: number): string {
  if (entries.length === 0) {
    return 'No captured requests matched. Start capture with browser_devtools_network action=start, then trigger the page traffic again.'
  }
  const shown = entries.slice(-limit)
  const lines = [`Captured requests (${shown.length} of ${entries.length}, generation ${generation}):`]
  for (const entry of shown) {
    const status = entry.failed === undefined
      ? (entry.status === undefined ? '(pending)' : String(entry.status))
      : `FAILED ${entry.failed}`
    const duration = entry.durationMs === undefined ? '' : ` ${entry.durationMs}ms`
    const size = entry.encodedDataLength === undefined ? '' : ` ${formatBytes(entry.encodedDataLength)}`
    lines.push(`[${entry.index}] ${entry.method} ${entry.url}`)
    lines.push(`    ${status}${duration}${size} type=${entry.resourceType ?? '?'}${entry.fromDiskCache ? ' from-disk-cache' : ''}${entry.fromServiceWorker ? ' from-service-worker' : ''}`)
    if (entry.pendingRequestEvent === true) {
      lines.push('    (Chrome withheld the main event for this request; method and request headers may be incomplete)')
    }
  }
  lines.push('', 'Use browser_devtools_get_request with an index for headers, timing, and (optionally) the response body.')
  return lines.join('\n')
}

/** Full detail of one captured request. */
export function renderRequestDetail(
  entry: NetworkEntry,
  options: { includeSensitiveHeaders: boolean; includeSensitiveBody: boolean; body?: string; bodyTruncated: boolean },
): string {
  const lines: string[] = []
  lines.push(`[${entry.index}] ${entry.method} ${entry.url}`)
  lines.push(`Type: ${entry.resourceType ?? 'unknown'}${entry.frameId === undefined ? '' : ` · frame ${entry.frameId}`}`)
  if (entry.initiator !== undefined) lines.push(`Initiator: ${entry.initiator}`)
  const status = entry.failed === undefined
    ? `${entry.status ?? '(pending)'} ${entry.statusText ?? ''}`.trim()
    : `FAILED: ${entry.failed}`
  lines.push(`Status: ${status}${entry.blockedReason === undefined ? '' : ` (blocked: ${entry.blockedReason})`}`)
  if (entry.mimeType !== undefined) lines.push(`MIME: ${entry.mimeType}`)
  if (entry.durationMs !== undefined) lines.push(`Duration: ${entry.durationMs}ms`)
  lines.push(`Transfer size: ${formatBytes(entry.encodedDataLength)}${entry.headerSize === undefined ? '' : ` (headers ${formatBytes(entry.headerSize)})`}`)
  lines.push(`Timing: ${formatTiming(entry.timing, entry.durationMs)}`)
  const cache: string[] = []
  if (entry.fromDiskCache) cache.push('disk cache')
  if (entry.fromServiceWorker) cache.push('service worker')
  if (cache.length > 0) lines.push(`Served from: ${cache.join(', ')}`)
  if (entry.redirects.length > 0) {
    lines.push('', 'Redirects:')
    for (const hop of entry.redirects) lines.push(`  ${hop.status} ${hop.url}`)
  }
  lines.push('', 'Request headers:')
  lines.push(...formatHeaders(entry.requestHeaders, options.includeSensitiveHeaders))
  if (entry.postData !== undefined) {
    lines.push('', 'Request payload:')
    const sensitive = !options.includeSensitiveBody && isSensitiveBodyUrl(entry.url)
    lines.push(sensitive ? REDACTED : truncateText(entry.postData, 4_000))
  } else if (entry.hasPostData) {
    lines.push('', 'This request carries a payload; read it with browser_devtools_request_body kind=request.')
  }
  lines.push('', 'Response headers:')
  lines.push(...formatHeaders(entry.responseHeaders, options.includeSensitiveHeaders))
  if (options.body !== undefined) {
    const sensitive = !options.includeSensitiveBody && isSensitiveBodyUrl(entry.url)
    lines.push('', 'Response body:')
    lines.push(sensitive ? REDACTED : options.body)
    if (options.bodyTruncated) lines.push('(body truncated)')
  }
  return lines.join('\n')
}

/** Render one body fetch. */
export function renderBody(
  entry: NetworkEntry,
  kind: 'request' | 'response',
  body: string,
  options: { truncated: boolean; json: boolean; redacted: boolean },
): string {
  const lines = [`[${entry.index}] ${kind} body of ${entry.method} ${entry.url}`]
  if (options.redacted) {
    lines.push('', REDACTED, 'This request looks authentication-related; pass includeSensitiveBody=true to read it.')
    return lines.join('\n')
  }
  lines.push(`Format: ${options.json ? 'JSON (pretty-printed)' : 'text'}${options.truncated ? ' · truncated' : ''}`)
  lines.push('', body)
  if (options.truncated) lines.push('', '(body truncated to the configured budget)')
  return lines.join('\n')
}

/** Levels are exposed so the tool layer can validate its own filter input. */
export function isConsoleLevel(value: string): value is ConsoleLevel {
  return value === 'log' || value === 'info' || value === 'warning' || value === 'error' || value === 'exception'
}

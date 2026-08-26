/**
 * Downloads driven by the extension rather than by the page.
 *
 * A page that starts several downloads trips Chrome's "allow multiple
 * downloads?" gate, and a click-driven download gives the model no id, no
 * progress, and no filename control. `chrome.downloads` has none of those
 * problems: the EXTENSION is the initiator, so the per-site multi-download
 * prompt never applies, each item comes back with a stable id, and the target
 * path is ours to choose. Cookies still come from the browser's own jar, so a
 * login-gated file downloads exactly as it would by hand.
 *
 * Chrome APIs are injected so the whole surface is testable without a browser.
 *
 * @module
 */

import { MAX_BATCH_DOWNLOADS } from '@yuxianglin/dsh-bridge-browser/src/protocol.ts'
import { wrapDerivedReport } from '../security/untrusted.ts'

/** One download the model asked for. */
export interface DownloadRequest {
  urls: string[]
  /** Filename for a single download, or the base name for a batch. */
  filename?: string
  /** Folder under the browser's download directory. */
  subdirectory?: string
  /** What to do when the target name already exists. */
  conflict: 'uniquify' | 'overwrite' | 'prompt'
  /** Ask the browser where to put it (one file only). */
  saveAs: boolean
}

/** A management operation on existing downloads. */
export interface DownloadsRequest {
  action: 'list' | 'cancel' | 'pause' | 'resume' | 'show'
  id?: number
  /** How many recent items `list` returns. */
  limit?: number
}

/** Chrome seams this module drives. */
export interface DownloadsDeps {
  start(options: chrome.downloads.DownloadOptions): Promise<number>
  search(query: chrome.downloads.DownloadQuery): Promise<chrome.downloads.DownloadItem[]>
  cancel(id: number): Promise<void>
  pause(id: number): Promise<void>
  resume(id: number): Promise<void>
  show(id: number): void
}

/** A refusal the model should read and act on. */
export class DownloadError extends Error {
  constructor(readonly code: 'bad-args' | 'action-failed', message: string) {
    super(message)
    this.name = 'DownloadError'
  }
}

/** Default and maximum number of items `list` reports. */
const DEFAULT_LIST_LIMIT = 10
const MAX_LIST_LIMIT = 50

/**
 * Reject a path that would escape the download directory or name a drive.
 *
 * `chrome.downloads` already refuses an absolute or `..` path, but it does so
 * with a generic error; catching it here lets the model read what was wrong.
 */
function assertRelativePath(label: string, value: string): void {
  if (value.startsWith('/') || value.startsWith('\\') || /^[a-zA-Z]:/.test(value)) {
    throw new DownloadError('bad-args', `${label} must be a relative path inside the download folder; received "${value}".`)
  }
  if (value.split(/[\\/]/).includes('..')) {
    throw new DownloadError('bad-args', `${label} must not contain "..".`)
  }
}

/**
 * Parse the model's arguments into a download request.
 * @param args - raw tool arguments.
 * @returns the validated request.
 * @throws DownloadError for an unusable shape.
 */
export function parseDownloadRequest(args: Record<string, unknown>): DownloadRequest {
  const single = typeof args.url === 'string' ? [args.url] : []
  const many = Array.isArray(args.urls) ? args.urls.filter((value): value is string => typeof value === 'string') : []
  const urls = [...single, ...many]
  if (urls.length === 0) throw new DownloadError('bad-args', 'Provide url, or urls for a batch.')
  if (urls.length > MAX_BATCH_DOWNLOADS) {
    throw new DownloadError('bad-args', `At most ${MAX_BATCH_DOWNLOADS} downloads can be started in one call; received ${urls.length}.`)
  }
  const normalized = urls.map((url) => {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new DownloadError('bad-args', `url is not valid: ${url}`)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new DownloadError('bad-args', `Only http and https downloads are supported; received ${parsed.protocol}.`)
    }
    return parsed.href
  })

  const filename = typeof args.filename === 'string' && args.filename !== '' ? args.filename : undefined
  if (filename !== undefined) assertRelativePath('filename', filename)
  const subdirectory = typeof args.subdirectory === 'string' && args.subdirectory !== '' ? args.subdirectory : undefined
  if (subdirectory !== undefined) assertRelativePath('subdirectory', subdirectory)
  const conflict = args.conflict === 'overwrite' || args.conflict === 'prompt' ? args.conflict : 'uniquify'
  const saveAs = args.saveAs === true
  if (saveAs && normalized.length > 1) {
    throw new DownloadError('bad-args', 'saveAs asks the user for one location, so it cannot be combined with a batch.')
  }
  return {
    urls: normalized,
    ...(filename === undefined ? {} : { filename }),
    ...(subdirectory === undefined ? {} : { subdirectory }),
    conflict,
    saveAs,
  }
}

/** Parse a management request. */
export function parseDownloadsRequest(args: Record<string, unknown>): DownloadsRequest {
  const action = args.action
  if (action !== 'list' && action !== 'cancel' && action !== 'pause' && action !== 'resume' && action !== 'show') {
    throw new DownloadError('bad-args', 'action must be list, cancel, pause, resume, or show.')
  }
  if (action !== 'list') {
    if (typeof args.id !== 'number' || !Number.isInteger(args.id) || args.id < 0) {
      throw new DownloadError('bad-args', `${action} requires the numeric id reported by the list action.`)
    }
    return { action, id: args.id }
  }
  const limit = typeof args.limit === 'number' && Number.isInteger(args.limit) && args.limit > 0
    ? Math.min(args.limit, MAX_LIST_LIMIT)
    : DEFAULT_LIST_LIMIT
  return { action, limit }
}

/**
 * The name one URL is saved as: the caller's filename for a single download,
 * and the caller's name with an index appended for a batch (so a batch cannot
 * silently collapse into one uniquified file per source name).
 */
function targetFilename(request: DownloadRequest, url: string, position: number): string | undefined {
  const base = request.filename
  if (base === undefined) {
    return request.subdirectory === undefined ? undefined : `${request.subdirectory}/${basenameFromUrl(url)}`
  }
  const named = request.urls.length === 1 ? base : numberedName(base, position)
  return request.subdirectory === undefined ? named : `${request.subdirectory}/${named}`
}

/** `report.pdf` + 2 → `report-2.pdf`. */
function numberedName(name: string, position: number): string {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return `${name}-${position}`
  return `${name.slice(0, dot)}-${position}${name.slice(dot)}`
}

/** Last path segment of a URL, or a generic name when it has none. */
export function basenameFromUrl(url: string): string {
  try {
    const path = new URL(url).pathname
    const last = path.split('/').filter((part) => part !== '').pop()
    return last === undefined || last === '' ? 'download' : decodeURIComponent(last)
  } catch {
    return 'download'
  }
}

/**
 * Start one or more downloads.
 *
 * Filenames are influenced by the remote server (`Content-Disposition`) and the
 * report echoes them, so it is enclosed in the untrusted-content boundary.
 *
 * @param request - the validated request.
 * @param deps - Chrome seams.
 * @returns model-facing text listing each started id, inside the trust boundary.
 */
export async function runDownload(request: DownloadRequest, deps: DownloadsDeps): Promise<string> {
  return wrapDerivedReport(await startDownloads(request, deps))
}

async function startDownloads(request: DownloadRequest, deps: DownloadsDeps): Promise<string> {
  const lines: string[] = []
  const started: number[] = []
  for (const [position, url] of request.urls.entries()) {
    const filename = targetFilename(request, url, position + 1)
    try {
      const id = await deps.start({
        url,
        conflictAction: request.conflict,
        saveAs: request.saveAs,
        ...(filename === undefined ? {} : { filename }),
      })
      started.push(id)
      lines.push(`  [id ${id}] ${filename ?? basenameFromUrl(url)} ← ${url}`)
    } catch (error: unknown) {
      lines.push(`  FAILED ${url}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (started.length === 0) {
    throw new DownloadError('action-failed', `No download could be started.\n${lines.join('\n')}`)
  }
  const header = started.length === request.urls.length
    ? `Started ${started.length} download(s):`
    : `Started ${started.length} of ${request.urls.length} download(s):`
  return [
    header,
    ...lines,
    'The extension is the initiator, so the page\'s multiple-download prompt does not apply. Use browser_downloads with action "list" to see progress.',
  ].join('\n')
}

/** Human-readable byte size. */
function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const value = bytes / 1024 ** exponent
  return `${exponent === 0 ? value : value.toFixed(1)} ${units[exponent]}`
}

/** One item's progress, as far as Chrome knows it. */
function renderItem(item: chrome.downloads.DownloadItem): string {
  const name = item.filename === '' ? basenameFromUrl(item.url) : item.filename
  const size = item.totalBytes > 0
    ? `${formatBytes(item.bytesReceived)}/${formatBytes(item.totalBytes)}`
    : formatBytes(item.bytesReceived)
  const state = item.state === 'interrupted' && item.error !== undefined ? `interrupted (${item.error})` : item.state
  const paused = item.paused === true ? ', paused' : ''
  return `  [id ${item.id}] ${state}${paused} ${size} — ${name}`
}

/**
 * Run one management operation.
 *
 * A listing carries each item's stored filename, which the remote server
 * influenced, so the report is enclosed like any other derived text.
 *
 * @param request - the validated request.
 * @param deps - Chrome seams.
 * @returns model-facing text, inside the trust boundary.
 */
export async function runDownloadsAction(request: DownloadsRequest, deps: DownloadsDeps): Promise<string> {
  return wrapDerivedReport(await manageDownloads(request, deps))
}

async function manageDownloads(request: DownloadsRequest, deps: DownloadsDeps): Promise<string> {
  if (request.action === 'list') {
    const items = await deps.search({ limit: request.limit, orderBy: ['-startTime'] })
    if (items.length === 0) return 'No downloads have been started in this browser profile.'
    return [`${items.length} most recent download(s):`, ...items.map(renderItem)].join('\n')
  }
  const id = request.id!
  const [item] = await deps.search({ id })
  if (item === undefined) {
    throw new DownloadError('action-failed', `No download with id ${id} exists. Call browser_downloads with action "list" for current ids.`)
  }
  switch (request.action) {
    case 'cancel':
      if (item.state !== 'in_progress') {
        throw new DownloadError('action-failed', `Download ${id} is already ${item.state}, so it cannot be cancelled.`)
      }
      await deps.cancel(id)
      return `Cancelled download ${id}.`
    case 'pause':
      if (item.state !== 'in_progress' || item.paused === true) {
        throw new DownloadError('action-failed', `Download ${id} is not running, so it cannot be paused.`)
      }
      await deps.pause(id)
      return `Paused download ${id}.`
    case 'resume':
      if (item.paused !== true) {
        throw new DownloadError('action-failed', `Download ${id} is not paused.`)
      }
      await deps.resume(id)
      return `Resumed download ${id}.`
    case 'show':
      deps.show(id)
      return `Opened the containing folder for download ${id} in the file manager.`
  }
}

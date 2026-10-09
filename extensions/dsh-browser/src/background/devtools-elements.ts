/**
 * Element and CSS inspection plus live debugging edits, driven over CDP.
 *
 * Every helper resolves the target element the same way: a CSS selector through
 * `DOM.querySelector` on the document root, or a `browser_snapshot` inventory
 * index through the `data-dsh-el` attribute the content script writes (evaluated
 * in the frame's own JavaScript context so iframe inventory numbers resolve too).
 *
 * The resolution layer is a small port so the presentation logic can be tested
 * against a scripted CDP client without Chrome.
 *
 * @module
 */

import type { CdpClient } from './debugger-session.ts'

/** Computed-style properties returned when the caller names none. */
export const DEFAULT_COMPUTED_PROPERTIES = [
  'display',
  'position',
  'width',
  'height',
  'margin',
  'padding',
  'color',
  'background-color',
  'font-family',
  'font-size',
  'font-weight',
  'line-height',
  'border',
  'flex-direction',
  'gap',
  'overflow',
  'opacity',
  'z-index',
  'transform',
] as const

/** Attribute names the model must never write through the debugger. */
const FORBIDDEN_ATTRIBUTES = new Set(['srcdoc'])

/** Attribute names that carry inline event handlers or resource URLs. */
const SCRIPT_ATTRIBUTES = /^on[a-z]|^(src|href|xlink:href)$/i

/** A locator: exactly one of selector/index is used. */
export interface ElementLocator {
  selector?: string
  index?: number
  frame?: number
}

/** One attribute name/value pair. */
export interface AttributeView {
  name: string
  value: string
}

/** One matched CSS rule rendered for the model. */
export interface MatchedRuleView {
  selector: string
  origin: string
  declarations: string[]
  media?: string
}

/** The element inspector's full report. */
export interface ElementView {
  identity: string
  domPath: string
  inventoryIndex?: number
  box?: { x: number; y: number; width: number; height: number }
  boxModel?: { content: string; padding: string; border: string; margin: string }
  computed: Record<string, string>
  inlineStyle: string[]
  matchedRules: MatchedRuleView[]
  attributes: AttributeView[]
  childNodeCount: number
}

/** Frame order and default-context ids observed by the CDP session. */
export interface DebuggerFrames {
  /**
   * Frames in traversal order (main frame first), matching `browser_snapshot`
   * numbering. Rebuilt when the main frame navigates.
   */
  order(): readonly string[]
  /** The page's default execution context for a frame, when one was observed. */
  defaultContext(frameId: string): number | undefined
  /** Record one `Page.frameNavigated` / `Runtime.executionContextCreated` observation. */
  observe(method: string, params: unknown): void
}

/** A `Runtime.executionContextCreated` payload. */
interface ExecutionContextPayload {
  context?: { id?: number; origin?: string; name?: string; auxData?: { frameId?: string; isDefault?: boolean } }
}

/** A `Page.frameNavigated` payload. */
interface FrameNavigatedPayload {
  frame?: { id?: string; parentId?: string; url?: string }
}

/**
 * Track the frame tree and each frame's default execution context from the CDP
 * event stream. `Page.getFrameTree` remains the source of truth for a freshly
 * attached session; this registry covers the common case without an extra
 * command and always picks the *page's own* context when one is known.
 */
export class FrameRegistry implements DebuggerFrames {
  private frames: string[] = []
  private contexts = new Map<string, number>()

  /** @returns frames in traversal order (main frame first). */
  order(): readonly string[] {
    return this.frames
  }

  /** @returns the default execution context of a frame, when observed. */
  defaultContext(frameId: string): number | undefined {
    return this.contexts.get(frameId)
  }

  /** Replace the frame order from an authoritative `Page.getFrameTree` read. */
  setTree(ids: readonly string[]): void {
    this.frames = [...ids]
  }

  /**
   * Fold one CDP event into the registry.
   * @param method - CDP event name.
   * @param params - CDP event payload.
   */
  observe(method: string, params: unknown): void {
    switch (method) {
      case 'Runtime.executionContextCreated': {
        const context = (params as ExecutionContextPayload).context
        const frameId = context?.auxData?.frameId
        if (frameId === undefined || context?.id === undefined) return
        // Page contexts report `isDefault`; extension/isolated worlds do not.
        if (context.auxData?.isDefault !== true) return
        this.contexts.set(frameId, context.id)
        break
      }
      case 'Runtime.executionContextDestroyed': {
        const id = (params as { executionContextId?: number }).executionContextId
        if (id === undefined) return
        for (const [frameId, contextId] of this.contexts) {
          if (contextId === id) this.contexts.delete(frameId)
        }
        break
      }
      case 'Runtime.executionContextsCleared':
        this.contexts.clear()
        break
      case 'Page.frameNavigated': {
        const frame = (params as FrameNavigatedPayload).frame
        if (frame?.id === undefined) return
        if (frame.parentId === undefined) {
          // A new top-level document invalidates every previous frame and index.
          this.frames = [frame.id]
          this.contexts.clear()
          break
        }
        if (!this.frames.includes(frame.id)) this.frames.push(frame.id)
        break
      }
      case 'Page.frameDetached': {
        const frameId = (params as { frameId?: string }).frameId
        if (frameId === undefined) return
        this.frames = this.frames.filter((id) => id !== frameId)
        this.contexts.delete(frameId)
        break
      }
      default:
        break
    }
  }
}

/**
 * Resolve one locator to a CDP node id.
 * @param client - the CDP session.
 * @param locator - selector or inventory index, plus an optional frame.
 * @param frames - frame registry used for index lookups outside the top frame.
 * @returns the DOM node id.
 * @throws when no element matches or the locator is incomplete.
 */
export async function resolveNodeId(
  client: CdpClient,
  locator: ElementLocator,
  frames?: DebuggerFrames,
): Promise<number> {
  if (typeof locator.selector === 'string' && locator.selector.trim() !== '') {
    const root = (await client.send('DOM.getDocument', { depth: 0 })) as { root?: { nodeId?: number } }
    const documentNodeId = root.root?.nodeId
    if (documentNodeId === undefined) throw new Error('The page document is unavailable.')
    const found = (await client.send('DOM.querySelector', { nodeId: documentNodeId, selector: locator.selector })) as { nodeId?: number }
    if (found.nodeId === undefined || found.nodeId === 0) {
      throw new Error(`No element matches the selector ${locator.selector}.`)
    }
    return found.nodeId
  }
  if (typeof locator.index === 'number' && Number.isInteger(locator.index) && locator.index > 0) {
    return resolveInventoryIndex(client, locator.index, locator.frame ?? 0, frames)
  }
  throw new Error('Provide exactly one of selector or index to identify the element.')
}

/**
 * Resolve a `browser_snapshot` inventory index through the `data-dsh-el`
 * attribute the content script writes on every inventoried element.
 */
async function resolveInventoryIndex(
  client: CdpClient,
  index: number,
  frame: number,
  frames: DebuggerFrames | undefined,
): Promise<number> {
  const contextId = await frameContextId(client, frame, frames)
  const evaluated = (await client.send('Runtime.evaluate', {
    expression: `document.querySelector('[data-dsh-el="${index}"]')`,
    ...contextId === undefined ? {} : { contextId },
    returnByValue: false,
    objectGroup: 'dsh-devtools',
    includeCommandLineAPI: false,
  })) as { result?: { objectId?: string; subtype?: string } }
  const objectId = evaluated.result?.objectId
  if (objectId === undefined || evaluated.result?.subtype === 'null') {
    throw new Error(`Inventory index ${index} no longer matches an element${frame === 0 ? '' : ` in frame ${frame}`}. Call browser_snapshot again for fresh indices.`)
  }
  try {
    const node = (await client.send('DOM.requestNode', { objectId })) as { nodeId?: number }
    if (node.nodeId === undefined) throw new Error(`Inventory index ${index} could not be resolved to a DOM node.`)
    return node.nodeId
  } finally {
    // The remote object is only an intermediate step towards the node id.
    void client.send('Runtime.releaseObject', { objectId }).catch(() => undefined)
  }
}

/** Locate the JavaScript context of one frame; the main frame needs none. */
export async function frameContextId(
  client: CdpClient,
  frame: number,
  frames: DebuggerFrames | undefined,
): Promise<number | undefined> {
  if (frame === 0) return undefined
  const known = frames?.order() ?? []
  const frameId = known[frame]
  if (frameId === undefined) {
    throw new Error(`Frame ${frame} does not exist in the current page.`)
  }
  const context = frames?.defaultContext(frameId)
  if (context !== undefined) return context
  const world = (await client.send('Page.createIsolatedWorld', {
    frameId,
    worldName: 'dsh-devtools',
    grantUniveralAccess: false,
  })) as { executionContextId?: number }
  if (world.executionContextId === undefined) throw new Error(`Frame ${frame} has no usable JavaScript context.`)
  return world.executionContextId
}

/** Frame id of one snapshot frame number, or undefined for the main frame. */
export function frameIdAt(frames: DebuggerFrames | undefined, frame: number): string | undefined {
  return frames?.order()[frame]
}

/** Refresh the frame registry from `Page.getFrameTree` (authoritative at attach). */
export async function syncFrames(client: CdpClient, frames: FrameRegistry): Promise<void> {
  const tree = (await client.send('Page.getFrameTree', {})) as { frameTree?: FrameTreeNode }
  frames.setTree(flattenFrameTree(tree.frameTree).map((frame) => frame.id ?? '').filter((id) => id !== ''))
}

interface FrameTreeNode {
  frame?: { id?: string; url?: string }
  childFrames?: FrameTreeNode[]
}

/** Depth-first frame order: main frame first, then children in document order. */
function flattenFrameTree(node: FrameTreeNode | undefined): { id?: string; url?: string }[] {
  if (node?.frame === undefined) return []
  const frames = [node.frame]
  for (const child of node.childFrames ?? []) frames.push(...flattenFrameTree(child))
  return frames
}

/** Fetch everything the element inspector reports for one node. */
export async function inspectElement(
  client: CdpClient,
  nodeId: number,
  properties?: readonly string[],
): Promise<ElementView> {
  const described = (await client.send('DOM.describeNode', { nodeId, depth: 0, pierce: false })) as { node?: DescribedNode }
  const node = described.node ?? {}
  const attributes = attributePairs(node.attributes)
  const computedResponse = (await client.send('CSS.getComputedStyleForNode', { nodeId })) as {
    computedStyle?: { name: string; value: string }[]
  }
  const computedStyles = computedResponse.computedStyle ?? []
  const requested = properties === undefined || properties.length === 0
    ? [...DEFAULT_COMPUTED_PROPERTIES]
    : properties
  const computed: Record<string, string> = {}
  for (const name of requested) {
    // A duplicate request must not add a second line to the report.
    if (name in computed) continue
    const found = computedStyles.find((entry) => entry.name.toLowerCase() === name.toLowerCase())
    computed[name] = found === undefined ? '(not set)' : found.value
  }
  const matched = await matchedRules(client, nodeId)
  const boxModel = await boxModelOf(client, nodeId)
  const inventory = attributes.find((attribute) => attribute.name === 'data-dsh-el')
  const inventoryIndex = inventory === undefined ? undefined : Number(inventory.value)
  return {
    identity: shortIdentity(node, attributes),
    domPath: await describePath(client, nodeId, described),
    ...(inventoryIndex === undefined || !Number.isInteger(inventoryIndex) ? {} : { inventoryIndex }),
    ...(boxModel === undefined ? {} : { box: boxModel.box, boxModel: boxModel.boxes }),
    computed,
    inlineStyle: matched.inline,
    matchedRules: matched.rules,
    attributes,
    childNodeCount: node.childNodeCount ?? 0,
  }
}

/** The `DOM.describeNode` subset this module reads. */
interface DescribedNode {
  nodeName?: string
  localName?: string
  attributes?: string[]
  childNodeCount?: number
  parentId?: number
}

/** Read one node description. */
async function describeNode(client: CdpClient, nodeId: number): Promise<DescribedNode> {
  const described = (await client.send('DOM.describeNode', { nodeId, depth: 0, pierce: false })) as { node?: DescribedNode }
  return described.node ?? {}
}

/** Flatten `CSS.getMatchedStylesForNode` into inline declarations and rules. */
export async function matchedRules(
  client: CdpClient,
  nodeId: number,
): Promise<{ inline: string[]; rules: MatchedRuleView[] }> {
  const response = (await client.send('CSS.getMatchedStylesForNode', { nodeId })) as {
    inlineStyle?: StylePayload
    matchedCSSRules?: MatchedRulePayload[]
    inherited?: { matchedCSSRules?: MatchedRulePayload[] }[]
  }
  const rules: MatchedRuleView[] = (response.matchedCSSRules ?? []).map((entry) => toRuleView(entry, 'author'))
  for (const inherited of response.inherited ?? []) {
    for (const entry of inherited.matchedCSSRules ?? []) rules.push(toRuleView(entry, 'inherited'))
  }
  return { inline: declarationsOf(response.inlineStyle), rules }
}

interface StylePayload {
  cssProperties?: { name: string; value: string; important?: boolean; disabled?: boolean }[]
  cssText?: string
  /** Editable sheet id; absent for inline styles Chrome does not expose as a sheet. */
  styleSheetId?: string
  /** Token range of the declaration block inside its stylesheet. */
  range?: RangePayload
}

interface MatchedRulePayload {
  rule?: {
    selectorList?: { text?: string }
    origin?: string
    media?: { text?: string }[]
    styleSheetId?: string
    style?: StylePayload
  }
  matchingSelectors?: number[]
}

function toRuleView(entry: MatchedRulePayload, origin: string): MatchedRuleView {
  const rule = entry.rule ?? {}
  const matching = entry.matchingSelectors ?? []
  const selector = matching.length === 0
    ? rule.selectorList?.text ?? '(unknown selector)'
    : matching
        .map((position) => rule.selectorList?.text?.split(',')[position]?.trim() ?? '')
        .filter((part) => part !== '')
        .join(', ')
  const media = (rule.media ?? []).map((query) => query.text ?? '').filter((text) => text !== '').join(' and ')
  return {
    selector: selector === '' ? rule.selectorList?.text ?? '(unknown selector)' : selector,
    origin: rule.origin ?? origin,
    declarations: declarationsOf(rule.style),
    ...(media === '' ? {} : { media }),
  }
}

/** Every longhand a given shorthand can expand into. */
const LONGHANDS_OF: Record<string, readonly string[]> = {
  margin: ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'],
  padding: ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'],
  gap: ['row-gap', 'column-gap'],
  overflow: ['overflow-x', 'overflow-y'],
  background: ['background-color', 'background-image', 'background-position', 'background-size', 'background-repeat', 'background-attachment'],
  border: ['border-width', 'border-style', 'border-color'],
  inset: ['top', 'right', 'bottom', 'left'],
}

/** Which shorthand family a property belongs to; longhands belong to their own. */
export function propertyFamily(name: string): string {
  const normalized = name.trim().toLowerCase()
  for (const [shorthand, longhands] of Object.entries(LONGHANDS_OF)) {
    if (normalized === shorthand || longhands.includes(normalized)) return shorthand
  }
  return normalized
}

/**
 * Canonicalize one declaration block.
 *
 * CDP reports both a shorthand and every longhand it expands into, which is
 * most of a style report's bulk. A longhand stays only when nothing in the same
 * block covers it, or when the caller explicitly edited it (dropping an edit
 * would silently discard what the user asked for).
 *
 * @param declarations - `name: value` lines in cascade order.
 * @param edited - lower-cased property names the caller supplied.
 * @returns the reduced lines, in their original order.
 */
export function canonicalizeDeclarations(
  declarations: readonly string[],
  edited: ReadonlySet<string> = new Set(),
): string[] {
  const present = new Set<string>()
  for (const declaration of declarations) {
    const separator = declaration.indexOf(':')
    if (separator < 0) continue
    present.add(declaration.slice(0, separator).trim().toLowerCase())
  }
  const covered = new Set<string>()
  for (const [shorthand, longhands] of Object.entries(LONGHANDS_OF)) {
    if (!present.has(shorthand)) continue
    for (const longhand of longhands) {
      if (!edited.has(longhand)) covered.add(longhand)
    }
  }
  return declarations.filter((declaration) => {
    const separator = declaration.indexOf(':')
    if (separator < 0) return true
    return !covered.has(declaration.slice(0, separator).trim().toLowerCase())
  })
}

/**
 * Render one CDP style payload as `name: value` lines.
 *
 * Custom properties are dropped: they are theme plumbing, not an answer about
 * this element, and a single page can put hundreds of them on `body`.
 */
export function declarationsOf(style: StylePayload | undefined): string[] {
  const seen = new Set<string>()
  const declarations: string[] = []
  for (const property of style?.cssProperties ?? []) {
    if (property.disabled === true) continue
    if (property.name.startsWith('--')) continue
    const name = property.name.trim().toLowerCase()
    if (name === '' || seen.has(name)) continue
    seen.add(name)
    declarations.push(`${property.name}: ${property.value}${property.important === true ? ' !important' : ''}`)
  }
  return canonicalizeDeclarations(declarations)
}

/** Box model in compact numeric form plus per-edge lists. */
async function boxModelOf(
  client: CdpClient,
  nodeId: number,
): Promise<{ box: { x: number; y: number; width: number; height: number }; boxes: { content: string; padding: string; border: string; margin: string } } | undefined> {
  let model: { content?: number[]; padding?: number[]; border?: number[]; margin?: number[] } | undefined
  try {
    const response = (await client.send('DOM.getBoxModel', { nodeId })) as { model?: typeof model }
    model = response.model
  } catch {
    // Elements without a layout box (display:none, detached) report no model.
    return undefined
  }
  const content = model?.content
  if (content === undefined || content.length < 8) return undefined
  const left = Math.min(content[0]!, content[6]!)
  const top = Math.min(content[1]!, content[3]!)
  const right = Math.max(content[2]!, content[4]!)
  const bottom = Math.max(content[5]!, content[7]!)
  return {
    box: { x: round(left), y: round(top), width: round(right - left), height: round(bottom - top) },
    boxes: {
      content: `${round(right - left)}×${round(bottom - top)}`,
      padding: quadToEdges(model?.padding),
      border: quadToEdges(model?.border),
      margin: quadToEdges(model?.margin),
    },
  }
}

/** Turn one CDP quad into `top right bottom left` pixel values. */
function quadToEdges(quad: number[] | undefined): string {
  if (quad === undefined || quad.length < 8) return '0px 0px 0px 0px'
  const [x1, y1, x2, , , y3, x4, y4] = quad as [number, number, number, number, number, number, number, number]
  return `${round(Math.abs(y1 - y3))}px ${round(Math.abs(x2 - x1))}px ${round(Math.abs(y4 - y1))}px ${round(Math.abs(x1 - x4))}px`
}

function round(value: number): number {
  return Math.round(value * 10) / 10
}

/** A short element identity, preferring id then the first class. */
export function shortIdentity(node: { nodeName?: string; localName?: string }, attributes: AttributeView[]): string {
  const tag = (node.localName ?? node.nodeName ?? 'node').toLowerCase()
  const id = attributes.find((attribute) => attribute.name === 'id')?.value
  if (id !== undefined && id !== '') return `${tag}#${id}`
  const firstClass = attributes.find((attribute) => attribute.name === 'class')?.value?.split(/\s+/).find((entry) => entry !== '')
  return firstClass === undefined ? tag : `${tag}.${firstClass}`
}

/** `DOM.describeNode` reports attributes as a flat name/value list. */
export function attributePairs(attributes: string[] | undefined): AttributeView[] {
  const pairs: AttributeView[] = []
  const list = attributes ?? []
  for (let index = 0; index + 1 < list.length; index += 2) {
    pairs.push({ name: list[index]!, value: list[index + 1]! })
  }
  return pairs
}

/**
 * Build a readable ancestor path for one element.
 *
 * The already-described target is reused, and the walk stops at the first
 * unordered or unknown ancestor so a deep DOM cannot turn one inspection into a
 * long chain of commands.
 */
async function describePath(
  client: CdpClient,
  nodeId: number,
  target?: { node?: DescribedNode },
): Promise<string> {
  const origin = target?.node ?? await describeNode(client, nodeId)
  const segments: string[] = [shortIdentity(origin, attributePairs(origin.attributes))]
  let current = origin
  for (let depth = 0; depth < 16; depth += 1) {
    const parentId = current.parentId
    if (parentId === undefined || parentId <= 0) break
    let parent: DescribedNode
    try {
      parent = await describeNode(client, parentId)
    } catch {
      // Some nodes (documents, shadow roots) have no describable parent.
      break
    }
    if (parent.nodeName === undefined) break
    segments.unshift(shortIdentity(parent, attributePairs(parent.attributes)))
    current = parent
  }
  return segments.join(' > ')
}

/**
 * Apply inline (element `style` attribute) declarations.
 *
 * `CSS.setStyleTexts` needs a `styleSheetId` plus the declaration block's
 * `range`, which Chrome only reports for inline styles it exposes as an editable
 * sheet (`isInline`). When that metadata is absent the edit is applied through
 * the `style` attribute, which reaches the same result without depending on CDP
 * internals.
 */
export async function setInlineStyle(
  client: CdpClient,
  nodeId: number,
  properties: readonly { name: string; value: string; important?: boolean }[],
): Promise<string[]> {
  const matched = (await client.send('CSS.getMatchedStylesForNode', { nodeId })) as { inlineStyle?: StylePayload }
  const inline = matched.inlineStyle
  const merged = mergeDeclarations(inline, properties)
  const text = merged.map((declaration) => `${declaration};`).join(' ')
  const styleSheetId = inline?.styleSheetId
  const range = inline?.range
  if (styleSheetId !== undefined && range !== undefined) {
    await client.send('CSS.setStyleTexts', {
      edits: [{ styleSheetId, range, text }],
      nodeForPropertySyntaxValidation: nodeId,
    })
    return merged
  }
  await client.send('DOM.setAttributeValue', { nodeId, name: 'style', value: inlineText(merged) })
  return merged
}

/** The `style` attribute text for a declaration list. */
function inlineText(declarations: readonly string[]): string {
  return declarations.length === 0 ? '' : `${declarations.map((declaration) => `${declaration};`).join(' ')}`
}

/**
 * Edit declarations of the first author rule that matches the element.
 *
 * The stylesheet is edited by splicing its own source text at the CSS rule
 * token ranges, so unrelated rules in the same sheet survive the write.
 */
export async function setMatchedRuleStyle(
  client: CdpClient,
  nodeId: number,
  properties: readonly { name: string; value: string; important?: boolean }[],
): Promise<{ selector: string; declarations: string[] }> {
  const response = (await client.send('CSS.getMatchedStylesForNode', { nodeId })) as {
    matchedCSSRules?: MatchedRulePayload[]
  }
  const rule = (response.matchedCSSRules ?? []).map((entry) => entry.rule).find((candidate) => candidate?.styleSheetId !== undefined)
  const styleSheetId = rule?.styleSheetId
  if (rule === undefined || styleSheetId === undefined) {
    throw new Error('This element has no matching author stylesheet rule to edit; use mode "inline" instead.')
  }
  const merged = mergeDeclarations(rule.style, properties)
  const text = await spliceStyleSheet(client, styleSheetId, rule.style?.range, merged)
  await client.send('CSS.setStyleSheetText', { styleSheetId, text })
  return { selector: rule.selectorList?.text ?? '(unknown selector)', declarations: merged }
}

/** Read the sheet and replace the rule's declaration block in place. */
async function spliceStyleSheet(
  client: CdpClient,
  styleSheetId: string,
  range: RangePayload | undefined,
  declarations: readonly string[],
): Promise<string> {
  const sheet = (await client.send('CSS.getStyleSheetText', { styleSheetId })) as { text?: string }
  const source = sheet.text ?? ''
  const block = `{ ${declarations.map((declaration) => `${declaration};`).join(' ')} }`
  if (range === undefined) return `${source}\n${block}`
  const start = offsetOf(source, range.startLine, range.startColumn)
  const end = offsetOf(source, range.endLine, range.endColumn)
  if (start === undefined || end === undefined || end < start) return `${source}\n${block}`
  return `${source.slice(0, start)}${block}${source.slice(end)}`
}

interface RangePayload {
  startLine: number
  startColumn: number
  endLine: number
  endColumn: number
}

/** Convert a line/column pair into a string offset. */
function offsetOf(text: string, line: number, column: number): number | undefined {
  let offset = 0
  let currentLine = 0
  while (currentLine < line) {
    const next = text.indexOf('\n', offset)
    if (next < 0) return undefined
    offset = next + 1
    currentLine += 1
  }
  return Math.min(text.length, offset + column)
}

/** Apply a property change set to an existing declaration list. */
export function mergeDeclarations(
  style: StylePayload | undefined,
  properties: readonly { name: string; value: string; important?: boolean }[],
): string[] {
  const edits = new Map<string, { name: string; value: string; important?: boolean }>()
  for (const property of properties) edits.set(property.name.trim().toLowerCase(), property)
  // An edit resolves its whole shorthand family: editing `margin-top` while the
  // block carries `margin` (or its other edges) drops the stale family, or the
  // shorthand would win the cascade and the edit would do nothing.
  const editedFamilies = new Set([...edits.keys()].map((name) => propertyFamily(name)))
  const declarations: string[] = []
  const seen = new Set<string>()
  for (const property of style?.cssProperties ?? []) {
    const key = property.name.trim().toLowerCase()
    if (property.disabled === true || seen.has(key)) continue
    seen.add(key)
    if (editedFamilies.has(propertyFamily(key))) continue
    declarations.push(`${property.name}: ${property.value}${property.important === true ? ' !important' : ''}`)
  }
  for (const edit of edits.values()) {
    if (edit.value === '') continue
    declarations.push(`${edit.name}: ${edit.value}${edit.important === true ? ' !important' : ''}`)
  }
  return canonicalizeDeclarations(declarations)
}

/** Attribute names that require extra scrutiny before a write. */
export function attributeRisk(name: string): 'forbidden' | 'script' | 'normal' {
  const normalized = name.trim().toLowerCase()
  if (normalized === '' || /[\s<>]/.test(normalized)) return 'forbidden'
  if (FORBIDDEN_ATTRIBUTES.has(normalized)) return 'forbidden'
  if (SCRIPT_ATTRIBUTES.test(normalized)) return 'script'
  return 'normal'
}

/** Set or remove one attribute. */
export async function setAttribute(
  client: CdpClient,
  nodeId: number,
  name: string,
  value: string | undefined,
  remove: boolean,
): Promise<void> {
  if (remove) {
    await client.send('DOM.removeAttribute', { nodeId, name })
    return
  }
  if (value === undefined) return
  await client.send('DOM.setAttributeValue', { nodeId, name, value })
}

/** Current value of one attribute, or undefined when absent. */
export async function attributeValue(client: CdpClient, nodeId: number, name: string): Promise<string | undefined> {
  const found = (await client.send('DOM.getAttributes', { nodeId })) as { attributes?: string[] }
  return attributePairs(found.attributes).find((attribute) => attribute.name.toLowerCase() === name.toLowerCase())?.value
}

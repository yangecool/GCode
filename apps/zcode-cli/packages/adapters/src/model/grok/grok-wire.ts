/**
 * G Code — Grok Responses wire 层（M0 自包含模块）。
 *
 * 移植自 grok-harness `packages/grok/model/src/{types,sse,serialize,replay}.ts`
 * （Apache-2.0；上游 grok-build Rust，Copyright SpaceXAI，rev e8563f8f / 1.0.35）。
 * 关键语义已对照原版核实：
 * - `status` 字段 output-only，回放前剥除（xai-grok-sampling-types conversation/responses.rs:212）。
 * - reasoning item 逐字节保留（含 encrypted_content）以维持 prefix-cache。
 * - 原版输出项词汇含 McpCall（responses.rs:66），grok-harness 未移植——已收录为
 *   known-but-unmapped，M1 精读 responses.rs 定映射（对账清单第 4 项）。
 * - include 默认集仅 `reasoning.encrypted_content`；原版 client.rs 某些路径同时带
 * `no_inline_citations`（是否测试代码待 M1 核实，对账清单第 5 项）。
 *
 * 本模块刻意零依赖、无相对导入：node --test 可在未安装 workspace 依赖时直接运行。
 * DSH/ZCode 消息模型到 wire item 的映射（原 serialize.ts 的 Message 相关部分）属于
 * M1 adapter 批次，不在此文件。
 */

// ---------------------------------------------------------------------------
// Wire vocabulary（移植自 types.ts）
// ---------------------------------------------------------------------------

/** One function tool accepted by the Responses endpoint. */
export interface GrokWireFunctionTool {
  type: 'function'
  name: string
  description?: string
  parameters: Record<string, unknown>
}

/** Provider-hosted web search, sent as a native Responses tool type. */
export interface GrokWireHostedWebSearchTool {
  type: 'web_search'
  filters?: {
    allowed_domains?: readonly string[]
    excluded_domains?: readonly string[]
  }
}

/** Provider-hosted X search, sent as a native Responses tool type. */
export interface GrokWireHostedXSearchTool {
  type: 'x_search'
  from_date?: string
  to_date?: string
}

/** One entry in the Responses `tools` array. */
export type GrokWireTool = GrokWireFunctionTool | GrokWireHostedWebSearchTool | GrokWireHostedXSearchTool

/** Native hosted web-search call item replayed in request history. */
export interface GrokWireWebSearchCall extends Record<string, unknown> {
  type: 'web_search_call'
}

/** Native custom-tool item used by Grok's provider-hosted X search. */
export interface GrokWireXSearchCall extends Record<string, unknown> {
  type: 'custom_tool_call'
}

/** Native provider-side code-interpreter call retained for later replay. */
export interface GrokWireCodeInterpreterCall extends Record<string, unknown> {
  type: 'code_interpreter_call'
}

/** Closed hosted output-item set supported by the pinned Grok Build transport. */
export type GrokWireHostedCall = GrokWireWebSearchCall | GrokWireXSearchCall | GrokWireCodeInterpreterCall

/** One easy message in Responses input history. */
export interface GrokWireMessage {
  type: 'message'
  role: 'system' | 'user' | 'assistant'
  content: string | GrokWireInputContent[]
}

/** One text or image part inside a native Responses input message. */
export type GrokWireInputContent =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; detail: 'auto'; image_url: string }

/** Replayed provider reasoning item, retained byte-for-byte except output-only status. */
export interface GrokWireReasoningItem extends Record<string, unknown> {
  type: 'reasoning'
}

/** Replayed assistant function call. */
export interface GrokWireFunctionCall {
  type: 'function_call'
  call_id: string
  name: string
  arguments: string
}

/** Tool output returned to one provider-issued call id. */
export interface GrokWireFunctionOutput {
  type: 'function_call_output'
  call_id: string
  output: string | GrokWireInputContent[]
}

/** One ordered item accepted in native Responses request history. */
export type GrokWireInputItem =
  | GrokWireMessage
  | GrokWireReasoningItem
  | GrokWireFunctionCall
  | GrokWireFunctionOutput
  | GrokWireHostedCall

/** Exact direct request body for `POST /responses`. */
export interface GrokWireRequest {
  model: string
  input: GrokWireInputItem[]
  stream: true
  store: false
  include: Array<'reasoning.encrypted_content' | 'no_inline_citations'>
  reasoning: {
    effort: string
    summary?: 'auto' | 'concise' | 'detailed'
  }
  tools?: GrokWireTool[]
  prompt_cache_key?: string
  temperature?: number
  max_output_tokens?: number
}

/** Provider error envelope returned for non-2xx requests. */
export interface GrokWireError {
  error?: { message?: string; type?: string; code?: string }
  message?: string
}

/** Loosely typed SSE event: event-specific fields are narrowed at use sites. */
export type GrokResponseEvent = Record<string, unknown> & { type: string }

// ---------------------------------------------------------------------------
// Wire error（对齐 grok-harness LlmError 码位，独立于宿主错误体系）
// ---------------------------------------------------------------------------

/** Wire-layer failure with a stable machine code. */
export class GrokWireError extends Error {
  readonly code: string

  constructor(message: string, code: string) {
    super(message)
    this.name = 'GrokWireError'
    this.code = code
  }
}

// ---------------------------------------------------------------------------
// H7 版本化词汇表：未知 item 的 fail-loud ↔ passthrough 策略
// ---------------------------------------------------------------------------

/** Bump when the known-item set or an item's mapped semantics change. */
export const GROK_WIRE_REGISTRY_VERSION = 1

/**
 * Item `type` values accepted in native Responses request history.
 * `mcp_call` is known-but-unmapped（原版 responses.rs:66 有 McpCall 分支；
 * grok-harness 未收录）。映射在 M1 落地前按 passthrough 处理。
 */
export const GROK_KNOWN_INPUT_ITEM_TYPES: readonly string[] = [
  'message',
  'reasoning',
  'function_call',
  'function_call_output',
  'web_search_call',
  'custom_tool_call',
  'code_interpreter_call',
  'mcp_call',
]

/** Unknown-item handling: `fail` 保留 grok-build 的 fail-loud 纪律；`passthrough` 供 4.7 前向兼容。 */
export type GrokUnknownItemPolicy = 'fail' | 'passthrough'

/** One recorded decision to forward an item outside the known vocabulary. */
export interface GrokUnknownItemDiagnostic {
  readonly itemIndex: number
  readonly itemType: string
  readonly action: 'passthrough'
}

/**
 * Admit one request-history item under the current registry policy.
 * @param item - Candidate input item.
 * @param index - Position in the history, for diagnostics.
 * @param policy - Unknown-item policy.
 * @param diagnostics - Optional sink collecting passthrough decisions.
 * @returns `'known'` for vocabulary items, `'passthrough'` when forwarded.
 * @throws GrokWireError `UNSUPPORTED_RESPONSE_ITEM` for unknown items under `fail`.
 */
export function acceptGrokInputItem(
  item: GrokWireInputItem | Record<string, unknown>,
  index: number,
  policy: GrokUnknownItemPolicy,
  diagnostics?: GrokUnknownItemDiagnostic[],
): 'known' | 'passthrough' {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) {
    throw new GrokWireError(`input item ${index} must be an object`, 'UNSUPPORTED_RESPONSE_ITEM')
  }
  const type = (item as Record<string, unknown>)['type']
  if (typeof type !== 'string' || !GROK_KNOWN_INPUT_ITEM_TYPES.includes(type)) {
    if (policy === 'fail') {
      throw new GrokWireError(
        `unsupported Responses input item type ${JSON.stringify(String(type))} at ${index}`,
        'UNSUPPORTED_RESPONSE_ITEM',
      )
    }
    diagnostics?.push({ itemIndex: index, itemType: String(type), action: 'passthrough' })
    return 'passthrough'
  }
  return 'known'
}

// ---------------------------------------------------------------------------
// SSE framing（契约移植自 sse.ts；自实现替代 eventsource-parser 依赖）
// ---------------------------------------------------------------------------

/** Native Responses stream terminator. */
export const GROK_DONE = '[DONE]'
/** Non-standard Grok detector frame reported outside the typed Responses vocabulary. */
export const GROK_DOOM_LOOP_EVENT = 'response.doom_loop_check'

/**
 * Preserve the detector payload while making an SSE-name-only frame safe for
 * the semantic translator. The upstream parser treats the SSE `event:` name
 * as authoritative: even malformed detector data is swallowed instead of
 * poisoning an otherwise valid model stream.
 */
function normalizeNamedDoomLoopFrame(data: string): string {
  let value: unknown
  try {
    value = JSON.parse(data)
  } catch {
    return JSON.stringify({ type: GROK_DOOM_LOOP_EVENT })
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return JSON.stringify({ type: GROK_DOOM_LOOP_EVENT })
  }
  return JSON.stringify({ ...value, type: GROK_DOOM_LOOP_EVENT })
}

/** Extract one spec-terminated line, or undefined while more bytes may complete it. */
function nextLine(buffered: string): { line: string; rest: string } | undefined {
  const lf = buffered.indexOf('\n')
  const cr = buffered.indexOf('\r')
  if (lf === -1 && cr === -1) return undefined
  if (cr !== -1 && (lf === -1 || cr < lf)) {
    if (cr === buffered.length - 1) return undefined
    if (buffered[cr + 1] === '\n') {
      return { line: buffered.slice(0, cr), rest: buffered.slice(cr + 2) }
    }
    return { line: buffered.slice(0, cr), rest: buffered.slice(cr + 1) }
  }
  const line = buffered.slice(0, lf)
  return { line: line.endsWith('\r') ? line.slice(0, -1) : line, rest: buffered.slice(lf + 1) }
}

/**
 * Yield every Responses data payload and normalize a clean EOF to the same
 * boundary as the optional native `[DONE]` terminator. The semantic translator
 * still requires a preceding `response.completed` or `response.incomplete`, so
 * a transport truncated before its terminal event fails closed.
 * @param stream - HTTP response body carrying SSE frames.
 * @param onComment - Optional activity callback for SSE comment frames.
 * @returns An async iterator of raw data payloads ending in `[DONE]`.
 */
export async function* parseGrokSse(
  stream: ReadableStream<Uint8Array>,
  onComment?: () => void,
): AsyncGenerator<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffered = ''
  let eventName: string | undefined
  let data: string[] | undefined
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffered += decoder.decode(value, { stream: true })
      if (buffered.charCodeAt(0) === 0xfeff) buffered = buffered.slice(1)
      for (;;) {
        const split = nextLine(buffered)
        if (split === undefined) break
        buffered = split.rest
        if (split.line === '') {
          if (data !== undefined) {
            const payload = data.join('\n')
            data = undefined
            const namedEvent = eventName
            eventName = undefined
            if (namedEvent === GROK_DOOM_LOOP_EVENT && payload !== GROK_DONE) {
              yield normalizeNamedDoomLoopFrame(payload)
            } else {
              yield payload
              if (payload === GROK_DONE) return
            }
          } else {
            eventName = undefined
          }
        } else if (split.line.startsWith(':')) {
          onComment?.()
        } else {
          const colon = split.line.indexOf(':')
          const field = colon === -1 ? split.line : split.line.slice(0, colon)
          let fieldValue = colon === -1 ? '' : split.line.slice(colon + 1)
          if (fieldValue.startsWith(' ')) fieldValue = fieldValue.slice(1)
          if (field === 'data') {
            data = data === undefined ? [fieldValue] : [...data, fieldValue]
          } else if (field === 'event') {
            eventName = fieldValue
          }
          // `id:` / `retry:` 按 WHATWG SSE 规范由消费方维护，此处不消费。
        }
      }
    }
    const trailing = buffered
    if (trailing !== '') {
      // EOF 处理无终结符的最后一行，再按空行分派一次。
      const finalSplit = { line: trailing, rest: '' }
      if (finalSplit.line.startsWith(':')) {
        onComment?.()
      } else if (finalSplit.line !== '') {
        const colon = finalSplit.line.indexOf(':')
        const field = colon === -1 ? finalSplit.line : finalSplit.line.slice(0, colon)
        let fieldValue = colon === -1 ? '' : finalSplit.line.slice(colon + 1)
        if (fieldValue.startsWith(' ')) fieldValue = fieldValue.slice(1)
        if (field === 'data') {
          data = data === undefined ? [fieldValue] : [...data, fieldValue]
        } else if (field === 'event') {
          eventName = fieldValue
        }
      }
    }
    if (data !== undefined) {
      const payload = data.join('\n')
      if (eventName === GROK_DOOM_LOOP_EVENT && payload !== GROK_DONE) {
        yield normalizeNamedDoomLoopFrame(payload)
      } else {
        yield payload
        if (payload === GROK_DONE) return
      }
    }
  } finally {
    reader.releaseLock()
  }
  yield GROK_DONE
}

// ---------------------------------------------------------------------------
// Lossless encrypted-reasoning replay（移植自 replay.ts；宿主消息边界改为最小结构）
// ---------------------------------------------------------------------------

/** Replay metadata aligned one-to-one with durable assistant content blocks. */
export type GrokReplayBlock =
  | { type: 'text'; hostedItem?: GrokWireHostedCall }
  | { type: 'reasoning'; item: GrokWireReasoningItem }
  | { type: 'tool-call' }

/** Adapter-private state attached to one completed assistant turn. */
export interface GrokReplayState {
  kind: 'grok-build-responses'
  version: 1
  blocks: GrokReplayBlock[]
  responseId?: string
}

function invalid(message: string): never {
  throw new GrokWireError(`invalid grok-build replay state: ${message}`, 'INVALID_REPLAY_STATE')
}

function hostedCallItem(value: unknown, index: number): GrokWireHostedCall {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalid(`text block ${index} hostedItem must be an object`)
  }
  const item = value as Record<string, unknown>
  if (item['type'] !== 'web_search_call'
    && item['type'] !== 'custom_tool_call'
    && item['type'] !== 'code_interpreter_call'
    && item['type'] !== 'mcp_call') {
    return invalid(`text block ${index} hostedItem type is not a supported hosted call`)
  }
  const { status: _status, ...inputItem } = item
  return structuredClone(inputItem) as GrokWireHostedCall
}

function reasoningItem(value: unknown, index: number): GrokWireReasoningItem {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalid(`reasoning block ${index} item must be an object`)
  }
  const item = value as Record<string, unknown>
  if (item['type'] !== 'reasoning') return invalid(`reasoning block ${index} has a non-reasoning item`)
  // `status` is response-only; Rust grok-build removes it before replay
  // （conversation/responses.rs:212 "`status` is output-only and rejected on input"）。
  const { status: _status, ...inputItem } = item
  return structuredClone(inputItem) as GrokWireReasoningItem
}

/** 调用方提供的最小宿主消息形状（GCode adapter 批次接入 ZCode 会话类型）。 */
export interface GrokReplaySource {
  readonly content: readonly { readonly type: string }[]
  readonly replayState?: unknown
}

/**
 * Validate adapter replay state against the durable block sequence.
 * @param source - Completed assistant turn whose private state may contain Grok replay data.
 * @returns Validated replay state, or undefined for absent state.
 * @throws GrokWireError `INVALID_REPLAY_STATE` for structurally inconsistent state.
 */
export function readGrokReplayState(source: GrokReplaySource): GrokReplayState | undefined {
  if (source.replayState === undefined) return undefined
  const raw = source.replayState
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return invalid('expected an object')
  const envelope = raw as Record<string, unknown>
  const candidate = envelope['kind'] === 'grok-build-responses' ? envelope : envelope['response']
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    return invalid('response metadata must be an object')
  }
  const state = candidate as Record<string, unknown>
  if (state['kind'] !== 'grok-build-responses') return undefined
  if (state['version'] !== 1) return invalid(`unsupported version ${String(state['version'])}`)
  if (!Array.isArray(state['blocks'])) return invalid('blocks must be an array')
  if (state['blocks'].length !== source.content.length) {
    return invalid('block count does not match assistant content')
  }
  if (state['responseId'] !== undefined && typeof state['responseId'] !== 'string') {
    return invalid('responseId must be a string')
  }
  const blocks = state['blocks'].map((rawBlock, index): GrokReplayBlock => {
    if (typeof rawBlock !== 'object' || rawBlock === null || Array.isArray(rawBlock)) {
      return invalid(`block ${index} must be an object`)
    }
    const block = rawBlock as Record<string, unknown>
    const durable = source.content[index]
    if (durable === undefined || block['type'] !== durable.type) {
      return invalid(`block ${index} does not match assistant content`)
    }
    if (block['type'] === 'reasoning') return { type: 'reasoning', item: reasoningItem(block['item'], index) }
    if (block['type'] === 'text') {
      return block['hostedItem'] === undefined
        ? { type: 'text' }
        : { type: 'text', hostedItem: hostedCallItem(block['hostedItem'], index) }
    }
    if (block['type'] === 'tool-call') return { type: 'tool-call' }
    return invalid(`block ${index} has an unsupported type`)
  })
  return {
    kind: 'grok-build-responses',
    version: 1,
    blocks,
    ...state['responseId'] === undefined ? {} : { responseId: state['responseId'] },
  }
}

/**
 * Build adapter replay state from finalized output blocks.
 * @param blocks - Metadata aligned with the durable output blocks.
 * @param responseId - Optional terminal provider response id.
 * @returns A detached replay-state record safe to persist with the assistant message.
 */
export function grokReplayState(blocks: GrokReplayBlock[], responseId?: string): GrokReplayState {
  return {
    kind: 'grok-build-responses',
    version: 1,
    blocks: structuredClone(blocks),
    ...responseId === undefined ? {} : { responseId },
  }
}

// ---------------------------------------------------------------------------
// Hosted tool 校验（移植自 serialize.ts 的纯 wire 部分）
// ---------------------------------------------------------------------------

/** One hosted tool the deployment may send on the Responses `tools` array. */
export interface GrokHostedToolSpec {
  /** Responses tool type / colliding function name, for example `web_search`. */
  readonly wireName: string
  /** Fully validated raw hosted entry supplied by the owner resolver. */
  readonly entry?: Record<string, unknown>
}

function invalidHostedEntry(wireName: string): GrokWireError {
  return new GrokWireError(
    `grok wire hosted tool ${JSON.stringify(wireName)} has an invalid wire entry`,
    'UNSUPPORTED_TOOL',
  )
}

function hostedDomains(value: unknown, wireName: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw invalidHostedEntry(wireName)
  const domains: unknown[] = value
  if (domains.length === 0 || domains.length > 5
    || domains.some(domain => typeof domain !== 'string' || domain.length === 0)) {
    throw invalidHostedEntry(wireName)
  }
  return domains.map((domain) => {
    if (typeof domain !== 'string') throw invalidHostedEntry(wireName)
    return domain
  })
}

function hostedDate(value: unknown, wireName: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw invalidHostedEntry(wireName)
  }
  const date = new Date(`${value}T00:00:00.000Z`)
  if (!Number.isFinite(date.valueOf()) || date.toISOString().slice(0, 10) !== value) {
    throw invalidHostedEntry(wireName)
  }
  return value
}

/**
 * Validate one hosted tool entry into its exact wire form.
 * @param spec - Hosted tool wire name plus optional raw entry from the owner resolver.
 * @returns The validated native Responses tool entry.
 * @throws GrokWireError `UNSUPPORTED_TOOL` / `UNSUPPORTED_HOSTED_TOOL` for invalid entries.
 */
export function hostedWireTool(spec: GrokHostedToolSpec): GrokWireHostedWebSearchTool | GrokWireHostedXSearchTool {
  const entry = spec.entry ?? { type: spec.wireName }
  if (spec.wireName === 'web_search' && entry['type'] === 'web_search') {
    const keys = Object.keys(entry)
    if (keys.some(key => key !== 'type' && key !== 'filters')) throw invalidHostedEntry(spec.wireName)
    const filters = entry['filters']
    if (filters === undefined) return { type: 'web_search' }
    if (typeof filters !== 'object' || filters === null || Array.isArray(filters)) {
      throw invalidHostedEntry(spec.wireName)
    }
    const record = filters as Record<string, unknown>
    if (Object.keys(record).some(key => key !== 'allowed_domains' && key !== 'excluded_domains')) {
      throw invalidHostedEntry(spec.wireName)
    }
    const allowed = hostedDomains(record['allowed_domains'], spec.wireName)
    const excluded = hostedDomains(record['excluded_domains'], spec.wireName)
    if (allowed !== undefined && excluded !== undefined) throw invalidHostedEntry(spec.wireName)
    return {
      type: 'web_search',
      ...allowed === undefined && excluded === undefined ? {} : {
        filters: {
          ...allowed === undefined ? {} : { allowed_domains: allowed },
          ...excluded === undefined ? {} : { excluded_domains: excluded },
        },
      },
    }
  }
  if (spec.wireName === 'x_search' && entry['type'] === 'x_search') {
    if (Object.keys(entry).some(key => key !== 'type' && key !== 'from_date' && key !== 'to_date')) {
      throw invalidHostedEntry(spec.wireName)
    }
    const fromDate = hostedDate(entry['from_date'], spec.wireName)
    const toDate = hostedDate(entry['to_date'], spec.wireName)
    if (fromDate !== undefined && toDate !== undefined && fromDate > toDate) {
      throw invalidHostedEntry(spec.wireName)
    }
    return {
      type: 'x_search',
      ...fromDate === undefined ? {} : { from_date: fromDate },
      ...toDate === undefined ? {} : { to_date: toDate },
    }
  }
  if (spec.wireName === 'web_search' || spec.wireName === 'x_search') {
    throw new GrokWireError(
      `grok wire hosted tool ${JSON.stringify(spec.wireName)} has a mismatched wire entry`,
      'UNSUPPORTED_TOOL',
    )
  }
  throw new GrokWireError(
    `grok wire does not serialize hosted tool "${spec.wireName}"`,
    'UNSUPPORTED_HOSTED_TOOL',
  )
}

// ---------------------------------------------------------------------------
// Reasoning effort（H8 开放枚举：目录驱动的 known 集，默认仍 fail-loud）
// ---------------------------------------------------------------------------

/** Reasoning effort spellings accepted by the native Grok Responses request（原版封闭集）. */
export type GrokReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh'

/** 原版 ReasoningEffort 封闭集；4.7 新档位经模型目录扩展传入而非改代码。 */
export const GROK_REASONING_EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh']

/**
 * Resolve and validate the model-visible reasoning effort.
 * @param requested - Per-request effort, when supplied by the caller.
 * @param fallback - Route effort used when the request omits one.
 * @param knownEfforts - Catalog-driven admissible set（H8 接缝）.
 * @returns A native Grok reasoning effort spelling.
 * @throws GrokWireError `UNSUPPORTED_REASONING_EFFORT` outside the admissible set.
 */
export function resolveGrokReasoningEffort(
  requested: unknown,
  fallback: GrokReasoningEffort,
  knownEfforts: readonly string[] = GROK_REASONING_EFFORTS,
): string {
  const value = requested === undefined ? fallback : String(requested)
  if (!knownEfforts.includes(value)) {
    throw new GrokWireError(
      `grok does not support reasoning effort "${value}"`,
      'UNSUPPORTED_REASONING_EFFORT',
    )
  }
  return value
}

// ---------------------------------------------------------------------------
// 请求体组装（纯数据；DSH/ZCode 消息映射属 M1 adapter 批次）
// ---------------------------------------------------------------------------

/** Per-model reasoning summary mode; `none` omits the field. */
export type GrokReasoningSummary = 'none' | 'auto' | 'concise' | 'detailed'

/** Inputs to one native Responses request body. */
export interface GrokRequestBodyInput {
  readonly model: string
  readonly input: readonly GrokWireInputItem[]
  readonly effort: string
  readonly summary?: GrokReasoningSummary
  readonly tools?: readonly GrokWireTool[]
  readonly promptCacheKey?: string
  readonly temperature?: number
  readonly maxOutputTokens?: number
  /** 默认仅 `reasoning.encrypted_content`；对账清单第 5 项定夺后可带 `no_inline_citations`。 */
  readonly include?: readonly ('reasoning.encrypted_content' | 'no_inline_citations')[]
}

/**
 * Build one native Responses body without any SDK defaults or fingerprints.
 * @param input - Validated request ingredients.
 * @returns The exact JSON body sent to the Grok Responses endpoint.
 */
export function buildGrokResponsesRequestBody(input: GrokRequestBodyInput): GrokWireRequest {
  return {
    model: input.model,
    input: [...input.input],
    stream: true,
    store: false,
    include: [...(input.include ?? ['reasoning.encrypted_content'])],
    reasoning: {
      effort: input.effort,
      ...input.summary === undefined || input.summary === 'none' ? {} : { summary: input.summary },
    },
    ...input.tools === undefined || input.tools.length === 0 ? {} : { tools: [...input.tools] },
    ...input.promptCacheKey === undefined ? {} : { prompt_cache_key: input.promptCacheKey },
    ...input.temperature === undefined ? {} : { temperature: input.temperature },
    ...input.maxOutputTokens === undefined ? {} : { max_output_tokens: input.maxOutputTokens },
  }
}

/**
 * Sticky-routing cache key for one Responses body.
 * Auxiliary calls（标题、权限旁路）不复用主会话的 routing slot；压缩回放
 * system/tools/history 时保留父 key（语义同 grok-harness serialize.ts）。
 * @param sessionId - Durable session id, when the caller has one.
 * @param purpose - Call purpose marker for auxiliary requests.
 * @returns The session id, or undefined when the body must not share the slot.
 */
export function grokPromptCacheKey(sessionId?: string, purpose?: string): string | undefined {
  if (sessionId === undefined) return undefined
  if (purpose === 'session-title' || purpose === 'permission-auto') return undefined
  return sessionId
}

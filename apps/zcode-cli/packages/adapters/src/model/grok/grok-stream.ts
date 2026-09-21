/**
 * G Code — Grok Responses SSE 事件 → 模型流事件语义翻译器（M0 第二批）。
 *
 * 移植自 grok-harness `packages/grok/model/src/stream.ts`（Apache-2.0；上游
 * grok-build Rust rev a28ee2b2 / 1.0.35），适配为 ZCode `ModelStreamEvent` 的
 * 结构形状（id 制 text/reasoning/tool_input 事件 + finish 携 usage 与
 * providerMetadata）。replay 状态经 providerMetadata 传递 —— H5 双表示：
 * 展示层为 ZCode 事件/块，规范重放态是 Responses items。
 *
 * 保留的原版语义：槽位按 output_index 排序（连续前缀直通，乱序暂存）；终态
 * 对账以 terminal response.output 为准（流式 delta 只作前缀延展）；工具参数
 * 批次 all-or-nothing（CompleteToolCalls 默认，参数非法的 incomplete 整批降级
 * 为 max-tokens 停止）；doom-loop 恢复预算 reasoning 8KiB / text 4KiB，截断
 * 标记计在预算外；max-tokens 终态的持久 replay 剔除 tool-call 块；completed
 * 无可见产出 fail-loud（EMPTY_RESPONSE）。
 *
 * 债务说明：本模块相对导入用 `.ts` 后缀（node 原生 TS 剥离可直接运行测试）；
 * M1 接入 tsc 构建时统一改 `.js`（机械替换），已记入施工图执行记录。
 */

import {
  GROK_DONE,
  GROK_DOOM_LOOP_EVENT,
  GrokWireError,
  grokReplayState,
} from './grok-wire.ts'
import type { GrokReplayBlock, GrokWireInputItem } from './grok-wire.ts'

type JsonObject = Record<string, unknown>
type SlotKind = 'text' | 'reasoning' | 'tool-call'

/** 结构形状对齐 ZCode `ModelUsage`（contracts/src/model/index.ts:499）。 */
export interface GrokUsage {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

/** 结构形状对齐 ZCode `ModelToolCall`（contracts/src/model/index.ts:322）。 */
export interface GrokToolCall {
  id: string
  name: string
  input: unknown
  providerExecuted?: boolean
}

/** 结构形状对齐 ZCode `ModelStreamEvent`（contracts/src/model/index.ts:715）的 GCode 子集。 */
export type GrokStreamEvent =
  | { type: 'start' }
  | { type: 'text_start'; id: string }
  | { type: 'text_delta'; id?: string; text: string }
  | { type: 'text_end'; id: string }
  | { type: 'reasoning_start'; id: string; providerMetadata?: Record<string, unknown> }
  | { type: 'reasoning_delta'; id?: string; text: string }
  | { type: 'reasoning_end'; id: string; providerMetadata?: Record<string, unknown> }
  | { type: 'tool_input_start'; id: string; toolName: string }
  | { type: 'tool_input_delta'; id: string; delta: string }
  | { type: 'tool_input_end'; id: string }
  | { type: 'tool_call'; toolCall: GrokToolCall }
  | {
      type: 'finish'
      finishReason: 'stop' | 'tool-calls' | 'content-filter' | 'length'
      usage?: GrokUsage
      providerMetadata?: Record<string, unknown>
    }

interface OutputSlot {
  readonly index: number
  readonly kind: SlotKind
  started: boolean
  pending: GrokStreamEvent[]
  text: string
  id: string
  name: string
  arguments: string
  item?: JsonObject
}

interface TerminalResponse {
  readonly eventType: 'response.completed' | 'response.incomplete'
  readonly response: JsonObject
}

/** One detected failed attempt handed to the Grok recovery owner. */
export interface GrokDoomLoopDetection {
  /** Deduplicated raw detector labels, including warn-only signals. */
  readonly triggers: readonly string[]
  /** Replay-safe failed response items; empty when any tool call vetoed replay. */
  readonly recoveryItems: readonly GrokWireInputItem[]
}

/** Per-attempt detector controls resolved by the Grok loop service. */
export interface GrokDoomLoopStreamControl {
  /** Abort on a confident thinking-tail signal; false keeps collecting but accepts the response. */
  readonly abort: boolean
  /** Largest `tail_repetition` threshold considered confident. */
  readonly maxThreshold: number
  /** Stage one failed response before the request-error waterfall decides whether to retry. */
  readonly onDetected?: (detection: GrokDoomLoopDetection) => void
  /** Observe a confident response accepted after the independent retry budget. */
  readonly onAccepted?: (triggers: readonly string[]) => void
}

/** Optional non-standard stream features enabled for one main turn attempt. */
export interface GrokResponseStreamOptions {
  /** Whether this attempt can safely recover an invalid-image stream error by stripping images. */
  readonly requestHasImages?: boolean
  readonly doomLoop?: GrokDoomLoopStreamControl
}

const RECOVERY_REASONING_BYTES = 8 * 1024
const RECOVERY_TEXT_BYTES = 4 * 1024
const RECOVERY_TRUNCATION = ' […truncated]'
const INCOMPLETE_CONTENT_FILTER = 'content_filter'
const INCOMPLETE_MAX_OUTPUT_TOKENS = 'max_output_tokens'
const INCOMPLETE_MAX_PROMPT_TOKENS = 'max_prompt_tokens'

class RecoveryBudget {
  private used = 0
  private spent = false
  private readonly cap: number

  constructor(cap: number) {
    this.cap = cap
  }

  fit(value: string): string {
    if (this.spent || value.length === 0) return ''
    const bytes = Buffer.byteLength(value)
    const remaining = Math.max(0, this.cap - this.used)
    if (bytes <= remaining) {
      this.used += bytes
      return value
    }
    this.spent = true
    if (remaining === 0) return ''
    let end = Math.min(value.length, remaining)
    while (end > 0 && Buffer.byteLength(value.slice(0, end)) > remaining) end -= 1
    const prefix = value.slice(0, end)
    if (prefix.length === 0) return ''
    const fitted = `${prefix}${RECOVERY_TRUNCATION}`
    // The marker describes the cut and deliberately sits outside the source
    // byte budget, matching Grok Build's RecoveryBudget::append contract.
    this.used += Buffer.byteLength(prefix)
    return fitted
  }

  chargeOpaque(value: string): boolean {
    if (this.spent) return false
    const bytes = Buffer.byteLength(value)
    if (bytes > this.cap - this.used) return false
    this.used += bytes
    return true
  }
}

function object(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : undefined
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

function hasOwn(value: JsonObject | undefined, key: string): boolean {
  return value !== undefined && Object.prototype.hasOwnProperty.call(value, key)
}

function triggerStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string')
}

function doomLoopTriggers(container: JsonObject | undefined): string[] {
  return triggerStrings(object(container?.['doom_loop_check'])?.['triggers'])
}

function confidentTriggers(triggers: readonly string[], maxThreshold: number): string[] {
  return triggers.filter((trigger) => {
    const match = /^tail_repetition:(\d+)@thinking$/u.exec(trigger)
    if (match === null) return false
    const threshold = Number(match[1])
    return Number.isSafeInteger(threshold) && threshold <= maxThreshold
  })
}

function fitReasoningItem(item: JsonObject, budget: RecoveryBudget): GrokWireInputItem | undefined {
  const clone = structuredClone(item)
  delete clone['status']
  const fitParts = (key: 'summary' | 'content'): void => {
    const raw = clone[key]
    if (!Array.isArray(raw)) return
    clone[key] = raw.flatMap((entry) => {
      const part = object(entry)
      if (part === undefined) return []
      const text = string(part['text'])
      if (text === undefined) return [part]
      const fitted = budget.fit(text)
      return fitted.length === 0 ? [] : [{ ...part, text: fitted }]
    })
  }
  fitParts('content')
  fitParts('summary')
  const encrypted = string(clone['encrypted_content'])
  if (encrypted !== undefined && !budget.chargeOpaque(encrypted)) delete clone['encrypted_content']
  const hasText = (Array.isArray(clone['content']) && clone['content'].length > 0)
    || (Array.isArray(clone['summary']) && clone['summary'].length > 0)
  if (!hasText && clone['encrypted_content'] === undefined) return undefined
  return clone as GrokWireInputItem
}

function recoveryFromOutput(output: readonly unknown[]): GrokWireInputItem[] {
  if (output.some((raw) => {
    const type = string(object(raw)?.['type'])
    return type !== 'reasoning' && type !== 'message'
  })) return []
  const reasoningBudget = new RecoveryBudget(RECOVERY_REASONING_BYTES)
  const textBudget = new RecoveryBudget(RECOVERY_TEXT_BYTES)
  const items: GrokWireInputItem[] = []
  for (const raw of output) {
    const item = object(raw)
    if (item === undefined) continue
    if (item['type'] === 'reasoning') {
      const fitted = fitReasoningItem(item, reasoningBudget)
      if (fitted !== undefined) items.push(fitted)
      continue
    }
    const text = textBudget.fit(messageText(item))
    if (text.length > 0) items.push({ type: 'message', role: 'assistant', content: text })
  }
  return items
}

/** Whether a wire reasoning item already carries text in content or summary. */
function reasoningItemHasText(item: JsonObject): boolean {
  for (const key of ['content', 'summary'] as const) {
    const raw = item[key]
    if (!Array.isArray(raw)) continue
    for (const entry of raw) {
      const text = string(object(entry)?.['text'])
      if (text !== undefined && text.length > 0) return true
    }
  }
  return false
}

function recoveryFromSlots(slots: ReadonlyMap<number, OutputSlot>): GrokWireInputItem[] {
  const ordered = [...slots.values()].sort((left, right) => left.index - right.index)
  if (ordered.some((slot) => {
    if (slot.kind === 'tool-call') return true
    const type = string(slot.item?.['type'])
    return type !== undefined && type !== 'reasoning' && type !== 'message'
  })) return []
  const reasoningBudget = new RecoveryBudget(RECOVERY_REASONING_BYTES)
  const textBudget = new RecoveryBudget(RECOVERY_TEXT_BYTES)
  const items: GrokWireInputItem[] = []
  for (const slot of ordered) {
    if (slot.kind === 'reasoning') {
      const wireItem = slot.item?.['type'] === 'reasoning' ? slot.item : undefined
      // A doom abort leaves the wire item at its sparse `added` form; the deltas
      // it never finalized are the only content the retry can replay (Rust
      // `fit_reasoning` fills empty content from the streamed text the same way).
      const source: JsonObject = wireItem === undefined
        ? {
          type: 'reasoning',
          id: slot.id || `doom-loop-recovery-${slot.index}`,
          content: slot.text.length === 0 ? [] : [{ type: 'reasoning_text', text: slot.text }],
          summary: [],
        }
        : slot.text.length > 0 && !reasoningItemHasText(wireItem)
          ? { ...wireItem, content: [{ type: 'reasoning_text', text: slot.text }] }
          : wireItem
      const fitted = fitReasoningItem(source, reasoningBudget)
      if (fitted !== undefined) items.push(fitted)
    } else {
      const text = textBudget.fit(slot.item === undefined ? slot.text : messageText(slot.item) || slot.text)
      if (text.length > 0) items.push({ type: 'message', role: 'assistant', content: text })
    }
  }
  return items
}

/**
 * Convert cumulative Responses usage into disjoint counters（形状同 ZCode ModelUsage）。
 * @param response - Terminal provider response containing optional usage data.
 * @returns Disjoint token counters, or undefined when the provider omitted usage.
 */
export function mapGrokUsage(response: JsonObject): GrokUsage | undefined {
  const usage = object(response['usage'])
  if (usage === undefined) return undefined
  const inputDetails = object(usage['input_tokens_details'])
  const outputDetails = object(usage['output_tokens_details'])
  const inputTotal = count(usage['input_tokens'])
  const cacheRead = count(inputDetails?.['cached_tokens'])
  const cacheWrite = count(inputDetails?.['cache_write_tokens'] ?? inputDetails?.['cache_creation_tokens'])
  const reasoning = count(outputDetails?.['reasoning_tokens'])
  return {
    inputTokens: Math.max(0, inputTotal - cacheRead - cacheWrite),
    outputTokens: count(usage['output_tokens']),
    ...hasOwn(inputDetails, 'cached_tokens') ? { cacheReadTokens: cacheRead } : {},
    ...hasOwn(inputDetails, 'cache_write_tokens') || hasOwn(inputDetails, 'cache_creation_tokens')
      ? { cacheWriteTokens: cacheWrite }
      : {},
    ...hasOwn(outputDetails, 'reasoning_tokens') ? { reasoningTokens: reasoning } : {},
  }
}

function responseItemKind(item: JsonObject): SlotKind | undefined {
  const type = string(item['type'])
  if (type === 'reasoning') return 'reasoning'
  if (type === 'message' || type === 'web_search_call' || type === 'custom_tool_call' || type === 'code_interpreter_call') return 'text'
  if (type === 'function_call') return 'tool-call'
  return undefined
}

function hostedSearchText(item: JsonObject): string {
  const action = object(item['action'])
  const query = string(action?.['query'])
  if (query !== undefined && query.length > 0) return `[backend web_search] search: ${query}`
  return '[backend web_search]'
}

function hostedXSearchText(item: JsonObject): string {
  const name = string(item['name']) ?? 'x_search'
  const input = string(item['input']) ?? ''
  return input.length === 0 ? `[backend x_search] ${name}` : `[backend x_search] ${name}(${input})`
}

function hostedCodeInterpreterText(item: JsonObject): string {
  const code = string(item['code']) ?? ''
  const preview = code.length > 100 ? `${code.slice(0, 100)}...` : code
  return preview.length === 0 ? '[backend code_interpreter]' : `[backend code_interpreter] ${preview}`
}

function displayText(item: JsonObject): string {
  const type = string(item['type'])
  if (type === 'web_search_call') return hostedSearchText(item)
  if (type === 'custom_tool_call') return hostedXSearchText(item)
  if (type === 'code_interpreter_call') return hostedCodeInterpreterText(item)
  return messageText(item)
}

function hostedReplayItem(item: JsonObject | undefined): GrokReplayBlock {
  const type = string(item?.['type'])
  if (item === undefined
    || type !== 'web_search_call' && type !== 'custom_tool_call' && type !== 'code_interpreter_call') return { type: 'text' }
  const { status: _status, ...inputItem } = item
  return {
    type: 'text',
    hostedItem: structuredClone(inputItem) as
      | { type: 'web_search_call' }
      | { type: 'custom_tool_call' }
      | { type: 'code_interpreter_call' },
  }
}

function reasoningText(item: JsonObject): string {
  const parts: string[] = []
  for (const raw of Array.isArray(item['summary']) ? item['summary'] : []) {
    const text = string(object(raw)?.['text'])
    if (text !== undefined) parts.push(text)
  }
  for (const raw of Array.isArray(item['content']) ? item['content'] : []) {
    const text = string(object(raw)?.['text'])
    if (text !== undefined) parts.push(text)
  }
  return parts.join('\n')
}

function messageText(item: JsonObject): string {
  const parts: string[] = []
  for (const raw of Array.isArray(item['content']) ? item['content'] : []) {
    const part = object(raw)
    const type = string(part?.['type'])
    if (type !== 'output_text' && type !== 'refusal') continue
    const text = string(part?.[type === 'refusal' ? 'refusal' : 'text'])
    if (text !== undefined) parts.push(text)
  }
  return parts.join('\n')
}

function terminalIncompleteReason(response: JsonObject): string | undefined {
  return string(object(response['incomplete_details'])?.['reason'])
}

function completeToolArguments(slots: ReadonlyMap<number, OutputSlot>): boolean {
  return [...slots.values()].filter(slot => slot.kind === 'tool-call').every((slot) => {
    if (slot.arguments.trim().length === 0) return true
    try {
      JSON.parse(slot.arguments)
      return true
    } catch {
      return false
    }
  })
}

function parseToolInput(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

interface TerminalOutcome {
  finishReason: 'stop' | 'tool-calls' | 'content-filter' | 'length'
  rawReason?: string
}

function terminalFinishReason(terminal: TerminalResponse, slots: ReadonlyMap<number, OutputSlot>): TerminalOutcome {
  const hasToolCalls = [...slots.values()].some(slot => slot.kind === 'tool-call')
  if (terminal.eventType === 'response.completed') {
    return hasToolCalls ? { finishReason: 'tool-calls' } : { finishReason: 'stop' }
  }
  const reason = terminalIncompleteReason(terminal.response)
  if (reason === INCOMPLETE_CONTENT_FILTER) {
    return { finishReason: 'content-filter' }
  }
  // CompleteToolCalls is the Grok Build default. The batch is all-or-nothing:
  // one malformed argument string turns the whole incomplete response into a
  // max-token stop before the agent loop can dispatch any call.
  if (hasToolCalls && completeToolArguments(slots)) return { finishReason: 'tool-calls' }
  if (reason === INCOMPLETE_MAX_PROMPT_TOKENS) {
    return { finishReason: 'length', rawReason: 'model_context_window_exceeded' }
  }
  if (reason === INCOMPLETE_MAX_OUTPUT_TOKENS) {
    return { finishReason: 'length', rawReason: 'max_tokens' }
  }
  return { finishReason: 'length' }
}

function eventFailure(event: JsonObject, fallback: string, requestHasImages: boolean): GrokWireError {
  const response = object(event['response'])
  const error = object(response?.['error']) ?? object(event['error']) ?? event
  const code = string(error['code'])
  const message = string(error['message']) ?? fallback
  const failureCode = requestHasImages && code === 'invalid_image' ? 'INVALID_IMAGE' : 'SERVER'
  return new GrokWireError(code === undefined ? message : `${code}: ${message}`, failureCode)
}

function parseEvent(payload: string): JsonObject {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch (error: unknown) {
    throw new GrokWireError('Grok Responses stream contained invalid JSON', 'PROTOCOL')
  }
  const event = object(parsed)
  if (event === undefined || typeof event['type'] !== 'string') {
    throw new GrokWireError('Grok Responses stream event has no type', 'PROTOCOL')
  }
  return event
}

function slotId(slot: OutputSlot): string {
  return slot.id || `${slot.kind}-${slot.index}`
}

function startEvents(slot: OutputSlot): GrokStreamEvent[] {
  if (slot.started) return []
  slot.started = true
  const opener: GrokStreamEvent = slot.kind === 'reasoning'
    ? { type: 'reasoning_start', id: slotId(slot) }
    : slot.kind === 'text'
      ? { type: 'text_start', id: slotId(slot) }
      : { type: 'tool_input_start', id: slotId(slot), toolName: slot.name }
  const events: GrokStreamEvent[] = [opener, ...slot.pending]
  slot.pending.length = 0
  return events
}

function deltaEvent(slot: OutputSlot, text: string): GrokStreamEvent {
  return slot.kind === 'reasoning'
    ? { type: 'reasoning_delta', id: slotId(slot), text }
    : { type: 'text_delta', id: slotId(slot), text }
}

function argumentsDeltaEvent(slot: OutputSlot, delta: string): GrokStreamEvent {
  return { type: 'tool_input_delta', id: slotId(slot), delta }
}

/**
 * Translate one complete Responses event stream into ZCode-shaped model events.
 *
 * Deltas in the contiguous provider output prefix pass through immediately.
 * A later index waits until every preceding index is known, keeping durable
 * block order aligned with native replay order. Block closure, usage and the
 * successful finish wait for the normalized terminal boundary. `parseGrokSse`
 * supplies that boundary for either native `[DONE]` or clean EOF; a stream that
 * closes before a terminal response object still fails closed.
 * @param payloads - Raw Responses data payloads including the normalized final boundary.
 * @param options - Attempt-local detector policy and replay recovery hooks.
 * @returns Model stream events in durable block order, ending in `finish`.
 */
export async function* translateGrokResponses(
  payloads: AsyncIterable<string>,
  options: GrokResponseStreamOptions = {},
): AsyncGenerator<GrokStreamEvent> {
  const slots = new Map<number, OutputSlot>()
  let nextStartIndex = 0
  let terminal: TerminalResponse | undefined
  const doomTriggers = new Set<string>()

  yield { type: 'start' }

  const recordTriggers = (triggers: readonly string[]): string[] => {
    for (const trigger of triggers) doomTriggers.add(trigger)
    return [...doomTriggers]
  }

  const rejectConfident = (triggers: readonly string[], response?: JsonObject): void => {
    const control = options.doomLoop
    if (control === undefined || !control.abort) return
    const confident = confidentTriggers(triggers, control.maxThreshold)
    if (confident.length === 0) return
    try {
      control.onDetected?.({
        triggers,
        recoveryItems: response === undefined
          ? recoveryFromSlots(slots)
          : recoveryFromOutput(Array.isArray(response['output']) ? response['output'] : []),
      })
    } catch {
      // Capture is best effort; detector recovery still owns the failure.
    }
    throw new GrokWireError(`Grok doom-loop detector rejected ${confident.join(', ')}`, 'DOOM_LOOP')
  }

  const ensure = (index: number, kind: SlotKind): OutputSlot => {
    const current = slots.get(index)
    if (current !== undefined) {
      if (current.kind !== kind) {
        throw new GrokWireError(
          `Grok Responses output index ${index} changed from ${current.kind} to ${kind}`,
          'PROTOCOL',
        )
      }
      return current
    }
    const created: OutputSlot = {
      index,
      kind,
      started: false,
      pending: [],
      text: '',
      id: '',
      name: '',
      arguments: '',
    }
    slots.set(index, created)
    return created
  }

  const flushContiguous = (): GrokStreamEvent[] => {
    const events: GrokStreamEvent[] = []
    for (;;) {
      const slot = slots.get(nextStartIndex)
      if (slot === undefined) return events
      events.push(...startEvents(slot))
      nextStartIndex += 1
    }
  }

  const stage = (slot: OutputSlot, ...events: GrokStreamEvent[]): GrokStreamEvent[] => {
    if (slot.started) return events
    slot.pending.push(...events)
    return flushContiguous()
  }

  for await (const payload of payloads) {
    if (payload === GROK_DONE) {
      if (terminal === undefined) {
        throw new GrokWireError('Grok Responses stream ended without a completed or incomplete response', 'STREAM_CLOSED')
      }

      const rawOutput = terminal.response['output']
      if (rawOutput !== undefined && !Array.isArray(rawOutput)) {
        throw new GrokWireError('Grok terminal response output is not an array', 'PROTOCOL')
      }
      const output = Array.isArray(rawOutput) ? rawOutput : []
      for (const [index, rawItem] of output.entries()) {
        const item = object(rawItem)
        if (item === undefined) throw new GrokWireError(`Grok output item ${index} is not an object`, 'PROTOCOL')
        const kind = responseItemKind(item)
        if (kind === undefined) {
          throw new GrokWireError(
            `Grok returned unsupported Responses output item "${String(item['type'])}"; refusing lossy replay`,
            'UNSUPPORTED_RESPONSE_ITEM',
          )
        }
        const slot = ensure(index, kind)
        slot.item = structuredClone(item)
        if (kind === 'reasoning') {
          const finalText = reasoningText(item)
          if (slot.text.length === 0 && finalText.length > 0) {
            for (const event of stage(slot, deltaEvent(slot, finalText))) yield event
          } else if (finalText.startsWith(slot.text) && finalText.length > slot.text.length) {
            for (const event of stage(slot, deltaEvent(slot, finalText.slice(slot.text.length)))) yield event
          }
          slot.text = finalText || slot.text
        } else if (kind === 'text') {
          const finalText = displayText(item)
          if (slot.text.length === 0 && finalText.length > 0) {
            for (const event of stage(slot, deltaEvent(slot, finalText))) yield event
          } else if (finalText.startsWith(slot.text) && finalText.length > slot.text.length) {
            for (const event of stage(slot, deltaEvent(slot, finalText.slice(slot.text.length)))) yield event
          }
          slot.text = finalText || slot.text
        } else {
          const id = string(item['call_id']) ?? slot.id
          const name = string(item['name']) ?? slot.name
          const finalArguments = string(item['arguments']) ?? slot.arguments
          slot.id = id || slot.id || `call-${index}`
          slot.name = name
          const events: GrokStreamEvent[] = []
          if (finalArguments.startsWith(slot.arguments) && finalArguments.length > slot.arguments.length) {
            events.push(argumentsDeltaEvent(slot, finalArguments.slice(slot.arguments.length)))
          }
          for (const event of stage(slot, ...events)) yield event
          slot.arguments = finalArguments
        }
      }

      const order = [...slots.keys()].sort((left, right) => left - right)
      const replayBlocks: GrokReplayBlock[] = []
      let hasUserVisibleResult = false
      for (const index of order) {
        const slot = slots.get(index)
        if (slot === undefined) continue
        for (const event of startEvents(slot)) yield event
        if (slot.kind === 'reasoning') {
          const item = slot.item ?? {
            type: 'reasoning',
            id: `reasoning-${index}`,
            summary: slot.text.length === 0 ? [] : [{ type: 'summary_text', text: slot.text }],
          }
          yield { type: 'reasoning_end', id: slotId(slot) }
          replayBlocks.push({ type: 'reasoning', item: item as { type: 'reasoning' } & JsonObject })
        } else if (slot.kind === 'text') {
          yield { type: 'text_end', id: slotId(slot) }
          replayBlocks.push(hostedReplayItem(slot.item))
          if (slot.text.length > 0 || slot.item !== undefined
            && (string(slot.item['type']) === 'web_search_call' || string(slot.item['type']) === 'custom_tool_call')) {
            hasUserVisibleResult = true
          }
        } else {
          const id = slot.id || `call-${index}`
          yield { type: 'tool_input_end', id }
          yield {
            type: 'tool_call',
            toolCall: { id, name: slot.name, input: parseToolInput(slot.arguments) },
          }
          replayBlocks.push({ type: 'tool-call' })
          hasUserVisibleResult = true
        }
      }

      if (terminal.eventType === 'response.completed' && !hasUserVisibleResult) {
        throw new GrokWireError('Grok completed without assistant text or a tool call', 'EMPTY_RESPONSE')
      }
      const usage = mapGrokUsage(terminal.response)
      if (options.doomLoop !== undefined && !options.doomLoop.abort) {
        const confident = confidentTriggers([...doomTriggers], options.doomLoop.maxThreshold)
        if (confident.length > 0) {
          try {
            options.doomLoop.onAccepted?.([...doomTriggers])
          } catch {
            // Telemetry cannot turn an accepted model response into a failure.
          }
        }
      }
      const responseId = string(terminal.response['id'])
      const { finishReason, rawReason } = terminalFinishReason(terminal, slots)
      const durableReplayBlocks = finishReason === 'length'
        ? replayBlocks.filter(block => block.type !== 'tool-call')
        : replayBlocks
      yield {
        type: 'finish',
        finishReason,
        ...usage === undefined ? {} : { usage },
        providerMetadata: {
          ...rawReason === undefined ? {} : { finishRawReason: rawReason },
          response: grokReplayState(durableReplayBlocks, responseId),
        },
      }
      return
    }

    const event = parseEvent(payload)
    const type = string(event['type']) as string
    if (type === GROK_DOOM_LOOP_EVENT) {
      rejectConfident(recordTriggers(doomLoopTriggers(event)))
      continue
    }
    if (type === 'response.failed') {
      throw eventFailure(event, 'Grok response failed', options.requestHasImages === true)
    }
    if (type === 'error' || type === 'response.error') {
      throw eventFailure(event, 'Grok stream failed', options.requestHasImages === true)
    }
    if (type === 'response.completed' || type === 'response.incomplete') {
      const response = object(event['response'])
      if (response === undefined) throw new GrokWireError(`${type} has no response object`, 'PROTOCOL')
      rejectConfident(recordTriggers(doomLoopTriggers(response)), response)
      terminal = { eventType: type, response }
      continue
    }

    const index = nonNegativeInteger(event['output_index'])
    if (type === 'response.output_item.added' || type === 'response.output_item.done') {
      if (index === undefined) throw new GrokWireError(`${type} has no output_index`, 'PROTOCOL')
      const item = object(event['item'])
      if (item === undefined) throw new GrokWireError(`${type} has no item`, 'PROTOCOL')
      const kind = responseItemKind(item)
      if (kind === undefined) continue
      const slot = ensure(index, kind)
      slot.item = structuredClone(item)
      if (kind === 'tool-call') {
        slot.id = string(item['call_id']) ?? string(event['item_id']) ?? slot.id
        slot.name = string(item['name']) ?? slot.name
        if (type === 'response.output_item.added') {
          const argumentsDelta = string(item['arguments']) ?? ''
          slot.arguments = argumentsDelta
          if (argumentsDelta.length > 0) {
            for (const staged of stage(slot, argumentsDeltaEvent(slot, argumentsDelta))) yield staged
          }
        } else {
          slot.arguments = string(item['arguments']) ?? slot.arguments
        }
      }
      continue
    }

    if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') {
      if (index === undefined) throw new GrokWireError(`${type} has no output_index`, 'PROTOCOL')
      const delta = string(event['delta']) ?? ''
      if (delta.length === 0) continue
      const slot = ensure(index, 'reasoning')
      slot.text += delta
      for (const staged of stage(slot, deltaEvent(slot, delta))) yield staged
      continue
    }

    if (type === 'response.output_text.delta' || type === 'response.refusal.delta') {
      if (index === undefined) throw new GrokWireError(`${type} has no output_index`, 'PROTOCOL')
      const delta = string(event['delta']) ?? ''
      if (delta.length === 0) continue
      const slot = ensure(index, 'text')
      slot.text += delta
      for (const staged of stage(slot, deltaEvent(slot, delta))) yield staged
      continue
    }

    if (type === 'response.function_call_arguments.delta') {
      if (index === undefined) throw new GrokWireError(`${type} has no output_index`, 'PROTOCOL')
      const slot = ensure(index, 'tool-call')
      slot.id ||= string(event['call_id']) ?? string(event['item_id']) ?? `call-${index}`
      const delta = string(event['delta']) ?? ''
      slot.arguments += delta
      for (const staged of stage(slot, argumentsDeltaEvent(slot, delta))) yield staged
      continue
    }

    if (type === 'response.function_call_arguments.done') {
      if (index === undefined) throw new GrokWireError(`${type} has no output_index`, 'PROTOCOL')
      const slot = ensure(index, 'tool-call')
      slot.id ||= string(event['call_id']) ?? string(event['item_id']) ?? `call-${index}`
      slot.name = string(event['name']) ?? slot.name
      slot.arguments = string(event['arguments']) ?? slot.arguments
    }
  }

  throw new GrokWireError('Grok Responses stream ended without a terminal boundary', 'STREAM_CLOSED')
}

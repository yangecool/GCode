/**
 * G Code — 会话历史 → Grok Responses wire items 序列化（M1 adapter 批次）。
 *
 * 移植自 grok-harness `packages/grok/model/src/serialize.ts` 的消息映射，
 * 输入改为 ZCode `ModelInputMessage` 的结构子集（工具结果是 role:'tool' 消息；
 * 图片块自带 dataUrl，无需附件服务）。
 *
 * replay 载体（H5 双表示的 ZCode 侧约定）：assistant 块的 `providerOptions`
 * 携带 `grokItem`（reasoning 原始 item）与 `grokHostedItem`（hosted call），
 * 与原版"replay blocks 与 assistant 内容块一一对齐"等价；仅在消息
 * `providerId`/`modelId` 与当前路由匹配时读取（防跨 provider 重放）。
 * 运行时接线（M1 后续）负责把 finish.providerMetadata 的 replay 状态写进
 * 持久化 assistant 消息的块 providerOptions。
 */

import { GrokWireError, hostedWireTool } from './grok-wire.js'
import type {
  GrokHostedToolSpec,
  GrokWireFunctionTool,
  GrokWireInputContent,
  GrokWireInputItem,
  GrokWireTool,
} from './grok-wire.ts'

/** 结构子集对齐 ZCode `ModelInputMessage`（contracts/src/model/index.ts:402）。 */
export interface GrokHistoryToolCall {
  readonly id: string
  readonly name: string
  readonly input?: unknown
}

/** 结构子集对齐 ZCode 内容块（contracts/src/model/index.ts:336-384）。 */
export type GrokHistoryBlock =
  | { readonly type: 'text'; readonly text: string; readonly providerOptions?: Record<string, unknown> }
  | { readonly type: 'reasoning'; readonly text: string; readonly providerOptions?: Record<string, unknown> }
  | { readonly type: 'image'; readonly mediaType: string; readonly dataUrl: string; readonly detail?: string }
  | { readonly type: 'file'; readonly mediaType: string; readonly name?: string; readonly uri?: string; readonly dataUrl?: string; readonly text?: string }
  | { readonly type: 'video'; readonly mediaType: string; readonly dataUrl: string }
  | { readonly type: 'resource_link'; readonly uri: string; readonly name?: string; readonly title?: string }

/** 结构子集对齐 ZCode `ModelInputMessage`。 */
export interface GrokHistoryMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool'
  readonly content: string | readonly GrokHistoryBlock[]
  readonly toolCalls?: readonly GrokHistoryToolCall[]
  readonly toolCallId?: string
  readonly toolName?: string
  readonly providerId?: string
  readonly modelId?: string
}

/** 路由匹配参数：与消息 providerId/modelId 一致时才读取 replay 元数据。 */
export interface GrokSerializeOptions {
  readonly providerId?: string
  readonly modelId?: string
}

const HOSTED_ITEM_TYPES = ['web_search_call', 'custom_tool_call', 'code_interpreter_call', 'mcp_call']

function blocksOf(message: GrokHistoryMessage): readonly GrokHistoryBlock[] {
  if (message.content === undefined) return []
  return typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content
}

function placeholder(prefix: string, mediaType: string, name?: string): string {
  return name && name.length > 0 ? `[${prefix} ${mediaType}: ${name}]` : `[${prefix} ${mediaType}]`
}

function blockText(block: GrokHistoryBlock): string {
  switch (block.type) {
    case 'text':
      return block.text
    case 'reasoning':
      return ''
    case 'image':
      return placeholder('Attached', block.mediaType, undefined)
    case 'video':
      return placeholder('Attached', block.mediaType, undefined)
    case 'file':
      if (block.text !== undefined && block.text.length > 0) return block.text
      return placeholder('Attached', block.mediaType, block.name)
    case 'resource_link':
      return `[Resource: ${block.title ?? block.name ?? block.uri}]`
  }
}

function textOf(message: GrokHistoryMessage): string {
  return blocksOf(message).map(blockText).filter(value => value.length > 0).join('\n\n')
}

/** 历史中是否含图片输入（stream 翻译器 invalid_image 恢复策略的输入）。 */
export function historyHasImages(messages: readonly GrokHistoryMessage[]): boolean {
  return messages.some(message => blocksOf(message).some(block => block.type === 'image'))
}

function validArguments(raw: string): string {
  try {
    JSON.parse(raw)
    return raw
  } catch {
    return '{}'
  }
}

function toolCallArguments(input: unknown): string {
  if (typeof input === 'string') return validArguments(input)
  try {
    return JSON.stringify(input ?? {})
  } catch {
    return '{}'
  }
}

function replayReasoningItem(value: unknown): { type: 'reasoning' } & Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new GrokWireError('assistant reasoning block grokItem must be an object', 'INVALID_REPLAY_STATE')
  }
  const item = value as Record<string, unknown>
  if (item['type'] !== 'reasoning') {
    throw new GrokWireError('assistant reasoning block grokItem is not a reasoning item', 'INVALID_REPLAY_STATE')
  }
  // `status` is response-only; Rust grok-build removes it before replay.
  const { status: _status, ...inputItem } = item
  return structuredClone(inputItem) as { type: 'reasoning' } & Record<string, unknown>
}

function replayHostedItem(value: unknown): GrokWireInputItem {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new GrokWireError('assistant text block grokHostedItem must be an object', 'INVALID_REPLAY_STATE')
  }
  const item = value as Record<string, unknown>
  if (typeof item['type'] !== 'string' || !HOSTED_ITEM_TYPES.includes(item['type'])) {
    throw new GrokWireError('assistant text block grokHostedItem is not a hosted call', 'INVALID_REPLAY_STATE')
  }
  const { status: _status, ...inputItem } = item
  return structuredClone(inputItem) as GrokWireInputItem
}

function serializeUser(message: GrokHistoryMessage): GrokWireInputItem {
  const blocks = blocksOf(message)
  const hasImage = blocks.some(block => block.type === 'image')
  if (!hasImage) {
    const text = textOf(message)
    return { type: 'message', role: 'user', content: text }
  }
  const content: GrokWireInputContent[] = []
  for (const block of blocks) {
    if (block.type === 'text') {
      if (block.text.length > 0) content.push({ type: 'input_text', text: block.text })
    } else if (block.type === 'image') {
      content.push({ type: 'input_image', detail: 'auto', image_url: block.dataUrl })
    } else {
      const text = blockText(block)
      if (text.length > 0) content.push({ type: 'input_text', text })
    }
  }
  return { type: 'message', role: 'user', content }
}

function serializeAssistant(message: GrokHistoryMessage, options: GrokSerializeOptions): GrokWireInputItem[] {
  const own = options.providerId !== undefined
    && message.providerId === options.providerId
    && (options.modelId === undefined || message.modelId === options.modelId)
  const items: GrokWireInputItem[] = []
  for (const block of blocksOf(message)) {
    if (block.type === 'reasoning') {
      const raw = own ? block.providerOptions?.['grokItem'] : undefined
      if (raw !== undefined) {
        items.push(replayReasoningItem(raw))
      } else {
        items.push({
          type: 'reasoning',
          summary: block.text.length === 0 ? [] : [{ type: 'summary_text', text: block.text }],
        })
      }
    } else if (block.type === 'text') {
      const raw = own ? block.providerOptions?.['grokHostedItem'] : undefined
      if (raw !== undefined) {
        items.push(replayHostedItem(raw))
      } else if (block.text.length > 0) {
        items.push({ type: 'message', role: 'assistant', content: block.text })
      }
    }
  }
  for (const call of message.toolCalls ?? []) {
    items.push({
      type: 'function_call',
      call_id: call.id,
      name: call.name,
      arguments: toolCallArguments(call.input),
    })
  }
  return items
}

function serializeTool(message: GrokHistoryMessage): GrokWireInputItem {
  const text = textOf(message)
  return {
    type: 'function_call_output',
    call_id: message.toolCallId ?? '',
    output: text.length === 0 ? '(no output)' : text,
  }
}

/**
 * Serialize ZCode-shaped history into native Responses input items.
 * @param messages - Durable history（system/user/assistant/tool 角色）。
 * @param options - 路由匹配参数，控制 replay 元数据的读取资格。
 * @returns Ordered native Responses input items。
 * @throws GrokWireError `INVALID_REPLAY_STATE` for structurally invalid replay metadata.
 */
export function serializeGrokMessages(
  messages: readonly GrokHistoryMessage[],
  options: GrokSerializeOptions = {},
): GrokWireInputItem[] {
  const input: GrokWireInputItem[] = []
  for (const message of messages) {
    if (message.role === 'system') {
      input.push({ type: 'message', role: 'system', content: textOf(message) })
    } else if (message.role === 'assistant') {
      input.push(...serializeAssistant(message, options))
    } else if (message.role === 'tool') {
      input.push(serializeTool(message))
    } else {
      input.push(serializeUser(message))
    }
  }
  return input
}

/** 模型可见函数工具的最小结构（ZCode `ModelToolContract` 子集）。 */
export interface GrokFunctionToolSpec {
  readonly name: string
  readonly description?: string
  readonly parameters: Record<string, unknown>
}

/**
 * Serialize the request tool array: hosted entries validated first, colliding
 * local function names dropped（原版语义：hosted wire name 优先）。
 * @param tools - Local function tools requested for this turn.
 * @param hosted - Deployment-owned hosted Responses tools.
 * @returns The native tools array, or undefined when empty.
 */
export function serializeGrokTools(
  tools: readonly GrokFunctionToolSpec[],
  hosted: readonly GrokHostedToolSpec[] = [],
): GrokWireTool[] | undefined {
  const hostedEntries = hosted.map(hostedWireTool)
  const hostedNames = new Set<string>(hostedEntries.map(tool => tool.type))
  const functions: GrokWireFunctionTool[] = tools
    .filter(tool => !hostedNames.has(tool.name))
    .map(tool => ({
      type: 'function' as const,
      name: tool.name,
      ...tool.description === undefined ? {} : { description: tool.description },
      parameters: tool.parameters,
    }))
  const all: GrokWireTool[] = [...functions, ...hostedEntries]
  return all.length === 0 ? undefined : all
}

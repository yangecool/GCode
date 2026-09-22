/**
 * G Code — Grok ModelExecutor 核心映射（M1 第三批：接线 GCode Model 面）。
 *
 * 定位：`executeGrokRequest`（引擎）与 GCode `ModelExecutor` 契约之间的纯映射层。
 * 本文件只做 `import type`（剥离后无 @gcode 运行时依赖），保证 node 原生 TS
 * 剥离下可独立测试；GrokWireError → ModelProtocolError 的错误包装在 runner
 * 侧壳（grok-runner.ts）完成，那里本来就活在 ai/@gcode 的运行时世界里。
 *
 * 事件语义：GrokStreamEvent 与 GCode ModelStreamEvent 同形（H5 双表示的
 * GCode 侧就是流事件本身），stream 路径按原样透传；generateText 路径把流
 * 归并为 ModelTextResult——reasoning 块从 finish 的 replay state（wire 原始
 * item）回填 `providerOptions.grokItem`，与 serializeGrokMessages 的读取端
 * 约定一致。
 *
 * 债务：responseJsonSchema（结构化输出）与 hosted 工具目录（web_search 等
 * providerNative 声明）属 M3 工具目录方言批次；hosted call 的块级
 * grokHostedItem 附着依赖会话层按块持久化 assistant 消息，属 M4/M5。
 */

import { executeGrokRequest, streamGrokRequest } from './grok-adapter.js'
import type { GrokAdapterConfig, GrokExecutionRequest } from './grok-adapter.js'
import type { GrokFunctionToolSpec, GrokHistoryMessage } from './grok-serialize.js'
import type { GrokStreamEvent, GrokUsage } from './grok-stream.js'
import { resolveGrokReasoningEffort } from './grok-wire.js'

/** ModelToolContract 的结构子集（避免 @gcode 运行时值依赖）。 */
export interface GrokToolContractSource {
  readonly name: string
  readonly description?: string
  readonly inputSchema?: unknown
}

/** ModelExecutionRequest 的结构子集（messages 即 GrokHistoryMessage）。 */
export interface GrokModelRequestCore {
  readonly messages: readonly GrokHistoryMessage[]
  readonly tools?: readonly GrokToolContractSource[]
  readonly reasoningLevel?: string
  readonly maxOutputTokens?: number
  /** H13 粘性路由 cache key（会话槽；辅助调用缺省）。 */
  readonly promptCacheKey?: string
  readonly abortSignal?: AbortSignal
}

/** ModelTextResult 的结构子集。 */
export interface GrokTextResultCore {
  readonly text: string
  readonly finishReason: string
  readonly usage?: GrokUsage
  readonly reasoning?: readonly {
    readonly type: 'reasoning'
    readonly text: string
    readonly providerOptions?: Record<string, unknown>
  }[]
  readonly toolCalls?: readonly {
    readonly id: string
    readonly name: string
    readonly input: unknown
  }[]
  readonly providerMetadata?: Record<string, unknown>
}

/** ModelExecutor 形状（结构性，不 import 契约类型本体）。 */
export interface GrokModelExecutorCore {
  generateText(request: GrokModelRequestCore): Promise<GrokTextResultCore>
  streamText(request: GrokModelRequestCore): AsyncIterable<GrokStreamEvent>
}

/** 模型绑定事实：目录（H8）与 provider 配置在绑定时冻结。 */
export interface GrokModelBinding {
  /** 目录 admissible efforts；缺省用原版全集并保持 fail-loud。 */
  readonly knownEfforts?: readonly string[]
  readonly defaultEffort?: string
  readonly reasoningSummary?: GrokAdapterConfig['reasoningSummary']
  readonly temperature?: number
  readonly maxRetries?: number
  readonly streamIdleTimeoutMs?: number
  readonly retryBackoffBaseMs?: number
  readonly doomLoopMaxResamples?: number
  readonly doomLoopMaxThreshold?: number
  readonly doomLoopReminder?: string
  readonly clientVersion?: string
}

/** ModelToolContract → Responses function 工具声明。 */
export function grokFunctionTools(
  tools: readonly GrokToolContractSource[] | undefined,
): GrokFunctionToolSpec[] | undefined {
  if (tools === undefined || tools.length === 0) return undefined
  return tools.map(tool => ({
    name: tool.name,
    ...tool.description === undefined ? {} : { description: tool.description },
    parameters: objectSchema(tool.inputSchema),
  }))
}

function objectSchema(schema: unknown): Record<string, unknown> {
  if (typeof schema === 'object' && schema !== null && !Array.isArray(schema)) {
    return schema as Record<string, unknown>
  }
  // 契约面 inputSchema 缺失/非对象时退回 open schema，不猜参数形状。
  return { type: 'object' }
}

/** 目录 reasoningLevel（档位值）→ Responses effort；不可接受值 fail-loud。 */
export function grokRequestEffort(
  reasoningLevel: string | undefined,
  binding: GrokModelBinding,
): string {
  return resolveGrokReasoningEffort(
    reasoningLevel,
    (binding.defaultEffort ?? 'high') as never,
    binding.knownEfforts,
  )
}

function executionRequest(request: GrokModelRequestCore): GrokExecutionRequest {
  return {
    messages: request.messages,
    tools: grokFunctionTools(request.tools),
    abortSignal: request.abortSignal,
  }
}

function adapterConfig(
  binding: GrokModelBinding,
  base: Omit<GrokAdapterConfig, 'reasoningEffort' | 'maxOutputTokens'>,
  request: GrokModelRequestCore,
): GrokAdapterConfig {
  return {
    ...base,
    reasoningEffort: grokRequestEffort(request.reasoningLevel, binding),
    ...request.maxOutputTokens === undefined ? {} : { maxOutputTokens: request.maxOutputTokens },
    ...request.promptCacheKey === undefined ? {} : { promptCacheKey: request.promptCacheKey },
    ...binding.reasoningSummary === undefined ? {} : { reasoningSummary: binding.reasoningSummary },
    ...binding.temperature === undefined ? {} : { temperature: binding.temperature },
    ...binding.maxRetries === undefined ? {} : { maxRetries: binding.maxRetries },
    ...binding.streamIdleTimeoutMs === undefined
      ? {}
      : { streamIdleTimeoutMs: binding.streamIdleTimeoutMs },
    ...binding.retryBackoffBaseMs === undefined
      ? {}
      : { retryBackoffBaseMs: binding.retryBackoffBaseMs },
    ...binding.doomLoopMaxResamples === undefined
      ? {}
      : { doomLoopMaxResamples: binding.doomLoopMaxResamples },
    ...binding.doomLoopMaxThreshold === undefined
      ? {}
      : { doomLoopMaxThreshold: binding.doomLoopMaxThreshold },
    ...binding.doomLoopReminder === undefined ? {} : { doomLoopReminder: binding.doomLoopReminder },
    ...binding.clientVersion === undefined ? {} : { clientVersion: binding.clientVersion },
  }
}

/**
 * 组装 Grok ModelExecutor 核心。
 * @param base - provider 侧连接事实（apiKey/baseURL/headers/hostedTools/transport）。
 * @param binding - 目录侧模型事实（efforts/summary/重试预算）。
 */
export function createGrokModelExecutorCore(
  base: Omit<GrokAdapterConfig, 'model' | 'reasoningEffort' | 'maxOutputTokens'> & { model: string },
  binding: GrokModelBinding = {},
): GrokModelExecutorCore {
  return {
    async generateText(request) {
      const { events } = await executeGrokRequest(adapterConfig(binding, base, request), executionRequest(request))
      return collectGrokTextResult(events)
    },
    streamText(request) {
      // 真流式：事件随产生随下发（含重试资格守卫），不缓冲到终态。
      return streamGrokRequest(adapterConfig(binding, base, request), executionRequest(request))
    },
  }
}

/** 流事件 → ModelTextResult 归并（generateText 路径）。 */
export function collectGrokTextResult(events: readonly GrokStreamEvent[]): GrokTextResultCore {
  let text = ''
  const reasoningText = new Map<string, string>()
  const reasoningOrder: string[] = []
  const toolCalls: { id: string; name: string; input: unknown }[] = []
  let finish: Extract<GrokStreamEvent, { type: 'finish' }> | undefined
  for (const event of events) {
    switch (event.type) {
      case 'text_delta':
        text += event.text
        break
      case 'reasoning_start':
        // 单 opener 规则：每个 reasoning 块恰一次 start，先于所有 delta。
        reasoningOrder.push(event.id)
        break
      case 'reasoning_delta': {
        const id = event.id ?? reasoningOrder.at(-1)
        if (id !== undefined) {
          reasoningText.set(id, (reasoningText.get(id) ?? '') + event.text)
        }
        break
      }
      case 'tool_call':
        toolCalls.push({ id: event.toolCall.id, name: event.toolCall.name, input: event.toolCall.input })
        break
      case 'finish':
        finish = event
        break
      default:
        break
    }
  }
  if (finish === undefined) {
    throw new GrokStreamEndedWithoutFinishError()
  }
  const replayBlocks = replayReasoningItems(finish)
  const reasoning = reasoningOrder
    .filter(id => (reasoningText.get(id) ?? '').length > 0)
    .map((id, index) => {
      const item = replayBlocks[index]
      return {
        type: 'reasoning' as const,
        text: reasoningText.get(id) ?? '',
        ...(item === undefined ? {} : { providerOptions: { grokItem: item } }),
      }
    })
  return {
    text,
    finishReason: finish.finishReason,
    usage: finish.usage,
    ...(reasoning.length === 0 ? {} : { reasoning }),
    ...(toolCalls.length === 0 ? {} : { toolCalls }),
    providerMetadata: finish.providerMetadata,
  }
}

class GrokStreamEndedWithoutFinishError extends Error {
  constructor() {
    super('Grok generateText stream ended without a finish event')
    this.name = 'GrokStreamEndedWithoutFinishError'
  }
}

/** finish.providerMetadata.response 的 replay state 里按序取 reasoning 原始 item。 */
function replayReasoningItems(
  finish: Extract<GrokStreamEvent, { type: 'finish' }>,
): Record<string, unknown>[] {
  const response = finish.providerMetadata?.['response']
  if (typeof response !== 'object' || response === null) return []
  const blocks = (response as { blocks?: unknown }).blocks
  if (!Array.isArray(blocks)) return []
  const items: Record<string, unknown>[] = []
  for (const block of blocks) {
    if (typeof block !== 'object' || block === null) continue
    const typed = block as { type?: unknown; item?: unknown }
    if (typed.type !== 'reasoning') continue
    if (typeof typed.item === 'object' && typed.item !== null) {
      items.push(typed.item as Record<string, unknown>)
    }
  }
  return items
}

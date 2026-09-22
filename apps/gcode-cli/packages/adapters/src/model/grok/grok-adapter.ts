/**
 * G Code — Grok 模型执行编排（M1 第二批，引擎收口）。
 *
 * 移植自 grok-harness `packages/grok/model/src/{adapter,plugin}.ts` 的执行语义，
 * 组合本目录 wire/serialize/stream/http 四个模块。对账第 1 项已裁决：重试总
 * 尝试次数按 Rust 原版 `xai-grok-sampler/src/retry.rs` 执行——
 * `DEFAULT_MAX_RETRIES = 15`（含首次共 16 次尝试；grok-harness 的"15 次总数"
 * 是 DSH 适配漂移，不采用）。
 *
 * 原版语义保留：429 预算阈值 2；退避 2s 指数、上限 30s、抖动 ±0.2；首个
 * 5xx 用 fresh HTTP/1.1 通道重建传输（退避 200ms）；doom-loop 重采样预算
 * 独立于传输预算（默认 2，钳 0..=5），毒 attempt 的 recovery items 连同
 * reminder 注入重试请求（原版 `append_recovery_context` 无条件追加 reminder，
 * 恢复上下文跨多次 doom 重试累积）且绝不进入持久结果；空闲超时默认 300s。
 *
 * 债务：length 文本续写（原版会话层 length_salvage）属会话集成批次；
 * `retry_only_before_output` 下 doom 中止不可重采样直接失败的守卫属会话层
 * 策略，本层未实现。
 */

import { translateGrokResponses } from './grok-stream.js'
import type { GrokStreamEvent } from './grok-stream.js'
import { buildGrokResponsesRequestBody, GrokWireError, parseGrokSse } from './grok-wire.js'
import type { GrokHostedToolSpec, GrokWireInputItem, GrokWireRequest } from './grok-wire.js'
import { historyHasImages, serializeGrokMessages, serializeGrokTools } from './grok-serialize.js'
import type { GrokFunctionToolSpec, GrokHistoryMessage } from './grok-serialize.js'
import { createGrokHttpTransport, isGrokTransportError } from './grok-http.js'
import type { GrokHttpTransport } from './grok-http.js'

/**
 * 原版 retry.rs 常量（对账第 1 项裁决后的口径）。
 */
const DEFAULT_MAX_RETRIES = 15
const RATE_LIMIT_RETRY_THRESHOLD = 2
const RETRY_BACKOFF_BASE_MS = 2_000
const RETRY_BACKOFF_MAX_MS = 30_000
const RETRY_JITTER = 0.2
const TRANSPORT_REBUILD_BACKOFF_MS = 200
const DEFAULT_IDLE_TIMEOUT_MS = 300_000
const DEFAULT_DOOM_RESAMPLES = 2
const DEFAULT_DOOM_THRESHOLD = 64

/**
 * 逐字取自 Rust 原版 `doom_loop_recovery.rs` 的 `RECOVERY_REMINDER`。
 * 原版 `append_recovery_context` 无条件追加该 reminder（被 veto 的失败轮
 * "the retry carries the reminder alone"），此处保持同语义：默认启用，
 * 配置空串显式关闭（G Code 扩展）。
 */
export const GROK_RECOVERY_REMINDER =
  '<system_reminder>Your messages have been flagged as looping. Your response has been flagged as repeating the same text pattern. Avoid excessive repetition. If you are having trouble ask the user for guidance.</system_reminder>'

/** 执行器配置；字段与原版 GrokProviderProfile 对应。 */
export interface GrokAdapterConfig {
  /** API key（Bearer）；不写入日志与错误信息。 */
  readonly apiKey: string
  /** Responses 根地址，默认 `https://api.x.ai/v1`。 */
  readonly baseURL?: string
  readonly model: string
  /** 当前路由的 provider id；同源历史消息凭它读取 replay 元数据。 */
  readonly providerId?: string
  /**
   * H3 订阅模式：走 grok-build 客户端身份头集 + OAuth bearer（loginViaBrowser
   * 写入的设备流令牌）。缺省 api-key（Bearer apiKey）。
   */
  readonly authMode?: 'api-key' | 'grok-subscription'
  /** 订阅模式 bearer 解析（attempt 级 await；可刷新）。 */
  readonly resolveBearer?: () => Promise<string>
  /** 订阅模式稳定 agent id（x-grok-agent-id 头；订阅流量专用）。 */
  readonly agentId?: string
  /** 追加请求头（不得覆盖协议身份头）。 */
  readonly headers?: Readonly<Record<string, string>>
  readonly reasoningEffort?: string
  readonly reasoningSummary?: 'none' | 'auto' | 'concise' | 'detailed'
  readonly temperature?: number
  readonly maxOutputTokens?: number
  readonly promptCacheKey?: string
  readonly hostedTools?: readonly GrokHostedToolSpec[]
  /** doom-loop 重采样预算（原版钳 0..=5）。 */
  readonly doomLoopMaxResamples?: number
  readonly doomLoopMaxThreshold?: number
  /** doom-loop 恢复注入的 reminder 文案；默认原版逐字文案，空串显式关闭。 */
  readonly doomLoopReminder?: string
  readonly maxRetries?: number
  readonly streamIdleTimeoutMs?: number
  readonly clientVersion?: string
  /** 退避基数（毫秒），默认 2000；测试注入口。 */
  readonly retryBackoffBaseMs?: number
  /** 注入式传输（测试）；缺省按进程 env 建一次。 */
  readonly transport?: GrokHttpTransport
}

/** 一次模型执行请求（GCode ModelRequest 的结构子集）。 */
export interface GrokExecutionRequest {
  readonly messages: readonly GrokHistoryMessage[]
  readonly tools?: readonly GrokFunctionToolSpec[]
  readonly abortSignal?: AbortSignal
}

/** 重试轮次诊断（不含凭证）。 */
export interface GrokAttemptDiagnostic {
  readonly attempt: number
  readonly code: string
  readonly retried: boolean
}

export interface GrokExecutionResult {
  readonly events: readonly GrokStreamEvent[]
  readonly attempts: readonly GrokAttemptDiagnostic[]
}

/** 流式执行的增量下发控制（retry_only_before_output 守卫的输入）。 */
export interface GrokStreamCallbacks {
  /** 每个事件产生时同步回调（含 finish；缓冲路径不传）。 */
  readonly onEvent?: (event: GrokStreamEvent) => void
  /**
   * 是否已有输出下发到外部消费者（`start` 不计——会话层幂等）。
   * 返回 true 后任何失败都不再静默重试，直接浮出（Rust 原版会话层
   * `retry_only_before_output` 语义：已下发的内容无法收回重采样）。
   */
  readonly outputDelivered?: () => boolean
}

/** 任意失败 → 带稳定码位的 GrokWireError；网络相非 wire 错误统一 TRANSPORT。 */
function asGrokWireFailure(error: unknown): GrokWireError {
  if (error instanceof GrokWireError) return error
  // 连接建立与 body 读取两个阶段的非 wire 异常（DNS/ECONNRESET/中途截断/
  // idle-timeout abort 的底层错误）都按传输失败分类进入重试预算——对齐
  // 参照实现 stream() 的 TRANSPORT 兜底；协议错误在翻译器内已是 wire 错误。
  const detail = isGrokTransportError(error)
    ? error.message
    : error instanceof Error ? error.message : String(error)
  return new GrokWireError(detail, 'TRANSPORT')
}

function userAgent(version: string): string {
  const os = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : process.platform
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64'
  return `grok-shell/${version} (${os}; ${arch})`
}

function backoffMs(attempt: number, baseMs: number): number {
  const raw = Math.min(baseMs * 2 ** attempt, RETRY_BACKOFF_MAX_MS)
  const jitter = raw * RETRY_JITTER * (Math.random() * 2 - 1)
  return Math.max(0, raw + jitter)
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new GrokWireError('aborted', 'ABORTED'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort(): void {
      clearTimeout(timer)
      reject(new GrokWireError('aborted', 'ABORTED'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** 可重试分类：预算内 DOOM_LOOP/RATE_LIMIT、5xx、传输/协议层。 */
function classify(error: unknown, rateLimitUsed: number, doomUsed: number, doomBudget: number): {
  readonly retry: boolean
  readonly rebuildTransport: boolean
} {
  const code = error instanceof GrokWireError ? error.code : ''
  if (code === 'DOOM_LOOP') return { retry: doomUsed < doomBudget, rebuildTransport: false }
  if (code === 'RATE_LIMIT') {
    return { retry: rateLimitUsed < RATE_LIMIT_RETRY_THRESHOLD, rebuildTransport: false }
  }
  if (code === 'SERVER_5XX') return { retry: true, rebuildTransport: true }
  if (code === 'TRANSPORT' || code === 'STREAM_CLOSED' || code === 'PROTOCOL') {
    return { retry: true, rebuildTransport: code === 'TRANSPORT' }
  }
  return { retry: false, rebuildTransport: false }
}

function wireErrorFromResponse(status: number, body: string): GrokWireError {
  let message = body
  let providerCode: string | undefined
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string; code?: string }; message?: string }
    message = parsed.error?.message ?? parsed.message ?? body
    providerCode = parsed.error?.code
  } catch {
    // 保留原始 body 作为消息
  }
  if (status === 429) return new GrokWireError(message, 'RATE_LIMIT')
  if (status >= 500) return new GrokWireError(message, 'SERVER_5XX')
  const code = providerCode !== undefined ? `${providerCode}: ` : ''
  return new GrokWireError(`${status} ${code}${message}`.trim(), `HTTP_${status}`)
}

function withIdleTimeout(
  body: ReadableStream<Uint8Array>,
  timeoutMs: number,
  attemptController: AbortController,
): ReadableStream<Uint8Array> {
  const reader = body.getReader()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const timer = setTimeout(() => attemptController.abort(), timeoutMs)
      try {
        const { done, value } = await reader.read()
        if (done) {
          controller.close()
          return
        }
        controller.enqueue(value)
      } finally {
        clearTimeout(timer)
      }
    },
    cancel() {
      void reader.cancel().catch(() => {})
    },
  })
}

/**
 * Run one Grok Responses request to completion with the native retry policy.
 * @param config - 执行器配置。
 * @param request - 会话历史与工具面。
 * @param stream - 可选的增量下发回调；传入后事件随产生随下发，且输出一旦
 * 下发即冻结重试资格（retry_only_before_output）。
 * @returns 终态事件序列（含 finish）与逐轮诊断；毒 attempt 不进入结果。
 * @throws GrokWireError 预算耗尽或不可重试失败的最终错误。
 */
export async function executeGrokRequest(
  config: GrokAdapterConfig,
  request: GrokExecutionRequest,
  stream: GrokStreamCallbacks = {},
): Promise<GrokExecutionResult> {
  const transport = config.transport ?? createGrokHttpTransport()
  const defaultBase = config.authMode === 'grok-subscription'
    ? 'https://cli-chat-proxy.grok.com/v1'
    : 'https://api.x.ai/v1'
  const url = new URL(`${config.baseURL ?? defaultBase}/responses`)
  const maxAttempts = 1 + (config.maxRetries ?? DEFAULT_MAX_RETRIES)
  const doomBudget = config.doomLoopMaxResamples ?? DEFAULT_DOOM_RESAMPLES
  const idleTimeout = config.streamIdleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
  // grok-shell 1.0.38（2026-09 grok-build 4247f661）；随上游发布窗口更新。
  const clientVersion = config.clientVersion ?? '1.0.38'
  const subscription = config.authMode === 'grok-subscription'
  // 订阅模式身份头集（grok-build 客户端）：identity + agent id；请求头在
  // attempt 级组装（bearer 可刷新）。
  const staticHeaders: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    'user-agent': userAgent(clientVersion),
    'x-grok-client-version': clientVersion,
    'x-grok-client-identifier': 'grok-shell',
    ...subscription
      ? {
        'x-xai-token-auth': 'xai-grok-cli',
        'x-authenticateresponse': 'authenticate-response',
        ...(config.agentId === undefined ? {} : { 'x-grok-agent-id': config.agentId }),
      }
      : {},
    ...config.headers,
  }
  const input = serializeGrokMessages(request.messages, {
    ...config.providerId === undefined ? {} : { providerId: config.providerId },
    modelId: config.model,
  })
  const tools = serializeGrokTools(request.tools ?? [], config.hostedTools ?? [])

  let recoveryTail: readonly GrokWireInputItem[] = []
  let rateLimitUsed = 0
  let doomUsed = 0
  let rebuilt = false
  const diagnostics: GrokAttemptDiagnostic[] = []

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    // 已取消的请求不发送：AbortSignal 对已 aborted 状态不再触发 abort 事件，
    // listener 方式对预取消静默，必须显式预检。
    if (request.abortSignal?.aborted) {
      diagnostics.push({ attempt, code: 'ABORTED', retried: false })
      throw new GrokWireError('aborted by caller', 'ABORTED')
    }
    const body: GrokWireRequest = buildGrokResponsesRequestBody({
      model: config.model,
      input: [...input, ...recoveryTail],
      effort: config.reasoningEffort ?? 'high',
      ...config.reasoningSummary === undefined ? {} : { summary: config.reasoningSummary },
      ...tools === undefined ? {} : { tools },
      ...config.promptCacheKey === undefined ? {} : { promptCacheKey: config.promptCacheKey },
      ...config.temperature === undefined ? {} : { temperature: config.temperature },
      ...config.maxOutputTokens === undefined ? {} : { maxOutputTokens: config.maxOutputTokens },
    })
    const fetchImpl = rebuilt ? transport.freshHttp1Fetch : transport.fetch
    const attemptController = new AbortController()
    const onOuterAbort = (): void => attemptController.abort()
    request.abortSignal?.addEventListener('abort', onOuterAbort, { once: true })
    const collected: GrokStreamEvent[] = []
    let terminal: GrokStreamEvent | undefined
    try {
      const bearer = subscription
        ? await config.resolveBearer?.()
        : undefined
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          ...staticHeaders,
          authorization: `Bearer ${bearer ?? config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: attemptController.signal,
      })
      if (!response.ok || response.body === null) {
        throw wireErrorFromResponse(response.status, await response.text().catch(() => ''))
      }
      const payloads = parseGrokSse(withIdleTimeout(response.body, idleTimeout, attemptController))
      for await (const event of translateGrokResponses(payloads, {
        requestHasImages: historyHasImages(request.messages),
        doomLoop: {
          abort: true,
          maxThreshold: config.doomLoopMaxThreshold ?? DEFAULT_DOOM_THRESHOLD,
          onDetected: detection => {
            recoveryTail = [...recoveryTail, ...detection.recoveryItems]
          },
        },
      })) {
        if (event.type === 'finish') {
          terminal = event
        } else {
          collected.push(event)
        }
        stream.onEvent?.(event)
      }
      if (terminal === undefined) {
        throw new GrokWireError('stream ended without finish', 'STREAM_CLOSED')
      }
      diagnostics.push({ attempt, code: 'OK', retried: false })
      recoveryTail = []
      return { events: [...collected, terminal], attempts: diagnostics }
    } catch (error: unknown) {
      if (request.abortSignal?.aborted) {
        diagnostics.push({ attempt, code: 'ABORTED', retried: false })
        throw new GrokWireError('aborted by caller', 'ABORTED')
      }
      const failure = asGrokWireFailure(error)
      const verdict = classify(failure, rateLimitUsed, doomUsed, doomBudget)
      const willRetry = verdict.retry
        && attempt < maxAttempts
        && stream.outputDelivered?.() !== true
      diagnostics.push({ attempt, code: failure.code, retried: willRetry })
      if (!willRetry) {
        throw failure
      }
      if (failure.code === 'RATE_LIMIT') rateLimitUsed += 1
      if (failure.code === 'DOOM_LOOP') {
        doomUsed += 1
        const reminder = config.doomLoopReminder ?? GROK_RECOVERY_REMINDER
        if (reminder.length > 0) {
          recoveryTail = [...recoveryTail, { type: 'message', role: 'user', content: reminder }]
        }
      }
      if (verdict.rebuildTransport && !rebuilt) {
        rebuilt = true
        await sleep(TRANSPORT_REBUILD_BACKOFF_MS, request.abortSignal)
      } else {
        await sleep(backoffMs(attempt - 1, config.retryBackoffBaseMs ?? RETRY_BACKOFF_BASE_MS), request.abortSignal)
      }
    } finally {
      request.abortSignal?.removeEventListener('abort', onOuterAbort)
    }
  }
  throw new GrokWireError('retry budget exhausted', 'RETRY_EXHAUSTED')
}

/** 单生产者/单消费者的先入先出事件队列（回调 → 异步迭代器桥接）。 */
class GrokEventQueue {
  private pending: GrokStreamEvent[] = []
  private waiters: Array<() => void> = []
  private failure: { readonly error: unknown } | undefined
  private finished = false

  push(event: GrokStreamEvent): void {
    this.pending.push(event)
    this.release()
  }

  finish(): void {
    this.finished = true
    this.release()
  }

  fail(error: unknown): void {
    if (this.failure === undefined && !this.finished) this.failure = { error }
    this.release()
  }

  private release(): void {
    for (const waiter of this.waiters.splice(0)) waiter()
  }

  async *drain(): AsyncGenerator<GrokStreamEvent> {
    for (;;) {
      while (this.pending.length > 0) {
        const event = this.pending.shift()
        if (event !== undefined) yield event
      }
      if (this.failure !== undefined) throw this.failure.error
      if (this.finished) return
      await new Promise<void>(resolve => { this.waiters.push(resolve) })
    }
  }
}

/**
 * 流式执行入口：事件随产生随下发，不等待终态（真流式）。
 *
 * 重试语义与 Rust 原版 `retry_only_before_output` 守卫一致：`start` 之后
 * 首个内容事件下发前，传输/5xx/doom 失败仍按预算静默重试（消费者只会看到
 * 重复的幂等 `start`）；一旦有内容事件下发，任何失败直接浮出，不再重采样。
 * @param config - 执行器配置。
 * @param request - 会话历史与工具面。
 * @returns 终结于 finish（或抛出最终失败）的增量事件流。
 */
export function streamGrokRequest(
  config: GrokAdapterConfig,
  request: GrokExecutionRequest,
): AsyncGenerator<GrokStreamEvent> {
  let delivered = false
  const queue = new GrokEventQueue()
  void executeGrokRequest(config, request, {
    onEvent: event => {
      if (event.type !== 'start') delivered = true
      queue.push(event)
    },
    outputDelivered: () => delivered,
  }).then(
    () => queue.finish(),
    error => queue.fail(error),
  )
  return queue.drain()
}

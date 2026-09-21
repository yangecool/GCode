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

import { translateGrokResponses } from './grok-stream.ts'
import type { GrokStreamEvent } from './grok-stream.ts'
import { buildGrokResponsesRequestBody, GrokWireError, parseGrokSse } from './grok-wire.ts'
import type { GrokHostedToolSpec, GrokWireInputItem, GrokWireRequest } from './grok-wire.ts'
import { historyHasImages, serializeGrokMessages, serializeGrokTools } from './grok-serialize.ts'
import type { GrokFunctionToolSpec, GrokHistoryMessage } from './grok-serialize.ts'
import { createGrokHttpTransport } from './grok-http.ts'
import type { GrokHttpTransport } from './grok-http.ts'

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

/** 一次模型执行请求（ZCode ModelRequest 的结构子集）。 */
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
  attemptSignal: AbortSignal,
): ReadableStream<Uint8Array> {
  const reader = body.getReader()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const timer = setTimeout(() => attemptSignal.abort(), timeoutMs)
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
 * @returns 终态事件序列（含 finish）与逐轮诊断；毒 attempt 不进入结果。
 * @throws GrokWireError 预算耗尽或不可重试失败的最终错误。
 */
export async function executeGrokRequest(
  config: GrokAdapterConfig,
  request: GrokExecutionRequest,
): Promise<GrokExecutionResult> {
  const transport = config.transport ?? createGrokHttpTransport()
  const url = new URL(`${config.baseURL ?? 'https://api.x.ai/v1'}/responses`)
  const maxAttempts = 1 + (config.maxRetries ?? DEFAULT_MAX_RETRIES)
  const doomBudget = config.doomLoopMaxResamples ?? DEFAULT_DOOM_RESAMPLES
  const idleTimeout = config.streamIdleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
  const clientVersion = config.clientVersion ?? '1.0.35'
  const headers: Record<string, string> = {
    authorization: `Bearer ${config.apiKey}`,
    'content-type': 'application/json',
    accept: 'text/event-stream',
    'user-agent': userAgent(clientVersion),
    'x-grok-client-version': clientVersion,
    'x-grok-client-identifier': 'grok-shell',
    ...config.headers,
  }
  const input = serializeGrokMessages(request.messages, { providerId: 'xai', modelId: config.model })
  const tools = serializeGrokTools(request.tools ?? [], config.hostedTools ?? [])

  let recoveryTail: readonly GrokWireInputItem[] = []
  let rateLimitUsed = 0
  let doomUsed = 0
  let rebuilt = false
  const diagnostics: GrokAttemptDiagnostic[] = []

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
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
      const response = await fetchImpl(url, {
        method: 'POST',
        headers,
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
      const code = error instanceof GrokWireError ? error.code : 'UNKNOWN'
      const verdict = classify(error, rateLimitUsed, doomUsed, doomBudget)
      const willRetry = verdict.retry && attempt < maxAttempts
      diagnostics.push({ attempt, code, retried: willRetry })
      if (!willRetry) {
        throw error instanceof GrokWireError ? error : new GrokWireError(String(error), 'UNKNOWN')
      }
      if (code === 'RATE_LIMIT') rateLimitUsed += 1
      if (code === 'DOOM_LOOP') {
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

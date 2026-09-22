/**
 * G Code — 采样循环策略核心（M4-b，移植自 grok-harness loop 纯核）。
 *
 * 引擎内部重试（16 次总尝试）已在 grok-adapter 拥有；本模块拥有**其上**的
 * 会话级恢复层语义：采样耗尽后的 turn 重提交预算（阶梯退避 + 每步/每提示
 * 上限 + 10 分钟墙钟窗口）、length 文本续写（length salvage）决策。
 *
 * 清偿 M1 债务 #3：LENGTH_CONTINUE_REMINDER_BODY 逐字提取；续写条件 =
 * assistant 消息已提交 && finish 为 max-tokens && 无工具调用 && 每轮预算
 * （默认 2 次）未耗尽。
 */

/** 原版 DEFAULT_MAX_RETRIES：重试上限（含首次共 16 次尝试）。 */
export const DEFAULT_MAX_ATTEMPTS = 15
/** 429 总尝试阈值（含首发）。 */
export const RATE_LIMIT_RETRY_THRESHOLD = 2
/** doom-loop 置信 tail-repetition 上限。 */
export const DEFAULT_DOOM_LOOP_MAX_THRESHOLD = 64
/** doom-loop 独立重采样预算。 */
export const DEFAULT_DOOM_LOOP_MAX_RETRIES = 2
/** 服务端检测窗口（tokens）。 */
export const DEFAULT_DOOM_LOOP_WINDOW_TOKENS = 1024
/** 近即时 doom 重采样延迟上限（含）。 */
export const MAX_DOOM_LOOP_DELAY_MS = 250
/** 首次重试传输重建退避（±20% 抖动前）。 */
export const TRANSIENT_REBUILD_BACKOFF_MS = 200
/** 瞬态重试延迟上限。 */
export const MAX_TRANSIENT_DELAY_MS = 30_000
/** 单个采样步骤可用的采样耗尽重提交数。 */
export const MAX_TRANSIENT_TURN_RETRIES = 3
/** 单个人类提示可用的采样耗尽重提交数。 */
export const MAX_TRANSIENT_RETRIES_PER_PROMPT = 10
/** length 续写预算（对齐 grok-build）。 */
export const DEFAULT_LENGTH_SALVAGE = 2
/** 文本响应在输出上限被截断时的继续提醒（逐字）。 */
export const LENGTH_CONTINUE_REMINDER_BODY =
  'Your previous response exceeded the output token limit and was cut off. Continue from exactly where it stopped — or if a newer user message follows this note, answer that instead.'
/** 一次采样耗尽恢复时段的墙钟上限。 */
export const MAX_TRANSIENT_RETRY_WINDOW_MS = 10 * 60 * 1000

const JITTER_LOSS = 0.8
const JITTER_SPAN = 0.4

function jitter(baseMs: number, random: () => number): number {
  const sample = random()
  const bounded = Number.isFinite(sample) ? Math.min(1, Math.max(0, sample)) : 0.5
  return Math.round(baseMs * (JITTER_LOSS + JITTER_SPAN * bounded))
}

/** doom-loop 重采样延迟：0..250ms 均匀采样。 */
export function doomLoopDelay(random: () => number = Math.random): number {
  const sample = random()
  if (!Number.isFinite(sample)) return 0
  return Math.min(MAX_DOOM_LOOP_DELAY_MS, Math.max(0, Math.floor(sample * (MAX_DOOM_LOOP_DELAY_MS + 1))))
}

export interface TransientFailureLike {
  readonly code: string
  /** provider Retry-After 毫秒。 */
  readonly providerRetryAfterMs?: number
  /** HTTP 状态（SERVER 类失败）。 */
  readonly status?: number
}

/**
 * 引擎内瞬态重试延迟：Retry-After 优先（帽 30s）；首次传输失败用重建退避；
 * 否则 2s 指数（帽 30s）。均加 ±20% 抖动。
 */
export function transientDelay(
  attempt: number,
  failure: TransientFailureLike,
  random: () => number = Math.random,
): number {
  const provider = failure.providerRetryAfterMs
  if (provider !== undefined && provider > 0) {
    return Math.min(MAX_TRANSIENT_DELAY_MS, jitter(Math.min(provider, MAX_TRANSIENT_DELAY_MS), random))
  }
  if (attempt === 1 && failure.code === 'TRANSPORT') {
    return jitter(TRANSIENT_REBUILD_BACKOFF_MS, random)
  }
  const base = Math.min(2_000 * 2 ** Math.min(attempt - 1, 1024), MAX_TRANSIENT_DELAY_MS)
  return Math.min(MAX_TRANSIENT_DELAY_MS, jitter(base, random))
}

/** 采样耗尽后的 turn 重提交阶梯：2s → 10s → 30s（±20% 抖动，帽 30s）。 */
export function transientTurnDelay(
  previousAttempts: number,
  random: () => number = Math.random,
): number {
  const ladder = [2_000, 10_000, 30_000] as const
  const base = ladder[Math.min(previousAttempts, ladder.length - 1)] ?? MAX_TRANSIENT_DELAY_MS
  return Math.min(MAX_TRANSIENT_DELAY_MS, jitter(base, random))
}

/** turn 重提交资格：空闲超时/传输/流关闭，或 5xx（525/526 除外）。 */
export function transientTurnEligible(failure: TransientFailureLike): boolean {
  if (failure.code === 'IDLE_TIMEOUT' || failure.code === 'TRANSPORT' || failure.code === 'STREAM_CLOSED') return true
  return failure.code === 'SERVER'
    && failure.status !== undefined
    && failure.status >= 500
    && failure.status !== 525
    && failure.status !== 526
}

// ---------------------------------------------------------------------------
// 预算跟踪（每步 3 / 每提示 10 / 墙钟 10 分钟）
// ---------------------------------------------------------------------------

/** 采样耗尽恢复预算（每会话独立；turn/step 结束时按宿主事件清账）。 */
export class TransientRetryBudget {
  private readonly maxPerStep: number
  private readonly maxPerPrompt: number
  private readonly windowMs: number
  private readonly now: () => number
  private perPrompt = 0
  private readonly perStep = new Map<string, number>()
  private windowStartedAt: number | undefined

  constructor(
    maxPerStep: number = MAX_TRANSIENT_TURN_RETRIES,
    maxPerPrompt: number = MAX_TRANSIENT_RETRIES_PER_PROMPT,
    windowMs: number = MAX_TRANSIENT_RETRY_WINDOW_MS,
    now: () => number = Date.now,
  ) {
    this.maxPerStep = maxPerStep
    this.maxPerPrompt = maxPerPrompt
    this.windowMs = windowMs
    this.now = now
  }

  /** 是否还允许一次 turn 重提交（会推进预算窗口）。 */
  allow(turn: number, step: number): boolean {
    const at = this.now()
    if (this.windowStartedAt !== undefined && at - this.windowStartedAt > this.windowMs) {
      this.reset()
    }
    const stepKey = `${turn}:${step}`
    const stepUsed = this.perStep.get(stepKey) ?? 0
    if (stepUsed >= this.maxPerStep) return false
    if (this.perPrompt >= this.maxPerPrompt) return false
    this.windowStartedAt ??= at
    this.perStep.set(stepKey, stepUsed + 1)
    this.perPrompt += 1
    return true
  }

  /** 步/轮结束清账（宿主 session 事件接线点）。 */
  endStep(turn: number, step: number): void {
    this.perStep.delete(`${turn}:${step}`)
  }

  /** 轮结束：整轮与每提示计数复位。 */
  endTurn(): void {
    this.reset()
  }

  reset(): void {
    this.perPrompt = 0
    this.perStep.clear()
    this.windowStartedAt = undefined
  }
}

// ---------------------------------------------------------------------------
// length 文本续写（length salvage）决策
// ---------------------------------------------------------------------------

/** 一次 assistant 流的续写判定输入。 */
export interface LengthSalvageFacts {
  /** assistant 消息已提交进会话。 */
  readonly committedMessage: boolean
  /** finish 原因为输出上限截断（max-tokens/length）。 */
  readonly maxTokens: boolean
  /** 该 assistant 流中出现过任一工具调用。 */
  readonly sawToolCall: boolean
  /** 本轮已用掉的续写次数。 */
  readonly used: number
  /** 续写预算；默认 2。 */
  readonly budget?: number
}

/**
 * 是否应注入继续提醒（steer 一条 LENGTH_CONTINUE_REMINDER_BODY 用户消息）。
 * 原版条件四联：已提交 + max-tokens + 无工具调用 + 预算未耗尽。
 */
export function shouldLengthSalvage(facts: LengthSalvageFacts): boolean {
  if (!facts.committedMessage || !facts.maxTokens || facts.sawToolCall) return false
  return facts.used < (facts.budget ?? DEFAULT_LENGTH_SALVAGE)
}

/** 续写 steer 消息体（原版 createUserMessage 的 content 文本）。 */
export function lengthSalvageMessage(): string {
  return LENGTH_CONTINUE_REMINDER_BODY
}

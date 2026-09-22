/**
 * G Code — Grok 全量替换压缩（M4-a，移植自 grok-harness compaction 纯核 +
 * grok-build `xai-grok-compaction` 对账补全）。
 *
 * Rust 对账补全（harness TS 未显式移植的事实）：
 * - `DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT = 85`（config.rs；grok-build 与
 *   Grok chat 两侧同为 ~85% 触发）。
 * - `MIN_SUMMARY_SEED_CHARS = 500`：清洗后的 summary 种子短于该值视为退化，
 *   按瞬态失败重试（观测到的最小健康值 ~3242 字符）。
 * - `FullReplaceConfig` 默认：3 次总尝试、3s 重试间隔、120s 采样超时。
 * - per-model 请求头协同：`x-compaction-at`（token 数 = context_window ×
 *   threshold% / 100，或常量 N）、`x-compactions-remaining`（未压缩前缀为 1，
 *   已压缩为 0）——引擎请求头接线记入债务（目录旗标驱动）。
 *
 * 保留尾部 = 最后一条真实用户查询及其后的消息；之前的全部内容用独立压缩
 * 采样总结（COMPACT_SYSTEM_PROMPT，非活 system/tools 的 KV-cache 重放）。
 */

/** Rust config.rs 同名常量。 */
export const DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT = 85
export const MIN_SUMMARY_SEED_CHARS = 500

/** Rust FullReplaceConfig 默认值。 */
export const GROK_FULL_REPLACE_DEFAULTS = {
  maxAttempts: 3,
  retryDelaySecs: 3,
  samplingTimeoutSecs: 120,
} as const

/** 压缩阈值解析：显式百分比 → 目录旗标 → 原版默认 85。 */
export function resolveAutoCompactThresholdPercent(
  configured?: number,
): number {
  if (configured === undefined) return DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT
  if (!Number.isInteger(configured) || configured < 1 || configured > 100) {
    throw new Error(`grok-compaction: threshold percent must be an integer in 1..100, got ${String(configured)}`)
  }
  return configured
}

/** 压缩是否应触发（Rust 判定为 tokens/contextWindow ≥ ratio）。 */
export function shouldAutoCompact(
  totalTokens: number,
  contextWindow: number,
  thresholdPercent = DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT,
): boolean {
  if (contextWindow <= 0) return false
  return totalTokens / contextWindow >= thresholdPercent / 100
}

// ---------------------------------------------------------------------------
// 采样提示（code_compaction/prompt.rs 的 9 段全量替换指令）
// ---------------------------------------------------------------------------

/** `/compact <instructions>` 的用户上下文拼接（prompt.rs 同形）。 */
export function userContextSection(instructions: string | undefined): string {
  if (instructions === undefined || instructions.trim().length === 0) return ''
  return `\n\n**User-provided context for this compaction:**\n${instructions.trim()}\n\nPlease incorporate this context into your summary, ensuring it is prominently addressed in the relevant sections.\n\n`
}

/** 独立压缩采样用的 system prompt。 */
export const COMPACT_SYSTEM_PROMPT =
  'You are an AI coding agent. Summarize the conversation so another coding agent can continue the work. Preserve file paths, decisions, errors, and the current task. Do not mention this summarization request.'

/** 9 段全量替换 summary 指令（用户轮）。 */
export function buildSummaryPrompt(instructions?: string): string {
  return `You are compacting an earlier coding-agent conversation into a successor note.

Write a structured summary with these sections when they have content:

1. Goal and current task
2. Key decisions and constraints
3. Files and code sections already touched
4. Errors, tests, and remaining failures
5. User messages that still bind the work
6. Pending tasks and TODOs
7. Running background work, loops, subagents, and workflows that must survive
8. Open questions
9. Next concrete steps
${userContextSection(instructions)}
Preserve exact file paths, identifiers, commands, and error text. Do not mention this summarization request.`
}

/** summary 种子是否退化（短于 MIN_SUMMARY_SEED_CHARS 按瞬态失败重试）。 */
export function isDegenerateSummarySeed(cleanedSummary: string): boolean {
  return cleanedSummary.trim().length < MIN_SUMMARY_SEED_CHARS
}

// ---------------------------------------------------------------------------
// 全量替换装配（code_compaction/assemble.rs 同形）
// ---------------------------------------------------------------------------

export interface FullReplaceParts {
  readonly lastUserQuery?: string
  readonly recent: readonly string[]
  readonly summary: string
  readonly agentsMd?: string
  readonly reminder?: string
}

/** 重建对话体：[agentsMd?, lastUserQuery?, recent..., summary, reminder?]。 */
export function assembleFullReplaceBody(parts: FullReplaceParts): string {
  const sections = [
    parts.agentsMd === undefined ? undefined : parts.agentsMd,
    parts.lastUserQuery === undefined ? undefined : parts.lastUserQuery,
    ...parts.recent,
    parts.summary,
    parts.reminder === undefined ? undefined : parts.reminder,
  ].filter((section): section is string => section !== undefined && section.length > 0)
  return sections.join('\n\n')
}

// ---------------------------------------------------------------------------
// 压缩后 / 冷恢复 reminder（reminder.rs 移植）
// ---------------------------------------------------------------------------

/** 模型可见 poll/cancel 工具名。 */
export interface SubagentToolNames {
  readonly poll: string
  readonly cancel: string
}

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'

export interface TodoItem {
  readonly id: string
  readonly content: string
  readonly status: TodoStatus
}

export interface BackgroundTask {
  readonly taskId: string
  readonly command: string
  readonly status: string
  readonly toolName?: string
}

export interface RunningSubagent {
  readonly subagentId: string
  readonly subagentType?: string
  readonly description?: string
  readonly elapsedSecs: number
}

export interface ScheduledLoop {
  readonly taskId: string
  readonly interval: string
  readonly nextFireAt: string
  readonly prompt: string
}

export interface WorkflowRun {
  readonly name: string
  readonly runId: string
  readonly status: string
  readonly objective?: string
  readonly currentPhase?: string
  readonly agentsUsed: number
  readonly agentBudget?: number
  readonly elapsedSecs: number
}

export interface ActiveAgentReminderState {
  readonly runningCommands?: readonly BackgroundTask[]
  readonly todos?: readonly TodoItem[]
  readonly runningSubagents?: readonly RunningSubagent[]
  readonly scheduledLoops?: readonly ScheduledLoop[]
  readonly workflows?: readonly WorkflowRun[]
  readonly workflowTool?: string
}

function collapsedWs(value: string): string {
  return value.replace(/\s+/gu, ' ').trim()
}

function formatBackgroundTaskLine(task: BackgroundTask): string {
  return task.toolName === undefined
    ? `- "${task.taskId}": \`${task.command}\` (${task.status})`
    : `- "${task.taskId}": \`${task.command}\` (${task.status}, ${task.toolName})`
}

function formatScheduledLoopLine(loop: ScheduledLoop): string {
  return `- "${loop.taskId}": \`${collapsedWs(loop.prompt)}\` (scheduler runs ${loop.interval}, next ${loop.nextFireAt})`
}

function formatSubagentLine(subagent: RunningSubagent): string {
  const command = collapsedWs(subagent.description ?? subagent.subagentType ?? 'subagent')
  const kind = subagent.subagentType ?? 'subagent'
  return `- "${subagent.subagentId}": \`${command}\` (running for ${String(subagent.elapsedSecs)}s, ${kind})`
}

function formatWorkflowLine(run: WorkflowRun): string {
  const bits = [
    `status: ${run.status}`,
    run.objective === undefined ? undefined : `objective: ${run.objective}`,
    run.currentPhase === undefined ? undefined : `phase: ${run.currentPhase}`,
    `agents ${String(run.agentsUsed)}${run.agentBudget === undefined ? '' : `/${String(run.agentBudget)}`}`,
    `${String(run.elapsedSecs)}s`,
  ].filter((bit): bit is string => bit !== undefined)
  return `- Workflow '${run.name}' (run id \`${run.runId}\`) — ${bits.join(', ')}`
}

function todoTag(status: TodoStatus): string {
  switch (status) {
    case 'pending': return '[pending]'
    case 'in_progress': return '[in_progress]'
    case 'completed': return '[completed]'
    case 'cancelled': return '[cancelled]'
  }
}

function isActionable(status: TodoStatus): boolean {
  return status === 'pending' || status === 'in_progress'
}

export function sectionRunningBackground(state: ActiveAgentReminderState): string | undefined {
  const lines = [
    ...(state.runningCommands ?? []).map(formatBackgroundTaskLine),
    ...(state.scheduledLoops ?? []).map(formatScheduledLoopLine),
  ]
  if (lines.length === 0) return undefined
  return `## Running Background Tasks\nThese tasks are still running:\n${lines.join('\n')}`
}

export function sectionWorkflows(state: ActiveAgentReminderState): string | undefined {
  const workflows = state.workflows ?? []
  if (workflows.length === 0) return undefined
  const tool = state.workflowTool ?? 'workflow'
  const lines = workflows.map(formatWorkflowLine).join('\n')
  return `## Running Workflows\nThese workflow runs were launched before this compaction and are still running. Use \`${tool}\` to inspect or resume them.\n${lines}`
}

export function sectionTodoList(todos: readonly TodoItem[]): string | undefined {
  const active = todos
    .filter(todo => isActionable(todo.status))
    .map(todo => `- ${todoTag(todo.status)} ${todo.id}: ${todo.content}`)
  if (active.length === 0) return undefined
  const completed = todos.filter(todo => todo.status === 'completed').length
  const cancelled = todos.filter(todo => todo.status === 'cancelled').length
  const trailer = completed === 0 && cancelled === 0
    ? ''
    : completed > 0 && cancelled === 0
      ? `\n(${String(completed)} completed)`
      : completed === 0
        ? `\n(${String(cancelled)} cancelled)`
        : `\n(${String(completed)} completed, ${String(cancelled)} cancelled)`
  return `## TODO List\nThis is your task list from before the conversation was compacted — it is still active. Keep working through the items below and update their status as you make progress:\n${active.join('\n')}${trailer}`
}

export function sectionRunningSubagents(
  subagents: readonly RunningSubagent[],
  tools: SubagentToolNames,
): string | undefined {
  if (subagents.length === 0) return undefined
  const lines = subagents.map(formatSubagentLine).join('\n')
  return `## Running Subagents\nThese subagents were launched before this compaction and are still running. Use \`${tools.poll}\` with the subagent_id to check their status or retrieve results. Use \`${tools.cancel}\` with the subagent_id to cancel a subagent.\n${lines}`
}

export function wrapSystemReminder(sections: readonly (string | undefined)[]): string | undefined {
  const body = sections
    .filter((section): section is string => section !== undefined && section.trim().length > 0)
    .join('\n\n')
  if (body.length === 0) return undefined
  return `<system-reminder>\n${body}\n</system-reminder>`
}

/** GCode 活工具面的 poll/cancel 名（原版默认为 grok-build 工具名）。 */
export const GCODE_SUBAGENT_TOOLS: SubagentToolNames = {
  poll: 'TaskOutput',
  cancel: 'TaskStop',
}

/** 压缩后全量 active-state reminder。 */
export function formatActiveAgentReminder(
  state: ActiveAgentReminderState,
  subagentTools: SubagentToolNames = GCODE_SUBAGENT_TOOLS,
): string | undefined {
  return wrapSystemReminder([
    sectionRunningBackground(state),
    sectionWorkflows(state),
    sectionTodoList(state.todos ?? []),
    sectionRunningSubagents(state.runningSubagents ?? [], subagentTools),
  ])
}

/** 冷恢复 reminder（进程退出后恢复会话，1.0.19 语义）。 */
export function formatResumeReminder(state: ActiveAgentReminderState): string | undefined {
  const parts: string[] = ['This session was resumed after the previous process exited.']
  const loops = state.scheduledLoops ?? []
  if (loops.length > 0) {
    parts.push(`## Loops\nThese loops are still scheduled despite the restart:\n${loops.map(formatScheduledLoopLine).join('\n')}`)
  }
  const commands = state.runningCommands ?? []
  if (commands.length > 0) {
    parts.push(`## Background commands\nThese commands were killed when the session stopped:\n${commands.map(formatBackgroundTaskLine).join('\n')}`)
  }
  const subagents = state.runningSubagents ?? []
  if (subagents.length > 0) {
    parts.push(`## Subagents\nThese subagents were cancelled when the session stopped:\n${subagents.map(formatSubagentLine).join('\n')}`)
  }
  const workflows = state.workflows ?? []
  if (workflows.length > 0) {
    parts.push(`## Workflows\nThese workflow runs were cancelled when the session stopped:\n${workflows.map(formatWorkflowLine).join('\n')}`)
  }
  if (parts.length === 1) return undefined
  return wrapSystemReminder([parts.join('\n\n')])
}

/** G Code — hosted 工具部署解析器 + compaction 核心 + loop 策略测试。 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveGrokHostedTools } from '../../src/grok/grok-hosted-tools.ts'
import {
  DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT,
  MIN_SUMMARY_SEED_CHARS,
  assembleFullReplaceBody,
  buildSummaryPrompt,
  formatActiveAgentReminder,
  formatResumeReminder,
  isDegenerateSummarySeed,
  resolveAutoCompactThresholdPercent,
  shouldAutoCompact,
  userContextSection,
} from '../../src/grok/grok-compaction.ts'
import {
  LENGTH_CONTINUE_REMINDER_BODY,
  TransientRetryBudget,
  doomLoopDelay,
  shouldLengthSalvage,
  transientDelay,
  transientTurnDelay,
  transientTurnEligible,
} from '../../src/grok/grok-loop.ts'

// ---------------------------------------------------------------------------
// hosted-tools
// ---------------------------------------------------------------------------

test('hosted tools resolve owned entries with policies', () => {
  assert.deepEqual(resolveGrokHostedTools({}), [])
  assert.deepEqual(resolveGrokHostedTools({ owned: ['web_search'] }), [
    { wireName: 'web_search', entry: { type: 'web_search' } },
  ])
  assert.deepEqual(resolveGrokHostedTools({
    owned: ['web_search', 'x_search'],
    webSearch: { allowedDomains: ['Example.COM.'] },
    xSearch: { fromDate: '2026-01-01', toDate: '2026-02-01' },
  }), [
    { wireName: 'web_search', entry: { type: 'web_search', filters: { allowed_domains: ['example.com'] } } },
    { wireName: 'x_search', entry: { type: 'x_search', from_date: '2026-01-01', to_date: '2026-02-01' } },
  ])
})

test('hosted tools reject invalid policies fail-loud', () => {
  const message = (fn: () => unknown): string => {
    try { fn(); return '' } catch (error) { return error instanceof Error ? error.message : String(error) }
  }
  assert.ok(message(() => resolveGrokHostedTools({ owned: ['web_search', 'web_search'] })).includes('duplicates'))
  assert.ok(message(() => resolveGrokHostedTools({ owned: ['code_interpreter' as never] })).includes('unknown hosted tool'))
  assert.ok(message(() => resolveGrokHostedTools({
    owned: ['web_search'],
    webSearch: { allowedDomains: ['a.com'], excludedDomains: ['b.com'] },
  })).includes('mutually exclusive'))
  assert.ok(message(() => resolveGrokHostedTools({
    owned: ['web_search'],
    webSearch: { allowedDomains: ['a.com', 'b.com', 'c.com', 'd.com', 'e.com', 'f.com'] },
  })).includes('at most 5'))
  assert.ok(message(() => resolveGrokHostedTools({
    owned: ['web_search'],
    webSearch: { allowedDomains: ['a.com', 'a.com'] },
  })).includes('duplicate'))
  assert.ok(message(() => resolveGrokHostedTools({
    owned: ['x_search'],
    xSearch: { fromDate: '2026-13-01' },
  })).includes('valid calendar date'))
  assert.ok(message(() => resolveGrokHostedTools({
    owned: ['x_search'],
    xSearch: { fromDate: '2026-05-01', toDate: '2026-04-01' },
  })).includes('must not be after'))
  assert.ok(message(() => resolveGrokHostedTools({
    webSearch: { allowedDomains: ['a.com'] },
  })).includes('requires owned web_search'))
})

// ---------------------------------------------------------------------------
// compaction
// ---------------------------------------------------------------------------

test('compaction threshold resolves and triggers at the original ratio', () => {
  assert.equal(resolveAutoCompactThresholdPercent(), DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT)
  assert.equal(resolveAutoCompactThresholdPercent(80), 80)
  assert.throws(() => resolveAutoCompactThresholdPercent(0))
  assert.throws(() => resolveAutoCompactThresholdPercent(101))
  assert.equal(shouldAutoCompact(84_999, 100_000), false)
  assert.equal(shouldAutoCompact(85_000, 100_000), true)
  assert.equal(shouldAutoCompact(424_999, 500_000, 85), false)
  assert.equal(shouldAutoCompact(425_000, 500_000, 85), true)
})

test('summary prompt carries nine sections and the user-context splice', () => {
  const bare = buildSummaryPrompt()
  assert.equal(bare.match(/\n\d+\. /g)?.length, 9)
  assert.ok(!bare.includes('User-provided context'))
  const withContext = buildSummaryPrompt('focus on the parser')
  assert.ok(withContext.includes('**User-provided context for this compaction:**\nfocus on the parser'))
  assert.equal(userContextSection(undefined), '')
  assert.equal(isDegenerateSummarySeed('x'.repeat(MIN_SUMMARY_SEED_CHARS - 1)), true)
  assert.equal(isDegenerateSummarySeed('x'.repeat(MIN_SUMMARY_SEED_CHARS)), false)
})

test('full-replace body orders agentsMd, last query, recent, summary, reminder', () => {
  assert.equal(assembleFullReplaceBody({
    recent: ['r1', 'r2'],
    summary: 'SUMMARY',
  }), 'r1\n\nr2\n\nSUMMARY')
  assert.equal(assembleFullReplaceBody({
    lastUserQuery: 'Q',
    recent: ['r'],
    summary: 'S',
    agentsMd: '# AGENTS',
    reminder: '<system-reminder>r</system-reminder>',
  }), '# AGENTS\n\nQ\n\nr\n\nS\n\n<system-reminder>r</system-reminder>')
})

test('active-agent reminder renders only non-empty sections', () => {
  assert.equal(formatActiveAgentReminder({}), undefined)
  const reminder = formatActiveAgentReminder({
    runningCommands: [{ taskId: 'b1', command: 'npm test', status: 'running' }],
    todos: [
      { id: '1', content: 'port engine', status: 'completed' },
      { id: '2', content: 'write tests', status: 'in_progress' },
    ],
    runningSubagents: [{ subagentId: 'a1', elapsedSecs: 30, description: 'scan files' }],
  })
  assert.ok(reminder?.startsWith('<system-reminder>'))
  assert.ok(reminder?.includes('## Running Background Tasks'))
  assert.ok(reminder?.includes('- "b1": `npm test` (running)'))
  assert.ok(reminder?.includes('## TODO List'))
  assert.ok(reminder?.includes('- [in_progress] 2: write tests'))
  assert.ok(reminder?.includes('(1 completed)'))
  assert.ok(reminder?.includes('## Running Subagents'))
  assert.ok(reminder?.includes('`TaskOutput` with the subagent_id'))
  const resume = formatResumeReminder({
    runningCommands: [{ taskId: 'b1', command: 'npm test', status: 'killed' }],
  })
  assert.ok(resume?.includes('This session was resumed after the previous process exited.'))
  assert.ok(resume?.includes('## Background commands'))
  assert.equal(formatResumeReminder({}), undefined)
})

// ---------------------------------------------------------------------------
// loop 策略
// ---------------------------------------------------------------------------

test('transient delays honor Retry-After, rebuild backoff, and ladders', () => {
  const fixed = (): number => 0.5
  assert.equal(transientDelay(3, { code: 'RATE_LIMIT', providerRetryAfterMs: 5_000 }, fixed), 5_000)
  assert.equal(transientDelay(1, { code: 'TRANSPORT' }, fixed), 200)
  assert.equal(transientDelay(2, { code: 'SERVER' }, fixed), 4_000)
  assert.equal(transientTurnDelay(0, fixed), 2_000)
  assert.equal(transientTurnDelay(1, fixed), 10_000)
  assert.equal(transientTurnDelay(99, fixed), 30_000)
  assert.equal(transientTurnEligible({ code: 'IDLE_TIMEOUT' }), true)
  assert.equal(transientTurnEligible({ code: 'SERVER', status: 503 }), true)
  assert.equal(transientTurnEligible({ code: 'SERVER', status: 525 }), false)
  assert.equal(transientTurnEligible({ code: 'RATE_LIMIT', status: 429 }), false)
  assert.ok(doomLoopDelay(() => 0.999) <= 250)
  assert.equal(doomLoopDelay(() => 0), 0)
})

test('transient retry budget enforces per-step, per-prompt, and window caps', () => {
  let at = 0
  const budget = new TransientRetryBudget(3, 10, 1_000, () => at)
  assert.equal(budget.allow(1, 1), true)
  assert.equal(budget.allow(1, 1), true)
  assert.equal(budget.allow(1, 1), true)
  assert.equal(budget.allow(1, 1), false)
  budget.endStep(1, 1)
  assert.equal(budget.allow(1, 2), true)
  at = 2_000
  assert.equal(budget.allow(1, 3), true)
  budget.endTurn()
  assert.equal(budget.allow(2, 1), true)
})

test('length salvage requires committed max-tokens text without tool calls', () => {
  assert.equal(shouldLengthSalvage({ committedMessage: true, maxTokens: true, sawToolCall: false, used: 0 }), true)
  assert.equal(shouldLengthSalvage({ committedMessage: true, maxTokens: true, sawToolCall: true, used: 0 }), false)
  assert.equal(shouldLengthSalvage({ committedMessage: false, maxTokens: true, sawToolCall: false, used: 0 }), false)
  assert.equal(shouldLengthSalvage({ committedMessage: true, maxTokens: false, sawToolCall: false, used: 0 }), false)
  assert.equal(shouldLengthSalvage({ committedMessage: true, maxTokens: true, sawToolCall: false, used: 2 }), false)
  assert.ok(LENGTH_CONTINUE_REMINDER_BODY.includes('Continue from exactly where it stopped'))
})

// ---------------------------------------------------------------------------
// H11 开放注册
// ---------------------------------------------------------------------------

test('hosted tools accept extra open-registry wire names with validated entries', () => {
  const specs = resolveGrokHostedTools({
    owned: ['web_search'],
    extra: {
      future_hosted_tool: { type: 'future_hosted_tool', enabled: true },
    },
  })
  // extra 名不在封闭集：登记即透传（wire 层 hostedWireTool 校验在请求侧 fail-loud）。
  assert.deepEqual(specs.at(-1), {
    wireName: 'future_hosted_tool',
    entry: { type: 'future_hosted_tool', enabled: true },
  })
})

test('hosted tools still reject unregistered names', () => {
  assert.throws(
    () => resolveGrokHostedTools({ owned: ['code_interpreter' as never] }),
    /unknown hosted tool/,
  )
})

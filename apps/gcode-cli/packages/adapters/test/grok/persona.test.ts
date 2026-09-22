/** G Code — persona 系统提示解析器测试（分支结构对齐 Rust MiniJinja 模板）。 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  GCODE_DEFAULT_TOOL_KINDS,
  GROK_DEFAULT_PERSONA_LABEL,
  buildGrokPersonaPrompt,
  buildGrokSubagentPrompt,
} from '../../src/grok/grok-persona.ts'

test('persona renders identity, work policy, and cwd with default branches off', () => {
  const prompt = buildGrokPersonaPrompt({ cwd: '/work/repo' })
  assert.ok(prompt.startsWith(`You are ${GROK_DEFAULT_PERSONA_LABEL} released by xAI. You are an interactive CLI tool`))
  assert.ok(prompt.includes("complete the user's request."))
  assert.ok(!prompt.includes('<user_query>'))
  assert.ok(!prompt.includes('<memory>'))
  assert.ok(!prompt.includes('<background_tasks>'))
  assert.ok(!prompt.includes('<browser_verification>'))
  assert.ok(prompt.includes('<user_guide>'))
  assert.ok(prompt.endsWith('Your working directory is /work/repo.'))
})

test('persona non-interactive switches wording and drops the user guide', () => {
  const prompt = buildGrokPersonaPrompt({ cwd: '/w', isNonInteractive: true })
  assert.ok(prompt.includes('an autonomous agent that completes software engineering tasks. There is no human operator in this session.'))
  assert.ok(!prompt.includes('<user_guide>'))
})

test('persona user_query tag and tool branches resolve from live kinds', () => {
  const prompt = buildGrokPersonaPrompt({
    cwd: '/w',
    userQueryTagged: true,
    tools: GCODE_DEFAULT_TOOL_KINDS,
    systemRemindersEnabled: true,
  })
  assert.ok(prompt.includes(', denoted within the <user_query> tag.'))
  assert.ok(prompt.includes('make the `Agent` calls near the start'))
  assert.ok(prompt.includes('as a background command in `Bash`'))
  assert.ok(prompt.includes('; its completion is reported to you'))
  assert.ok(prompt.includes('`TaskOutput` for watch processes'))
  // 无 task 工具时子代理句省略。
  const noTask = buildGrokPersonaPrompt({ cwd: '/w', tools: { execute: 'Bash' } })
  assert.ok(!noTask.includes('subagents or delegate'))
})

test('persona memory_v2 section resolves paths and edit tool clause', () => {
  const prompt = buildGrokPersonaPrompt({
    cwd: '/w',
    memoryV2: { globalPath: '~/.gcode/memory-v2/global', workspacePath: '~/.gcode/memory-v2/workspaces/repo-ab12cd34' },
    tools: { search: 'Grep', read: 'Read', edit: 'Edit' },
  })
  assert.ok(prompt.includes('<memory>'))
  assert.ok(prompt.includes('`~/.gcode/memory-v2/global/topics/` — maintained Markdown notes'))
  assert.ok(prompt.includes(': `Grep` to search, `Read` to read, and `Edit` to create or edit Markdown files.'))
  // write 回退：无 edit 时用 write 名。
  const writeOnly = buildGrokPersonaPrompt({
    cwd: '/w',
    memoryV2: { globalPath: '/g', workspacePath: '/ws' },
    tools: { write: 'Write' },
  })
  assert.ok(writeOnly.includes('and `Write` to create or edit Markdown files.'))
})

test('subagent prompt branches on hashline workflow and background param', () => {
  const base = buildGrokSubagentPrompt({
    osName: 'linux', shellPath: '/bin/bash', workingDirectory: '/w', currentDate: '2026-09-21',
  })
  assert.ok(base.includes('You are a G Code subagent'))
  assert.ok(!base.includes('hashline workflow'))
  assert.ok(!base.includes('<background_tasks>'))
  assert.ok(base.includes('Do not reproduce, summarize, paraphrase'))

  const hashline = buildGrokSubagentPrompt({
    osName: 'linux', shellPath: '/bin/bash', workingDirectory: '/w', currentDate: '2026-09-21',
    tools: { read: 'hashline_read', edit: 'hashline_edit', search: 'hashline_grep', execute: 'run_terminal_command' },
    hashlineWorkflow: true,
    executeBackgroundParam: 'run_in_background',
    roleInstructions: 'Review only.',
  })
  assert.ok(hashline.includes('Prefer the hashline workflow'))
  assert.ok(hashline.includes('edits are atomic'))
  assert.ok(hashline.includes('`run_in_background: true` in run_terminal_command'))
  assert.ok(hashline.includes('ANCHOR→CONTENT'))
  assert.ok(hashline.includes('<role-instructions>\nReview only.\n</role-instructions>'))
})

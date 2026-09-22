/** G Code — 工具接线回归：memory_search/get 与 HashlineEdit 的 ToolEntry 行为。 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateAnchors, renderAnchor, splitLines } from '@zcode/adapters/grok-hashline'
import {
  hashlineEditToolEntry,
} from '../../src/tool/handlers/grok-hashline-edit.js'
import {
  memoryGetToolEntry,
  memorySearchToolEntry,
} from '../../src/tool/handlers/grok-memory.js'
import type { ToolExecutionContext } from '../../src/tool/types.js'

function context(cwd: string): ToolExecutionContext {
  return { workingDirectory: cwd } as ToolExecutionContext
}

test('memory_search finds keyword hits across scopes with advisory', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gcode-mem-'))
  const cwd = await mkdtemp(join(tmpdir(), 'gcode-ws-'))
  process.env.GCODE_HOME = home
  try {
    const globalTopic = join(home, 'memory-v2', 'global', 'topics', 'engine.md')
    await mkdir(join(home, 'memory-v2', 'global', 'topics'), { recursive: true })
    await mkdir(join(home, 'memory-v2', 'global'), { recursive: true })
    await mkdir(join(globalTopic, '..'), { recursive: true })
    await writeFile(globalTopic, '# Grok engine notes\nNative executor bypasses the SDK.\n')
    const workspaceIndex = join(home, 'memory-v2', 'workspaces')
    await mkdir(workspaceIndex, { recursive: true })

    const output = await memorySearchToolEntry.handler(
      // 查询词避开生成的 MEMORY.md 索引（含 "Grok" 字样），只命中主题文件。
      { query: 'bypasses' },
      context(cwd),
    ) as Record<string, unknown>
    assert.ok(Array.isArray(output['results']))
    assert.equal((output['results'] as Array<{ id: string }>).length, 1)
    assert.match(String((output['results'] as Array<{ id: string }>)[0]?.id), /global:topics\/engine\.md/)
    assert.match(String(output['advisory']), /historical context/)
  } finally {
    delete process.env.GCODE_HOME
    await rm(home, { recursive: true, force: true })
    await rm(cwd, { recursive: true, force: true })
  }
})

test('memory_get reads by id and fails closed on unknown ids', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gcode-mem-'))
  const cwd = await mkdtemp(join(tmpdir(), 'gcode-ws-'))
  process.env.GCODE_HOME = home
  try {
    const globalDir = join(home, 'memory-v2', 'global')
    await mkdir(join(globalDir, 'topics'), { recursive: true })
    await writeFile(join(globalDir, 'topics', 'notes.md'), '# Notes\nGrok notes body\n')

    const output = await memoryGetToolEntry.handler(
      { id: 'global:topics/notes.md' },
      context(cwd),
    ) as Record<string, unknown>
    assert.match(String(output['content']), /Grok notes body/)

    const missing = await memoryGetToolEntry.handler(
      { id: 'global:topics/absent.md' },
      context(cwd),
    ) as { result?: false; message?: string }
    assert.equal(missing.result, false)
    assert.match(String(missing.message), /absent\.md/)
  } finally {
    delete process.env.GCODE_HOME
    await rm(home, { recursive: true, force: true })
    await rm(cwd, { recursive: true, force: true })
  }
})

test('HashlineEdit applies atomic batches and reports stale anchors', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gcode-hl-'))
  const file = join(dir, 'sample.ts')
  await writeFile(file, 'const alpha = 1\nconst beta = 2\nconst gamma = 3\n')

  // 锚点必须从文件的精确行集生成（含尾随空行——它参与 chunk 指纹）。
  const anchors = generateAnchors(
    splitLines(await readFile(file, 'utf8')),
    { startLine: 1 },
  )
  const anchorOf = (line: number): string => {
    const found = anchors.find(anchor => anchor.line === line)
    assert.ok(found !== undefined)
    // chunk 方案的完整锚点带 context 段（Read 输出同形）。
    return renderAnchor(found)
  }

  const applied = await hashlineEditToolEntry.handler(
    {
      file_path: file,
      edits: [
        { op: 'replace', anchor: anchorOf(2), content: 'const beta = 20' },
      ],
    },
    context(dir),
  ) as Record<string, unknown>
  assert.equal(applied['status'], 'ok')
  assert.equal(applied['applied'], 1)
  assert.match(await readFile(file, 'utf8'), /const beta = 20/)

  // 过期锚点：内容已变，原锚点必须整批拒绝并给出当前上下文。
  const stale = await hashlineEditToolEntry.handler(
    {
      file_path: file,
      edits: [
        { op: 'replace', anchor: anchorOf(2), content: 'const beta = 999' },
      ],
    },
    context(dir),
  ) as Record<string, unknown>
  assert.equal(stale['status'], 'error')
  assert.equal(stale['error'], 'stale_anchor')
  assert.match(await readFile(file, 'utf8'), /const beta = 20/)

  await rm(dir, { recursive: true, force: true })
})

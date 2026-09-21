/** G Code — 隔离 v2 记忆存储测试（临时目录驱动）。 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  formatMemorySearchHit,
  getMemoryFile,
  listMemoryFiles,
  memoryV2Root,
  openMemoryStore,
  searchMemoryFiles,
  workspaceHashName,
} from '../../src/grok/grok-memory.ts'

test('workspace hash name is slug plus stable hash8', () => {
  const name = workspaceHashName('/disk/ssd1/codecache/my-repo')
  assert.match(name, /^my-repo-[0-9a-f]{8}$/u)
  assert.equal(workspaceHashName('/disk/ssd1/codecache/my-repo'), name)
  // 非法字符折叠为 '-'（空格与 '!' 各贡献一个）。
  assert.match(workspaceHashName('/x/My Repo!'), /^My-Repo--+[0-9a-f]{8}$/u)
})

test('memory root prefers GCODE_HOME and falls back to ~/.gcode', () => {
  assert.equal(memoryV2Root('/custom/home'), '/custom/home/memory-v2')
  const previous = process.env.GCODE_HOME
  process.env.GCODE_HOME = '/env/home'
  try {
    assert.equal(memoryV2Root(), '/env/home/memory-v2')
  } finally {
    if (previous === undefined) delete process.env.GCODE_HOME
    else process.env.GCODE_HOME = previous
  }
})

test('store initializes scopes, lists, and searches markdown notes', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gcode-memory-'))
  const cwd = await mkdtemp(join(tmpdir(), 'gcode-ws-'))
  try {
    const store = await openMemoryStore(cwd, home)
    await writeFile(join(store.workspaceDir, 'topics', 'engine.md'), '# Engine\nGrok engine port lives in adapters.', 'utf8')
    await writeFile(join(store.globalDir, 'topics', 'style.md'), 'Prefer plain prose over tables.', 'utf8')
    await writeFile(join(store.workspaceDir, 'archive', 'old.txt'), 'ignored non-markdown', 'utf8')

    const files = await listMemoryFiles(store)
    // 生成式 MEMORY.md 清单本身也是 .md，计入列表（原版行为）。
    assert.equal(files.length, 4)
    assert.ok(files.some(file => file.id === 'workspace:topics/engine.md'))
    assert.ok(files.some(file => file.id === 'global:MEMORY.md'))

    const hits = searchMemoryFiles(files, 'grok engine')
    // MEMORY.md 清单文本含 "Grok"，也命中（score 1）；主题文件双词最高分。
    assert.equal(hits.length, 3)
    assert.equal(hits[0]?.id, 'workspace:topics/engine.md')
    assert.equal(hits[0]?.score, 2)
    assert.ok(formatMemorySearchHit(hits[0] as never).includes('(score 2, workspace)'))

    const direct = await getMemoryFile(store, 'global:topics/style.md')
    assert.equal(direct?.content, 'Prefer plain prose over tables.')
    assert.equal(await getMemoryFile(store, 'nope:topics/style.md'), undefined)
    // '..' 段直接拒绝（fail-loud），不是静默 undefined。
    await assert.rejects(() => getMemoryFile(store, 'global:../root.md'), /escapes/u)
    await assert.rejects(() => getMemoryFile(store, 'global:../../etc/passwd'), /escapes/u)
  } finally {
    await rm(home, { recursive: true, force: true })
    await rm(cwd, { recursive: true, force: true })
  }
})

test('symlinked memory content is rejected outright', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gcode-memory-'))
  const cwd = await mkdtemp(join(tmpdir(), 'gcode-ws-'))
  try {
    const store = await openMemoryStore(cwd, home)
    const outside = await mkdtemp(join(tmpdir(), 'gcode-outside-'))
    await writeFile(join(outside, 'secret.md'), 'secret', 'utf8')
    await symlink(outside, join(store.globalDir, 'topics', 'link.md'))
    await assert.rejects(() => listMemoryFiles(store), /symbolic links are not allowed/u)
    await rm(outside, { recursive: true, force: true })
  } finally {
    await rm(home, { recursive: true, force: true })
    await rm(cwd, { recursive: true, force: true })
  }
})

/** G Code — hashline 锚点方案与编辑核心测试（chunk_v1 语义 + 原子批）。 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  anchorMatches,
  applyHashlineEdit,
  formatHashlineRead,
  generateAnchors,
  lineHash,
  normalizeHashlineEdits,
  parseAnchor,
  renderAnchor,
  runHashlineEdit,
  schemeWireName,
  splitLines,
} from '../../src/grok/grok-hashline.ts'

const CONTENT = 'alpha\nbeta  gamma\ngamma\ndelta\n'.repeat(3)

test('line hash is whitespace-normalized and deterministic', () => {
  assert.equal(lineHash('beta  gamma'), lineHash('beta gamma'))
  assert.equal(lineHash('  beta gamma  '), lineHash('beta gamma'))
  assert.notEqual(lineHash('beta'), lineHash('gamma'))
})

test('anchors carry per-line local and per-chunk context hashes', () => {
  const anchors = generateAnchors(splitLines(CONTENT))
  assert.equal(anchors.length, splitLines(CONTENT).length)
  assert.equal(anchors[0]?.line, 1)
  // 'alpha' 在第 1/5/9 行重复：局部哈希一致。
  assert.equal(anchors[0]?.local, anchors[4]?.local)
  assert.notEqual(anchors[0]?.local, anchors[1]?.local)
  // chunk 尺寸 8：前 8 行同一上下文指纹，第 9 行换块。
  assert.equal(anchors[0]?.context, anchors[7]?.context)
  assert.notEqual(anchors[7]?.context, anchors[8]?.context)
  assert.equal(schemeWireName(), 'chunk_v1')
  assert.equal(schemeWireName({ scheme: 'content_only' }), 'content_only_v1')
  const bare = generateAnchors(['x'], { scheme: 'content_only' })[0]
  assert.equal(bare?.context, undefined)
})

test('formatHashlineRead renders anchor→content and parseAnchor round-trips', () => {
  const rendered = formatHashlineRead(CONTENT, 2, 2)
  const lines = rendered.split('\n')
  assert.equal(lines.length, 2)
  assert.ok(lines[0]?.startsWith('2:'))
  assert.ok(lines[0]?.endsWith('→beta  gamma'))
  const parsed = parseAnchor(lines[0]?.split('→')[0] ?? '')
  assert.equal(parsed?.line, 2)
  assert.equal(anchorMatches(parsed as never, splitLines(CONTENT)), true)
  assert.equal(renderAnchor({ line: 9, local: 'abc', context: 'xyz' }), '9:abc:xyz')
  assert.equal(parseAnchor('0:zz'), undefined)
  assert.equal(parseAnchor('line:zz'), undefined)
})

test('replace and insert_after apply against fresh anchors', () => {
  const lines = splitLines(CONTENT)
  const anchor = renderAnchor(generateAnchors(lines)[0] as never)
  const { result, content } = applyHashlineEdit(CONTENT, [
    { op: 'replace', anchor, content: 'ALPHA' },
  ], '/p/file.ts')
  assert.equal(result.status, 'ok')
  if (result.status === 'ok') {
    assert.equal(result.applied, 1)
    assert.equal(result.scheme, 'chunk_v1')
    assert.ok(result.snippet.includes('ALPHA'))
  }
  assert.ok(content?.startsWith('ALPHA\n'))

  const second = renderAnchor(generateAnchors(lines)[1] as never)
  const insert = applyHashlineEdit(CONTENT, [
    { op: 'insert_after', anchor: second, content: 'INSERTED' },
  ], '/p/file.ts')
  assert.equal(insert.result.status, 'ok')
  assert.ok(insert.content?.includes('beta  gamma\nINSERTED\ngamma'))

  const eof = applyHashlineEdit(CONTENT, [
    { op: 'insert_after', anchor: 'EOF', content: 'TAIL' },
  ], '/p/file.ts')
  assert.ok(eof.content?.endsWith('TAIL'))
})

test('stale anchors reject the whole batch with fresh context for retry', () => {
  const lines = splitLines(CONTENT)
  const stale = `${String(lines.length + 3)}:zzz`
  const good = renderAnchor(generateAnchors(lines)[0] as never)
  const failed = applyHashlineEdit(CONTENT, [
    { op: 'replace', anchor: good, content: 'ok' },
    { op: 'replace', anchor: stale, content: 'bad' },
  ], '/p/file.ts')
  assert.equal(failed.result.status, 'error')
  if (failed.result.status === 'error') {
    assert.equal(failed.result.error, 'out_of_range')
    assert.ok(failed.result.context !== undefined)
  }
  assert.equal(failed.content, undefined)

  // 局部哈希仍在但行号漂移：stale_anchor + 唯一候选给出 shifted_anchor。
  const anchors = generateAnchors(lines)
  const local = anchors[2]?.local
  const drifted = applyHashlineEdit(CONTENT, [
    { op: 'replace', anchor: `7:${local}`, content: 'x' },
  ], '/p')
  if (drifted.result.status === 'error') {
    assert.equal(drifted.result.error, 'stale_anchor')
    assert.ok(drifted.result.shifted_anchor !== undefined || drifted.result.ambiguous_candidates.length > 0)
  } else {
    assert.fail('expected stale_anchor failure')
  }
})

test('overlap, copied anchors, and write exclusivity fail closed', () => {
  const lines = splitLines(CONTENT)
  const a = renderAnchor(generateAnchors(lines)[0] as never)
  const b = renderAnchor(generateAnchors(lines)[1] as never)
  const overlap = applyHashlineEdit(CONTENT, [
    { op: 'replace', anchor: a, end_anchor: b, content: 'x' },
    { op: 'replace', anchor: b, content: 'y' },
  ], '/p')
  assert.equal(overlap.result.status, 'error')
  if (overlap.result.status === 'error') assert.equal(overlap.result.error, 'overlap')

  const copied = applyHashlineEdit(CONTENT, [
    { op: 'replace', anchor: a, content: `${a}→sneaky` },
  ], '/p')
  assert.equal(copied.result.status, 'error')

  const mixedWrite = applyHashlineEdit(CONTENT, [
    { op: 'write', content: 'all' },
    { op: 'replace', anchor: a, content: 'x' },
  ], '/p')
  assert.equal(mixedWrite.result.status, 'error')

  const write = applyHashlineEdit(CONTENT, [{ op: 'write', content: 'NEW FILE' }], '/p')
  assert.equal(write.result.status, 'ok')
  assert.equal(write.content, 'NEW FILE')
})

test('normalizeHashlineEdits accepts objects, arrays, and JSON strings', () => {
  const one = normalizeHashlineEdits({ op: 'write', content: 'x' })
  assert.equal(one.length, 1)
  const arr = normalizeHashlineEdits([{ op: 'insert_after', anchor: 'EOF', content: 'x' }])
  assert.equal(arr.length, 1)
  const json = normalizeHashlineEdits('[{"op":"write","content":"x"}]')
  assert.deepEqual(json, [{ op: 'write', content: 'x' }])
  assert.throws(() => normalizeHashlineEdits('not json'))
  assert.throws(() => normalizeHashlineEdits([]))
})

test('runHashlineEdit reads, applies, and writes through the IO seam', async () => {
  const files = new Map<string, string>([['/p/f.ts', CONTENT]])
  const io = {
    read: async (path: string) => files.get(path) ?? '',
    write: async (path: string, content: string) => { files.set(path, content) },
  }
  const anchor = renderAnchor(generateAnchors(splitLines(CONTENT))[0] as never)
  const ok = await runHashlineEdit(io, { file_path: '/p/f.ts', edits: [{ op: 'replace', anchor, content: 'ZED' }] })
  assert.equal(ok.status, 'ok')
  assert.ok(files.get('/p/f.ts')?.startsWith('ZED\n'))

  const fail = await runHashlineEdit(io, { file_path: '/p/f.ts', edits: [{ op: 'replace', anchor: '99:zzz', content: 'q' }] })
  assert.equal(fail.status, 'error')
  assert.ok(files.get('/p/f.ts')?.startsWith('ZED\n'))
})

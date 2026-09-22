/**
 * G Code — Grok wire 层 M0 round-trip 测试。
 *
 * 覆盖施工图 M0 出口判据的核心子集：item round-trip 保真（reasoning 逐字节、
 * status 剥除、hosted call 透传）、未知 item 的 fail-loud ↔ passthrough 策略
 * （H7）、SSE 分帧契约（含 doom_loop 帧归一化与 [DONE] 终止）。
 *
 * 运行：pnpm test（node --test 加 test 目录下全部 .test.ts；node ≥22.18 原生 TS 剥离，无需安装依赖）。
 * 本目录不在 tsconfig include（src 下全量）内，构建不受影响。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  GROK_DONE,
  GROK_DOOM_LOOP_EVENT,
  GROK_WIRE_REGISTRY_VERSION,
  acceptGrokInputItem,
  buildGrokResponsesRequestBody,
  grokPromptCacheKey,
  grokReplayState,
  hostedWireTool,
  parseGrokSse,
  readGrokReplayState,
  resolveGrokReasoningEffort,
} from '../../src/model/grok/grok-wire.ts'
import type { GrokReplayBlock } from '../../src/model/grok/grok-wire.ts'

function streamOf(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

async function collect(chunks: readonly string[], onComment?: () => void): Promise<string[]> {
  const out: string[] = []
  for await (const payload of parseGrokSse(streamOf(chunks), onComment)) out.push(payload)
  return out
}

test('replay round-trip keeps encrypted reasoning byte-for-byte and strips status', () => {
  const reasoning = {
    type: 'reasoning',
    id: 'rs_1',
    encrypted_content: 'AQIDBP8AAA==',
    summary: [] as unknown[],
    status: 'completed',
  }
  const blocks: GrokReplayBlock[] = [
    { type: 'reasoning', item: reasoning },
    { type: 'text' },
    { type: 'tool-call' },
  ]
  const source = {
    content: [{ type: 'reasoning' }, { type: 'text' }, { type: 'tool-call' }],
    replayState: grokReplayState(blocks, 'resp_9'),
  }
  const state = readGrokReplayState(source)
  assert.ok(state !== undefined)
  assert.equal(state.responseId, 'resp_9')
  const item = state.blocks[0]
  if (item.type !== 'reasoning') assert.fail('expected reasoning block')
  assert.equal(item.item['encrypted_content'], 'AQIDBP8AAA==')
  assert.equal(item.item['id'], 'rs_1')
  assert.equal('status' in item.item, false, 'status must be stripped before replay')
})

test('replay round-trip strips status from hosted calls and admits mcp_call', () => {
  const webCall = { type: 'web_search_call', id: 'ws_1', status: 'completed' }
  const mcpCall = { type: 'mcp_call', id: 'mc_1', status: 'completed' }
  const source = {
    content: [{ type: 'text' }, { type: 'text' }],
    replayState: grokReplayState([
      { type: 'text', hostedItem: webCall },
      { type: 'text', hostedItem: mcpCall },
    ]),
  }
  const state = readGrokReplayState(source)
  assert.ok(state !== undefined)
  const first = state.blocks[0]
  const second = state.blocks[1]
  if (first.type !== 'text' || second.type !== 'text') assert.fail('expected text blocks')
  assert.equal(first.hostedItem?.['type'], 'web_search_call')
  assert.equal('status' in (first.hostedItem ?? {}), false)
  assert.equal(second.hostedItem?.['type'], 'mcp_call')
})

test('replay validation fails loud on structural drift', () => {
  const blocks: GrokReplayBlock[] = [{ type: 'text' }, { type: 'text' }]
  const mismatch = {
    content: [{ type: 'text' }],
    replayState: grokReplayState(blocks),
  }
  assert.throws(() => readGrokReplayState(mismatch), /block count/)
  const badVersion = {
    content: [{ type: 'text' }],
    replayState: {
      kind: 'grok-build-responses',
      version: 2,
      blocks: [{ type: 'text' }],
    },
  }
  assert.throws(() => readGrokReplayState(badVersion), /version/)
  // 外源 replayState 非对象封套时 fail loud（原版语义：response 元数据必须是对象）。
  const foreign = { content: [{ type: 'text' }], replayState: { kind: 'other' } }
  assert.throws(() => readGrokReplayState(foreign), /response metadata/)
  // 嵌套封套内 kind 不符 → 明确返回 undefined，不误抛。
  const nestedForeign = { content: [{ type: 'text' }], replayState: { response: { kind: 'other' } } }
  assert.equal(readGrokReplayState(nestedForeign), undefined)
})

test('replay unwraps a nested response envelope', () => {
  const inner = grokReplayState([{ type: 'text' }])
  const source = {
    content: [{ type: 'text' }],
    replayState: { response: inner },
  }
  const state = readGrokReplayState(source)
  assert.ok(state !== undefined)
  assert.equal(state.kind, 'grok-build-responses')
})

test('unknown input item: fail policy throws, passthrough records diagnostics', () => {
  assert.equal(acceptGrokInputItem({ type: 'message' }, 0, 'fail'), 'known')
  assert.equal(acceptGrokInputItem({ type: 'mcp_call' }, 1, 'fail'), 'known')
  assert.throws(
    () => acceptGrokInputItem({ type: 'frob_call' }, 2, 'fail'),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.equal((error as { code?: string }).code, 'UNSUPPORTED_RESPONSE_ITEM')
      return true
    },
  )
  const diagnostics: Array<{ itemIndex: number; itemType: string; action: string }> = []
  assert.equal(acceptGrokInputItem({ type: 'frob_call' }, 3, 'passthrough', diagnostics), 'passthrough')
  assert.equal(diagnostics.length, 1)
  assert.equal(diagnostics[0]?.itemType, 'frob_call')
  assert.equal(diagnostics[0]?.itemIndex, 3)
  assert.ok(GROK_WIRE_REGISTRY_VERSION >= 1)
})

test('SSE: multi-line data, CRLF framing, comments, [DONE] terminates', async () => {
  let comments = 0
  const payloads = await collect(
    [
      'data: {"type":"response.output_item.added"}\n\n',
      ': keepalive\n\n',
      'data: line one\ndata: line two\n\n',
      'data: {"type":"response.completed"}\r\n\r\n',
      'data: [DONE]\n\n',
      'data: {"type":"must-not-appear"}\n\n',
    ],
    () => { comments += 1 },
  )
  assert.deepEqual(payloads, [
    '{"type":"response.output_item.added"}',
    'line one\nline two',
    '{"type":"response.completed"}',
    GROK_DONE,
  ])
  assert.equal(comments, 1)
})

test('SSE: CR at chunk boundary still terminates the line', async () => {
  const payloads = await collect(['data: y\r', '\n\n'])
  assert.deepEqual(payloads, ['y', GROK_DONE])
})

test('SSE: clean EOF normalizes to the [DONE] boundary', async () => {
  const payloads = await collect(['data: {"type":"response.completed"}\n\n'])
  assert.deepEqual(payloads, ['{"type":"response.completed"}', GROK_DONE])
})

test('SSE: named doom-loop frames normalize with payload preserved', async () => {
  const payloads = await collect([
    `event: ${GROK_DOOM_LOOP_EVENT}\ndata: {"signals":1}\n\n`,
    `event: ${GROK_DOOM_LOOP_EVENT}\ndata: not-json\n\n`,
    `event: ${GROK_DOOM_LOOP_EVENT}\ndata: [1,2]\n\n`,
  ])
  const normalized = payloads.slice(0, 3).map(value => JSON.parse(value))
  assert.deepEqual(normalized, [
    { signals: 1, type: GROK_DOOM_LOOP_EVENT },
    { type: GROK_DOOM_LOOP_EVENT },
    { type: GROK_DOOM_LOOP_EVENT },
  ])
  // 干净 EOF 按契约归一化为 [DONE] 边界。
  assert.equal(payloads[3], GROK_DONE)
})

test('hosted tool validation enforces the pinned wire contract', () => {
  assert.deepEqual(hostedWireTool({ wireName: 'web_search' }), { type: 'web_search' })
  assert.deepEqual(
    hostedWireTool({
      wireName: 'web_search',
      entry: { type: 'web_search', filters: { allowed_domains: ['a.com', 'b.com'] } },
    }),
    { type: 'web_search', filters: { allowed_domains: ['a.com', 'b.com'] } },
  )
  assert.throws(
    () => hostedWireTool({
      wireName: 'web_search',
      entry: { type: 'web_search', filters: { allowed_domains: ['1.com', '2.com', '3.com', '4.com', '5.com', '6.com'] } },
    }),
    /invalid wire entry/,
  )
  assert.throws(
    () => hostedWireTool({
      wireName: 'web_search',
      entry: { type: 'web_search', filters: { allowed_domains: ['a.com'], excluded_domains: ['b.com'] } },
    }),
    /invalid wire entry/,
  )
  assert.deepEqual(
    hostedWireTool({
      wireName: 'x_search',
      entry: { type: 'x_search', from_date: '2026-01-02', to_date: '2026-01-03' },
    }),
    { type: 'x_search', from_date: '2026-01-02', to_date: '2026-01-03' },
  )
  assert.throws(
    () => hostedWireTool({ wireName: 'x_search', entry: { type: 'x_search', from_date: '2026-13-01' } }),
    /invalid wire entry/,
  )
  assert.throws(
    () => hostedWireTool({
      wireName: 'x_search',
      entry: { type: 'x_search', from_date: '2026-02-02', to_date: '2026-01-03' },
    }),
    /invalid wire entry/,
  )
  assert.throws(() => hostedWireTool({ wireName: 'frob' }), /does not serialize hosted tool/)
})

test('reasoning effort stays fail-loud by default and opens via catalog', () => {
  assert.equal(resolveGrokReasoningEffort('xhigh', 'high'), 'xhigh')
  assert.equal(resolveGrokReasoningEffort(undefined, 'high'), 'high')
  assert.throws(() => resolveGrokReasoningEffort('ultra', 'high'), /reasoning effort/)
  assert.equal(resolveGrokReasoningEffort('ultra', 'high', ['low', 'medium', 'high', 'xhigh', 'ultra']), 'ultra')
})

test('request body builder omits optional fields exactly', () => {
  const body = buildGrokResponsesRequestBody({
    model: 'grok-4.6',
    input: [{ type: 'message', role: 'user', content: 'hi' }],
    effort: 'high',
    summary: 'none',
    tools: [],
  })
  assert.equal(body.stream, true)
  assert.equal(body.store, false)
  assert.deepEqual(body.include, ['reasoning.encrypted_content'])
  assert.equal('summary' in body.reasoning, false)
  assert.equal('tools' in body, false)
  assert.equal('prompt_cache_key' in body, false)
  const full = buildGrokResponsesRequestBody({
    model: 'grok-4.6',
    input: [],
    effort: 'xhigh',
    summary: 'concise',
    tools: [{ type: 'function', name: 'read_file', parameters: { type: 'object' } }],
    promptCacheKey: 'sess-1',
    temperature: 0,
    maxOutputTokens: 1024,
  })
  assert.equal(full.reasoning.summary, 'concise')
  assert.equal(full.tools?.length, 1)
  assert.equal(full.prompt_cache_key, 'sess-1')
  assert.equal(full.temperature, 0)
  assert.equal(full.max_output_tokens, 1024)
})

test('prompt cache key excludes auxiliary purposes', () => {
  assert.equal(grokPromptCacheKey('sess-1'), 'sess-1')
  assert.equal(grokPromptCacheKey('sess-1', 'compaction'), 'sess-1')
  assert.equal(grokPromptCacheKey('sess-1', 'session-title'), undefined)
  assert.equal(grokPromptCacheKey('sess-1', 'permission-auto'), undefined)
  assert.equal(grokPromptCacheKey(undefined), undefined)
})

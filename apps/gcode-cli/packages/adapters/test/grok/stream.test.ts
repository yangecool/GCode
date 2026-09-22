/**
 * G Code — Grok stream 语义翻译器 fixture 测试（M0 第二批）。
 *
 * 覆盖：流式 delta 直通与槽位排序、终态对账（前缀延展/replay 组装/usage）、
 * Length 策略 all-or-nothing 工具参数降级、doom-loop 拒绝与放行、hosted 工具
 * 展示文本与 replay 保留、fail-loud 路径（EMPTY/UNSUPPORTED/STREAM_CLOSED）。
 * 运行：pnpm test（node --test，原生 TS 剥离）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { translateGrokResponses, mapGrokUsage } from '../../src/model/grok/grok-stream.ts'
import { readGrokReplayState } from '../../src/model/grok/grok-wire.ts'

const DONE = '[DONE]'

async function* payloadsOf(items: readonly string[]): AsyncGenerator<string> {
  yield* items
}

async function collect(
  items: readonly string[],
  options?: Parameters<typeof translateGrokResponses>[1],
): Promise<Array<Record<string, unknown>>> {
  const events: Array<Record<string, unknown>> = []
  for await (const event of translateGrokResponses(payloadsOf(items), options)) {
    events.push(event as Record<string, unknown>)
  }
  return events
}

function codesOf(error: unknown): string {
  assert.ok(error instanceof Error)
  return (error as { code?: string }).code ?? ''
}

function terminal(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'response.completed',
    response: {
      id: 'resp_1',
      output: [
        {
          type: 'reasoning',
          id: 'rs_1',
          summary: [{ type: 'summary_text', text: 'think' }],
          encrypted_content: 'QUJD',
          status: 'completed',
        },
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Hello' }],
          status: 'completed',
        },
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'read_file',
          arguments: '{"path":"a.ts"}',
          status: 'completed',
        },
      ],
      usage: {
        input_tokens: 100,
        output_tokens: 40,
        input_tokens_details: { cached_tokens: 60, cache_write_tokens: 10 },
        output_tokens_details: { reasoning_tokens: 20 },
      },
      ...overrides,
    },
  })
}

const happyStream = [
  JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_1' } }),
  JSON.stringify({ type: 'response.reasoning_summary_text.delta', output_index: 0, delta: 'think' }),
  JSON.stringify({ type: 'response.output_item.added', output_index: 1, item: { type: 'message', role: 'assistant' } }),
  JSON.stringify({ type: 'response.output_text.delta', output_index: 1, delta: 'Hello' }),
  JSON.stringify({
    type: 'response.output_item.added',
    output_index: 2,
    item: { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '' },
  }),
  JSON.stringify({ type: 'response.function_call_arguments.delta', output_index: 2, delta: '{"path"' }),
  JSON.stringify({ type: 'response.function_call_arguments.delta', output_index: 2, delta: ':"a.ts"}' }),
  terminal(),
  DONE,
]

test('happy path: ordered events, single opener per slot, replay + usage on finish', async () => {
  const events = await collect(happyStream)
  const types = events.map(event => event['type'])
  // 块关闭按原版语义等终态边界统一结算：deltas 直通，ends 随 finish 批量到齐。
  assert.deepEqual(types, [
    'start',
    'reasoning_start', 'reasoning_delta',
    'text_start', 'text_delta',
    'tool_input_start', 'tool_input_delta', 'tool_input_delta',
    'reasoning_end', 'text_end', 'tool_input_end', 'tool_call',
    'finish',
  ])
  assert.equal(events.filter(event => event['type'] === 'tool_input_start').length, 1)
  const opener = events.find(event => event['type'] === 'tool_input_start')
  assert.equal(opener?.['toolName'], 'read_file')
  const toolCall = events.find(event => event['type'] === 'tool_call')?.['toolCall'] as Record<string, unknown>
  assert.deepEqual(toolCall, { id: 'call_1', name: 'read_file', input: { path: 'a.ts' } })
  const finish = events.at(-1) as Record<string, unknown>
  assert.equal(finish['type'], 'finish')
  assert.equal(finish['finishReason'], 'tool-calls')
  assert.deepEqual(finish['usage'], {
    inputTokens: 30,
    outputTokens: 40,
    cacheReadTokens: 60,
    cacheWriteTokens: 10,
    reasoningTokens: 20,
  })
  const meta = finish['providerMetadata'] as Record<string, unknown>
  const replay = meta['response'] as Record<string, unknown>
  assert.equal(replay['kind'], 'grok-build-responses')
  assert.equal(replay['responseId'], 'resp_1')
  const blocks = replay['blocks'] as Array<Record<string, unknown>>
  assert.deepEqual(blocks.map(block => block['type']), ['reasoning', 'text', 'tool-call'])
  const reasoningItem = blocks[0]?.['item'] as Record<string, unknown>
  assert.equal(reasoningItem['encrypted_content'], 'QUJD')
  // 原版语义：reasoning 的 status 随存储保留，replay-read 时剥除（hosted 是捕获时剥除）。
  const readBack = readGrokReplayState({
    content: [{ type: 'reasoning' }, { type: 'text' }, { type: 'tool-call' }],
    replayState: replay,
  })
  const readBlock = readBack?.blocks[0]
  if (readBlock?.type !== 'reasoning') assert.fail('expected reasoning replay block')
  assert.equal('status' in readBlock.item, false)
  assert.equal(readBlock.item['encrypted_content'], 'QUJD')
})

test('text-only completion finishes stop', async () => {
  const events = await collect([
    JSON.stringify({ type: 'response.output_text.delta', output_index: 0, delta: 'Hi' }),
    JSON.stringify({
      type: 'response.completed',
      response: {
        id: 'resp_2',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hi' }] }],
      },
    }),
    DONE,
  ])
  const finish = events.at(-1) as Record<string, unknown>
  assert.equal(finish['finishReason'], 'stop')
  const blocks = ((finish['providerMetadata'] as Record<string, unknown>)['response'] as Record<string, unknown>)['blocks'] as Array<Record<string, unknown>>
  assert.deepEqual(blocks.map(block => block['type']), ['text'])
})

test('hosted web_search_call renders display text and keeps replay item', async () => {
  const events = await collect([
    JSON.stringify({
      type: 'response.completed',
      response: {
        id: 'resp_3',
        output: [
          {
            type: 'web_search_call',
            id: 'ws_1',
            action: { query: 'grok responses api' },
            status: 'completed',
          },
        ],
      },
    }),
    DONE,
  ])
  const delta = events.find(event => event['type'] === 'text_delta') as Record<string, unknown> | undefined
  assert.ok(delta !== undefined)
  assert.equal(delta['text'], '[backend web_search] search: grok responses api')
  const finish = events.at(-1) as Record<string, unknown>
  assert.equal(finish['finishReason'], 'stop')
  const blocks = ((finish['providerMetadata'] as Record<string, unknown>)['response'] as Record<string, unknown>)['blocks'] as Array<Record<string, unknown>>
  const hosted = blocks[0]?.['hostedItem'] as Record<string, unknown>
  assert.equal(hosted['type'], 'web_search_call')
  assert.equal('status' in hosted, false)
})

function incomplete(reason: string, output: unknown[]): string {
  return JSON.stringify({
    type: 'response.incomplete',
    response: { id: 'resp_4', output, incomplete_details: { reason } },
  })
}

test('incomplete max_output_tokens with text keeps replay, rawReason recorded', async () => {
  const events = await collect([
    incomplete('max_output_tokens', [
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'partial' }] },
    ]),
    DONE,
  ])
  const finish = events.at(-1) as Record<string, unknown>
  assert.equal(finish['finishReason'], 'length')
  assert.equal((finish['providerMetadata'] as Record<string, unknown>)['finishRawReason'], 'max_tokens')
})

test('incomplete with malformed tool arguments downgrades the whole batch', async () => {
  const events = await collect([
    incomplete('max_output_tokens', [
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'partial' }] },
      { type: 'function_call', call_id: 'c1', name: 't', arguments: '{"broken' },
    ]),
    DONE,
  ])
  const finish = events.at(-1) as Record<string, unknown>
  assert.equal(finish['finishReason'], 'length')
  const blocks = ((finish['providerMetadata'] as Record<string, unknown>)['response'] as Record<string, unknown>)['blocks'] as Array<Record<string, unknown>>
  assert.deepEqual(blocks.map(block => block['type']), ['text'], 'tool-call must be dropped from durable replay')
})

test('incomplete with complete tool arguments still finishes tool-calls', async () => {
  const events = await collect([
    incomplete('max_output_tokens', [
      { type: 'function_call', call_id: 'c1', name: 't', arguments: '{"ok":true}' },
    ]),
    DONE,
  ])
  const finish = events.at(-1) as Record<string, unknown>
  assert.equal(finish['finishReason'], 'tool-calls')
})

test('content_filter incomplete maps to content-filter finish', async () => {
  const events = await collect([
    incomplete('content_filter', [
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'cut' }] },
    ]),
    DONE,
  ])
  assert.equal((events.at(-1) as Record<string, unknown>)['finishReason'], 'content-filter')
})

test('completed without visible output fails loud', async () => {
  await assert.rejects(
    collect([JSON.stringify({ type: 'response.completed', response: { id: 'r', output: [] } }), DONE]),
    (error: unknown) => codesOf(error) === 'EMPTY_RESPONSE',
  )
})

test('unsupported terminal output item refuses lossy replay', async () => {
  await assert.rejects(
    collect([
      JSON.stringify({
        type: 'response.completed',
        response: { id: 'r', output: [{ type: 'frob_call' }] },
      }),
      DONE,
    ]),
    (error: unknown) => codesOf(error) === 'UNSUPPORTED_RESPONSE_ITEM',
  )
})

test('missing terminal boundary fails closed', async () => {
  await assert.rejects(collect([DONE]), (error: unknown) => codesOf(error) === 'STREAM_CLOSED')
})

test('confident doom-loop trigger with abort rejects and stages recovery', async () => {
  const detections: Array<{ triggers: readonly string[]; recoveryItems: readonly unknown[] }> = []
  const doomFrame = JSON.stringify({
    type: 'response.doom_loop_check',
    doom_loop_check: { triggers: ['tail_repetition:10@thinking', 'other_signal'] },
  })
  await assert.rejects(
    collect([doomFrame, terminal(), DONE], {
      doomLoop: {
        abort: true,
        maxThreshold: 64,
        onDetected: detection => detections.push(detection),
      },
    }),
    (error: unknown) => codesOf(error) === 'DOOM_LOOP',
  )
  assert.equal(detections.length, 1)
  assert.deepEqual(detections[0]?.triggers, ['tail_repetition:10@thinking', 'other_signal'])
})

test('warn-only doom-loop accepts the response and reports triggers', async () => {
  const accepted: Array<readonly string[]> = []
  const events = await collect(
    [
      JSON.stringify({
        type: 'response.doom_loop_check',
        doom_loop_check: { triggers: ['tail_repetition:10@thinking'] },
      }),
      terminal(),
      DONE,
    ],
    {
      doomLoop: {
        abort: false,
        maxThreshold: 64,
        onAccepted: triggers => accepted.push(triggers),
      },
    },
  )
  assert.equal((events.at(-1) as Record<string, unknown>)['finishReason'], 'tool-calls')
  assert.equal(accepted.length, 1)
  assert.deepEqual(accepted[0], ['tail_repetition:10@thinking'])
})

test('out-of-order indices keep durable block order', async () => {
  const events = await collect([
    JSON.stringify({ type: 'response.output_text.delta', output_index: 1, delta: 'second' }),
    JSON.stringify({ type: 'response.output_text.delta', output_index: 0, delta: 'first' }),
    JSON.stringify({
      type: 'response.completed',
      response: {
        id: 'r',
        output: [
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'first' }] },
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'second' }] },
        ],
      },
    }),
    DONE,
  ])
  const textEvents = events.filter(event => event['type'] === 'text_start' || event['type'] === 'text_delta')
  assert.deepEqual(
    textEvents.map(event => `${String(event['type'])}:${String(event['id'])}:${String(event['text'] ?? '')}`),
    ['text_start:text-0:', 'text_delta:text-0:first', 'text_start:text-1:', 'text_delta:text-1:second'],
  )
})

test('usage mapping keeps counters disjoint', () => {
  const usage = mapGrokUsage({
    usage: {
      input_tokens: 100,
      output_tokens: 40,
      input_tokens_details: { cached_tokens: 60, cache_creation_tokens: 10 },
      output_tokens_details: { reasoning_tokens: 20 },
    },
  })
  assert.deepEqual(usage, {
    inputTokens: 30,
    outputTokens: 40,
    cacheReadTokens: 60,
    cacheWriteTokens: 10,
    reasoningTokens: 20,
  })
  assert.equal(mapGrokUsage({}), undefined)
})

test('reasoning_end carries the lossless grokItem for durable replay', async () => {
  const events = await collect([
    JSON.stringify({
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'reasoning', id: 'rs_meta', encrypted_content: 'RU5D' },
    }),
    JSON.stringify({ type: 'response.reasoning_text.delta', output_index: 0, delta: 'thinking' }),
    JSON.stringify({
      type: 'response.completed',
      response: {
        id: 'resp_meta',
        output: [
          {
            type: 'reasoning',
            id: 'rs_meta',
            encrypted_content: 'RU5D',
            content: [{ type: 'reasoning_text', text: 'thinking' }],
            status: 'completed',
          },
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] },
        ],
      },
    }),
    DONE,
  ])
  const end = events.find(event => event['type'] === 'reasoning_end')
  assert.ok(end !== undefined)
  // 会话层对 reasoning 事件的 providerMetadata 做 last-wins 写入
  // block.providerOptions；块级 grokItem 是 serialize 端无损回放的读取端。
  assert.deepEqual(end['providerMetadata'], {
    grokItem: {
      type: 'reasoning',
      id: 'rs_meta',
      encrypted_content: 'RU5D',
      content: [{ type: 'reasoning_text', text: 'thinking' }],
      status: 'completed',
    },
  })
  const finish = events.at(-1) as Record<string, unknown>
  const replay = (finish['providerMetadata'] as Record<string, unknown>)['response'] as Record<string, unknown>
  const blocks = replay['blocks'] as Array<Record<string, unknown>>
  // 事件侧与 finish replay 各持独立克隆，互不共享可变引用。
  assert.notEqual(end['providerMetadata'], blocks[0])
})

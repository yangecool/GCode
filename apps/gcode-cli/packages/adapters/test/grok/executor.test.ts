/** G Code — ModelExecutor 核心映射测试（工具/档位映射、结果归并、端到端接线）。 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  collectGrokTextResult,
  createGrokModelExecutorCore,
  grokFunctionTools,
  grokRequestEffort,
} from '../../src/model/grok/grok-executor.ts'
import { createGrokHttpTransport } from '../../src/model/grok/grok-http.ts'

test('grokFunctionTools maps tool contracts and defaults missing schemas', () => {
  assert.equal(grokFunctionTools(undefined), undefined)
  assert.equal(grokFunctionTools([]), undefined)
  assert.deepEqual(grokFunctionTools([
    { name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
    { name: 'no_schema' },
  ]), [
    { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
    { name: 'no_schema', parameters: { type: 'object' } },
  ])
})

test('grokRequestEffort is catalog-driven and fail-loud', () => {
  assert.equal(grokRequestEffort(undefined, {}), 'high')
  assert.equal(grokRequestEffort('low', { defaultEffort: 'medium' }), 'low')
  assert.deepEqual(
    (() => { try { grokRequestEffort('banana', {}); return 'no-throw' } catch (error) { return (error as { code?: string }).code } })(),
    'UNSUPPORTED_REASONING_EFFORT',
  )
  // 目录收窄后的 admissible 集（H8）：unknown 档位拒绝，即便在原版全集里。
  assert.deepEqual(
    (() => { try { grokRequestEffort('xhigh', { knownEfforts: ['low', 'medium', 'high'] }); return 'no-throw' } catch (error) { return (error as { code?: string }).code } })(),
    'UNSUPPORTED_REASONING_EFFORT',
  )
})

test('collectGrokTextResult assembles text, reasoning grokItem backfill, toolCalls, finish', () => {
  const result = collectGrokTextResult([
    { type: 'start' },
    { type: 'reasoning_start', id: 'rs_1' },
    { type: 'reasoning_delta', id: 'rs_1', text: 'thinking...' },
    { type: 'reasoning_end', id: 'rs_1' },
    { type: 'text_start', id: 'text-0' },
    { type: 'text_delta', text: 'hello ' },
    { type: 'text_delta', text: 'world' },
    { type: 'text_end', id: 'text-0' },
    { type: 'tool_input_start', id: 'call_1', toolName: 'read_file' },
    { type: 'tool_input_delta', id: 'call_1', delta: '{"path":"a"}' },
    { type: 'tool_input_end', id: 'call_1' },
    { type: 'tool_call', toolCall: { id: 'call_1', name: 'read_file', input: { path: 'a' } } },
    {
      type: 'finish',
      finishReason: 'tool-calls',
      usage: { inputTokens: 10, outputTokens: 5 },
      providerMetadata: {
        response: {
          kind: 'grok-build-responses',
          version: 1,
          responseId: 'resp_1',
          blocks: [
            { type: 'reasoning', item: { type: 'reasoning', id: 'rs_1', content: [{ type: 'reasoning_text', text: 'thinking...' }], summary: [] } },
            { type: 'text', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello world' }] } },
            { type: 'tool-call' },
          ],
        },
      },
    },
  ])
  assert.equal(result.text, 'hello world')
  assert.equal(result.finishReason, 'tool-calls')
  assert.deepEqual(result.toolCalls, [{ id: 'call_1', name: 'read_file', input: { path: 'a' } }])
  // reasoning 块回填 wire 原始 item（serializeGrokMessages 读取 grokItem 的同一约定）。
  assert.deepEqual(result.reasoning, [
    {
      type: 'reasoning',
      text: 'thinking...',
      providerOptions: { grokItem: { type: 'reasoning', id: 'rs_1', content: [{ type: 'reasoning_text', text: 'thinking...' }], summary: [] } },
    },
  ])
  const response = (result.providerMetadata as Record<string, unknown>)['response'] as Record<string, unknown>
  assert.equal(response['responseId'], 'resp_1')
})

interface Captured {
  body: Record<string, unknown>
}

async function startScripted(frames: readonly unknown[]): Promise<{ url: string; captured: Captured[]; close(): Promise<void> }> {
  const captured: Captured[] = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', chunk => { raw += String(chunk) })
    req.on('end', () => {
      captured.push({ body: JSON.parse(raw) as Record<string, unknown> })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const frame of frames) res.write(`data: ${JSON.stringify(frame)}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    captured,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}

test('executor streams events verbatim and maps request options', async () => {
  const server = await startScripted([
    { type: 'response.completed', response: { id: 'resp_ok', output: [
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] },
    ] } },
  ])
  try {
    const executor = createGrokModelExecutorCore(
      {
        apiKey: 'test-key',
        baseURL: server.url,
        model: 'grok-4.6',
        transport: createGrokHttpTransport({}),
        retryBackoffBaseMs: 1,
      },
      { knownEfforts: ['low', 'medium', 'high', 'xhigh'] },
    )
    const events = []
    for await (const event of executor.streamText({
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{ name: 'read_file', inputSchema: { type: 'object' } }],
      reasoningLevel: 'xhigh',
      maxOutputTokens: 1024,
    })) {
      events.push(event)
    }
    assert.equal(events.at(-1)?.type, 'finish')
    const body = server.captured[0]?.body
    assert.equal(body['model'], 'grok-4.6')
    assert.equal((body['reasoning'] as Record<string, unknown>)['effort'], 'xhigh')
    assert.equal(body['max_output_tokens'], 1024)
    assert.deepEqual(body['tools'], [{ type: 'function', name: 'read_file', parameters: { type: 'object' } }])

    const result = await executor.generateText({
      messages: [{ role: 'user', content: 'hello' }],
      reasoningLevel: 'low',
    })
    assert.equal(result.text, 'hi')
    assert.equal(result.finishReason, 'stop')
    const second = server.captured[1]?.body
    assert.equal((second['reasoning'] as Record<string, unknown>)['effort'], 'low')
    assert.equal(second['max_output_tokens'], undefined)
  } finally {
    await server.close()
  }
})

test('executor streamText delivers deltas before the terminal boundary', async () => {
  // 评审回归：streamText 曾把 executeGrokRequest 的完整缓冲结果一次性转发，
  // 消费者在终态前看不到任何事件。此处服务器门控在 delta 之后，验证增量性。
  const release = { promise: Promise.withResolvers<void>() }
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', chunk => { raw += String(chunk) })
    req.on('end', () => {
      void JSON.parse(raw)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', role: 'assistant', id: 'msg_i' } })}\n\n`)
      res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', output_index: 0, item_id: 'msg_i', delta: 'early' })}\n\n`)
      void release.promise.promise.then(() => {
        res.write(`data: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_i', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'early' }] }] } })}\n\n`)
        res.write('data: [DONE]\n\n')
        res.end()
      })
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  try {
    const executor = createGrokModelExecutorCore(
      {
        apiKey: 'test-key',
        baseURL: `http://127.0.0.1:${port}`,
        model: 'grok-4.6',
        transport: createGrokHttpTransport({}),
      },
    )
    const seen: string[] = []
    const firstDelta = Promise.withResolvers<void>()
    const consumed = (async () => {
      for await (const event of executor.streamText({ messages: [{ role: 'user', content: 'hello' }] })) {
        seen.push(event.type)
        if (event.type === 'text_delta') firstDelta.resolve()
        if (event.type === 'finish') return
      }
    })()
    const guard = setTimeout(() => firstDelta.reject(new Error('stream buffered until terminal')), 2_000)
    guard.unref()
    await firstDelta.promise
    clearTimeout(guard)
    release.promise.resolve()
    await consumed
    assert.ok(seen.includes('finish'))
  } finally {
    release.promise.resolve()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

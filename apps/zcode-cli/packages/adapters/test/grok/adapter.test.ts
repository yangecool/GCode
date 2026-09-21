/** G Code — 执行编排批次测试（本地 SSE 服务器驱动重试/doom-loop 全路径）。 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { executeGrokRequest, GROK_RECOVERY_REMINDER } from '../../src/model/grok/grok-adapter.ts'
import { createGrokHttpTransport } from '../../src/model/grok/grok-http.ts'
import type { GrokAdapterConfig } from '../../src/model/grok/grok-adapter.ts'

interface Captured {
  method: string
  headers: http.IncomingHttpHeaders
  body: Record<string, unknown>
}

interface ScriptedServer {
  readonly url: string
  readonly captured: Captured[]
  close(): Promise<void>
}

type Responder = (req: http.IncomingMessage, res: http.ServerResponse, index: number) => void

async function startScripted(responders: readonly Responder[]): Promise<ScriptedServer> {
  const captured: Captured[] = []
  let index = 0
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', chunk => { raw += String(chunk) })
    req.on('end', () => {
      captured.push({
        method: req.method ?? '',
        headers: req.headers,
        body: JSON.parse(raw) as Record<string, unknown>,
      })
      const responder = responders[Math.min(index, responders.length - 1)]
      index += 1
      responder(req, res, index - 1)
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

function sse(res: http.ServerResponse, frames: readonly unknown[]): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const frame of frames) res.write(`data: ${JSON.stringify(frame)}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
}

function json(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
}

const COMPLETED = [
  { type: 'response.completed', response: { id: 'resp_ok', output: [
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] },
  ] } },
]

function baseConfig(server: ScriptedServer, overrides: Partial<GrokAdapterConfig> = {}): GrokAdapterConfig {
  return {
    apiKey: 'test-key',
    baseURL: server.url,
    model: 'grok-4.6',
    retryBackoffBaseMs: 1,
    transport: createGrokHttpTransport({}),
    ...overrides,
  }
}

const HISTORY = [{ role: 'user' as const, content: 'hello' }]

test('happy path: one attempt, correct request shape, finish event', async () => {
  const server = await startScripted([(req, res) => sse(res, COMPLETED)])
  try {
    const result = await executeGrokRequest(baseConfig(server), {
      messages: HISTORY,
      tools: [{ name: 'read_file', parameters: { type: 'object' } }],
    })
    assert.deepEqual(result.attempts, [{ attempt: 1, code: 'OK', retried: false }])
    assert.equal(result.events.at(-1)?.type, 'finish')
    const seen = server.captured[0]
    assert.equal(seen?.method, 'POST')
    assert.equal(seen?.headers['authorization'], 'Bearer test-key')
    assert.equal(seen?.headers['x-grok-client-identifier'], 'grok-shell')
    assert.ok(String(seen?.headers['user-agent']).startsWith('grok-shell/'))
    assert.equal(seen?.body['model'], 'grok-4.6')
    assert.equal(seen?.body['stream'], true)
    assert.equal(seen?.body['store'], false)
    assert.deepEqual(seen?.body['input'], [{ type: 'message', role: 'user', content: 'hello' }])
    assert.deepEqual(seen?.body['tools'], [
      { type: 'function', name: 'read_file', parameters: { type: 'object' } },
    ])
    assert.equal((seen?.body['reasoning'] as Record<string, unknown>)['effort'], 'high')
  } finally {
    await server.close()
  }
})

test('429 within budget retries and succeeds', async () => {
  const server = await startScripted([
    (req, res) => json(res, 429, { error: { message: 'slow down' } }),
    (req, res) => json(res, 429, { error: { message: 'slow down' } }),
    (req, res) => sse(res, COMPLETED),
  ])
  try {
    const result = await executeGrokRequest(baseConfig(server), { messages: HISTORY })
    assert.deepEqual(result.attempts.map(a => a.code), ['RATE_LIMIT', 'RATE_LIMIT', 'OK'])
    assert.equal(server.captured.length, 3)
  } finally {
    await server.close()
  }
})

test('third 429 exceeds budget and surfaces', async () => {
  const server = await startScripted([
    (req, res) => json(res, 429, { error: { message: 'slow down' } }),
    (req, res) => json(res, 429, { error: { message: 'slow down' } }),
    (req, res) => json(res, 429, { error: { message: 'slow down' } }),
  ])
  try {
    await assert.rejects(
      executeGrokRequest(baseConfig(server), { messages: HISTORY }),
      (error: unknown) => (error as { code?: string }).code === 'RATE_LIMIT',
    )
    assert.equal(server.captured.length, 3)
  } finally {
    await server.close()
  }
})

test('first 5xx rebuilds onto the fresh HTTP/1.1 channel', async () => {
  const server = await startScripted([
    (req, res) => json(res, 503, { error: { message: 'unavailable' } }),
    (req, res) => sse(res, COMPLETED),
  ])
  try {
    const result = await executeGrokRequest(baseConfig(server), { messages: HISTORY })
    assert.deepEqual(result.attempts.map(a => a.code), ['SERVER_5XX', 'OK'])
    assert.equal(server.captured[1]?.headers['connection'], 'close')
  } finally {
    await server.close()
  }
})

test('doom-loop resample injects recovery tail with reminder', async () => {
  // 中毒 attempt：reasoning/message 流到一半被 doom 检测中止（无 done 帧），
  // 恢复重放必须用 wire item 身份 + 流式 delta 文本（Rust fit_reasoning 语义）。
  const poisoned = [
    { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_1' } },
    { type: 'response.reasoning_text.delta', output_index: 0, item_id: 'rs_1', delta: 'stuck in a loop' },
    { type: 'response.output_item.added', output_index: 1, item: { type: 'message', role: 'assistant', id: 'msg_1' } },
    { type: 'response.output_text.delta', output_index: 1, item_id: 'msg_1', delta: 'same text again' },
    { type: 'response.doom_loop_check', doom_loop_check: { triggers: ['tail_repetition:10@thinking'] } },
  ]
  const server = await startScripted([
    (req, res) => sse(res, poisoned),
    (req, res) => sse(res, COMPLETED),
  ])
  try {
    const result = await executeGrokRequest(baseConfig(server, {
      doomLoopReminder: '<system_reminder>looping</system_reminder>',
    }), { messages: HISTORY })
    assert.deepEqual(result.attempts.map(a => a.code), ['DOOM_LOOP', 'OK'])
    const input2 = server.captured[1]?.body['input'] as unknown[]
    assert.deepEqual(input2, [
      { type: 'message', role: 'user', content: 'hello' },
      { type: 'reasoning', id: 'rs_1', content: [{ type: 'reasoning_text', text: 'stuck in a loop' }] },
      { type: 'message', role: 'assistant', content: 'same text again' },
      { type: 'message', role: 'user', content: '<system_reminder>looping</system_reminder>' },
    ])
    // 中毒 attempt 的 delta 不进入成功结果。
    assert.equal(result.events.filter(e => e.type === 'text_delta').length, 1)
  } finally {
    await server.close()
  }
})

test('doom-loop retry defaults to the verbatim recovery reminder', async () => {
  const doom = [
    { type: 'response.doom_loop_check', doom_loop_check: { triggers: ['tail_repetition:10@thinking'] } },
  ]
  const server = await startScripted([
    (req, res) => sse(res, doom),
    (req, res) => sse(res, doom),
  ])
  try {
    await assert.rejects(
      executeGrokRequest(baseConfig(server, { doomLoopMaxResamples: 1 }), { messages: HISTORY }),
      (error: unknown) => (error as { code?: string }).code === 'DOOM_LOOP',
    )
    const input2 = server.captured[1]?.body['input'] as unknown[]
    assert.deepEqual(input2, [
      { type: 'message', role: 'user', content: 'hello' },
      { type: 'message', role: 'user', content: GROK_RECOVERY_REMINDER },
    ])
  } finally {
    await server.close()
  }
})

test('doom-loop budget exhaustion surfaces the failure', async () => {
  const doom = [
    { type: 'response.doom_loop_check', doom_loop_check: { triggers: ['tail_repetition:10@thinking'] } },
  ]
  const server = await startScripted([(req, res) => sse(res, doom)])
  try {
    await assert.rejects(
      executeGrokRequest(baseConfig(server, { doomLoopMaxResamples: 1 }), { messages: HISTORY }),
      (error: unknown) => (error as { code?: string }).code === 'DOOM_LOOP',
    )
    assert.equal(server.captured.length, 2)
    // 未配置 reminder 时默认注入原版逐字文案（veto 轮 reminder-alone 重试）。
    const input2 = server.captured[1]?.body['input'] as unknown[]
    assert.deepEqual(input2, [
      { type: 'message', role: 'user', content: 'hello' },
      { type: 'message', role: 'user', content: GROK_RECOVERY_REMINDER },
    ])
  } finally {
    await server.close()
  }
})

test('non-retryable 4xx fails immediately', async () => {
  const server = await startScripted([
    (req, res) => json(res, 401, { error: { message: 'bad key' } }),
  ])
  try {
    await assert.rejects(
      executeGrokRequest(baseConfig(server), { messages: HISTORY }),
      (error: unknown) => (error as { code?: string }).code === 'HTTP_401',
    )
    assert.equal(server.captured.length, 1)
  } finally {
    await server.close()
  }
})

/** G Code — 执行编排批次测试（本地 SSE 服务器驱动重试/doom-loop 全路径）。 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { executeGrokRequest, GROK_RECOVERY_REMINDER, streamGrokRequest } from '../../src/model/grok/grok-adapter.ts'
import { createGrokHttpTransport } from '../../src/model/grok/grok-http.ts'
import type { GrokAdapterConfig } from '../../src/model/grok/grok-adapter.ts'
import type { GrokHttpTransport } from '../../src/model/grok/grok-http.ts'

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


function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(settle => { resolve = settle })
  return { promise, resolve }
}

function withTimeoutMs<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    timer.unref()
    promise.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) },
    )
  })
}

test('pre-aborted signal fails closed without sending', async () => {
  const server = await startScripted([(req, res) => sse(res, COMPLETED)])
  try {
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      executeGrokRequest(baseConfig(server), { messages: HISTORY, abortSignal: controller.signal }),
      (error: unknown) => (error as { code?: string }).code === 'ABORTED',
    )
    // 已取消的请求不得发送：AbortSignal 对已 aborted 状态不会再触发事件。
    assert.equal(server.captured.length, 0)
  } finally {
    await server.close()
  }
})

test('transport-level network failures classify as retryable TRANSPORT', async () => {
  // 真实 ECONNREFUSED（连接建立阶段）走真传输的 GrokTransportError 包装；
  // 旧实现把非 wire 异常当 UNKNOWN 直接失败，不进传输重试分支。
  const holder = http.createServer()
  await new Promise<void>(resolve => holder.listen(0, '127.0.0.1', resolve))
  const deadPort = (holder.address() as AddressInfo).port
  await new Promise<void>(resolve => holder.close(() => resolve()))
  const server = await startScripted([(req, res) => sse(res, COMPLETED)])
  try {
    const real = createGrokHttpTransport({})
    let deadCalls = 0
    const flaky: GrokHttpTransport = {
      fetch: async (input, init) => {
        deadCalls += 1
        return await real.fetch(new URL(`http://127.0.0.1:${deadPort}/responses`), init)
      },
      freshHttp1Fetch: real.fetch,
      mode: 'direct',
      proxyEndpoints: [],
      close: async () => {},
    }
    const result = await executeGrokRequest(baseConfig(server, { transport: flaky }), { messages: HISTORY })
    assert.deepEqual(result.attempts.map(a => a.code), ['TRANSPORT', 'OK'])
    assert.equal(deadCalls, 1)
    assert.equal(server.captured.length, 1)
  } finally {
    await server.close()
  }
})

test('mid-stream cut before output retries as TRANSPORT', async () => {
  const server = await startScripted([
    (req, res) => {
      // 无终态帧的连接截断：body 读取相的裸网络错误必须按 TRANSPORT 重试。
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', role: 'assistant', id: 'msg_x' } })}\n\n`)
      res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', output_index: 0, item_id: 'msg_x', delta: 'partial' })}\n\n`)
      res.destroy()
    },
    (req, res) => sse(res, COMPLETED),
  ])
  try {
    const result = await executeGrokRequest(baseConfig(server), { messages: HISTORY })
    assert.deepEqual(result.attempts.map(a => a.code), ['TRANSPORT', 'OK'])
    assert.equal(server.captured.length, 2)
  } finally {
    await server.close()
  }
})

test('streaming delivers events incrementally before the terminal boundary', async () => {
  const releaseTerminal = deferred<void>()
  const server = await startScripted([(req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', role: 'assistant', id: 'msg_s' } })}\n\n`)
    res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', output_index: 0, item_id: 'msg_s', delta: 'partial' })}\n\n`)
    void releaseTerminal.promise.then(() => {
      res.write(`data: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_s', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'partial' }] }] } })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    })
  }])
  try {
    const seen: string[] = []
    const firstDelta = deferred<void>()
    const consumed = (async () => {
      for await (const event of streamGrokRequest(baseConfig(server), { messages: HISTORY })) {
        seen.push(event.type)
        if (event.type === 'text_delta') firstDelta.resolve()
        if (event.type === 'finish') return
      }
    })()
    // 服务器还没发终态，消费者必须已经看到 delta（真流式，非缓冲到终态）。
    await withTimeoutMs(firstDelta.promise, 2_000, 'stream buffered until the terminal boundary')
    releaseTerminal.resolve()
    await withTimeoutMs(consumed, 2_000, 'stream did not finish after terminal release')
    assert.ok(seen.includes('finish'))
  } finally {
    releaseTerminal.resolve()
    await server.close()
  }
})

test('streaming failure after delivered output surfaces instead of retrying', async () => {
  const deliveredToClient = deferred<void>()
  const server = await startScripted([
    (req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', role: 'assistant', id: 'msg_c' } })}\n\n`)
      res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', output_index: 0, item_id: 'msg_c', delta: 'partial' })}\n\n`)
      // 确定性截断：客户端确认收到 delta 之后再砍连接（写后立刻 destroy
      // 可能丢弃未冲刷的帧，让本次尝试变成无输出的干净重试）。
      void deliveredToClient.promise.then(() => res.destroy())
    },
    (req, res) => sse(res, COMPLETED),
  ])
  try {
    const seen: string[] = []
    await assert.rejects(
      (async () => {
        for await (const event of streamGrokRequest(baseConfig(server), { messages: HISTORY })) {
          seen.push(event.type)
          if (event.type === 'text_delta') deliveredToClient.resolve()
        }
      })(),
      (error: unknown) => (error as { code?: string }).code !== undefined,
    )
    assert.ok(seen.includes('text_delta'), 'output was delivered before the cut')
    // retry_only_before_output 守卫：已下发的输出无法收回，不得重采样。
    assert.equal(server.captured.length, 1)
  } finally {
    deliveredToClient.resolve()
    await server.close()
  }
})

test('same-provider history replays the reasoning grokItem verbatim', async () => {
  const server = await startScripted([(req, res) => sse(res, COMPLETED)])
  try {
    const history = [
      { role: 'user' as const, content: 'hello' },
      {
        role: 'assistant' as const,
        providerId: 'xai-grok',
        modelId: 'grok-4.6',
        content: [{
          type: 'reasoning' as const,
          text: 'thoughts',
          providerOptions: { grokItem: { type: 'reasoning', id: 'rs_9', encrypted_content: 'ENC', summary: [] } },
        }],
      },
    ]
    await executeGrokRequest(baseConfig(server, { providerId: 'xai-grok' }), { messages: history })
    const input = server.captured[0]?.body['input'] as unknown[]
    // 同源路由：原始 item（含 encrypted_content）逐字节回放，维持 prefix-cache。
    assert.deepEqual(input[1], { type: 'reasoning', id: 'rs_9', encrypted_content: 'ENC', summary: [] })
  } finally {
    await server.close()
  }
})

test('cross-provider history falls back to summary replay', async () => {
  const server = await startScripted([(req, res) => sse(res, COMPLETED)])
  try {
    const history = [
      { role: 'user' as const, content: 'hello' },
      {
        role: 'assistant' as const,
        providerId: 'other-provider',
        modelId: 'grok-4.6',
        content: [{
          type: 'reasoning' as const,
          text: 'thoughts',
          providerOptions: { grokItem: { type: 'reasoning', id: 'rs_9', encrypted_content: 'ENC', summary: [] } },
        }],
      },
    ]
    await executeGrokRequest(baseConfig(server, { providerId: 'xai-grok' }), { messages: history })
    const input = server.captured[0]?.body['input'] as unknown[]
    assert.deepEqual(input[1], { type: 'reasoning', summary: [{ type: 'summary_text', text: 'thoughts' }] })
  } finally {
    await server.close()
  }
})

test('subscription mode sends device-flow bearer with grok-build identity headers', async () => {
  let bearer: string | undefined
  let tokenAuth: string | undefined
  const server = await startScripted([
    (req, res) => {
      bearer = req.headers['authorization']
      tokenAuth = req.headers['x-xai-token-auth'] as string | undefined
      sse(res, COMPLETED)
    },
  ])
  try {
    const result = await executeGrokRequest(baseConfig(server, {
      apiKey: 'should-not-be-sent',
      authMode: 'grok-subscription',
      resolveBearer: async () => 'device-flow-token',
      agentId: 'agent-123',
    }), { messages: HISTORY })
    assert.equal(result.events.at(-1)?.type, 'finish')
    assert.equal(bearer, 'Bearer device-flow-token')
    assert.equal(tokenAuth, 'xai-grok-cli')
    const capturedAgent = server.captured[0]?.headers['x-grok-agent-id']
    assert.equal(capturedAgent, 'agent-123')
  } finally {
    await server.close()
  }
})

/** G Code — HTTP 传输批次测试（本地服务器，无外网）。运行：pnpm test（node --test）。 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { gzipSync } from 'node:zlib'
import type { AddressInfo } from 'node:net'
import { createGrokHttpTransport } from '../../src/model/grok/grok-http.ts'

interface LocalServer {
  readonly url: URL
  readonly requests: Array<{ method: string; path: string; headers: http.IncomingHttpHeaders; body: string }>
  close(): Promise<void>
}

async function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, record: LocalServer['requests']) => void,
): Promise<LocalServer> {
  const requests: LocalServer['requests'] = []
  const server = http.createServer((req, res) => handler(req, res, requests))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: new URL(`http://127.0.0.1:${port}`),
    requests,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}

test('direct POST delivers explicit headers and streams the SSE body', async () => {
  const server = await startServer((req, res, record) => {
    let body = ''
    req.on('data', chunk => { body += String(chunk) })
    req.on('end', () => {
      record.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers, body })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: {"type":"start"}\n\n')
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  try {
    const transport = createGrokHttpTransport({})
    assert.equal(transport.mode, 'direct')
    const response = await transport.fetch(server.url, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-key',
        'x-grok-client-version': '1.0.38',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'grok-4.6' }),
    })
    assert.equal(response.status, 200)
    const text = await response.text()
    assert.equal(text, 'data: {"type":"start"}\n\ndata: [DONE]\n\n')
    const seen = server.requests[0]
    assert.equal(seen?.method, 'POST')
    assert.equal(seen?.headers['authorization'], 'Bearer test-key')
    assert.equal(seen?.headers['x-grok-client-version'], '1.0.38')
    assert.deepEqual(JSON.parse(seen?.body ?? ''), { model: 'grok-4.6' })
    assert.equal(seen?.headers['sec-fetch-mode'], undefined, 'no fetch default headers')
    await transport.close()
  } finally {
    await server.close()
  }
})

test('gzip responses are transparently decompressed', async () => {
  const payload = JSON.stringify({ hello: 'world' })
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' })
    res.end(gzipSync(payload))
  })
  try {
    const transport = createGrokHttpTransport({})
    const response = await transport.fetch(server.url)
    assert.equal(response.headers.get('content-encoding'), null)
    assert.equal(await response.text(), payload)
    await transport.close()
  } finally {
    await server.close()
  }
})

test('fresh HTTP/1.1 channel sends connection close', async () => {
  let sawConnection = ''
  const server = await startServer((req, res) => {
    sawConnection = String(req.headers['connection'] ?? '')
    res.writeHead(200)
    res.end('ok')
  })
  try {
    const transport = createGrokHttpTransport({})
    const response = await transport.freshHttp1Fetch(server.url)
    assert.equal(await response.text(), 'ok')
    assert.equal(sawConnection, 'close')
    await transport.close()
  } finally {
    await server.close()
  }
})

test('http proxy routing uses the configured proxy with sanitized diagnostics', async () => {
  const viaProxy: string[] = []
  const proxy = await startServer((req, res) => {
    viaProxy.push(req.url ?? '')
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('from-proxy')
  })
  try {
    const transport = createGrokHttpTransport({
      http_proxy: `http://user:secret@127.0.0.1:${(proxy.url as URL).port}`,
    })
    assert.equal(transport.mode, 'proxy')
    assert.deepEqual(transport.proxyEndpoints, [`http://127.0.0.1:${(proxy.url as URL).port}`])
    const response = await transport.fetch(new URL('http://api.internal/v1/models'))
    assert.equal(await response.text(), 'from-proxy')
    assert.deepEqual(viaProxy, ['http://api.internal/v1/models'])
    await transport.close()
  } finally {
    await proxy.close()
  }
})

test('NO_PROXY bypass wins over proxy configuration', async () => {
  const direct = await startServer((req, res) => {
    res.writeHead(200)
    res.end('direct')
  })
  try {
    const transport = createGrokHttpTransport({
      http_proxy: 'http://127.0.0.1:9',
      no_proxy: '127.0.0.1',
    })
    assert.equal(transport.mode, 'proxy')
    const response = await transport.fetch(direct.url)
    assert.equal(await response.text(), 'direct')
    await transport.close()
  } finally {
    await direct.close()
  }
})

test('https requests go through the CONNECT tunnel established with the proxy', async () => {
  const connects: string[] = []
  const proxy = http.createServer()
  proxy.on('connect', (req, socket) => {
    connects.push(req.url ?? '')
    const [host, port] = (req.url ?? '').split(':')
    const upstream = net.connect(Number(port), host)
    const teardown = (): void => {
      upstream.destroy()
      socket.destroy()
    }
    upstream.on('connect', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    upstream.on('close', teardown)
    socket.on('close', teardown)
  })
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
  const proxyPort = (proxy.address() as AddressInfo).port
  // 哑 origin：任何连接立即销毁，让隧道上的 TLS 握手快速失败。判别信号是
  // 代理侧 CONNECT 计数——被忽略的 tunnel socket 会让请求绕过代理直连。
  let originDials = 0
  const origin = net.createServer(socket => {
    originDials += 1
    socket.destroy()
  })
  await new Promise<void>(resolve => origin.listen(0, '127.0.0.1', resolve))
  const originPort = (origin.address() as AddressInfo).port
  const transport = createGrokHttpTransport({ https_proxy: `http://127.0.0.1:${proxyPort}` })
  await assert.rejects(
    transport.fetch(`https://localhost:${originPort}/responses`, { method: 'POST', body: '{}' }),
  )
  assert.deepEqual(connects, [`localhost:${originPort}`])
  assert.ok(originDials >= 1, 'proxy dialed the origin after CONNECT')
  await transport.close()
  await new Promise<void>(resolve => origin.close(() => resolve()))
  await new Promise<void>(resolve => proxy.close(() => resolve()))
})

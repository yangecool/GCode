/** G Code — /models 发现（H9）测试。 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { fetchGrokModelIds } from '../../src/grok/grok-discovery.ts'

test('fetchGrokModelIds lists deduped ids with bearer auth', async () => {
  const seen: Array<{ authorization?: string; accept?: string }> = []
  const server = http.createServer((req, res) => {
    seen.push({ authorization: req.headers.authorization, accept: req.headers.accept })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      object: 'list',
      data: [
        { id: 'grok-4.7' },
        { id: 'grok-4.6' },
        { id: 'grok-4.7' },
        { id: 42 },
        {},
      ],
    }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  try {
    const ids = await fetchGrokModelIds({ apiKey: 'k', baseURL: `http://127.0.0.1:${port}` })
    assert.deepEqual(ids, ['grok-4.7', 'grok-4.6'])
    assert.equal(seen[0]?.authorization, 'Bearer k')
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test('fetchGrokModelIds fails loud on non-2xx and malformed bodies', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(503)
    res.end('nope')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  try {
    await assert.rejects(
      fetchGrokModelIds({ apiKey: 'k', baseURL: `http://127.0.0.1:${port}` }),
      /HTTP 503/,
    )
    await assert.rejects(
      fetchGrokModelIds({
        apiKey: 'k',
        baseURL: `http://127.0.0.1:${port}`,
        transport: {
          fetch: async () => new Response('{"data": {}}', { headers: { 'content-type': 'application/json' } }),
          freshHttp1Fetch: async () => { throw new Error('unused') },
          mode: 'direct',
          proxyEndpoints: [],
          close: async () => {},
        },
      }),
      /no data array/,
    )
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

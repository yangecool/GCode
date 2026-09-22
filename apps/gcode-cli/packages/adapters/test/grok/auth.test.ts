/** G Code — 订阅 OAuth 测试（脚本化 IdP：设备流全路径 + 刷新 + 浏览器编排）。 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_CLIENT_ID,
  DEFAULT_ISSUER,
  GrokAuthService,
  authExpiresAtMs,
  getOrCreateGrokAgentId,
  gcodeHome,
  loginViaBrowser,
  openLoginUrl,
} from '../../src/grok/grok-auth.ts'

interface ScriptedIdp {
  readonly url: string
  readonly deviceRequests: Array<Record<string, string>>
  readonly tokenRequests: Array<Record<string, string>>
  close(): Promise<void>
}

/** 形如 IdP 的脚本服务器：device/code → token（先 pending 后成功）。 */
async function startIdp(script: {
  device?: (body: Record<string, string>) => Record<string, unknown>
  token?: (body: Record<string, string>, attempt: number) => { status: number; body: Record<string, unknown> }
}): Promise<ScriptedIdp> {
  const deviceRequests: Array<Record<string, string>> = []
  const tokenRequests: Array<Record<string, string>> = []
  let tokenAttempt = 0
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', chunk => { raw += String(chunk) })
    req.on('end', () => {
      const body = Object.fromEntries(new URLSearchParams(raw)) as Record<string, string>
      if (req.url === '/.well-known/openid-configuration') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ token_endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/oauth2/token` }))
        return
      }
      if (req.url === '/oauth2/device/code') {
        deviceRequests.push(body)
        const payload = script.device?.(body) ?? {
          device_code: 'dev_1',
          user_code: 'ABCD-1234',
          verification_uri: 'https://auth.x.ai/device',
          verification_uri_complete: 'https://auth.x.ai/device?code=ABCD-1234',
          expires_in: 600,
          interval: 1,
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(payload))
        return
      }
      if (req.url === '/oauth2/token') {
        tokenAttempt += 1
        tokenRequests.push(body)
        const verdict = script.token?.(body, tokenAttempt) ?? {
          status: 200,
          body: {
            access_token: 'at_1',
            refresh_token: 'rt_1',
            expires_in: 3600,
            id_token: `h.${Buffer.from(JSON.stringify({ sub: 'user-1', email: 'dev@x.ai' })).toString('base64url')}.s`,
          },
        }
        res.writeHead(verdict.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(verdict.body))
        return
      }
      res.writeHead(404)
      res.end('{}')
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    deviceRequests,
    tokenRequests,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}

function fakeNow(): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let at = 1_700_000_000_000
  const sleep = async (ms: number): Promise<void> => {
    at += Math.max(ms, 1)
    // 真实让出一个宏任务，让被测服务的真实 HTTP/fs 有机会推进。
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  return { now: () => at, sleep }
}

test('device login completes and persists a scoped token record', async () => {
  const idp = await startIdp({})
  const dir = await mkdtemp(join(tmpdir(), 'gcode-auth-'))
  let pendingOnce = false
  try {
    const clock = fakeNow()
    const service = new GrokAuthService(
      { issuer: idp.url, authPath: join(dir, 'auth.json') },
      { now: clock.now, sleep: clock.sleep },
    )
    const opened: string[] = []
    const result = await loginViaBrowser(service, {
      launch: async url => { opened.push(url) },
      now: clock.now,
      sleep: clock.sleep,
      pollMs: 1000,
    })
    assert.equal(result.status, 'complete')
    assert.equal(result.auth?.configured, true)
    assert.equal(result.auth?.email, 'dev@x.ai')
    // verification_uri_complete 优先（自动携带 user code）。
    assert.deepEqual(opened, ['https://auth.x.ai/device?code=ABCD-1234'])
    assert.equal(idp.deviceRequests[0]?.client_id, DEFAULT_CLIENT_ID)
    assert.ok((idp.deviceRequests[0]?.scope ?? '').includes('grok-cli:access'))
    assert.equal(idp.tokenRequests[0]?.grant_type, 'urn:ietf:params:oauth:grant-type:device_code')
    assert.equal(idp.tokenRequests[0]?.device_code, 'dev_1')

    const stored = JSON.parse(await readFile(join(dir, 'auth.json'), 'utf8')) as Record<string, Record<string, unknown>>
    const scope = `${idp.url}::${DEFAULT_CLIENT_ID}`
    const record = stored[scope]
    assert.equal(record?.key, 'at_1')
    assert.equal(record?.refresh_token, 'rt_1')
    assert.equal(record?.auth_mode, 'oidc')
    assert.equal(record?.user_id, 'user-1')
    assert.ok(authExpiresAtMs(record ?? {}) !== undefined)
    assert.equal(await service.resolveAccessToken(), 'at_1')
    service.close()
  } finally {
    await idp.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('authorization_pending retries then slow_down backs off; denial surfaces an error', async () => {
  const idp = await startIdp({
    token: (_body, attempt) => {
      if (attempt === 1) return { status: 400, body: { error: 'authorization_pending' } }
      if (attempt === 2) return { status: 400, body: { error: 'slow_down' } }
      return { status: 400, body: { error: 'access_denied' } }
    },
  })
  const dir = await mkdtemp(join(tmpdir(), 'gcode-auth-'))
  try {
    const clock = fakeNow()
    const service = new GrokAuthService(
      { issuer: idp.url, authPath: join(dir, 'auth.json') },
      { now: clock.now, sleep: clock.sleep },
    )
    const result = await loginViaBrowser(service, {
      launch: async () => {},
      now: clock.now,
      sleep: clock.sleep,
      pollMs: 1000,
    })
    assert.equal(result.status, 'error')
    assert.equal(result.error, 'authorization denied')
    assert.equal(idp.tokenRequests.length, 3)
    service.close()
  } finally {
    await idp.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('expired token refreshes once under single flight', async () => {
  const idp = await startIdp({
    token: body => {
      if (body.grant_type === 'refresh_token') {
        return { status: 200, body: { access_token: 'at_2', refresh_token: 'rt_2', expires_in: 3600 } }
      }
      return { status: 400, body: { error: 'unsupported_grant_type' } }
    },
  })
  const dir = await mkdtemp(join(tmpdir(), 'gcode-auth-'))
  try {
    const authPath = join(dir, 'auth.json')
    await writeFile(authPath, JSON.stringify({
      [`${idp.url}::${DEFAULT_CLIENT_ID}`]: {
        key: 'at_stale',
        refresh_token: 'rt_1',
        create_time: new Date(1_700_000_000_000).toISOString(),
        expires_at: new Date(1_700_000_000_500).toISOString(),
      },
    }), 'utf8')
    const clock = fakeNow()
    const service = new GrokAuthService(
      { issuer: idp.url, authPath },
      { now: clock.now },
    )
    assert.equal(await service.resolveAccessToken(), 'at_2')
    assert.equal(await service.resolveAccessToken(), 'at_2')
    const refreshes = idp.tokenRequests.filter(body => body.grant_type === 'refresh_token')
    assert.equal(refreshes.length, 1)
    assert.equal(refreshes[0]?.refresh_token, 'rt_1')
    service.close()
  } finally {
    await idp.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('browser launcher failure keeps the flow alive for manual fallback', async () => {
  const idp = await startIdp({})
  const dir = await mkdtemp(join(tmpdir(), 'gcode-auth-'))
  try {
    const clock = fakeNow()
    const service = new GrokAuthService(
      { issuer: idp.url, authPath: join(dir, 'auth.json') },
      { now: clock.now, sleep: clock.sleep },
    )
    const result = await loginViaBrowser(service, {
      launch: async () => { throw new Error('no xdg-open') },
      now: clock.now,
      sleep: clock.sleep,
      pollMs: 1000,
    })
    // 浏览器没打开但登录本身完成（用户手动访问）——状态由 IdP 决定。
    assert.equal(result.status, 'complete')
    assert.equal(result.userCode, 'ABCD-1234')
    service.close()
  } finally {
    await idp.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('openLoginUrl prefers the complete URI and agent id persists', async () => {
  const opened: string[] = []
  await openLoginUrl(
    { flowId: 'f', userCode: 'U', verificationUri: 'https://a/device', expiresAt: new Date().toISOString() },
    async url => { opened.push(url) },
  )
  await openLoginUrl(
    {
      flowId: 'f', userCode: 'U', verificationUri: 'https://a/device',
      verificationUriComplete: 'https://a/device?code=U', expiresAt: new Date().toISOString(),
    },
    async url => { opened.push(url) },
  )
  assert.deepEqual(opened, ['https://a/device', 'https://a/device?code=U'])

  const home = await mkdtemp(join(tmpdir(), 'gcode-agent-'))
  try {
    const id = getOrCreateGrokAgentId({ home, randomUUID: () => 'fixed-uuid' })
    assert.equal(id, 'fixed-uuid')
    assert.equal(getOrCreateGrokAgentId({ home }), 'fixed-uuid')
    const raw = await readFile(join(home, 'agent_id'), 'utf8')
    assert.equal(raw.trim(), 'fixed-uuid')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('home resolution prefers GCODE_HOME and keeps defaults intact', () => {
  assert.equal(gcodeHome({ GCODE_HOME: '/g' }), '/g')
  assert.equal(gcodeHome({ GROK_HOME: '/legacy' }), '/legacy')
  assert.ok(gcodeHome({}).endsWith('.gcode'))
  assert.equal(DEFAULT_ISSUER, 'https://auth.x.ai')
})

/**
 * G Code — Grok HTTP 传输（M1 adapter 批次，零依赖）。
 *
 * 移植自 grok-harness `packages/grok/model/src/proxy.ts`（undici 版），改用
 * node:http/https 实现：显式头集合（不带 fetch 默认的 sec-fetch-mode /
 * accept-language）、进程 env 代理解析（小写/大写、ALL_PROXY 兜底、NO_PROXY
 * 权威）、HTTPS-over-proxy 走 CONNECT 隧道、gzip/br/deflate 透明解压、
 * freshHttp1Fetch 单请求 HTTP/1.1 通道（Connection: close，首个 5xx 恢复用）。
 * 简化项（相对 undici 版）：NO_PROXY 仅按主机名后缀/全等/'*' 匹配（不含
 * CIDR）；代理端点按 http 代理处理（https 源代理不支持，诊断中可见）。
 */

import http from 'node:http'
import https from 'node:https'
import { Readable } from 'node:stream'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'

/** Environment names that participate in Grok request routing. */
export type GrokProxyEnvironment = Readonly<Record<string, string | undefined>>

/** One lifecycle-owned fetch implementation and its non-secret route summary. */
export interface GrokHttpTransport {
  /** Fetch implementation injected into model and discovery requests. */
  readonly fetch: typeof globalThis.fetch
  /** One-request, pool-isolated HTTP/1.1 transport used for first-failure recovery. */
  readonly freshHttp1Fetch: typeof globalThis.fetch
  /** `direct` when no proxy variable was configured, otherwise `proxy`. */
  readonly mode: 'direct' | 'proxy'
  /** Credential-free endpoints used only in diagnostics. */
  readonly proxyEndpoints: readonly string[]
  /** Close direct/proxy connection pools. */
  close(): Promise<void>
}

/** First non-blank value, preserving the conventional lowercase precedence. */
function environmentValue(environment: GrokProxyEnvironment, ...names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = environment[name]?.trim()
    if (value !== undefined && value.length > 0) return value
  }
  return undefined
}

/** Render a proxy authority without ever retaining username/password text. */
function safeProxyEndpoint(value: string): string {
  try {
    const parsed = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `http://${value}`)
    return `${parsed.protocol}//${parsed.host}`
  } catch {
    return '<invalid proxy URL>'
  }
}

/** Prefer the most specific, deepest network failure over generic messages. */
function transportFailureDetail(error: unknown): string {
  let cursor: unknown = error
  let fallback = 'unknown transport error'
  const visited = new Set<unknown>()
  for (let depth = 0; depth < 8 && cursor !== undefined && cursor !== null; depth += 1) {
    if (visited.has(cursor)) break
    visited.add(cursor)
    if (!(cursor instanceof Error)) break
    if (cursor.message.length > 0 && cursor.message !== 'fetch failed') {
      const code = (cursor as Error & { code?: unknown }).code
      fallback = typeof code === 'string' && !cursor.message.includes(code)
        ? `${code}: ${cursor.message}`
        : cursor.message
    }
    cursor = (cursor as Error & { cause?: unknown }).cause
  }
  return fallback
}

/** Transport marker whose message contains only credential-free route facts. */
class GrokTransportError extends TypeError {
  override readonly name = 'GrokTransportError'
}

function noProxyMatches(noProxy: string, hostname: string): boolean {
  const value = noProxy.trim()
  if (value.length === 0) return false
  if (value === '*') return true
  return value.split(',').some(entry => {
    const pattern = entry.trim().replace(/^\./, '').toLowerCase()
    if (pattern.length === 0) return false
    const host = hostname.toLowerCase()
    return host === pattern || host.endsWith(`.${pattern}`)
  })
}

interface ResolvedRoute {
  readonly proxyUrl: URL | undefined
  readonly bypass: boolean
}

function resolveRoute(target: URL, httpProxy: string, httpsProxy: string, noProxy: string): ResolvedRoute {
  if (noProxyMatches(noProxy, target.hostname)) return { proxyUrl: undefined, bypass: true }
  const raw = target.protocol === 'https:' ? httpsProxy : httpProxy
  if (raw.length === 0) return { proxyUrl: undefined, bypass: false }
  try {
    return { proxyUrl: new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`), bypass: false }
  } catch {
    throw new GrokTransportError(`Grok proxy configuration "${safeProxyEndpoint(raw)}" is invalid`)
  }
}

function openTunnel(proxy: URL, target: URL, signal?: AbortSignal): Promise<net_SocketLike> {
  return new Promise((resolve, reject) => {
    const connectReq = http.request({
      host: proxy.hostname,
      port: proxy.port === '' ? 80 : Number(proxy.port),
      method: 'CONNECT',
      path: `${target.hostname}:${target.port === '' ? 443 : Number(target.port)}`,
      headers: { host: `${target.hostname}` },
    })
    const fail = (error: unknown): void => {
      reject(error instanceof Error ? error : new Error(String(error)))
    }
    if (signal !== undefined) {
      const onAbort = (): void => { connectReq.destroy(new Error('aborted')) }
      signal.addEventListener('abort', onAbort, { once: true })
      connectReq.once('close', () => signal.removeEventListener('abort', onAbort))
    }
    connectReq.once('connect', (response, socket) => {
      if (response.statusCode === 200) {
        resolve(socket)
      } else {
        socket.destroy()
        fail(new Error(`proxy CONNECT failed with ${response.statusCode ?? 'unknown status'}`))
      }
    })
    connectReq.once('error', fail)
    connectReq.end()
  })
}

interface net_SocketLike {
  destroy(): void
}

interface PerformOptions {
  readonly freshHttp1: boolean
}

async function perform(
  url: URL,
  init: RequestInit | undefined,
  route: ResolvedRoute,
  options: PerformOptions,
): Promise<Response> {
  const requestBody = init?.body
  let requestPayload: string | Uint8Array | undefined
  if (typeof requestBody === 'string') requestPayload = requestBody
  else if (requestBody instanceof Uint8Array) requestPayload = requestBody
  else if (requestBody instanceof ArrayBuffer) requestPayload = new Uint8Array(requestBody)
  else if (requestBody instanceof URLSearchParams) requestPayload = requestBody.toString()
  else if (requestBody !== undefined && requestBody !== null) {
    throw new TypeError('Grok transport supports string, byte, ArrayBuffer, or URLSearchParams bodies')
  }
  const headers = Object.fromEntries(new Headers(init?.headers).entries())
  const method = init?.method ?? (requestPayload === undefined ? 'GET' : 'POST')
  const signal = init?.signal === null ? undefined : init?.signal

  const send = (protocol: typeof http | typeof https, requestOptions: http.RequestOptions): Promise<Response> =>
    new Promise<Response>((resolve, reject) => {
      const agent = options.freshHttp1
        ? new protocol.Agent({ keepAlive: false, maxSockets: 1 })
        : undefined
      const request = protocol.request({
        ...requestOptions,
        agent,
        // fresh 通道显式声明单请求语义，不依赖 agent 内部默认。
        headers: options.freshHttp1 ? { ...requestOptions.headers, connection: 'close' } : requestOptions.headers,
      }, response => {
        const responseHeaders = new Headers()
        for (const [name, raw] of Object.entries(response.headers)) {
          if (raw === undefined) continue
          if (Array.isArray(raw)) {
            for (const value of raw) responseHeaders.append(name, value)
          } else {
            responseHeaders.set(name, raw)
          }
        }
        let body: Readable = response
        const encoding = responseHeaders.get('content-encoding')?.trim().toLowerCase()
        if (encoding === 'gzip' || encoding === 'x-gzip') body = body.pipe(createGunzip())
        else if (encoding === 'br') body = body.pipe(createBrotliDecompress())
        else if (encoding === 'deflate') body = body.pipe(createInflate())
        if (encoding === 'gzip' || encoding === 'x-gzip' || encoding === 'br' || encoding === 'deflate') {
          responseHeaders.delete('content-encoding')
          responseHeaders.delete('content-length')
        }
        const empty = response.statusCode === 204 || response.statusCode === 205 || response.statusCode === 304
        resolve(new Response(empty ? null : Readable.toWeb(body) as ReadableStream<Uint8Array>, {
          status: response.statusCode,
          headers: responseHeaders,
        }))
      })
      request.once('error', reject)
      if (signal !== undefined) {
        const onAbort = (): void => request.destroy(new Error('aborted'))
        signal.addEventListener('abort', onAbort, { once: true })
        request.once('close', () => signal.removeEventListener('abort', onAbort))
      }
      if (requestPayload === undefined) request.end()
      else request.end(requestPayload)
    })

  try {
    if (route.proxyUrl === undefined) {
      return url.protocol === 'https:'
        ? await send(https, { hostname: url.hostname, port: url.port === '' ? 443 : Number(url.port), path: `${url.pathname}${url.search}`, method, headers })
        : await send(http, { hostname: url.hostname, port: url.port === '' ? 80 : Number(url.port), path: `${url.pathname}${url.search}`, method, headers })
    }
    const proxy = route.proxyUrl
    if (url.protocol === 'https:') {
      const socket = await openTunnel(proxy, url, signal)
      return await send(https, {
        socket,
        agent: false,
        path: `${url.pathname}${url.search}`,
        method,
        headers,
      })
    }
    return await send(http, {
      hostname: proxy.hostname,
      port: proxy.port === '' ? 80 : Number(proxy.port),
      path: url.toString(),
      method,
      headers,
    })
  } catch (error: unknown) {
    throw new GrokTransportError(`Grok ${options.freshHttp1 ? 'fresh HTTP/1.1 ' : ''}request failed: ${transportFailureDetail(error)}`)
  }
}

/**
 * Build one Grok request transport from the process environment.
 *
 * Lowercase/uppercase HTTP and HTTPS proxy variables are recognized, HTTPS
 * falls back to the HTTP value, `ALL_PROXY` is the final fallback, and
 * `NO_PROXY` remains authoritative. Empty configuration means direct access.
 * @param environment - launch environment, injectable for deterministic tests.
 * @returns a lifecycle-owned fetch pair and route diagnostics.
 */
export function createGrokHttpTransport(environment: GrokProxyEnvironment = process.env): GrokHttpTransport {
  const allProxy = environmentValue(environment, 'all_proxy', 'ALL_PROXY')
  const httpProxy = environmentValue(environment, 'http_proxy', 'HTTP_PROXY') ?? allProxy ?? ''
  const httpsProxy = environmentValue(environment, 'https_proxy', 'HTTPS_PROXY') ?? httpProxy
  const noProxy = environment.no_proxy ?? environment.NO_PROXY ?? ''
  const proxyEndpoints = [...new Set([httpProxy, httpsProxy].filter(value => value.length > 0))]
    .map(safeProxyEndpoint)
  const routeCache = new Map<string, ResolvedRoute>()
  const routeOf = (url: URL): ResolvedRoute => {
    const key = url.origin
    let route = routeCache.get(key)
    if (route === undefined) {
      route = resolveRoute(url, httpProxy, httpsProxy, noProxy)
      routeCache.set(key, route)
    }
    return route
  }
  const make = (freshHttp1: boolean): typeof globalThis.fetch =>
    (input, init) => {
      if (input instanceof Request) {
        throw new TypeError('Grok transport accepts URL inputs, not pre-built Request objects')
      }
      const url = input instanceof URL ? input : new URL(input)
      return perform(url, init, routeOf(url), { freshHttp1 })
    }
  return {
    fetch: make(false),
    freshHttp1Fetch: make(true),
    mode: proxyEndpoints.length > 0 ? 'proxy' : 'direct',
    proxyEndpoints,
    close: async () => {
      http.globalAgent.destroy()
      https.globalAgent.destroy()
    },
  }
}

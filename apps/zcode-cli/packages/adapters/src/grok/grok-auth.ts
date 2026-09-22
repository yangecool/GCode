/**
 * G Code — Grok 订阅 OAuth（M2-b，移植自 grok-harness auth 核心服务）。
 *
 * OIDC 设备流（issuer https://auth.x.ai）+ 刷新令牌持久化 + 单飞刷新。
 * Rust grok-build 对账事实：刷新在 TTL 最后 60s 触发；刷新锁 25s 上限；
 * 设备码有效期下限 10 分钟；跨进程刷新竞态在锁内复读存储、复用他方结果；
 * 瞬态 IdP 故障时回退"未过期旧令牌"（绝不发送真过期令牌）。
 *
 * GCode 适配：home 解析 `GCODE_HOME` → `GROK_HOME` → `~/.gcode`；auth 存储
 * `<home>/auth.json`（0600，目录 0700）；`GCODE_AUTH`/`GROK_AUTH` 内联只读
 * 存储；`agent_id` 复用原生 `<home>/agent_id` 文件。原子写与文件锁为本模块
 * 自实现（替代 dsh-atomic-write）：临时文件 + rename；锁为 lockfile 轮询。
 */

import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { chmod, mkdir, readFile, rename, rm, writeFile, open } from 'node:fs/promises'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'

/** Rust grok-build 兼容 OIDC issuer。 */
export const DEFAULT_ISSUER = 'https://auth.x.ai'
/** Rust grok-build 兼容公共 OAuth client id。 */
export const DEFAULT_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828'
/** 订阅代理与账号面要求的 scope 集。 */
export const DEFAULT_SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'grok-cli:access',
  'api:access',
  'conversations:read',
  'conversations:write',
  'workspaces:read',
  'workspaces:write',
] as const
/** 设备流 referrer。 */
export const DEFAULT_REFERRER = 'grok-build'
/** 订阅代理头里的 client 归因。 */
export const DEFAULT_CLIENT_IDENTIFIER = 'grok-shell'
/** OAuth 端点上报的版本（对齐 Rust 发布版）。 */
export const CLIENT_VERSION = '1.0.38'

/** Rust 设备码有效期下限（秒）。 */
const MIN_DEVICE_CODE_EXPIRY_SECONDS = 10 * 60
/** TTL 最后 60s 内刷新 OIDC bearer。 */
const REFRESH_MARGIN_MS = 60_000
/** 刷新专属跨进程锁获取上限。 */
const REFRESH_LOCK_TIMEOUT_MS = 25_000
const REQUEST_TIMEOUT_MS = 15_000
const LOCK_POLL_MS = 50
const LOCK_TIMEOUT_MS = 10_000

type AuthRecord = Record<string, unknown>
type AuthStore = Record<string, AuthRecord>

interface TokenResponse {
  access_token?: unknown
  refresh_token?: unknown
  expires_in?: unknown
  id_token?: unknown
}

interface DeviceResponse {
  device_code?: unknown
  user_code?: unknown
  verification_uri?: unknown
  verification_uri_complete?: unknown
  expires_in?: unknown
  interval?: unknown
}

interface DiscoveryResponse {
  token_endpoint?: unknown
}

interface PendingFlow {
  readonly flowId: string
  status: 'pending' | 'complete' | 'error'
  readonly userCode: string
  readonly verificationUri: string
  readonly verificationUriComplete?: string
  readonly expiresAt: string
  readonly deviceCode: string
  readonly intervalMs: number
  error?: string
}

/** 公开设备流状态（不含 device_code）。 */
export interface GrokDeviceStart {
  readonly flowId: string
  readonly userCode: string
  readonly verificationUri: string
  readonly verificationUriComplete?: string
  readonly expiresAt: string
}

export interface GrokDeviceFlowStatus extends GrokDeviceStart {
  readonly status: 'pending' | 'complete' | 'error'
  readonly error?: string
}

/** 账号状态（已脱敏，无令牌本体）。 */
export interface GrokAuthStatus {
  readonly configured: boolean
  readonly pending: boolean
  readonly userId?: string
  readonly email?: string
  readonly expiresAt?: string
}

/** OAuth 端点错误（code 为 IdP 的 error 码）。 */
export class GrokOAuthError extends Error {
  readonly code: string | undefined
  readonly status: number

  constructor(message: string, code: string | undefined, status: number) {
    super(message)
    this.name = 'GrokOAuthError'
    this.code = code
    this.status = status
  }
}

// ---------------------------------------------------------------------------
// home / 路径 / agent_id
// ---------------------------------------------------------------------------

function environmentValue(name: string): string | undefined {
  const value = process.env[name]?.trim()
  return value === undefined || value.length === 0 ? undefined : value
}

/** GCode home：`GCODE_HOME` → `GROK_HOME` → `~/.gcode`。 */
export function gcodeHome(env: Record<string, string | undefined> = process.env): string {
  const configured = env.GCODE_HOME?.trim() || env.GROK_HOME?.trim()
  return resolve(configured !== undefined && configured.length > 0 ? configured : join(homedir(), '.gcode'))
}

/** auth 存储路径：显式配置 → `<home>/auth.json`。 */
export function grokAuthFilePath(configured?: string): string {
  const explicit = configured ?? environmentValue('GCODE_AUTH_PATH') ?? environmentValue('GROK_AUTH_PATH')
  if (explicit !== undefined) return resolve(explicit)
  return join(gcodeHome(), 'auth.json')
}

/** 内联只读存储（`GCODE_AUTH`，迁移期兼容 `GROK_AUTH`）。 */
function inlineAuthStore(): AuthStore | undefined {
  const raw = environmentValue('GCODE_AUTH') ?? environmentValue('GROK_AUTH')
  return raw === undefined ? undefined : parseAuthStore(raw, 'GCODE_AUTH')
}

export interface GrokAgentIdOptions {
  home?: string
  env?: Record<string, string | undefined>
  randomUUID?: () => string
}

const agentIdMemo = new Map<string, string>()

function readAgentId(path: string): string | undefined {
  let value: string
  try { value = readFileSync(path, 'utf8').trim() } catch { return undefined }
  if (value.length === 0) return undefined
  try { chmodSync(path, 0o600) } catch { /* 可读即兼容 */ }
  return value
}

/** 模型请求用的稳定设备身份（复用/创建 `<home>/agent_id`，owner-only）。 */
export function getOrCreateGrokAgentId(options: GrokAgentIdOptions = {}): string {
  const env = options.env ?? process.env
  const home = resolve(options.home ?? env.GCODE_HOME ?? env.GROK_HOME ?? join(homedir(), '.gcode'))
  const path = join(home, 'agent_id')
  const memoized = agentIdMemo.get(path)
  if (memoized !== undefined) return memoized

  let id = readAgentId(path)
  if (id === undefined) {
    const created = (options.randomUUID ?? randomUUID)()
    try {
      mkdirSync(home, { recursive: true, mode: 0o700 })
      writeFileSync(path, created, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      id = created
    } catch {
      id = readAgentId(path)
      if (id === undefined) {
        try {
          writeFileSync(path, created, { encoding: 'utf8', mode: 0o600 })
          chmodSync(path, 0o600)
        } catch { /* 不可写 home 时保持进程内稳定 */ }
        id = created
      }
    }
  }
  agentIdMemo.set(path, id)
  return id
}

// ---------------------------------------------------------------------------
// 存储读写（解析、原子写、文件锁）
// ---------------------------------------------------------------------------

function parseAuthStore(raw: string, source: string): AuthStore {
  if (raw.trim() === '') return {}
  let value: unknown
  try { value = JSON.parse(raw) } catch (error) {
    throw new Error(`grok-auth: ${source} is not valid JSON: ${String(error)}`)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`grok-auth: ${source} must be an object keyed by auth scope`)
  }
  const store: AuthStore = {}
  for (const [scope, record] of Object.entries(value)) {
    if (typeof record !== 'object' || record === null || Array.isArray(record)) continue
    store[scope] = record as AuthRecord
  }
  return store
}

async function readAuthStore(path: string): Promise<AuthStore> {
  let raw: string
  try { raw = await readFile(path, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
  try { await chmod(path, 0o600) } catch { /* 读权限仍然可用 */ }
  return parseAuthStore(raw, path)
}

/** 临时文件 + rename 原子写（owner-only）。 */
export async function writeFileAtomic(path: string, content: string): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`
  await writeFile(temp, content, { encoding: 'utf8', mode: 0o600 })
  await rename(temp, path)
}

/** lockfile 轮询互斥；超时抛出（与 dsh 原子写同消息形状，供刷新锁识别）。 */
export async function withFileLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const lock = `${path}.lock`
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  const handle = await open(lock, 'wx', 0o600).catch(async (error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    return undefined
  })
  if (handle === undefined) {
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, LOCK_POLL_MS))
      const retry = await open(lock, 'wx', 0o600).catch(() => undefined)
      if (retry !== undefined) {
        try {
          return await operation()
        } finally {
          await retry.close().catch(() => {})
          await rm(lock, { force: true }).catch(() => {})
        }
      }
    }
    throw new Error(`atomic-write: timed out waiting for the writer lock at ${lock}`)
  }
  try {
    return await operation()
  } finally {
    await handle.close().catch(() => {})
    await rm(lock, { force: true }).catch(() => {})
  }
}

function writerLockTimedOut(error: unknown, path: string): boolean {
  return error instanceof Error
    && error.message === `atomic-write: timed out waiting for the writer lock at ${path}.lock`
}

async function withRefreshFileLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + REFRESH_LOCK_TIMEOUT_MS
  for (;;) {
    try {
      return await withFileLock(path, operation)
    } catch (error) {
      if (!writerLockTimedOut(error, path) || Date.now() >= deadline) throw error
    }
  }
}

// ---------------------------------------------------------------------------
// 记录字段工具
// ---------------------------------------------------------------------------

function stringField(record: AuthRecord | undefined, key: string): string | undefined {
  const value = record?.[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function numberField(record: AuthRecord | undefined, key: string): number | undefined {
  const value = record?.[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/** 过期时刻（毫秒）；无 expires_at 时按创建时间 +30 天（Rust 同口径）。 */
export function authExpiresAtMs(record: Record<string, unknown>): number | undefined {
  const explicit = numberField(record, 'expires_at')
  if (explicit !== undefined) return explicit < 10_000_000_000 ? explicit * 1000 : explicit
  const created = numberField(record, 'create_time')
  return created === undefined ? undefined : created + 30 * 24 * 60 * 60 * 1000
}

function tokenRecord(record: AuthRecord | undefined): AuthRecord | undefined {
  return stringField(record, 'key') === undefined ? undefined : record
}

function jwtClaims(token: string): { sub?: string; email?: string } {
  const payload = token.split('.', 3)[1]
  if (payload === undefined) return {}
  try {
    const json = Buffer.from(payload, 'base64url').toString('utf8')
    const value = JSON.parse(json) as Record<string, unknown>
    return {
      ...typeof value.sub === 'string' ? { sub: value.sub } : {},
      ...typeof value.email === 'string' ? { email: value.email } : {},
    }
  } catch { return {} }
}

function validVerificationUri(value: string): string {
  const parsed = new URL(value)
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('verification URI must be HTTP(S)')
  for (const character of value) {
    if (character.charCodeAt(0) < 0x20) throw new Error('verification URI has control characters')
  }
  return value
}

function errorBody(body: string): { code?: string; description?: string } {
  try {
    const value = JSON.parse(body) as Record<string, unknown>
    return {
      ...typeof value.error === 'string' ? { code: value.error } : {},
      ...typeof value.error_description === 'string' ? { description: value.error_description } : {},
    }
  } catch { return {} }
}

// ---------------------------------------------------------------------------
// 核心服务
// ---------------------------------------------------------------------------

export interface GrokAuthConfig {
  readonly issuer?: string
  readonly clientId?: string
  readonly scopes?: readonly string[]
  readonly referrer?: string
  readonly authPath?: string
}

export type GrokAuthFetcher = (url: string, init: RequestInit) => Promise<Response>

export interface GrokAuthServiceOptions {
  readonly fetcher?: GrokAuthFetcher
  readonly now?: () => number
  readonly sleep?: (ms: number) => Promise<void>
}

/** 订阅 OAuth 核心服务（设备流 + 刷新 + 单飞解析）。 */
export class GrokAuthService {
  private readonly issuer: string
  private readonly clientId: string
  private readonly scopes: string[]
  private readonly referrer: string
  private readonly authPath: string
  private readonly fetcher: GrokAuthFetcher
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly flows = new Map<string, PendingFlow>()
  private refreshPromise: Promise<string | undefined> | undefined
  private closed = false

  constructor(config: GrokAuthConfig = {}, options: GrokAuthServiceOptions = {}) {
    this.issuer = (config.issuer ?? DEFAULT_ISSUER).replace(/\/+$/, '')
    this.clientId = config.clientId ?? DEFAULT_CLIENT_ID
    this.scopes = config.scopes === undefined || config.scopes.length === 0 ? [...DEFAULT_SCOPES] : [...config.scopes]
    this.referrer = config.referrer ?? DEFAULT_REFERRER
    this.authPath = grokAuthFilePath(config.authPath)
    this.fetcher = options.fetcher ?? (async (url, init) => fetch(url, init))
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  }

  private scope(): string {
    return `${this.issuer}::${this.clientId}`
  }

  private stopped(): boolean {
    return this.closed
  }

  private async store(): Promise<AuthStore> {
    return inlineAuthStore() ?? readAuthStore(this.authPath)
  }

  private async record(): Promise<AuthRecord | undefined> {
    return tokenRecord((await this.store())[this.scope()])
  }

  private async requestJson<T>(url: string, init: RequestInit = {}): Promise<T> {
    const controller = new AbortController()
    const timeout = setTimeout(() => { controller.abort() }, REQUEST_TIMEOUT_MS)
    try {
      const response = await this.fetcher(url, { ...init, signal: controller.signal })
      const body = await response.text()
      if (!response.ok) {
        const parsed = errorBody(body)
        throw new GrokOAuthError(
          parsed.description ?? `HTTP ${response.status} from ${url}`,
          parsed.code,
          response.status,
        )
      }
      try { return JSON.parse(body) as T } catch { throw new Error(`grok-auth: invalid JSON from ${url}`) }
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`grok-auth: request to ${new URL(url).host} timed out`)
      if (error instanceof TypeError && error.message === 'fetch failed') {
        const cause = (error as Error & { cause?: unknown }).cause
        const detail = cause instanceof Error ? `: ${cause.message}` : ''
        throw new Error(`grok-auth: could not reach ${new URL(url).host}${detail}`)
      }
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }

  private async writeStore(update: (store: AuthStore) => void): Promise<void> {
    if (inlineAuthStore() !== undefined) throw new Error('grok-auth: GCODE_AUTH is read-only; unset it before changing login')
    const path = this.authPath
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await withFileLock(path, async () => {
      const current = await readAuthStore(path)
      update(current)
      await writeFileAtomic(path, `${JSON.stringify(current, null, 2)}\n`)
    })
  }

  private toRecord(tokens: TokenResponse, previous?: AuthRecord): AuthRecord {
    const accessToken = typeof tokens.access_token === 'string' ? tokens.access_token : undefined
    if (accessToken === undefined || accessToken.length === 0) throw new Error('grok-auth: token response has no access_token')
    const claims = typeof tokens.id_token === 'string' ? jwtClaims(tokens.id_token) : {}
    const now = this.now()
    const refreshToken = typeof tokens.refresh_token === 'string'
      ? tokens.refresh_token
      : stringField(previous, 'refresh_token')
    const expiresIn = typeof tokens.expires_in === 'number' && Number.isFinite(tokens.expires_in)
      ? tokens.expires_in
      : undefined
    const email = claims.email ?? stringField(previous, 'email')
    const record: AuthRecord = {
      ...(previous ?? {}),
      key: accessToken,
      auth_mode: 'oidc',
      create_time: new Date(now).toISOString(),
      user_id: claims.sub ?? stringField(previous, 'user_id') ?? '',
      ...email === undefined ? {} : { email },
      ...refreshToken === undefined ? {} : { refresh_token: refreshToken },
      ...expiresIn === undefined ? {} : { expires_at: new Date(now + expiresIn * 1000).toISOString() },
      oidc_issuer: this.issuer,
      oidc_client_id: this.clientId,
    }
    return record
  }

  private async persistToken(tokens: TokenResponse, previous?: AuthRecord): Promise<AuthRecord> {
    const record = this.toRecord(tokens, previous)
    await this.writeStore((store) => { store[this.scope()] = record })
    return record
  }

  private async discovery(): Promise<string> {
    const discovery = await this.requestJson<DiscoveryResponse>(
      `${this.issuer}/.well-known/openid-configuration`,
      { headers: { accept: 'application/json', 'x-grok-client-version': CLIENT_VERSION } },
    )
    if (typeof discovery.token_endpoint !== 'string') throw new Error('grok-auth: discovery has no token_endpoint')
    return discovery.token_endpoint
  }

  private async refresh(record: AuthRecord): Promise<string | undefined> {
    if (inlineAuthStore() !== undefined) {
      throw new Error('grok-auth: GCODE_AUTH is read-only and cannot persist a refreshed token')
    }
    const path = this.authPath
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    return withRefreshFileLock(path, async () => {
      const store = await readAuthStore(path)
      const current = tokenRecord(store[this.scope()]) ?? record
      const currentKey = stringField(current, 'key')
      const currentExpiry = authExpiresAtMs(current)
      // 他进程可能已在锁等待期间完成刷新：复用其持久结果，不二次轮换 refresh token。
      if (currentKey !== undefined
        && (currentExpiry === undefined || currentExpiry - this.now() > REFRESH_MARGIN_MS)) {
        return currentKey
      }
      const refreshToken = stringField(current, 'refresh_token')
      if (refreshToken === undefined) return undefined
      const tokenEndpoint = await this.discovery()
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: this.clientId,
      })
      const principalType = stringField(current, 'principal_type')
      const principalId = stringField(current, 'principal_id')
      if (principalType !== undefined) body.set('principal_type', principalType)
      if (principalId !== undefined) body.set('principal_id', principalId)
      const tokens = await this.requestJson<TokenResponse>(tokenEndpoint, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
          'x-grok-client-version': CLIENT_VERSION,
        },
        body: body.toString(),
      })
      const next = this.toRecord(tokens, current)
      store[this.scope()] = next
      await writeFileAtomic(path, `${JSON.stringify(store, null, 2)}\n`)
      return stringField(next, 'key')
    })
  }

  /** 解析订阅采样 bearer（单飞；过期前 60s 内刷新）。 */
  async resolveAccessToken(): Promise<string | undefined> {
    if (this.refreshPromise !== undefined) return this.refreshPromise
    this.refreshPromise = this.resolveAccessTokenOnce().finally(() => { this.refreshPromise = undefined })
    return this.refreshPromise
  }

  private async resolveAccessTokenOnce(): Promise<string | undefined> {
    const record = await this.record()
    const key = stringField(record, 'key')
    if (record === undefined || key === undefined) return undefined
    const expiry = authExpiresAtMs(record)
    if (expiry === undefined || expiry - this.now() > REFRESH_MARGIN_MS) return key
    if (stringField(record, 'refresh_token') === undefined) {
      if (expiry > this.now()) return key
      throw new Error('grok-auth: subscription token expired and has no refresh_token')
    }
    try {
      return await this.refresh(record) ?? key
    } catch (error) {
      // 瞬态 IdP 故障时回退"未过期旧令牌"；绝不发送真过期令牌。
      if (expiry > this.now()) return key
      throw error
    }
  }

  /** 脱敏账号状态。 */
  async status(): Promise<GrokAuthStatus> {
    const record = await this.record()
    const expiry = record === undefined ? undefined : authExpiresAtMs(record)
    const expiresAt = typeof record?.expires_at === 'string' ? record.expires_at : undefined
    const displayExpiry = expiresAt ?? (expiry === undefined ? undefined : new Date(expiry).toISOString())
    const userId = stringField(record, 'user_id')
    const email = stringField(record, 'email')
    const pending = [...this.flows.values()].some(flow => flow.status === 'pending')
    return {
      configured: record !== undefined,
      pending,
      ...userId === undefined ? {} : { userId },
      ...email === undefined ? {} : { email },
      ...displayExpiry === undefined ? {} : { expiresAt: displayExpiry },
    }
  }

  private async requestDevice(): Promise<{
    deviceCode: string
    userCode: string
    verificationUri: string
    verificationUriComplete?: string
    expiresAt: string
    intervalMs: number
  }> {
    const body = new URLSearchParams({
      client_id: this.clientId,
      scope: this.scopes.join(' '),
      referrer: this.referrer,
    })
    const response = await this.requestJson<DeviceResponse>(
      `${this.issuer}/oauth2/device/code`,
      {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
          'x-grok-client-version': CLIENT_VERSION,
          'x-grok-client-surface': 'ui',
        },
        body: body.toString(),
      },
    )
    if (typeof response.device_code !== 'string' || response.device_code.length === 0
      || typeof response.user_code !== 'string' || response.user_code.length === 0
      || !/^[A-Za-z0-9-]+$/.test(response.user_code)
      || typeof response.verification_uri !== 'string'
      || typeof response.expires_in !== 'number' || !Number.isFinite(response.expires_in)
      || response.expires_in <= 0) {
      throw new Error('grok-auth: device endpoint returned an incomplete response')
    }
    const verificationUri = validVerificationUri(response.verification_uri)
    const verificationUriComplete = typeof response.verification_uri_complete === 'string'
      ? validVerificationUri(response.verification_uri_complete)
      : undefined
    const expiresAt = new Date(this.now() + Math.max(MIN_DEVICE_CODE_EXPIRY_SECONDS, response.expires_in) * 1000).toISOString()
    return {
      deviceCode: response.device_code,
      userCode: response.user_code,
      verificationUri,
      ...verificationUriComplete === undefined ? {} : { verificationUriComplete },
      expiresAt,
      intervalMs: Math.max(1000, typeof response.interval === 'number' ? response.interval * 1000 : 5000),
    }
  }

  /** 启动或复用一个浏览器设备登录流。 */
  async startDeviceLogin(): Promise<GrokDeviceStart> {
    const current = [...this.flows.values()].find(flow => flow.status === 'pending')
    if (current !== undefined) return publicFlow(current)
    const requested = await this.requestDevice()
    const flow: PendingFlow = {
      flowId: randomUUID(),
      status: 'pending',
      userCode: requested.userCode,
      verificationUri: requested.verificationUri,
      ...requested.verificationUriComplete === undefined ? {} : { verificationUriComplete: requested.verificationUriComplete },
      expiresAt: requested.expiresAt,
      deviceCode: requested.deviceCode,
      intervalMs: requested.intervalMs,
    }
    this.flows.set(flow.flowId, flow)
    void this.pollDevice(flow.flowId)
    return publicFlow(flow)
  }

  /** 查询设备流公开状态。 */
  async deviceStatus(flowId: string): Promise<GrokDeviceFlowStatus | undefined> {
    const flow = this.flows.get(flowId)
    return flow === undefined ? undefined : {
      ...publicFlow(flow),
      status: flow.status,
      ...flow.error === undefined ? {} : { error: flow.error } as Pick<GrokDeviceFlowStatus, 'error'>,
    }
  }

  private async pollDevice(flowId: string): Promise<void> {
    const flow = this.flows.get(flowId)
    if (flow === undefined) return
    let intervalMs = flow.intervalMs
    while (!this.stopped() && this.now() < Date.parse(flow.expiresAt)) {
      await this.sleep(intervalMs)
      if (this.stopped()) return
      const current = this.flows.get(flowId)
      if (current === undefined || current.status !== 'pending') return
      try {
        const body = new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: current.deviceCode,
          client_id: this.clientId,
        })
        const tokens = await this.requestJson<TokenResponse>(
          `${this.issuer}/oauth2/token`,
          {
            method: 'POST',
            headers: {
              accept: 'application/json',
              'content-type': 'application/x-www-form-urlencoded',
              'x-grok-client-version': CLIENT_VERSION,
              'x-grok-client-surface': 'ui',
            },
            body: body.toString(),
          },
        )
        await this.persistToken(tokens)
        this.flows.set(flowId, { ...current, status: 'complete' })
        return
      } catch (error) {
        if (error instanceof GrokOAuthError) {
          if (error.code === 'authorization_pending') continue
          if (error.code === 'slow_down') { intervalMs += 5000; continue }
          const message = error.code === 'access_denied' ? 'authorization denied'
            : error.code === 'expired_token' ? 'device code expired' : error.message
          this.flows.set(flowId, { ...current, status: 'error', error: message })
          return
        }
        this.flows.set(flowId, { ...current, status: 'error', error: error instanceof Error ? error.message : String(error) })
        return
      }
    }
    const current = this.flows.get(flowId)
    if (current?.status === 'pending') this.flows.set(flowId, { ...current, status: 'error', error: 'device code expired' })
  }

  /** 登出：清除当前 scope 的持久登录并取消进行中的设备流。 */
  async logout(): Promise<void> {
    for (const [id, flow] of this.flows) {
      if (flow.status === 'pending') this.flows.set(id, { ...flow, status: 'error', error: 'cancelled' })
    }
    await this.writeStore((store) => { Reflect.deleteProperty(store, this.scope()) })
  }

  /** 停止后台设备轮询。 */
  close(): void {
    this.closed = true
  }
}

function publicFlow(flow: PendingFlow): GrokDeviceStart {
  return {
    flowId: flow.flowId,
    userCode: flow.userCode,
    verificationUri: flow.verificationUri,
    ...flow.verificationUriComplete === undefined ? {} : { verificationUriComplete: flow.verificationUriComplete },
    expiresAt: flow.expiresAt,
  }
}

// ---------------------------------------------------------------------------
// 浏览器跳转 + desktop/TUI 登录编排
// ---------------------------------------------------------------------------

/** 浏览器打开器（可注入测试；缺省跨平台系统命令，detach 不阻塞宿主）。 */
export type BrowserLauncher = (url: string) => Promise<void>

/** 系统浏览器拉起（open / cmd start / xdg-open，detached）。 */
export async function systemBrowserLauncher(url: string): Promise<void> {
  const { spawn } = await import('node:child_process')
  const command = process.platform === 'darwin'
    ? 'open'
    : process.platform === 'win32'
      ? 'cmd'
      : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', detached: true })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

/**
 * 在系统浏览器打开登录 URL。launch 失败不吞——desktop/TUI 需要向用户回显
 * URL 与 user code 作为回退路径（调用方 catch 后打印两者）。
 */
export async function openLoginUrl(
  flow: GrokDeviceStart,
  launch: BrowserLauncher = systemBrowserLauncher,
): Promise<void> {
  // verification_uri_complete 自带 user code，desktop 首选；无则开手动页。
  await launch(flow.verificationUriComplete ?? flow.verificationUri)
}

export interface BrowserLoginResult {
  readonly status: 'complete' | 'error' | 'expired'
  readonly auth?: GrokAuthStatus
  readonly error?: string
}

/**
 * desktop/TUI 一键登录：启动设备流 → 打开系统浏览器 → 等待完成/失败/过期。
 * 浏览器打开失败时不中断：返回 pending 状态与 user code 由 UI 展示回退。
 */
export async function loginViaBrowser(
  service: GrokAuthService,
  options: {
    launch?: BrowserLauncher
    /** 完成等待轮询间隔；缺省 1s。 */
    pollMs?: number
    /** 等待上限；缺省到设备码过期为止。 */
    timeoutMs?: number
    now?: () => number
    sleep?: (ms: number) => Promise<void>
  } = {},
): Promise<GrokDeviceStart & BrowserLoginResult> {
  const flow = await service.startDeviceLogin()
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  const now = options.now ?? Date.now
  const pollMs = options.pollMs ?? 1000
  const deadline = options.timeoutMs ?? Date.parse(flow.expiresAt)
  let browserOpened = true
  try {
    await openLoginUrl(flow, options.launch)
  } catch {
    browserOpened = false
  }
  while (now() < deadline) {
    const status = await service.deviceStatus(flow.flowId)
    if (status === undefined) {
      return { ...flow, status: 'error', error: 'device flow disappeared' }
    }
    if (status.status === 'complete') {
      return { ...flow, status: 'complete', auth: await service.status() }
    }
    if (status.status === 'error') {
      return { ...flow, status: 'error', error: status.error }
    }
    await sleep(pollMs)
  }
  return {
    ...flow,
    status: 'expired',
    ...browserOpened ? {} : { error: 'browser did not open; use the verification URI and user code above' } as Pick<BrowserLoginResult, 'error'>,
  }
}

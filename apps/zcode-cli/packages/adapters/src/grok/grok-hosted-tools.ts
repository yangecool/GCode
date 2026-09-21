/**
 * G Code — hosted 工具部署解析器（M3-a，移植自 grok-harness hosted-tools）。
 *
 * 语义：未声明的 hosted 工具不进请求；与 owned hosted 工具同名的本地函数
 * 被丢弃（serializeGrokTools 已实现该侧）。域/日期校验与 wire 层
 * `hostedWireTool` 同规则；本模块只负责把部署配置解析成
 * `GrokAdapterConfig.hostedTools` 的输入（原版 Cordis Service 的纯函数核）。
 *
 * Rust 对账：owned 集合与静态策略对应 grok-build 的 GrokProviderProfile
 * hosted 工具声明；`code_interpreter` 在 pinned 传输的Responses 面未开放
 * （harness GROK_HOSTED_TOOL_NAMES = ['web_search','x_search']），照此收口。
 */

import type { GrokHostedToolSpec } from '../model/grok/grok-wire.js'

/** pinned 传输实现的 closed hosted 工具集。 */
export const GROK_HOSTED_TOOL_NAMES = ['web_search', 'x_search'] as const
export type GrokHostedToolName = typeof GROK_HOSTED_TOOL_NAMES[number]

/** 部署级 hosted 工具配置（原版 Config 的结构子集）。 */
export interface GrokHostedToolsConfig {
  /** 本部署 owned 的 hosted 工具 wire 名；空表示不发 hosted 工具。 */
  readonly owned?: readonly GrokHostedToolName[]
  /** web_search 静态域策略；allowed/excluded 互斥。 */
  readonly webSearch?: {
    readonly allowedDomains?: readonly string[]
    readonly excludedDomains?: readonly string[]
  }
  /** x_search 静态内容日期策略（YYYY-MM-DD，含端点）。 */
  readonly xSearch?: {
    readonly fromDate?: string
    readonly toDate?: string
  }
}

export function resolveGrokHostedTools(
  config: GrokHostedToolsConfig,
): GrokHostedToolSpec[] {
  const owned = config.owned ?? []
  if (new Set(owned).size !== owned.length) {
    throw new Error('grok-hosted-tools: owned must not contain duplicates')
  }
  const unknown = owned.filter(name => !(GROK_HOSTED_TOOL_NAMES as readonly string[]).includes(name))
  if (unknown.length > 0) {
    throw new Error(`grok-hosted-tools: unknown hosted tool ${unknown.join(', ')}`)
  }
  const allowed = policyDomains(config.webSearch?.allowedDomains, 'webSearch.allowedDomains')
  const excluded = policyDomains(config.webSearch?.excludedDomains, 'webSearch.excludedDomains')
  if (allowed !== undefined && excluded !== undefined) {
    throw new Error('grok-hosted-tools: webSearch allowedDomains and excludedDomains are mutually exclusive')
  }
  const fromDate = policyDate(config.xSearch?.fromDate, 'xSearch.fromDate')
  const toDate = policyDate(config.xSearch?.toDate, 'xSearch.toDate')
  if (fromDate !== undefined && toDate !== undefined && fromDate > toDate) {
    throw new Error('grok-hosted-tools: xSearch fromDate must not be after toDate')
  }
  const ownedSet = new Set(owned)
  if ((allowed !== undefined || excluded !== undefined) && !ownedSet.has('web_search')) {
    throw new Error('grok-hosted-tools: webSearch policy requires owned web_search')
  }
  if ((fromDate !== undefined || toDate !== undefined) && !ownedSet.has('x_search')) {
    throw new Error('grok-hosted-tools: xSearch policy requires owned x_search')
  }
  return owned.map((wireName): GrokHostedToolSpec => {
    if (wireName === 'web_search') {
      return {
        wireName,
        entry: {
          type: 'web_search',
          ...allowed === undefined && excluded === undefined ? {} : {
            filters: {
              ...allowed === undefined ? {} : { allowed_domains: [...allowed] },
              ...excluded === undefined ? {} : { excluded_domains: [...excluded] },
            },
          },
        },
      }
    }
    return {
      wireName,
      entry: {
        type: 'x_search',
        ...fromDate === undefined ? {} : { from_date: fromDate },
        ...toDate === undefined ? {} : { to_date: toDate },
      },
    }
  })
}

const MAX_WEB_SEARCH_DOMAINS = 5

function policyDomains(values: readonly string[] | undefined, field: string): string[] | undefined {
  if (values === undefined || values.length === 0) return undefined
  if (values.length > MAX_WEB_SEARCH_DOMAINS) {
    throw new Error(`grok-hosted-tools: ${field} accepts at most ${MAX_WEB_SEARCH_DOMAINS} domains`)
  }
  const normalized = values.map(value => {
    const domain = value.trim().toLowerCase().replace(/\.$/u, '')
    if (domain.length === 0 || domain.includes('/') || domain.includes(':')) {
      throw new Error(`grok-hosted-tools: ${field} contains invalid domain ${JSON.stringify(value)}`)
    }
    return domain
  })
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`grok-hosted-tools: ${field} must not contain duplicate domains`)
  }
  return normalized
}

function policyDate(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new Error(`grok-hosted-tools: ${field} must use YYYY-MM-DD`)
  }
  const date = new Date(`${value}T00:00:00.000Z`)
  if (!Number.isFinite(date.valueOf()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`grok-hosted-tools: ${field} is not a valid calendar date`)
  }
  return value
}

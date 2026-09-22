/**
 * G Code — Grok `/models` 发现（H9：`/models` 发现为主、内置目录为兜底）。
 *
 * 语义对齐 grok-build 的 ModelsManager 远端覆盖：GET `{baseURL}/models`，
 * 取 `data[].id`。只做发现，不做合并——调用方（目录层）决定与 builtin 的
 * 并集/排序。传输失败 fail-loud（发现是数据面，不静默兜底）。
 */

import type { GrokHttpTransport } from '../model/grok/grok-http.js'

export interface GrokDiscoveryConfig {
  /** API key（Bearer）。 */
  readonly apiKey: string
  /** 默认 `https://api.x.ai/v1`。 */
  readonly baseURL?: string
  readonly transport?: GrokHttpTransport
}

interface ModelsResponse {
  data?: Array<{ id?: unknown }>
}

/**
 * Fetch the provider model id list from `/models`.
 * @param config - 连接事实（key/baseURL/transport）。
 * @returns 去重后的模型 id 列表（保持服务端顺序）。
 * @throws 非 2xx、空列表或结构异常（fail-loud：发现层数据不可信时不下猜）。
 */
export async function fetchGrokModelIds(config: GrokDiscoveryConfig): Promise<string[]> {
  const transport = config.transport
  const url = new URL(`${config.baseURL ?? 'https://api.x.ai/v1'}/models`)
  const fetchImpl = transport?.fetch ?? ((input: URL | string, init?: RequestInit) => fetch(input, init))
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      accept: 'application/json',
    },
  })
  if (!response.ok) {
    throw new Error(`grok discovery failed: HTTP ${String(response.status)}`)
  }
  const parsed = await response.json() as ModelsResponse
  if (!Array.isArray(parsed.data)) {
    throw new Error('grok discovery failed: response has no data array')
  }
  const ids = parsed.data
    .map(entry => (typeof entry?.id === 'string' ? entry.id : undefined))
    .filter((id): id is string => id !== undefined && id.length > 0)
  return [...new Set(ids)]
}

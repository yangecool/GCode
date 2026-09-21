/**
 * G Code — Grok ModelExecutor 的 runner 侧壳（M1 第三批）。
 *
 * 只做两件事：把 RegistryProviderConfig/目录事实冻结成引擎连接配置，以及把
 * 引擎的 GrokWireError 包装成 ZCode 的 ModelProtocolError。纯映射逻辑全部
 * 在 grok-executor.ts（可独立测试）；本文件活在 ai/@zcode 运行时世界里，
 * 与其余 runner 接线同级。
 */

import { ModelErrorCode, ModelProtocolError } from "@zcode/contracts";
import type { ModelEvent, ModelResult } from "@zcode/contracts";
import type { ModelExecutionRequest, ModelExecutor } from "./model.js";
import { createGrokModelExecutorCore } from "./grok/grok-executor.js";
import type { GrokModelBinding } from "./grok/grok-executor.js";
import { GrokWireError } from "./grok/grok-wire.js";
import type { GrokHttpTransport } from "./grok/grok-http.js";
import { createGrokHttpTransport } from "./grok/grok-http.js";
import type { RegistryProviderConfig } from "@zcode/provider";

export interface GrokRunnerModelOptions {
  readonly providerId: string;
  readonly modelId: string;
  readonly providerConfig: RegistryProviderConfig;
  /** 目录 admissible reasoning 档位（H8）；缺省用引擎原版全集。 */
  readonly reasoningLevels?: readonly string[];
  readonly env?: Record<string, string | undefined>;
  readonly logger?: { warn(message: string, context?: unknown): void };
}

const GROK_API_KEY_ENV = "XAI_API_KEY";
const GROK_DEFAULT_BASE_URL = "https://api.x.ai/v1";

/** 引擎错误 → ZCode 协议错误；重试预算内失败已由引擎耗尽，此处只定级。 */
function toModelProtocolError(error: unknown, providerId: string, modelId: string): unknown {
  if (error instanceof ModelProtocolError) return error;
  if (error instanceof GrokWireError) {
    return new ModelProtocolError(
      grokErrorCode(error.code),
      `Grok request failed (${error.code}): ${error.message}`,
      { providerId, modelId, grokCode: error.code },
    );
  }
  return error;
}

function grokErrorCode(code: string): ModelErrorCode {
  switch (code) {
    case "ABORTED":
      return ModelErrorCode.ModelRequestCancelled;
    case "RATE_LIMIT":
      return ModelErrorCode.ModelRateLimited;
    case "PROTOCOL":
    case "UNSUPPORTED_RESPONSE_ITEM":
    case "INVALID_REPLAY_STATE":
    case "UNSUPPORTED_REASONING_EFFORT":
    case "EMPTY_RESPONSE":
    case "DOOM_LOOP":
      return ModelErrorCode.InvalidModelResponse;
    default:
      return ModelErrorCode.ModelRequestFailed;
  }
}

/** Grok 专用 ModelExecutor：绕过 AI SDK 提示词往返（H1 单引擎主张）。 */
export function createGrokModelExecutor(options: GrokRunnerModelOptions): ModelExecutor {
  const api = options.providerConfig.api;
  if (api?.type !== "grok-responses") {
    throw new ModelProtocolError(
      ModelErrorCode.InvalidModelRequest,
      `Grok executor requires api.type "grok-responses", got "${api?.type ?? "none"}"`,
      { providerId: options.providerId },
    );
  }
  const access = options.providerConfig.access;
  const apiKey =
    access.type !== "zhipu-account" && access.apiKey && access.apiKey.length > 0
      ? access.apiKey
      : options.env?.[GROK_API_KEY_ENV] ?? process.env[GROK_API_KEY_ENV];
  if (apiKey === undefined || apiKey.length === 0) {
    throw new ModelProtocolError(
      ModelErrorCode.ModelRequestAuthMissing,
      `Grok provider has no API key: set the provider credential or ${GROK_API_KEY_ENV}`,
      { providerId: options.providerId },
    );
  }
  const transport: GrokHttpTransport = createGrokHttpTransport(options.env ?? process.env);
  const binding: GrokModelBinding = {
    ...(options.reasoningLevels === undefined ? {} : { knownEfforts: options.reasoningLevels }),
  };
  const core = createGrokModelExecutorCore(
    {
      apiKey,
      baseURL: api.baseUrl ?? GROK_DEFAULT_BASE_URL,
      model: options.modelId,
      // 同源历史判定用真实 provider id（防止把本 provider 的历史当跨
      // provider 丢弃 replay 元数据）。
      providerId: options.providerId,
      transport,
    },
    binding,
  );
  const wrap = (error: unknown): unknown =>
    toModelProtocolError(error, options.providerId, options.modelId);
  const toCore = (request: ModelExecutionRequest) => ({
    messages: request.messages,
    tools: request.tools,
    reasoningLevel: request.options.reasoningLevel,
    maxOutputTokens: request.options.maxOutputTokens,
    abortSignal: request.abortSignal,
  });
  return {
    async generateText(request: ModelExecutionRequest): Promise<ModelResult> {
      try {
        return await core.generateText(toCore(request)) as ModelResult;
      } catch (error) {
        throw wrap(error);
      }
    },
    async *streamText(request: ModelExecutionRequest): AsyncIterable<ModelEvent> {
      try {
        for await (const event of core.streamText(toCore(request))) {
          yield event as ModelEvent;
        }
      } catch (error) {
        throw wrap(error);
      }
    },
  };
}

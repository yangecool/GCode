/**
 * G Code — Grok ModelExecutor 的 runner 侧壳（M1 第三批）。
 *
 * 只做两件事：把 RegistryProviderConfig/目录事实冻结成引擎连接配置，以及把
 * 引擎的 GrokWireError 包装成 GCode 的 ModelProtocolError。纯映射逻辑全部
 * 在 grok-executor.ts（可独立测试）；本文件活在 ai/@gcode 运行时世界里，
 * 与其余 runner 接线同级。
 */

import { ModelErrorCode, ModelProtocolError } from "@gcode/contracts";
import type { ModelEvent, ModelResult } from "@gcode/contracts";
import type { ModelExecutionRequest, ModelExecutor } from "./model.js";
import { createGrokModelExecutorCore } from "./grok/grok-executor.js";
import type { GrokModelBinding } from "./grok/grok-executor.js";
import { GrokWireError } from "./grok/grok-wire.js";
import type { GrokHttpTransport } from "./grok/grok-http.js";
import { createGrokHttpTransport } from "./grok/grok-http.js";
import { grokHostedToolsFromEnv } from "../grok/grok-session.js";
import { GrokAuthService, getOrCreateGrokAgentId } from "../grok/grok-auth.js";
import { grokPromptCacheKey } from "./grok/grok-wire.js";
import { getCurrentModelInvocationContext } from "@gcode/contracts";
import type { RegistryProviderConfig } from "@gcode/provider";

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

/** 引擎错误 → GCode 协议错误；重试预算内失败已由引擎耗尽，此处只定级。 */
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
    case "AUTH_MISSING":
      return ModelErrorCode.ModelRequestAuthMissing;
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
  const env = options.env ?? process.env;
  const apiKey =
    access.type !== "zhipu-account" && access.apiKey && access.apiKey.length > 0
      ? access.apiKey
      : env[GROK_API_KEY_ENV];
  // H3 订阅模式：GCODE_GROK_SUBSCRIPTION=1 时走设备流令牌（/login grok 写入
  // GCODE_HOME）+ grok-build 客户端身份头；API key 仅作回退。
  const subscription = env.GCODE_GROK_SUBSCRIPTION?.trim() === "1";
  if (!subscription && (apiKey === undefined || apiKey.length === 0)) {
    throw new ModelProtocolError(
      ModelErrorCode.ModelRequestAuthMissing,
      `Grok provider has no API key: set the provider credential or ${GROK_API_KEY_ENV}`,
      { providerId: options.providerId },
    );
  }
  const transport: GrokHttpTransport = createGrokHttpTransport(env);
  const subscriptionAuth = subscription ? new GrokAuthService() : undefined;
  const subscriptionBearer = subscription
    ? async (): Promise<string> => {
      const token = await subscriptionAuth?.resolveAccessToken();
      if (token === undefined) {
        throw new GrokWireError(
          "no grok subscription token: run /login grok (device flow) or set an API key",
          "AUTH_MISSING",
        );
      }
      return token;
    }
    : undefined;
  // H11：hosted 工具面经部署 env 声明（GCODE_GROK_HOSTED_TOOLS，JSON）；
  // 未声明不发 hosted 工具（原版语义：未 owner 的 hosted 工具不进请求）。
  const hostedTools = grokHostedToolsFromEnv(options.env ?? process.env);
  const binding: GrokModelBinding = {
    ...(options.reasoningLevels === undefined ? {} : { knownEfforts: options.reasoningLevels }),
  };
  const core = createGrokModelExecutorCore(
    {
      baseURL: api.baseUrl ?? GROK_DEFAULT_BASE_URL,
      model: options.modelId,
      // 同源历史判定用真实 provider id（防止把本 provider 的历史当跨
      // provider 丢弃 replay 元数据）。
      providerId: options.providerId,
      ...(hostedTools === undefined ? {} : { hostedTools }),
      ...(subscription
        ? {
          authMode: "grok-subscription" as const,
          resolveBearer: subscriptionBearer,
          agentId: getOrCreateGrokAgentId({ env }),
        }
        : {}),
      apiKey: apiKey ?? "",
      transport,
    },
    binding,
  );
  const wrap = (error: unknown): unknown =>
    toModelProtocolError(error, options.providerId, options.modelId);
  // H13：粘性路由 cache key——主/子代理请求共享会话槽，辅助调用（标题、
  // 权限旁路）不复用（原版 grokPromptCacheKey 语义）。
  const cacheKeyOf = (request: ModelExecutionRequest): string | undefined => {
    const context = getCurrentModelInvocationContext();
    const sessionType = context?.modelRequestSessionType;
    if (sessionType !== undefined && sessionType !== "main" && sessionType !== "subagent") {
      return undefined;
    }
    const sessionId = context?.metadata?.["sessionId"] ?? context?.traceContext?.sessionId;
    return grokPromptCacheKey(typeof sessionId === "string" ? sessionId : undefined);
  };
  const toCore = (request: ModelExecutionRequest) => ({
    messages: request.messages,
    tools: request.tools,
    reasoningLevel: request.options.reasoningLevel,
    maxOutputTokens: request.options.maxOutputTokens,
    promptCacheKey: cacheKeyOf(request),
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

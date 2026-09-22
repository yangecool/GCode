export const GCODE_RUNTIME_ENV_KEY = "GCODE_RUNTIME_ENV";
export const GCODE_HTTP_PROXY_ENV_KEY = "GCODE_HTTP_PROXY";
export const GCODE_NO_PROXY_ENV_KEY = "GCODE_NO_PROXY";
/** Desktop Host 只向 desktop-attached remote server 传递一次的网络配置。 */
export const GCODE_REMOTE_RUNTIME_NETWORK_AUTHORITY_ENV_KEY =
  "GCODE_REMOTE_RUNTIME_NETWORK_AUTHORITY";
export const GCODE_REMOTE_HTTP_PROXY_ENV_KEY = "GCODE_REMOTE_HTTP_PROXY";
export const GCODE_REMOTE_NO_PROXY_ENV_KEY = "GCODE_REMOTE_NO_PROXY";
export const GCODE_AGENT_CA_CERT_ENV_KEY = "GCODE_AGENT_CA_CERT";
export const GCODE_TOOL_ENV_PASSTHROUGH_ENV_KEY = "GCODE_TOOL_ENV_PASSTHROUGH_JSON";
/** Desktop Main 将服务端裁决的单功能灰度结果传给 Local/Remote Host。 */
export const GCODE_DESKTOP_CONTEXT_PROMPT_ENABLED_ENV = "GCODE_DESKTOP_CONTEXT_PROMPT_ENABLED";
export const GCODE_CUA_PRODUCT_HELPER_ENV_KEY = "GCODE_CUA_PRODUCT_HELPER";
export const GCODE_CUA_BROKER_SOCKET_ENV_KEY = "GCODE_CUA_PERMISSION_BROKER_SOCKET";
/** Shared node_repl host marker; unlike the broker bearer values it is not a secret. */
export const GCODE_CUA_NODE_REPL_HOST_ENV_KEY = "GCODE_CUA_NODE_REPL_HOST";
// One-knob local-development bundle. Setting GCODE_CUA_DEV_MODE implies the internal feature
// flag (below) plus the local-helper relaxations wired in packages/services (unsigned/
// unauthenticated local helper, dev install variant, "Dev.app" naming). It exists so a developer
// can launch the full local CUA loop with a single env var instead of the historical four-var
// incantation. 这些开关只在未打包本地构建生效；正式 desktop/Helper bundle 会在编译期关闭并在
// main→host 边界删除，不能用于 signed release 的 runtime override。
export const GCODE_CUA_DEV_MODE_ENV_KEY = "GCODE_CUA_DEV_MODE";

export type GCodeRuntimeEnv = "development" | "production" | "test";

type EnvRecord = Record<string, string | undefined>;

export function isCuaDevModeRequested(env: EnvRecord = process.env): boolean {
  const explicit = env[GCODE_CUA_DEV_MODE_ENV_KEY]?.trim().toLowerCase();
  return explicit === "1" || explicit === "true" || explicit === "on";
}

export function isGCodeCuaInternalFeatureEnabled(env: EnvRecord = process.env): boolean {
  // CUA 现已默认打包进正式版（plugin staged + Helper enabled），不再需要显式 env flag。
  // DEV_MODE 仍然 implied（开发一键），PRODUCT_HELPER=0/off/false 可显式关闭。
  if (isCuaDevModeRequested(env)) return true;
  const explicit = env[GCODE_CUA_PRODUCT_HELPER_ENV_KEY]?.trim().toLowerCase();
  if (explicit === "0" || explicit === "false" || explicit === "off") return false;
  return true;
}

const SANITIZED_RUNTIME_ENV_KEYS = [
  "NODE_ENV",
  "ELECTRON_RUN_AS_NODE",
  "NODE_NO_WARNINGS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "GIT_SSL_CAINFO",
  GCODE_REMOTE_RUNTIME_NETWORK_AUTHORITY_ENV_KEY,
  GCODE_REMOTE_HTTP_PROXY_ENV_KEY,
  GCODE_REMOTE_NO_PROXY_ENV_KEY,
  // CUA broker socket 是只该给目标 gcode-cua MCP server 的连接材料（由 desktop/CLI 在
  // 解析该 server 时定向注入其 env）。绝不能随 agent 全局 env 泄漏给其它 MCP server / Bash / tool
  // 子进程 —— 否则同 agent 内的恶意 MCP 或被 prompt-injection 触发的命令能直接驱动
  // 已授权 Helper（confused-deputy）。这里统一从所有子进程 env 剔除；gcode-cua server 的定向
  // env 注入在 buildMcpStdioEnv 之后 spread，因此仍能拿到（见 adapters/mcp StdioClientTransport）。
  GCODE_CUA_BROKER_SOCKET_ENV_KEY,
  // 遗留 bearer token：当前 broker 是 identity 模式（socket + authority，无口令，见
  // captureGCodeCuaBrokerCredentials），本进程不再产生也不再消费它。仍然剔除，因为用户机上
  // 可能装着旧版 Helper —— 那些版本认 bearer token，一旦这个变量随 agent 全局 env 漏给别的
  // MCP server / Bash 子进程，同一个 confused-deputy 又成立。剔除一个已不用的键是零成本的。
  "GCODE_CUA_PERMISSION_BROKER_TOKEN",
  "GCODE_CUA_PERMISSION_BROKER_REFRESH_MARKER",
  "GCODE_CUA_PLUGIN_AUTHORITY",
  // Agent OTLP Endpoint/Auth/Identity 只属于 CLI telemetry bootstrap，不能继续泄漏给
  // Bash、MCP 或模型工具子进程。sanitize 前会捕获到本进程私有 Map，供 Agent 启动边界读取。
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
  "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_METRICS_HEADERS",
  "OTEL_SERVICE_NAME",
  "OTEL_RESOURCE_ATTRIBUTES",
  "OTEL_EXPORTER_OTLP_COMPRESSION",
  "GCODE_MODEL_TELEMETRY_ENABLED",
  "GCODE_TELEMETRY_DEVICE_MID",
  // 历史身份变量不再受支持，但仍须从所有子进程环境剔除，避免旧配置把原始账号
  // 或可伪造 hash 泄漏给 Host、Bash 与 MCP。
  "GCODE_TELEMETRY_USER_ID",
  "GCODE_TELEMETRY_USER_ID_HASH",
  "GCODE_TELEMETRY_USER_SUBJECT_ID",
  "GCODE_TELEMETRY_IDENTITY_STATE",
  "GCODE_TELEMETRY_RUNTIME_SURFACE",
  "GCODE_TELEMETRY_RUNTIME_DISTRIBUTION",
] as const;

const NON_TOOL_PASSTHROUGH_RUNTIME_ENV_KEYS = [
  "NODE_ENV",
  "ELECTRON_RUN_AS_NODE",
  "NODE_NO_WARNINGS",
  // CUA broker 凭据不得经 tool-env-passthrough 恢复到 Bash/tool 子进程（否则等于绕过上面的剔除）。
  GCODE_CUA_BROKER_SOCKET_ENV_KEY,
  "GCODE_CUA_PERMISSION_BROKER_REFRESH_MARKER",
  "GCODE_CUA_PLUGIN_AUTHORITY",
  GCODE_REMOTE_RUNTIME_NETWORK_AUTHORITY_ENV_KEY,
  GCODE_REMOTE_HTTP_PROXY_ENV_KEY,
  GCODE_REMOTE_NO_PROXY_ENV_KEY,
] as const;

const SANITIZED_PACKAGE_MANAGER_ENV_PATTERN =
  /^(npm_config|yarn|pnpm)_(http_proxy|https_proxy|proxy|all_proxy|no_proxy|cafile|ca)$/i;

export function normalizeGCodeRuntimeEnv(value: string | undefined): GCodeRuntimeEnv | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "development" || normalized === "production" || normalized === "test") {
    return normalized;
  }
  return undefined;
}

export function resolveGCodeRuntimeEnv(
  env: Record<string, string | undefined>,
  fallback: GCodeRuntimeEnv = "production",
): GCodeRuntimeEnv {
  return normalizeGCodeRuntimeEnv(env[GCODE_RUNTIME_ENV_KEY]) ?? fallback;
}

// Exported so services/node.ts can inject the Helper's plugin authority into the agent spawn env
// (mirrors feat; the agent-side plugin host verifies the broker authority via this env var).
export const GCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY = "GCODE_CUA_PLUGIN_AUTHORITY";

interface CapturedCuaBrokerCredentials {
  socket: string;
  pluginAuthority: string;
  refreshMarker?: string;
}

let capturedCuaBrokerCredentials: Readonly<CapturedCuaBrokerCredentials> | undefined;
const capturedGCodeAgentTelemetryEnv: Record<string, string> = {};

// CUA broker socket 会被上面的 sanitize 从子进程 env 中剔除（confused-deputy 防护 —— 不能让
// 其它 MCP server / Bash / tool 子进程直接驱动已授权 Helper）。但 CLI 入口在 bootstrap
// 解析全局 ~/.gcode/cli/config.json 里的 `gcode-cua` server 之前就会先 sanitize process.env，导致
// 定向注入时已经读不到凭据 → 全局 gcode-cua 回退 `--backend auto`，让 Python/uvx 成为 TCC 主体
// （fail-open，违反 "Python/uvx must never become the implicit permission owner"）。因此在剔除前把
// 凭据捕获进本进程私有存储，只经 getCapturedGCodeCuaBrokerCredentials() 暴露给 bootstrap 的定向
// 注入路径，绝不写回任何子进程 env。
function captureGCodeCuaBrokerCredentials(env: Record<string, string | undefined>): void {
  const socket = env[GCODE_CUA_BROKER_SOCKET_ENV_KEY]?.trim();
  const pluginAuthority = env[GCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY]?.trim();
  const refreshMarker = env["GCODE_CUA_PERMISSION_BROKER_REFRESH_MARKER"]?.trim();
  // 连接没有口令：socket + authority（config-provenance 随机数）同批出现才构成有效凭据组；
  // 半组说明上游注入不完整或正在轮换。
  if (socket && pluginAuthority) {
    capturedCuaBrokerCredentials = Object.freeze({
      socket,
      pluginAuthority,
      ...(refreshMarker ? { refreshMarker } : {}),
    });
    return;
  }
  if (socket || pluginAuthority) {
    // 发现半组凭据说明上游注入不完整或正在轮换；清掉旧快照并 fail-closed，不能复用另一半。
    capturedCuaBrokerCredentials = undefined;
  }
}

function captureGCodeAgentTelemetryEnv(env: Record<string, string | undefined>): void {
  Object.assign(capturedGCodeAgentTelemetryEnv, readGCodeAgentTelemetryEnv(env));
}

/**
 * 只提取供 Agent telemetry bootstrap 使用的配置。宿主可在经过通用 env 清洗后，
 * 将这组值定向传给 host/Agent；不得把它并入 Bash/MCP 的 tool env。
 */
export function readGCodeAgentTelemetryEnv(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const telemetryEnv: Record<string, string> = {};
  for (const key of SANITIZED_RUNTIME_ENV_KEYS) {
    if (!isGCodeAgentTelemetryEnvKey(key)) continue;
    const value = env[key]?.trim();
    if (value) telemetryEnv[key] = value;
  }
  return telemetryEnv;
}

export function getCapturedGCodeAgentTelemetryEnv(): Record<string, string> {
  return { ...capturedGCodeAgentTelemetryEnv };
}

export function getCapturedGCodeCuaBrokerCredentials(): {
  socket: string | undefined;
  pluginAuthority: string | undefined;
  refreshMarker?: string;
} {
  return capturedCuaBrokerCredentials
    ? { ...capturedCuaBrokerCredentials }
    : { socket: undefined, pluginAuthority: undefined };
}

// 仅供测试重置进程内捕获状态。
export function resetCapturedGCodeCuaBrokerCredentialsForTest(): void {
  capturedCuaBrokerCredentials = undefined;
}

export function resetCapturedGCodeAgentTelemetryEnvForTest(): void {
  for (const key of Object.keys(capturedGCodeAgentTelemetryEnv)) {
    delete capturedGCodeAgentTelemetryEnv[key];
  }
}

export function sanitizeGCodeRuntimeEnv<T extends Record<string, string | undefined>>(
  env: T,
): Record<string, string> {
  captureGCodeCuaBrokerCredentials(env);
  captureGCodeAgentTelemetryEnv(env);
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || shouldSanitizeGCodeRuntimeEnvKey(key)) {
      continue;
    }
    sanitized[key] = value;
  }
  return sanitized;
}

export function buildGCodeToolEnvPassthroughEnv(env: EnvRecord): Record<string, string> {
  const captured = readGCodeToolEnvPassthroughEnv(env);

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || !shouldCaptureGCodeToolEnvPassthroughKey(key)) {
      continue;
    }
    captured[key] = value;
  }

  return stringifyGCodeToolEnvPassthroughEnv(captured);
}

export function readGCodeToolEnvPassthroughEnv(env: EnvRecord): Record<string, string> {
  const raw = env[GCODE_TOOL_ENV_PASSTHROUGH_ENV_KEY];
  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    const captured: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (
        typeof value === "string" &&
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) &&
        shouldCaptureGCodeToolEnvPassthroughKey(key)
      ) {
        captured[key] = value;
      }
    }
    return captured;
  } catch {
    return {};
  }
}

export function sanitizeGCodeRuntimeEnvInPlace(env: Record<string, string | undefined>): void {
  captureGCodeCuaBrokerCredentials(env);
  captureGCodeAgentTelemetryEnv(env);
  for (const key of Object.keys(env)) {
    if (shouldSanitizeGCodeRuntimeEnvKey(key)) {
      delete env[key];
    }
  }
}

function isGCodeAgentTelemetryEnvKey(key: string): boolean {
  return (
    key.startsWith("OTEL_") ||
    key.startsWith("GCODE_TELEMETRY_") ||
    key === "GCODE_MODEL_TELEMETRY_ENABLED"
  );
}

export function shouldSanitizeGCodeRuntimeEnvKey(key: string): boolean {
  const upperKey = key.toUpperCase();
  return (
    SANITIZED_RUNTIME_ENV_KEYS.some((candidate) => candidate === upperKey) ||
    SANITIZED_PACKAGE_MANAGER_ENV_PATTERN.test(key)
  );
}

export function shouldCaptureGCodeToolEnvPassthroughKey(key: string): boolean {
  const upperKey = key.toUpperCase();
  if (isGCodeAgentTelemetryEnvKey(upperKey)) {
    return false;
  }
  if (NON_TOOL_PASSTHROUGH_RUNTIME_ENV_KEYS.some((candidate) => candidate === upperKey)) {
    return false;
  }
  return shouldSanitizeGCodeRuntimeEnvKey(key);
}

function stringifyGCodeToolEnvPassthroughEnv(
  captured: Record<string, string>,
): Record<string, string> {
  const entries = Object.entries(captured).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) {
    return {};
  }
  return {
    [GCODE_TOOL_ENV_PASSTHROUGH_ENV_KEY]: JSON.stringify(Object.fromEntries(entries)),
  };
}

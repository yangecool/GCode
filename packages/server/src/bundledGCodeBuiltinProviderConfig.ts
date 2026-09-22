import { materializeGCodeBuiltinProviderConfig } from "@gcode/services/node";

declare const __GCODE_BUILTIN_PROVIDER_CONFIG_JSON__: string | undefined;

interface MaterializeBundledGCodeBuiltinProviderConfigOptions {
  readonly environmentConfigRoot: string;
  readonly content: string;
}

/** 返回构建时嵌入远端 Server 的 GCode Built-in Provider Config。 */
export function readBundledGCodeBuiltinProviderConfig(): string {
  if (typeof __GCODE_BUILTIN_PROVIDER_CONFIG_JSON__ !== "string") {
    throw new Error("当前构建未嵌入 GCode Built-in Provider Config");
  }
  return __GCODE_BUILTIN_PROVIDER_CONFIG_JSON__;
}

/**
 * 将 GCode Built-in Config 原子物化到所属环境的固定资源副本。
 * 升级前退出旧进程；不保留按内容 hash 增长的历史文件。
 */
export async function materializeBundledGCodeBuiltinProviderConfig(
  options: MaterializeBundledGCodeBuiltinProviderConfigOptions,
): Promise<string> {
  return materializeGCodeBuiltinProviderConfig(options);
}

export const GCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV = "GCODE_BUILTIN_PROVIDER_CONFIG_FILE";
export const GCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE_ENV =
  "GCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE";
export const GCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV = "GCODE_PERSONAL_PROVIDER_CONFIG_FILE";
export const PERSONAL_PROVIDER_CONFIG_FILE_NAME = "provider_config.json";

export interface NodeProviderRuntimePaths {
  readonly gcodeBuiltinFilePath: string;
  readonly personalFilePath: string;
}

export function createNodeProviderRuntimePathEnv(
  paths: NodeProviderRuntimePaths,
): Record<string, string> {
  return {
    [GCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: paths.gcodeBuiltinFilePath,
    [GCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: paths.personalFilePath,
  };
}

export function resolveNodeProviderRuntimePaths(
  env: Readonly<Record<string, string | undefined>>,
): NodeProviderRuntimePaths | null {
  const gcodeBuiltinFilePath = env[GCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]?.trim();
  const personalFilePath = env[GCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]?.trim();
  if (!gcodeBuiltinFilePath && !personalFilePath) return null;
  if (!gcodeBuiltinFilePath || !personalFilePath) {
    throw new Error("GCode Built-in 与 Personal Provider Config 路径必须同时提供");
  }
  return Object.freeze({ gcodeBuiltinFilePath, personalFilePath });
}

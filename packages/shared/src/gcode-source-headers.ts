import { DEFAULT_GCODE_ENDPOINT_ORIGIN } from "./gcodeEndpoint.js";

export const GCODE_SOURCE_HEADERS = {
  "User-Agent": "GCode/unknown",
  "HTTP-Referer": DEFAULT_GCODE_ENDPOINT_ORIGIN,
  "X-Title": "Z Code@electron",
} as const;

export interface BuildGCodeSourceHeadersFromContextOptions {
  appVersion?: string;
  arch?: string;
  clientLanguage?: string;
  clientTimezone?: string;
  deviceMid?: string;
  endpointOrigin?: string;
  osVersion?: string;
  platform?: string;
  releaseChannel?: string;
  sourceTitle?: string;
}

export function normalizeGCodeSourceHeaderValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || !/^[\x20-\x7e]+$/.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

export function buildGCodeSourceHeadersFromContext(
  options: BuildGCodeSourceHeadersFromContextOptions = {},
): Record<string, string> {
  const appVersion = normalizeGCodeSourceHeaderValue(options.appVersion);
  const arch = normalizeGCodeSourceHeaderValue(options.arch);
  const clientLanguage = normalizeGCodeSourceHeaderValue(options.clientLanguage) ?? "unknown";
  const clientTimezone = normalizeGCodeSourceHeaderValue(options.clientTimezone) ?? "unknown";
  const deviceMid = normalizeGCodeSourceHeaderValue(options.deviceMid);
  const endpointOrigin =
    normalizeGCodeSourceHeaderValue(options.endpointOrigin) ?? DEFAULT_GCODE_ENDPOINT_ORIGIN;
  const osVersion = normalizeGCodeSourceHeaderValue(options.osVersion);
  const platform = normalizeGCodeSourceHeaderValue(options.platform);
  const releaseChannel = normalizeGCodeSourceHeaderValue(options.releaseChannel);
  const sourceTitle = normalizeGCodeSourceHeaderValue(options.sourceTitle) ?? "electron";

  return {
    ...GCODE_SOURCE_HEADERS,
    "HTTP-Referer": endpointOrigin,
    "User-Agent": `GCode/${appVersion ?? "unknown"}`,
    ...(appVersion ? { "X-GCode-App-Version": appVersion } : {}),
    "X-Title": `Z Code@${sourceTitle}`,
    ...(platform && arch ? { "X-Platform": `${platform}-${arch}` } : {}),
    ...(releaseChannel ? { "X-Release-Channel": releaseChannel } : {}),
    "X-Client-Language": clientLanguage,
    "X-Client-Timezone": clientTimezone,
    ...(platform ? { "X-Os-Category": normalizeOsCategory(platform) } : {}),
    ...(osVersion ? { "X-Os-Version": osVersion } : {}),
    ...(deviceMid ? { "X-Device-Mid": deviceMid } : {}),
  };
}

function normalizeOsCategory(platform: string): string {
  switch (platform) {
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    default:
      return "linux";
  }
}

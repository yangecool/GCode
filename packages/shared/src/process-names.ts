const GCODE_PROCESS_PREFIX = "gcode";
const MAX_PROCESS_NAME_SEGMENT_LENGTH = 24;

function sanitizeProcessNameSegment(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized) {
    return null;
  }

  return normalized.slice(0, MAX_PROCESS_NAME_SEGMENT_LENGTH);
}

function joinGCodeProcessName(...segments: Array<string | null | undefined>): string {
  const sanitizedSegments = segments
    .map((segment) => sanitizeProcessNameSegment(segment))
    .filter((segment): segment is string => Boolean(segment));
  return [GCODE_PROCESS_PREFIX, ...sanitizedSegments].join("-");
}

function pickWorkspaceTag(workspacePath: string | null | undefined): string | undefined {
  const trimmedPath = workspacePath?.trim();
  if (!trimmedPath) {
    return undefined;
  }

  const parts = trimmedPath.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? trimmedPath;
}

export function formatGCodeMainProcessName(): string {
  return joinGCodeProcessName("main");
}

export function formatGCodeGpuProcessName(): string {
  return joinGCodeProcessName("gpu");
}

export function formatGCodeHostProcessName(label?: string): string {
  return joinGCodeProcessName("host", label);
}

export function formatGCodeRendererProcessName(windowTitle?: string): string {
  const normalizedTitle = windowTitle?.trim();
  if (!normalizedTitle || normalizedTitle === "GCode") {
    return joinGCodeProcessName("renderer", "main");
  }

  if (normalizedTitle === "Resource Manager") {
    return joinGCodeProcessName("renderer", "resource-manager");
  }

  const remoteWindowPrefix = "GCode - ";
  if (normalizedTitle.startsWith(remoteWindowPrefix)) {
    return joinGCodeProcessName(
      "renderer",
      "remote",
      normalizedTitle.slice(remoteWindowPrefix.length),
    );
  }

  return joinGCodeProcessName("renderer", normalizedTitle);
}

export function formatGCodeAgentProcessName(provider: string, workspacePath?: string): string {
  return joinGCodeProcessName("agent", provider, pickWorkspaceTag(workspacePath));
}

export function formatGCodeUtilityProcessName(name?: string, type = "utility"): string {
  return joinGCodeProcessName(type, name);
}

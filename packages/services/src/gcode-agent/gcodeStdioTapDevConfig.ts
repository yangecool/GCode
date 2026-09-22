import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GCodeStdioTapDevState } from "@gcode/shared";
import { getAppConfigDir } from "#src/paths.js";
import { isEffectiveDevelopmentNodeEnv } from "#src/runtime-tools/nodeEnv.js";

interface GCodeStdioTapStateFile {
  enabled?: boolean;
}

function isGCodeStdioTapDevVisible(): boolean {
  return isEffectiveDevelopmentNodeEnv();
}

function getGCodeStdioTapDevDir(): string {
  return join(getAppConfigDir(), "dev");
}

export function getGCodeStdioTapDevLogDir(): string {
  return join(getGCodeStdioTapDevDir(), "stdio-traffic");
}

function getGCodeStdioTapDevStatePath(): string {
  return join(getGCodeStdioTapDevDir(), "gcode-stdio-tap.json");
}

function readStateFile(path: string): GCodeStdioTapStateFile {
  if (!existsSync(path)) {
    return {};
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as GCodeStdioTapStateFile) : {};
  } catch {
    return {};
  }
}

export function readGCodeStdioTapDevState(): GCodeStdioTapDevState {
  const visible = isGCodeStdioTapDevVisible();
  const statePath = getGCodeStdioTapDevStatePath();
  const fileState = readStateFile(statePath);
  return {
    enabled: visible && fileState.enabled === true,
    visible,
    logDir: getGCodeStdioTapDevLogDir(),
    statePath,
  };
}

export function setGCodeStdioTapDevEnabled(enabled: boolean): GCodeStdioTapDevState {
  const visible = isGCodeStdioTapDevVisible();
  const statePath = getGCodeStdioTapDevStatePath();
  mkdirSync(getGCodeStdioTapDevDir(), { recursive: true });
  writeFileSync(
    statePath,
    `${JSON.stringify(
      {
        // 开发态 stdio 抓包是高频原始协议帧，只能通过显式开关写旁路文件，避免误进生产日志。
        enabled: visible && enabled,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  return readGCodeStdioTapDevState();
}

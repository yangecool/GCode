import type { GCodePersistedMessage, GCodeTaskPersistStatus } from "@gcode/shared";

/** 导入来源身份：外部原生 CLI（Claude Code），与 agent runtime 的 GCodeProvider 无关。 */
export type ClaudeNativeImportSourceProvider = "claude";

export interface ClaudeNativeImportedSessionSource {
  provider: ClaudeNativeImportSourceProvider;
  sessionId: string;
  workspacePath: string;
  sourcePath: string;
  createdAt: number;
  updatedAt: number;
  title?: string;
  model?: string;
  status?: GCodeTaskPersistStatus;
  migrationSource?: "claudeCode";
  messages: GCodePersistedMessage[];
}

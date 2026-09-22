import type { GCodeSessionStateSnapshot } from "@gcode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { repairImportedClaudeSessionSnapshot } from "#src/session/claude-native/importedClaudeHistoryRepair.js";
import type { IGCodeAgentService } from "#src/gcode-agent/gcodeAgent.js";
import type {
  GCodeSessionReadParams,
  GCodeSessionResumeParams,
} from "#src/gcode-session/gcodeSession.js";

const logger = createServiceLogger("gcode-session-service");

export async function repairEmptyImportedClaudeSessionSnapshot(params: {
  agentService: IGCodeAgentService;
  snapshot: GCodeSessionStateSnapshot;
  target: GCodeSessionResumeParams | GCodeSessionReadParams;
}): Promise<GCodeSessionStateSnapshot> {
  const repaired = await repairImportedClaudeSessionSnapshot({
    snapshot: params.snapshot,
    target: {
      workspacePath: params.target.workspacePath,
      workspaceIdentity: params.target.workspaceIdentity,
      taskId: params.target.sessionId,
      ...("mcpServers" in params.target && params.target.mcpServers
        ? { mcpServers: params.target.mcpServers }
        : {}),
    },
    createSession: (input) => params.agentService.createSession(input),
    onRepair: (history) => {
      logger.warn(
        undefined,
        `[gcode-session-service] Claude 导入 session 历史异常，按 ${history.source} 回填 taskId=${params.target.sessionId}`,
      );
    },
  });
  return repaired ?? params.snapshot;
}

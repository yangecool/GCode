/**
 * GCode Agent Slash Commands 便捷 hook
 *
 * 返回当前 workspace 下 Agent 广播的可用 slash commands 列表。
 */
import { useGCodeSessionStore, selectWorkspaceGCodeState } from "../store/gcodeSessionStore.js";

export function useSlashCommands(workspacePath: string, workspaceIdentity?: string) {
  return useGCodeSessionStore(
    (state) => selectWorkspaceGCodeState(state, workspacePath, workspaceIdentity).slashCommands,
  );
}

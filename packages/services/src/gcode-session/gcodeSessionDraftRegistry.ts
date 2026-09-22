import type { GCodeSessionStateSnapshot } from "@gcode/shared";
import type {
  GCodeSessionWorkspaceTarget,
  GCodeTaskTarget,
} from "#src/gcode-session/gcodeSession.js";

function getWorkspaceKey(target: GCodeSessionWorkspaceTarget): string {
  return target.workspaceIdentity?.trim() || target.workspacePath;
}

function getSessionScopedKey(target: GCodeTaskTarget): string {
  return `${getWorkspaceKey(target)}\0${target.sessionId}`;
}

export function createGCodeDeferredDraftRegistry() {
  const sessionKeys = new Set<string>();

  return {
    remember(params: GCodeSessionWorkspaceTarget, snapshot: GCodeSessionStateSnapshot): void {
      sessionKeys.add(
        getSessionScopedKey({
          workspacePath: snapshot.session.workspace.workspacePath,
          workspaceIdentity:
            snapshot.session.workspace.workspaceIdentity ?? params.workspaceIdentity,
          sessionId: snapshot.session.sessionId,
        }),
      );
    },

    has(target: GCodeTaskTarget): boolean {
      return sessionKeys.has(getSessionScopedKey(target));
    },

    forget(target: GCodeTaskTarget): void {
      sessionKeys.delete(getSessionScopedKey(target));
    },
  };
}

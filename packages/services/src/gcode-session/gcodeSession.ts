import { ServiceChannels } from "@gcode/shared";
import type {
  TraceId,
  GCodeAgentMcpServer,
  GCodeDeliveryKind,
  GCodeMessageWithParts,
  ModelSelection,
  GCodePermissionRequestParams,
  GCodeUserInputRequestParams,
  GCodeUserInputResponse,
  GCodeSessionInfo,
  GCodeSessionImportHistory,
  GCodeSessionEvent,
  GCodeSessionMode,
  GCodeSessionPersistence,
  GCodeSessionStateSnapshot,
  GCodeStateUpdatedNotification,
  GCodeWorkspacePresentation,
} from "@gcode/shared";
import { createServiceDescriptor } from "#src/descriptors.js";

export interface GCodeSessionWorkspaceTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

export type GCodeSessionReadWorkspacePresentationParams = GCodeSessionWorkspaceTarget;

export interface GCodeTaskTarget extends GCodeSessionWorkspaceTarget {
  sessionId: string;
}

export interface GCodeSessionCreateParams extends GCodeSessionWorkspaceTarget {
  /** 仅导入事务使用的预分配 ID；普通新会话继续由 Agent 分配。 */
  sessionId?: string;
  sessionTraceId?: TraceId;
  parentSessionId?: string;
  mode?: GCodeSessionMode;
  model?: ModelSelection;
  persistence?: GCodeSessionPersistence;
  thoughtLevel?: string;
  mcpServers?: GCodeAgentMcpServer[];
  importedHistory?: GCodeSessionImportHistory;
}

export interface GCodeSessionResumeParams extends GCodeTaskTarget {
  model?: ModelSelection;
  thoughtLevel?: string;
  mcpServers?: GCodeAgentMcpServer[];
  /**
   * 默认广播 resume 得到的历史快照，并让 shadow 订阅请求初始 snapshot。
   * 续聊发送前的 runtime 预恢复会关闭它，避免旧终态快照覆盖本地已开始的新输入运行态。
   */
  broadcastSnapshot?: boolean;
}

export interface GCodeSessionListParams extends GCodeSessionWorkspaceTarget {
  includeArchived?: boolean;
  limit?: number;
}

export interface GCodeSessionReadParams extends GCodeTaskTarget {
  deliveryKind?: GCodeDeliveryKind;
  messageLimit?: number;
  afterSeq?: number;
}

export interface GCodeSessionMessagesParams extends GCodeTaskTarget {
  afterMessageId?: string;
  limit?: number;
}

export interface GCodeSessionEventsParams extends GCodeTaskTarget {
  afterSeq?: number;
  limit?: number;
}

export interface GCodeSessionSetModelParams extends GCodeTaskTarget {
  model: ModelSelection;
  expectedRevision?: number;
  persistAsWorkspaceLastUsed?: boolean;
}

export interface GCodeSessionSetThoughtLevelParams extends GCodeTaskTarget {
  thoughtLevel?: string;
  expectedRevision?: number;
  persistAsWorkspaceLastUsed?: boolean;
}

export interface GCodeSessionSetModeParams extends GCodeTaskTarget {
  mode: GCodeSessionMode;
  expectedRevision?: number;
}

export interface GCodeSessionSubscribeParams extends GCodeTaskTarget {
  deliveryKind: GCodeDeliveryKind;
  afterSeq?: number;
  includeSnapshot?: boolean;
  eventCoalescing?: {
    mode: "background-summary";
    intervalMs?: number;
  };
}

export type GCodeSessionServiceEvent =
  | { type: "session.event"; event: GCodeSessionEvent }
  | { type: "state.updated"; notification: GCodeStateUpdatedNotification }
  | { type: "permission.request"; request: GCodePermissionRequestParams }
  | { type: "userInput.request"; request: GCodeUserInputRequestParams }
  | {
      type: "userInput.response";
      requestId: string;
      response: GCodeUserInputResponse;
    }
  | { type: "snapshot"; snapshot: GCodeSessionStateSnapshot };

export interface GCodeSessionInitializeResult {
  available: boolean;
  workspaceKey: string;
  protocolName?: string;
  protocolVersion?: number;
  transportKind?: "stdio" | "websocket";
  reason?: string;
  reasonCode?: "provider_not_ready";
}

export interface GCodeSessionWorkspaceRuntimeIdentity {
  generation: number;
  identity: string;
  processId?: number;
  workspaceKey: string;
}

export interface IGCodeSessionService {
  initializeWorkspace(params: GCodeSessionWorkspaceTarget): Promise<GCodeSessionInitializeResult>;
  getWorkspaceRuntimeIdentity(
    params: GCodeSessionWorkspaceTarget,
  ): Promise<GCodeSessionWorkspaceRuntimeIdentity>;
  readWorkspacePresentation(
    params: GCodeSessionReadWorkspacePresentationParams,
  ): Promise<GCodeWorkspacePresentation>;
  createSession(params: GCodeSessionCreateParams): Promise<GCodeSessionStateSnapshot>;
  resumeSession(params: GCodeSessionResumeParams): Promise<GCodeSessionStateSnapshot>;
  listSessions(params: GCodeSessionListParams): Promise<GCodeSessionInfo[]>;
  readSession(params: GCodeSessionReadParams): Promise<GCodeSessionStateSnapshot>;
  readSessionMessages(params: GCodeSessionMessagesParams): Promise<GCodeMessageWithParts[]>;
  readSessionEvents(params: GCodeSessionEventsParams): Promise<GCodeSessionEvent[]>;
  promoteDeferredDraftSession(params: GCodeTaskTarget): Promise<void>;
  closeSession(params: GCodeTaskTarget): Promise<void>;
  closeDeferredDraftSession(params: GCodeTaskTarget): Promise<boolean>;
  setModel(params: GCodeSessionSetModelParams): Promise<GCodeSessionStateSnapshot>;
  setThoughtLevel(params: GCodeSessionSetThoughtLevelParams): Promise<GCodeSessionStateSnapshot>;
  setMode(params: GCodeSessionSetModeParams): Promise<GCodeSessionStateSnapshot>;
  // renderer 订阅面走 agentService 的 conversation/sessions-index 帧通道。
}

export const IGCodeSessionService = createServiceDescriptor<IGCodeSessionService>(
  ServiceChannels.GCodeSession,
);

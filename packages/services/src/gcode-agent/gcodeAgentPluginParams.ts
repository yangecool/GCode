import type {
  GCodeAgentMcpServer,
  GCodeAutomationScheduleRule,
  GCodeMcpListMode,
  ModelSelection,
} from "@gcode/shared";

export interface GCodeAgentWorkspaceTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  /** 远程 workspace 的运行时会话身份；只用于隔离/路由，不能替代 workspacePath。 */
  remoteSessionId?: string;
}

export interface GCodeAgentPluginViewParams extends GCodeAgentWorkspaceTarget {
  configScope?: "user" | "workspace";
}

export interface GCodeAgentListMcpServerStatusesParams extends GCodeAgentWorkspaceTarget {
  mcpServers?: GCodeAgentMcpServer[];
  mode?: GCodeMcpListMode;
}

export interface GCodeAgentAddPluginMarketplaceParams extends GCodeAgentWorkspaceTarget {
  dryRun?: boolean;
  operationId?: string;
  source: string;
}

export interface GCodeAgentRemovePluginMarketplaceParams extends GCodeAgentWorkspaceTarget {
  marketplace: string;
}

export interface GCodeAgentUpdatePluginMarketplaceParams extends GCodeAgentWorkspaceTarget {
  marketplace?: string;
  operationId?: string;
}

export interface GCodeAgentInstallPluginParams extends GCodeAgentWorkspaceTarget {
  dryRun?: boolean;
  marketplace: string;
  operationId?: string;
  pluginName: string;
  scope?: "user" | "workspace";
}

export interface GCodeAgentCancelPluginOperationParams {
  operationId: string;
}

export interface GCodeAgentUninstallPluginParams extends GCodeAgentWorkspaceTarget {
  marketplace?: string;
  pluginId?: string;
  pluginName?: string;
  removeCache?: boolean;
}

export interface GCodeAgentUpdatePluginParams extends GCodeAgentWorkspaceTarget {
  pluginId?: string;
  marketplace?: string;
}

export interface GCodeAgentRestoreBuiltinPluginParams extends GCodeAgentWorkspaceTarget {
  pluginId: string;
}

export interface GCodeAgentConfigurePluginParams extends GCodeAgentWorkspaceTarget {
  clearOptionKeys?: string[];
  dryRun?: boolean;
  options: Record<string, unknown>;
  pluginId: string;
  scope?: "user" | "workspace";
}

export interface GCodeAgentResetPluginConfigParams extends GCodeAgentWorkspaceTarget {
  pluginId: string;
  scope?: "user" | "workspace";
}

export interface GCodeAgentValidatePluginParams extends GCodeAgentWorkspaceTarget {
  marketplace?: string;
  pluginName?: string;
  source?: string;
}

export interface GCodeAgentDescribePluginParams extends GCodeAgentWorkspaceTarget {
  marketplace: string;
  pluginName: string;
}

export interface GCodeAgentSetPluginEnabledParams extends GCodeAgentWorkspaceTarget {
  enabled: boolean;
  operationId?: string;
  pluginId: string;
  scope?: "user" | "workspace";
}

// Plugin 对话引用 catalog：
// 带 sessionId → session-owned 冻结 catalog（必须路由到持有该 session 的 workspace client）；
// 不带 → workspace 当前 catalog（新建草稿 Picker）。
export interface GCodeAgentPluginReferenceCatalogParams extends GCodeAgentWorkspaceTarget {
  sessionId?: string;
}

// Composer Skill catalog：与 Plugin 引用相同，以 sessionId 区分 workspace 当前目录和
// resident Session runtime 快照；不参与 Settings 管理目录。
export interface GCodeAgentSkillReferenceCatalogParams extends GCodeAgentWorkspaceTarget {
  sessionId?: string;
}
export interface GCodeAgentResolveSuggestedPluginReferenceParams extends GCodeAgentWorkspaceTarget {
  stableId: string;
  operationId: string;
  clientMode: "desktop-continuous" | "web-remote-replayable";
  deliveryKind: "desktop-continuous" | "web-remote-replayable";
}

// ---- 定时任务(automation)管理参数 ----

export interface GCodeAgentCreateAutomationParams extends GCodeAgentWorkspaceTarget {
  title: string;
  cronExpr: string;
  relativeDelayMinutes?: number;
  prompt: string;
  modelSelection?: ModelSelection;
  mode?: string;
  recurring?: boolean;
  maxRuns?: number;
  endAt?: number;
  scheduleRule?: GCodeAutomationScheduleRule;
}

export interface GCodeAgentUpdateAutomationParams extends GCodeAgentWorkspaceTarget {
  automationId: string;
  title?: string;
  cronExpr?: string;
  prompt?: string;
  modelSelection?: ModelSelection | null;
  mode?: string | null;
  recurring?: boolean;
  maxRuns?: number | null;
  endAt?: number | null;
  scheduleRule?: GCodeAutomationScheduleRule | null;
  scheduleEditedByUser?: boolean;
}

export interface GCodeAgentAutomationIdParams extends GCodeAgentWorkspaceTarget {
  automationId: string;
}

export interface GCodeAgentSetAutomationEnabledParams extends GCodeAgentWorkspaceTarget {
  automationId: string;
  enabled: boolean;
}

export interface GCodeAgentDeleteAutomationRunParams extends GCodeAgentWorkspaceTarget {
  runId: string;
}

import type { WorkspacePurpose, GCodeTaskMeta } from "@gcode/shared";

export type GCodeTaskListKind = "pinned" | "archived" | "timeline" | "active";
export type GCodeTaskListSortBy = "created" | "updated";

export interface GCodeTaskListWorkspaceScope {
  workspacePath: string;
  workspaceIdentity?: string;
  workspacePurpose?: WorkspacePurpose;
}

export interface GCodeTaskListQuery {
  kind: GCodeTaskListKind;
  workspaceScopes: GCodeTaskListWorkspaceScope[];
  sortBy: GCodeTaskListSortBy;
  search?: string;
  limit?: number;
}

export type GCodeTaskListItem = GCodeTaskMeta & {
  searchSnippet?: string;
  searchSnippets?: string[];
};

export interface GCodeTaskListResult {
  items: GCodeTaskListItem[];
  total: number;
  hasMore: boolean;
}

export type GCodeTaskGroupColor =
  | "gray"
  | "red"
  | "orange"
  | "yellow"
  | "green"
  | "blue"
  | "purple";

export interface GCodeTaskGroup {
  id: string;
  title: string;
  color: GCodeTaskGroupColor;
  createdAt: number;
  updatedAt: number;
}

export interface GCodeGroupedTaskRef {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
}

export type GCodeGroupedTaskViewTopLevelNodeRef =
  | { type: "group"; groupId: string }
  | { type: "task"; task: GCodeGroupedTaskRef };

export type GCodeGroupedTaskViewNode =
  | {
      type: "group";
      group: GCodeTaskGroup;
      tasks: GCodeTaskListItem[];
      sortOrder?: number;
    }
  | {
      type: "task";
      task: GCodeTaskListItem;
      sortOrder?: number;
    };

export interface GCodeGroupedTaskView {
  nodes: GCodeGroupedTaskViewNode[];
}

export interface GCodeGroupedTaskViewQuery {
  workspaceScopes: GCodeTaskListWorkspaceScope[];
  includeAllWorkspaces?: boolean;
}

// ── grouped 原始结构（不 join tasks 表）──
// grouped 视图的任务数据源迁到 sessions-index 后，服务端只提供分组结构
// （task_groups / task_group_members / task_group_view_node_orders），
// 由客户端与 sessions-index 会话做 join。

/** 组成员引用（不含任务 meta；task 内容由 sessions-index 提供）。 */
export interface GCodeGroupedTaskViewStructureMember {
  groupId: string;
  /** 服务端口径 workspaceKey（resolveWorkspaceKey：identity ?? path），join 匹配键。 */
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
  /** null = 尚未落 sort_order（新加入组）；客户端按 addedAt 降序补内存序。 */
  sortOrder: number | null;
  addedAt: number;
}

/** 顶层节点排序（task_group_view_node_orders，node_key 已解析为结构化引用）。 */
export type GCodeGroupedTaskViewStructureTopOrder =
  | { type: "group"; groupId: string; sortOrder: number }
  | { type: "task"; workspaceKey: string; taskId: string; sortOrder: number };

export interface GCodeGroupedTaskViewStructure {
  /** 已按 workspaceScopes 可见性过滤的 group（bootstrap workspace group 只在其 workspace 可见）。 */
  groups: GCodeTaskGroup[];
  /** 全量组成员（含不可见 group 的成员——顶层排除规则需要全量判断）。 */
  members: GCodeGroupedTaskViewStructureMember[];
  topLevelOrders: GCodeGroupedTaskViewStructureTopOrder[];
}

export interface GCodeGroupedTaskViewOrderInput {
  workspaceScopes: GCodeTaskListWorkspaceScope[];
  topLevelNodes: GCodeGroupedTaskViewTopLevelNodeRef[];
  groups: Array<{
    groupId: string;
    taskRefs: GCodeGroupedTaskRef[];
  }>;
}

export interface GCodeWorkspaceEventSubscriptionParams {
  workspacePath: string;
  workspaceIdentity?: string;
}

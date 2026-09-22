// ============================================================
// Grok memory v2 tools - memory_search / memory_get handlers
// ============================================================
// G Code：Grok memory-v2 隔离存储的模型工具面。存储实现与安全边界（symlink/
// traversal 拒绝、64KiB 读上限、命中上限）全部来自 adapters 的 grok-memory
// 模块（已测）；本文件只做 ToolEntry 包装。scope 索引在 handler 内按调用
// 打开（惰性建目录），无跨调用缓存。

import {
  getMemoryFile,
  listMemoryFiles,
  MEMORY_ADVISORY,
  openMemoryStore,
  searchMemoryFiles,
} from "@zcode/adapters/grok-memory";
import type { MemoryFile } from "@zcode/adapters/grok-memory";
import {
  MemoryGetInputSchema,
  MemoryGetOutputSchema,
  MemorySearchInputSchema,
  MemorySearchOutputSchema,
} from "@zcode/contracts";
import {
  MemoryGetInputJsonSchema,
  MemoryGetOutputJsonSchema,
  MemorySearchInputJsonSchema,
  MemorySearchOutputJsonSchema,
} from "@zcode/contracts";
import type { ToolExecutionContext } from "../types.js";
import type { ToolEntry, ToolHandlerFailure } from "../types.js";

const MEMORY_TOOL_DESCRIPTION =
  "Search the persistent memory knowledge base (Markdown notes recorded in earlier sessions, split into a global scope shared across workspaces and a workspace-specific scope). Tokens from the query are matched against file paths and content; results are scored hits with stable ids you can pass to memory_get.";

const MEMORY_GET_TOOL_DESCRIPTION =
  "Read one memory file by its id (as returned by memory_search, e.g. `global:topics/foo.md`). Memory is historical context — verify recalled facts against live sources before relying on them.";

const MAX_SEARCH_RESULTS = 8;

/** 业务失败码：与其它内建工具一致用稳定数字码；消息携带可读细节。 */
const MEMORY_TOOL_ERROR_CODE = 4601;

function memoryHandlerFailure(message: string): ToolHandlerFailure {
  return { result: false, errorCode: MEMORY_TOOL_ERROR_CODE, message };
}

const memorySearchHandler = async (
  input: unknown,
  context: ToolExecutionContext,
): Promise<Record<string, unknown> | ToolHandlerFailure> => {
  const parsed = MemorySearchInputSchema.safeParse(input);
  if (!parsed.success) return memoryHandlerFailure("Invalid memory_search input");
  const cwd = context.workingDirectory ?? process.cwd();
  const store = await openMemoryStore(cwd);
  const files = await listScope(store, parsed.data.scope ?? "all");
  const hits = searchMemoryFiles(files, parsed.data.query, parsed.data.limit ?? MAX_SEARCH_RESULTS);
  const remaining = searchMemoryFiles(files, parsed.data.query, hits.length + 1);
  return {
    results: hits.map(hit => ({
      id: hit.id,
      scope: hit.scope,
      relativePath: hit.relativePath,
      score: hit.score,
    })),
    truncated: remaining.length > hits.length,
    advisory: MEMORY_ADVISORY,
  };
};

async function listScope(
  store: Awaited<ReturnType<typeof openMemoryStore>>,
  scope: "all" | "global" | "workspace",
): Promise<MemoryFile[]> {
  const all = await listMemoryFiles(store);
  return scope === "all" ? all : all.filter(file => file.scope === scope);
}

const memoryGetHandler = async (
  input: unknown,
  context: ToolExecutionContext,
): Promise<Record<string, unknown> | ToolHandlerFailure> => {
  const parsed = MemoryGetInputSchema.safeParse(input);
  if (!parsed.success) return memoryHandlerFailure("Invalid memory_get input");
  const cwd = context.workingDirectory ?? process.cwd();
  const store = await openMemoryStore(cwd);
  const file = await getMemoryFile(store, parsed.data.id);
  if (file === undefined) {
    return memoryHandlerFailure(`No memory file with id ${parsed.data.id}`);
  }
  return {
    content: file.content,
    truncated: file.content.length >= 64 * 1024,
    advisory: MEMORY_ADVISORY,
  };
};

function memoryModelContent(output: unknown): string {
  const result = output as { results?: Array<{ id: string; score: number }>; content?: string };
  if (result.content !== undefined) return result.content;
  const results = result.results ?? [];
  if (results.length === 0) return "No memory hits. Memory may be empty for this workspace.";
  return results.map(hit => `${hit.id} (score ${hit.score})`).join("\n");
}

export const memorySearchToolEntry: ToolEntry = {
  capability: "Search the persistent memory knowledge base by keyword",
  metadata: {
    name: "memory_search",
    description: MEMORY_TOOL_DESCRIPTION,
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: 15000,
    maxOutputBytes: 32 * 1024,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: memorySearchHandler,
  inputSchema: MemorySearchInputJsonSchema,
  outputSchema: MemorySearchOutputJsonSchema,
  runtimeInputSchema: MemorySearchInputSchema,
  runtimeOutputSchema: MemorySearchOutputSchema,
  formatModelContent: memoryModelContent,
  permission: {
    permission: "read",
    reason: "memory_search only reads the isolated memory store",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: false,
    patternSources: [],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: 32 * 1024,
    maxModelBytes: 32 * 1024,
    strategy: "truncate",
  },
  timeout: { defaultMs: 15000, maxMs: 30000, allowCallOverride: false },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "Memory search was cancelled",
  },
  trace: { required: true, propagateToAdapters: false, recordInput: "summary", recordOutput: "summary" },
};

export const memoryGetToolEntry: ToolEntry = {
  capability: "Read one memory file by id",
  metadata: {
    name: "memory_get",
    description: MEMORY_GET_TOOL_DESCRIPTION,
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: 15000,
    maxOutputBytes: 64 * 1024 + 1024,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: memoryGetHandler,
  inputSchema: MemoryGetInputJsonSchema,
  outputSchema: MemoryGetOutputJsonSchema,
  runtimeInputSchema: MemoryGetInputSchema,
  runtimeOutputSchema: MemoryGetOutputSchema,
  formatModelContent: memoryModelContent,
  permission: {
    permission: "read",
    reason: "memory_get only reads the isolated memory store",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: false,
    patternSources: ["input"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: 64 * 1024 + 1024,
    maxModelBytes: 64 * 1024 + 1024,
    strategy: "truncate",
  },
  timeout: { defaultMs: 15000, maxMs: 30000, allowCallOverride: false },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "Memory read was cancelled",
  },
  trace: { required: true, propagateToAdapters: false, recordInput: "summary", recordOutput: "summary" },
};

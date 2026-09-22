// ============================================================
// HashlineEdit tool - Grok anchor-based atomic edit dialect
// ============================================================
// G Code：grok-build hashline 编辑方言（chunk_v1）的工具面。核心语义
// （锚点解析、批次原子性、stale 锚点回新锚点）来自 adapters 的 grok-hashline
// 模块（已测）；本文件做 ToolEntry 包装与文件 IO 接线。文件写走 fileSystemPort
// 之外的原生 fs——hashline 的 IO 契约（HashlineFileIo）就是纯 read/write。

import { runHashlineEdit } from "@gcode/adapters/grok-hashline";
import {
  HashlineEditInputSchema,
  HashlineEditToolOutputSchema,
} from "@gcode/contracts";
import { HashlineEditInputJsonSchema, HashlineEditToolOutputJsonSchema } from "@gcode/contracts";
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { ToolExecutionContext } from "../types.js";
import type { ToolEntry, ToolHandlerFailure } from "../types.js";

const HASHLINE_EDIT_DESCRIPTION =
  "Edit a file through anchored, atomic edit batches (Grok hashline dialect). Each edit anchors a line as `lineNumber:localHash` (plus optional `:context` to disambiguate identical lines) obtained from Read output; `replace` spans anchor..end_anchor, `insert_after` adds lines below an anchor, `write` rewrites the whole file. The batch is atomic: if any anchor is stale the whole batch is rejected and fresh anchors are returned — retry the full batch with them immediately, never fabricate anchors.";

const hashlineFileIo = {
  read: (path: string) => readFile(path, "utf8"),
  write: (path: string, content: string) => writeFile(path, content, "utf8"),
};

const hashlineEditHandler = async (
  input: unknown,
  context: ToolExecutionContext,
): Promise<Record<string, unknown> | ToolHandlerFailure> => {
  const parsed = HashlineEditInputSchema.safeParse(input);
  if (!parsed.success) {
    return { result: false, errorCode: "invalid_input", message: "Invalid HashlineEdit input" };
  }
  const rawPath = parsed.data.file_path;
  const absolutePath = isAbsolute(rawPath)
    ? rawPath
    : resolve(context.workingDirectory ?? process.cwd(), rawPath);
  const result = await runHashlineEdit(hashlineFileIo, {
    file_path: absolutePath,
    edits: parsed.data.edits as Parameters<typeof runHashlineEdit>[1]["edits"],
  });
  return { ...result } as Record<string, unknown>;
};

export const hashlineEditToolEntry: ToolEntry = {
  capability: "Apply anchored atomic edit batches to files (Grok hashline dialect)",
  metadata: {
    name: "HashlineEdit",
    description: HASHLINE_EDIT_DESCRIPTION,
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    timeoutMs: 30000,
    maxOutputBytes: 16 * 1024,
    sideEffectScope: "workspace",
    riskLevel: "medium",
    needsApproval: true,
  },
  handler: hashlineEditHandler,
  inputSchema: HashlineEditInputJsonSchema,
  outputSchema: HashlineEditToolOutputJsonSchema,
  runtimeInputSchema: HashlineEditInputSchema,
  runtimeOutputSchema: HashlineEditToolOutputSchema,
  formatModelContent: formatHashlineEditModelContent,
  permission: {
    permission: "edit",
    reason: "HashlineEdit writes workspace files through anchored edits",
    riskLevel: "medium",
    sideEffectScope: "workspace",
    needsApproval: true,
    patternSources: ["input"],
    alwaysAllowPatternSources: ["input"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: 16 * 1024,
    maxModelBytes: 16 * 1024,
    strategy: "truncate",
  },
  timeout: { defaultMs: 30000, maxMs: 60000, allowCallOverride: false },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "HashlineEdit was cancelled; no edits from this batch were applied",
  },
  trace: { required: true, propagateToAdapters: false, recordInput: "summary", recordOutput: "summary" },
};

function formatHashlineEditModelContent(output: unknown): string {
  const result = output as {
    status?: string;
    applied?: number;
    snippet?: string;
    snippet_start_line?: number;
    error?: string;
    message?: string;
    shifted_anchor?: string;
    shifted_to?: number;
    context?: string;
    context_start_line?: number;
    warnings?: string[];
  };
  if (result.status === "ok") {
    const lines = [`Applied ${String(result.applied ?? 0)} edit(s).`];
    if (result.snippet !== undefined) {
      lines.push(`Result from line ${String(result.snippet_start_line ?? 0)}:`);
      lines.push(result.snippet);
    }
    for (const warning of result.warnings ?? []) lines.push(warning);
    return lines.join("\n");
  }
  const lines = [`Edit batch rejected (${result.error ?? "error"}): ${result.message ?? ""}`];
  if (result.shifted_anchor !== undefined) {
    lines.push(`Fresh anchor: ${result.shifted_anchor} (line ${String(result.shifted_to)})`);
    lines.push("Retry the full batch with the fresh anchors.");
  }
  if (result.context !== undefined && result.context_start_line !== undefined) {
    lines.push(`Current context from line ${String(result.context_start_line)}:`);
    lines.push(result.context);
  }
  return lines.join("\n");
}

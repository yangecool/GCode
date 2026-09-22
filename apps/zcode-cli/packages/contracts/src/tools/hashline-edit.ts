// ============================================================
// HashlineEdit Tool - Grok anchor-based atomic edit dialect
// ============================================================
// G Code：grok-build 的 hashline 编辑方言（chunk_v1）。锚点 = 行号:本地哈希
// （可选 context 消歧）；编辑批次原子——任一锚点过期则整批拒绝并返回新锚点
// （shifted_anchor），模型立即用新锚点重试整批。

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

// -----------------------------------------------
// Input Schema
// -----------------------------------------------

const hashlineEditOpSchema = z.union([
  z.object({
    op: z.literal("replace"),
    anchor: z.string().describe("startLine:localHash[:context] anchor of the first replaced line"),
    end_anchor: z.string().optional().describe("anchor of the last replaced line; defaults to `anchor`"),
    content: z.string().describe("replacement text for the anchored line range"),
  }),
  z.object({
    op: z.literal("insert_after"),
    anchor: z.string().describe("insert new lines directly after this anchored line"),
    content: z.string(),
  }),
  z.object({
    op: z.literal("write"),
    content: z.string().describe("full file rewrite (no anchor)"),
  }),
]);

export const HashlineEditInputSchema = z.object({
  file_path: z.string().min(1).describe("absolute or workspace-relative path of the file to edit"),
  edits: z
    .union([hashlineEditOpSchema, z.array(hashlineEditOpSchema)])
    .describe("one edit or an atomic batch; every anchor must be fresh or the whole batch is rejected"),
});

export type HashlineEditInput = z.infer<typeof HashlineEditInputSchema>;

export const HashlineEditInputJsonSchema = toToolJsonSchema(HashlineEditInputSchema);

// -----------------------------------------------
// Output Types
// -----------------------------------------------

export interface HashlineEditToolOutput {
  status: "ok" | "error";
  /** Applied edit count (ok) or error class (error). */
  applied?: number;
  scheme?: "chunk_v1" | "content_only_v1";
  snippet_start_line?: number;
  snippet?: string;
  absolute_path?: string;
  warnings?: string[];
  error?: "invalid_input" | "stale_anchor" | "out_of_range" | "overlap";
  message?: string;
  requested_anchor?: string;
  current?: string;
  context?: string;
  context_start_line?: number;
  shifted_to?: number;
  shifted_anchor?: string;
  ambiguous_candidates?: number[];
}

export const HashlineEditToolOutputSchema = z
  .object({
    status: z.enum(["ok", "error"]),
    applied: z.number().int().nonnegative().optional(),
    scheme: z.enum(["chunk_v1", "content_only_v1"]).optional(),
    snippet_start_line: z.number().int().nonnegative().optional(),
    snippet: z.string().optional(),
    absolute_path: z.string().optional(),
    warnings: z.array(z.string()).optional(),
    error: z
      .enum(["invalid_input", "stale_anchor", "out_of_range", "overlap"])
      .optional(),
    message: z.string().optional(),
    requested_anchor: z.string().optional(),
    current: z.string().optional(),
    context: z.string().optional(),
    context_start_line: z.number().int().nonnegative().optional(),
    shifted_to: z.number().int().nonnegative().optional(),
    shifted_anchor: z.string().optional(),
    ambiguous_candidates: z.array(z.number().int()).optional(),
  })
  .strict();

export const HashlineEditToolOutputJsonSchema = toToolJsonSchema(HashlineEditToolOutputSchema);

// ============================================================
// Memory Search Tool - Grok memory v2 keyword search
// ============================================================
// G Code：查询 Grok memory-v2 隔离存储（global + workspace 两个 scope）。
// 语义移植自 grok-build 的 memory_search 工具：关键词计分、稳定 id 排序、
// 命中上限 50、MEMORY_ADVISORY 提示随结果返回。

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

// -----------------------------------------------
// Input Schema
// -----------------------------------------------

export const MemorySearchInputSchema = z.object({
  query: z.string().min(1).describe("Keyword query; tokens are matched against memory file paths and content"),
  scope: z
    .enum(["all", "global", "workspace"])
    .optional()
    .describe("Memory scope to search; defaults to all (global + workspace)"),
  limit: z.number().int().min(1).max(50).optional().describe("Maximum hits to return; defaults to 8"),
});

export type MemorySearchInput = z.infer<typeof MemorySearchInputSchema>;

export const MemorySearchInputJsonSchema = toToolJsonSchema(MemorySearchInputSchema);

// -----------------------------------------------
// Output Types
// -----------------------------------------------

export interface MemorySearchHit {
  id: string;
  scope: "global" | "workspace";
  relativePath: string;
  score: number;
}

export interface MemorySearchOutput {
  results: MemorySearchHit[];
  truncated: boolean;
  advisory: string;
}

export const MemorySearchOutputSchema = z
  .object({
    results: z.array(
      z.object({
        id: z.string(),
        scope: z.enum(["global", "workspace"]),
        relativePath: z.string(),
        score: z.number().int().nonnegative(),
      }),
    ),
    truncated: z.boolean(),
    advisory: z.string(),
  })
  .strict();

export const MemorySearchOutputJsonSchema = toToolJsonSchema(MemorySearchOutputSchema);

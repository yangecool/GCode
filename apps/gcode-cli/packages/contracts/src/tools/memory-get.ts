// ============================================================
// Memory Get Tool - read one Grok memory v2 file by id
// ============================================================
// id 形如 `global:topics/foo.md` / `workspace:MEMORY.md`；越界路径（`..`、
// 符号链接）由存储层拒绝（grok-memory 的 rejectSymlink/traversal 语义）。

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

// -----------------------------------------------
// Input Schema
// -----------------------------------------------

export const MemoryGetInputSchema = z.object({
  id: z
    .string()
    .min(1)
    .describe("Memory file id from memory_search, e.g. `global:topics/foo.md` or `workspace:MEMORY.md`"),
});

export type MemoryGetInput = z.infer<typeof MemoryGetInputSchema>;

export const MemoryGetInputJsonSchema = toToolJsonSchema(MemoryGetInputSchema);

// -----------------------------------------------
// Output Types
// -----------------------------------------------

export interface MemoryGetOutput {
  content: string;
  truncated: boolean;
  advisory: string;
}

export const MemoryGetOutputSchema = z
  .object({
    content: z.string(),
    truncated: z.boolean(),
    advisory: z.string(),
  })
  .strict();

export const MemoryGetOutputJsonSchema = toToolJsonSchema(MemoryGetOutputSchema);

import type { GCodeSessionFile, GCodeTaskMeta } from "@gcode/shared";
import { gcodeSessionFileSchema, gcodeTaskMetaSchema, gcodeTaskModeSchema } from "@gcode/shared";

export type LegacyTaskSessionFile = Omit<GCodeSessionFile, "meta"> & {
  meta: Omit<GCodeTaskMeta, "mode"> & { mode?: GCodeTaskMeta["mode"] };
};

const legacyTaskSessionFileSchema = gcodeSessionFileSchema.extend({
  // Claude 原生迁移会按清洗路径删除 meta.mode。
  // legacy snapshot 读取/写入仍要校验其它必需字段，但不能再强制把被过滤字段补回文件。
  meta: gcodeTaskMetaSchema.extend({
    mode: gcodeTaskModeSchema.optional(),
  }),
});

export function parseLegacyTaskSessionFile(input: unknown): LegacyTaskSessionFile {
  return legacyTaskSessionFileSchema.parse(input);
}

export function safeParseLegacyTaskSessionFile(input: unknown) {
  return legacyTaskSessionFileSchema.safeParse(input);
}

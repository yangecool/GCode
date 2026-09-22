import { z } from "zod";

/**
 * GCode agent 提供方的单一真源。
 *
 * 类型 GCodeProvider、运行时 schema gcodeProviderSchema 都从这里派生,
 * 避免各处内联 z.enum([...]) 副本随新增/删除 provider 漂移。
 * 本模块只依赖 zod(叶子),可被 validation / gcode-protocol 等无环引用。
 */
const GCODE_PROVIDERS = ["glm"] as const;

export const gcodeProviderSchema = z.enum(GCODE_PROVIDERS);

export type GCodeProvider = (typeof GCODE_PROVIDERS)[number];

import { z } from "zod";
import type { CommandAgentSource } from "./command-types.js";
import type { GCodeProvider } from "./gcode-task-types-core.js";

export const GCODE_AGENT_PROVIDER = "glm" satisfies GCodeProvider;
export const GCODE_AGENT_PROVIDER_LABEL = "GCode Agent";
export const GCODE_COMMAND_AGENT_SOURCE = "gcodeAgent" satisfies CommandAgentSource;

export const gcodeAgentProviderSchema = z.literal(GCODE_AGENT_PROVIDER);

export const GCODE_COMMAND_AGENT_SOURCES = [
  GCODE_COMMAND_AGENT_SOURCE,
] as const satisfies readonly CommandAgentSource[];

export function normalizeAgentProviderToGCodeAgent(
  _provider?: GCodeProvider | null,
): GCodeProvider {
  return GCODE_AGENT_PROVIDER;
}

export function isGCodeAgentProvider(
  provider: GCodeProvider | null | undefined,
): provider is typeof GCODE_AGENT_PROVIDER {
  return provider === GCODE_AGENT_PROVIDER;
}

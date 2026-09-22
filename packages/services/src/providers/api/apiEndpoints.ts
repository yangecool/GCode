import { buildRuntimeGCodeApiUrl, resolveZaiBusinessBaseUrl } from "@gcode/shared";

export const GCODE_CLIENT_SCENES_URL = buildRuntimeGCodeApiUrl(
  process.env,
  "/api/v1/client/scenes",
);

export const ZAI_API_HOST = resolveZaiBusinessBaseUrl(process.env);

import { createLocalServices, getAppConfigDir } from "@gcode/services/node";
import {
  materializeBundledGCodeBuiltinProviderConfig,
  readBundledGCodeBuiltinProviderConfig,
} from "./bundledGCodeBuiltinProviderConfig.js";
import { createHttpServer } from "./http.js";

async function main(): Promise<void> {
  const gcodeBuiltinProviderConfigFilePath = await materializeBundledGCodeBuiltinProviderConfig({
    environmentConfigRoot: getAppConfigDir(),
    content: readBundledGCodeBuiltinProviderConfig(),
  });
  const port = Number(process.env["PORT"]) || 3030;
  const host = process.env["GCODE_SERVER_HOST"]?.trim() || process.env["HOST"]?.trim() || undefined;
  const staticRoot = process.env["GCODE_WEB_STATIC_ROOT"]?.trim() || undefined;
  const authToken = process.env["GCODE_SERVER_AUTH_TOKEN"]?.trim() || undefined;
  const services = createLocalServices({
    gcodeBuiltinProviderConfigFilePath,
    providerProvisioningTargetEnabled: Boolean(authToken),
  });

  createHttpServer(services, port, {
    ...(host ? { host } : {}),
    ...(staticRoot ? { staticRoot, spaFallback: true } : {}),
    ...(authToken ? { authToken, authRequired: true } : {}),
  });
}

void main().catch((error: unknown) => {
  console.error("[gcode-server:http] startup failed", error);
  process.exitCode = 1;
});

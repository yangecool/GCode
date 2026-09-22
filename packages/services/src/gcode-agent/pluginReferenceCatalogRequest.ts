import {
  gcodeProtocolMethods,
  gcodePluginsReferenceCatalogResultSchema,
  type GCodePluginsReferenceCatalogParams,
} from "@gcode/shared";
import type { GCodeProtocolClient } from "#src/gcode-agent/gcodeProtocolClient.js";

/** 旧协议严格校验响应；新展示字段走独立入口，只有 -32601 能证明旧 Agent 不支持。 */
export async function requestPluginReferenceCatalog(
  client: Pick<GCodeProtocolClient, "request">,
  params: GCodePluginsReferenceCatalogParams,
) {
  try {
    return await client.request(
      gcodeProtocolMethods.pluginsReferenceCatalogWithCategory,
      params,
      gcodePluginsReferenceCatalogResultSchema,
    );
  } catch (error) {
    if (!(typeof error === "object" && error !== null && "code" in error && error.code === -32601))
      throw error;
    return client.request(
      gcodeProtocolMethods.pluginsReferenceCatalog,
      params,
      gcodePluginsReferenceCatalogResultSchema,
    );
  }
}

import {
  buildRuntimeGCodeEndpointUrls,
  GCODE_ENV,
  type RuntimeGCodeEndpointEnv,
} from "@gcode/shared";

interface RendererImportMetaEnv {
  VITE_GCODE_BASE_URL?: string;
  VITE_GCODE_ENDPOINT_ORIGIN?: string;
}

function readRendererImportMetaEnv(): RendererImportMetaEnv {
  return ((import.meta as ImportMeta & { env?: RendererImportMetaEnv }).env ??
    {}) as RendererImportMetaEnv;
}

function createRendererGCodeEndpointEnv(
  env: RendererImportMetaEnv = readRendererImportMetaEnv(),
): RuntimeGCodeEndpointEnv {
  return {
    GCODE_ENV,
    // UI 侧的 gcode-plan 占位 provider 以前只看 GCODE_ENV，
    // 没有消费 Vite 注入的 base url，导致自定义测试域名时 renderer 和 host/service 可能不一致。
    GCODE_BASE_URL: env.VITE_GCODE_BASE_URL,
    GCODE_ENDPOINT_ORIGIN: env.VITE_GCODE_ENDPOINT_ORIGIN,
  };
}

export const RENDERER_GCODE_ENDPOINT_URLS = buildRuntimeGCodeEndpointUrls(
  createRendererGCodeEndpointEnv(),
);

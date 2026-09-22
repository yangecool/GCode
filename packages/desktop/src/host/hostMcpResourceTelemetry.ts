import type { IDisposable } from "@gcode/rpc";
import type { IGCodeAgentService } from "@gcode/services";
import { HostResponseTypes, type ProcessResourceRuntimeSurface } from "@gcode/shared";

export function registerHostMcpResourceTelemetry(options: {
  agentService: Pick<IGCodeAgentService, "onDynamicMcpResourceSamples">;
  postMessage(message: unknown): void;
  runtimeSurface: ProcessResourceRuntimeSurface;
  environmentKey?: string;
}): IDisposable {
  return options.agentService.onDynamicMcpResourceSamples()((samples) => {
    try {
      options.postMessage({
        type: HostResponseTypes.McpResourceSamples,
        runtimeSurface: options.runtimeSurface,
        ...(options.environmentKey === undefined ? {} : { environmentKey: options.environmentKey }),
        samples,
      });
    } catch {
      // main 已退出或 IPC 关闭时只丢当前资源事实，不影响 MCP 生命周期。
    }
  });
}

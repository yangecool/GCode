// 平台能力面收敛：设置页「插件管理」的薄服务接口。
//
// 背景：pluginManagementStore / usePluginUninstall 过去直接注入 IGCodeAgentService，
// UI 层因此散布 13 个 plugins/* 旧协议词的消费点。收敛为独立薄 service 后，UI 只依赖
// 本接口；plugins/* 词表的 host 侧消费点收拢到 pluginManagementService 一处（插件的
// 事实源在 gcode-cli 进程，服务实现仍经 agent 协议往返——plugins 词表的收口归属
// 插件能力面自身的协议演进，不在会话 v4 词表范围内）。
// 注意与既有 IPluginsService（已 retired 的 marketplace pluginStore 通道）区分：
// 那套接口按 pluginName+marketplace 寻址且方法语义过时，不复用避免签名冲突。
import type { Event } from "@gcode/rpc";
import type {
  GCodePluginOperationProgressNotification,
  GCodePluginsConfigureResult,
  GCodePluginsCancelOperationResult,
  GCodePluginsDescribeResult,
  GCodePluginsInstallResult,
  GCodePluginsListResult,
  GCodePluginsMarketplaceMutationResult,
  GCodePluginsOverviewResult,
  GCodePluginsReferenceCatalogResult,
  GCodePluginsRestoreBuiltinResult,
  GCodePluginsSetEnabledResult,
  GCodePluginsUninstallResult,
  GCodePluginsValidateResult,
} from "@gcode/shared";
import { ServiceChannels } from "@gcode/shared";
import { createServiceDescriptor } from "../descriptors.js";
import type {
  GCodeAgentAddPluginMarketplaceParams,
  GCodeAgentConfigurePluginParams,
  GCodeAgentCancelPluginOperationParams,
  GCodeAgentDescribePluginParams,
  GCodeAgentInstallPluginParams,
  GCodeAgentPluginReferenceCatalogParams,
  GCodeAgentResolveSuggestedPluginReferenceParams,
  GCodeAgentResetPluginConfigParams,
  GCodeAgentPluginViewParams,
  GCodeAgentRemovePluginMarketplaceParams,
  GCodeAgentRestoreBuiltinPluginParams,
  GCodeAgentSetPluginEnabledParams,
  GCodeAgentUninstallPluginParams,
  GCodeAgentUpdatePluginMarketplaceParams,
  GCodeAgentUpdatePluginParams,
  GCodeAgentValidatePluginParams,
} from "../gcode-agent/gcodeAgentPluginParams.js";

export interface IPluginManagementService {
  listPlugins(params: GCodeAgentPluginViewParams): Promise<GCodePluginsListResult>;
  /**
   * Plugin 对话引用 catalog：
   * 带 sessionId → session-owned 冻结 catalog；不带 → workspace 当前 catalog。
   * 实现路由到 workspace 级 agent client，不走插件管理独立进程。
   */
  getPluginReferenceCatalog(
    params: GCodeAgentPluginReferenceCatalogParams,
  ): Promise<GCodePluginsReferenceCatalogResult>;
  resolveSuggestedPluginReference(
    params: GCodeAgentResolveSuggestedPluginReferenceParams,
  ): Promise<import("@gcode/shared").GCodePluginsResolveSuggestedReferenceResult>;
  onDynamicPluginOperationProgress(
    operationId: string,
  ): Event<GCodePluginOperationProgressNotification>;
  getPluginsOverview(params: GCodeAgentPluginViewParams): Promise<GCodePluginsOverviewResult>;
  addPluginMarketplace(
    params: GCodeAgentAddPluginMarketplaceParams,
  ): Promise<GCodePluginsMarketplaceMutationResult>;
  removePluginMarketplace(
    params: GCodeAgentRemovePluginMarketplaceParams,
  ): Promise<GCodePluginsMarketplaceMutationResult>;
  updatePluginMarketplace(
    params: GCodeAgentUpdatePluginMarketplaceParams,
  ): Promise<GCodePluginsMarketplaceMutationResult>;
  installPlugin(params: GCodeAgentInstallPluginParams): Promise<GCodePluginsInstallResult>;
  cancelPluginOperation(
    params: GCodeAgentCancelPluginOperationParams,
  ): Promise<GCodePluginsCancelOperationResult>;
  uninstallPlugin(params: GCodeAgentUninstallPluginParams): Promise<GCodePluginsUninstallResult>;
  updatePlugin(params: GCodeAgentUpdatePluginParams): Promise<GCodePluginsInstallResult>;
  restoreBuiltinPlugin(
    params: GCodeAgentRestoreBuiltinPluginParams,
  ): Promise<GCodePluginsRestoreBuiltinResult>;
  configurePlugin(params: GCodeAgentConfigurePluginParams): Promise<GCodePluginsConfigureResult>;
  resetPluginConfig(
    params: GCodeAgentResetPluginConfigParams,
  ): Promise<GCodePluginsConfigureResult>;
  validatePlugin(params: GCodeAgentValidatePluginParams): Promise<GCodePluginsValidateResult>;
  describePlugin(params: GCodeAgentDescribePluginParams): Promise<GCodePluginsDescribeResult>;
  setPluginEnabled(params: GCodeAgentSetPluginEnabledParams): Promise<GCodePluginsSetEnabledResult>;
}

export const IPluginManagementService = createServiceDescriptor<IPluginManagementService>(
  ServiceChannels.PluginManagement,
);

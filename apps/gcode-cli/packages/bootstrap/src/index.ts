// Bootstrap public API surface.

export * from "./app/create-app.js";
export type {
  ListGCodeSessionsOptions,
  PromptInput,
  ResolveLatestSessionOptions,
  ResumeOptions,
  RunGCodeProtocolAgentOptions,
  SendInputOptions,
  SendInputResult,
  SetLocaleResult,
  SteerTurnOptions,
  SubmitPromptOptions,
  UserPromptInput,
  GCodeApp,
  GCodeAppOptions,
  GCodeModelOption,
} from "./app/types.js";
export * from "./auth-login.js";
export * from "./grok-login.js";
export {
  inspectGCodeCustomCommand,
  listGCodeCustomCommands,
  loadGCodeCustomCommand,
} from "./custom-commands.js";
export type {
  InspectGCodeCustomCommandOptions,
  ListGCodeCustomCommandsOptions,
  GCodeCustomCommandInspection,
} from "./custom-commands.js";
export { createModelAdapter } from "./model-factory.js";
export type { CreateModelAdapterOptions } from "./model-factory.js";
export { startProcessProviderRegistryRuntime } from "./app/process-provider-registry-runtime.js";
export type { ProcessProviderRegistryRuntimeOptions } from "./app/process-provider-registry-runtime.js";
export {
  addGCodePluginMarketplace,
  getGCodePluginsOverview,
  installGCodeMarketplacePlugin,
  listGCodePlugins,
  removeGCodePluginMarketplace,
  resolveGCodePlugins,
  setGCodePluginEnabled,
  uninstallGCodeMarketplacePlugin,
  updateGCodeMarketplacePlugin,
  updateGCodePluginMarketplace,
  validateGCodePluginPath,
} from "./plugins.js";
export type {
  AddGCodeMarketplaceOptions,
  InstallGCodeMarketplacePluginOptions,
  ListGCodePluginsOptions,
  RemoveGCodeMarketplaceOptions,
  ResolveGCodePluginsOptions,
  SetGCodePluginEnabledOptions,
  SetGCodePluginEnabledResult,
  UninstallGCodeMarketplacePluginOptions,
  UpdateGCodeMarketplaceOptions,
  UpdateGCodeMarketplacePluginOptions,
  ValidateGCodePluginPathOptions,
  GCodeAvailablePluginData,
  GCodeInstalledPluginData,
  GCodeMarketplaceSummaryData,
  GCodeMarketplaceUpdateData,
  GCodePluginInstallData,
  GCodePluginUpdateData,
  GCodePluginsOverviewData,
} from "./plugins.js";
export { runGCodeProtocolAgent } from "./gcode-protocol-entrypoint.js";
// Exposed for the CLI's --output-format stream-json: it needs the same event
// shape the protocol server emits, rather than inventing a second one.
export { mapSessionEvent } from "./gcode-protocol/session-mapper.js";
export { prepareGCodeTelemetryEnv, shutdownGCodeTelemetry } from "./telemetry-bootstrap.js";
export type { SessionTranscriptMessage, SessionTranscriptPart } from "./session-transcript.js";
export { listGCodeSessions, resolveLatestSession } from "./sessions.js";
export { inspectGCodeSkill, listGCodeSkills } from "./skills.js";
export type {
  InspectGCodeSkillOptions,
  ListGCodeSkillsOptions,
  GCodeSkillInspection,
} from "./skills.js";
// Exposed for the CLI's headless slash routing: it must decide "is this a real
// custom command?" with the *same* reserved-name gate the app facade's
// customCommandPromptResolver applies, or the two disagree and a reserved name
// reaches the model as literal prompt text. See prompt-command.ts.
export { isReservedGCodeSlashCommandName } from "./slash-command-surface.js";
export {
  grantWorkspaceHookTrust,
  inspectWorkspaceHookTrust,
  revokeWorkspaceHookTrustCli,
} from "./workspace-hook-trust-cli.js";
export type {
  WorkspaceHookTrustCliItem,
  WorkspaceHookTrustCliStatus,
  WorkspaceHookTrustCliTarget,
} from "./workspace-hook-trust-cli.js";

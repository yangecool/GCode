import type { TuiReadClipboardImage, TuiWriteClipboardText } from "@gcode/tui";
import type { UiLocale } from "@gcode/i18n";
import type { Logger } from "@gcode/contracts";
import type {
  createManagedCdpBrowserRuntime,
  ManagedCdpBrowserRuntimeOptions,
} from "@gcode/adapters/browser";
import type {
  createModelAdapter,
  createGCodeApp,
  CreateModelAdapterOptions,
  configureCodingPlanApiKey,
  ConfigureCodingPlanApiKeyOptions,
  inspectGCodeSkill,
  inspectWorkspaceHookTrust,
  grantWorkspaceHookTrust,
  revokeWorkspaceHookTrustCli,
  inspectGCodeCustomCommand,
  InspectGCodeCustomCommandOptions,
  InspectGCodeSkillOptions,
  loginGCodeCli,
  loginBigmodelCodingPlan,
  LoginBigmodelCodingPlanOptions,
  LoginGCodeCliOptions,
  listGCodeCustomCommands,
  ListGCodeCustomCommandsOptions,
  loadGCodeCustomCommand,
  listGCodeSessions,
  listGCodeSkills,
  ListGCodeSessionsOptions,
  ListGCodeSkillsOptions,
  logoutGCodeCli,
  LogoutGCodeCliOptions,
  resolveLatestSession,
  ResolveLatestSessionOptions,
  RunGCodeProtocolAgentOptions,
  prepareGCodeTelemetryEnv,
  startProcessProviderRegistryRuntime,
  shutdownGCodeTelemetry,
  GCodeAppOptions,
} from "@gcode/bootstrap";
import type { CliEnv, DotenvLoadResult, LoadCliDotenvOptions } from "./env.js";
import type { PluginsCommandOverrides } from "./plugins-command.js";
import type { CliShutdownProcess } from "./shutdown.js";
import type { resolveWorkspaceGitBranch } from "./tui-workspace-git.js";

export type BootstrapModule = typeof import("@gcode/bootstrap");

export interface RunDependencies extends PluginsCommandOverrides {
  protocolLifecycle?: RunGCodeProtocolAgentOptions["lifecycle"];
  protocolInput?: NodeJS.ReadableStream;
  createManagedCdpBrowserRuntime?: (
    options?: ManagedCdpBrowserRuntimeOptions,
  ) => ReturnType<typeof createManagedCdpBrowserRuntime>;
  createModelAdapter?: (
    options?: CreateModelAdapterOptions,
  ) => ReturnType<typeof createModelAdapter>;
  createGCodeApp?: (
    options?: GCodeAppOptions,
  ) => Awaited<ReturnType<typeof createGCodeApp>> | ReturnType<typeof createGCodeApp>;
  /**
   * Session-event shaper for --output-format stream-json. Defaults to the
   * bootstrap module's, which is also what the protocol server uses; injectable
   * so a caller that supplies its own `createGCodeApp` (tests, embedders) can
   * still stream, since the bootstrap module is not loaded on that path.
   */
  mapSessionEvent?: BootstrapModule["mapSessionEvent"];
  cwd?: () => string;
  env?: CliEnv;
  inspectSkill?: (options: InspectGCodeSkillOptions) => ReturnType<typeof inspectGCodeSkill>;
  inspectWorkspaceHookTrust?: typeof inspectWorkspaceHookTrust;
  grantWorkspaceHookTrust?: typeof grantWorkspaceHookTrust;
  revokeWorkspaceHookTrustCli?: typeof revokeWorkspaceHookTrustCli;
  inspectCustomCommand?: (
    options: InspectGCodeCustomCommandOptions,
  ) => ReturnType<typeof inspectGCodeCustomCommand>;
  loginGCodeCli?: (options?: LoginGCodeCliOptions) => ReturnType<typeof loginGCodeCli>;
  loginBigmodelCodingPlan?: (
    options?: LoginBigmodelCodingPlanOptions,
  ) => ReturnType<typeof loginBigmodelCodingPlan>;
  configureCodingPlanApiKey?: (
    options: ConfigureCodingPlanApiKeyOptions,
  ) => ReturnType<typeof configureCodingPlanApiKey>;
  loadDotenv?: (options?: LoadCliDotenvOptions) => DotenvLoadResult;
  prepareGCodeTelemetryEnv?: typeof prepareGCodeTelemetryEnv;
  projectConfigPath?: string;
  listSessions?: (options: ListGCodeSessionsOptions) => ReturnType<typeof listGCodeSessions>;
  listCustomCommands?: (
    options: ListGCodeCustomCommandsOptions,
  ) => ReturnType<typeof listGCodeCustomCommands>;
  loadCustomCommand?: (
    options: InspectGCodeCustomCommandOptions,
  ) => ReturnType<typeof loadGCodeCustomCommand>;
  // headless slash 路由要和 app facade 的保留名 gate 用同一个判据；默认取 bootstrap 的，
  // 注入点只为让单测不必拉起整个 bootstrap 模块。见 prompt-command.ts。
  isReservedSlashCommandName?: BootstrapModule["isReservedGCodeSlashCommandName"];
  listSkills?: (options: ListGCodeSkillsOptions) => ReturnType<typeof listGCodeSkills>;
  logger?: Logger;
  readClipboardImage?: TuiReadClipboardImage;
  writeClipboardText?: TuiWriteClipboardText;
  resolveLatestSession?: (
    options: ResolveLatestSessionOptions,
  ) => ReturnType<typeof resolveLatestSession>;
  resolveWorkspaceGitBranch?: typeof resolveWorkspaceGitBranch;
  logoutGCodeCli?: (options?: LogoutGCodeCliOptions) => ReturnType<typeof logoutGCodeCli>;
  runGCodeProtocolAgent?: (options?: RunGCodeProtocolAgentOptions) => Promise<void>;
  runTui?: typeof import("@gcode/tui").runTui;
  skipUserConfig?: boolean;
  userConfigPath?: string;
  exitProcess?: (code: number) => void;
  shutdownCleanupTimeoutMs?: number;
  shutdownProcess?: CliShutdownProcess;
  startProcessProviderRegistryRuntime?: typeof startProcessProviderRegistryRuntime;
  shutdownGCodeTelemetry?: typeof shutdownGCodeTelemetry;
}

export type CliPermissionMode = "build" | "plan" | "edit" | "yolo";
export type CliRuntimeMode = CliPermissionMode | "auto";

export interface CliModeState {
  current?: CliRuntimeMode;
  override?: CliPermissionMode;
}

export interface CliTargetRequest {
  objective: string;
  replaceExisting: boolean;
}

export type ModeCapableApp = Awaited<ReturnType<typeof createGCodeApp>> & {
  getMode?: () => CliRuntimeMode;
  setLocale?: (locale: UiLocale) => Promise<{ locale: "en-US" | "zh-CN" }>;
  setMode?: (mode: CliRuntimeMode) => Promise<{ mode: CliRuntimeMode }>;
};

export interface CliResumeRequest {
  continueSession: boolean;
  resumeSessionId?: string;
}

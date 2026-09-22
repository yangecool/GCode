import {
  ProviderConfigService,
  type ProviderConfigLayerSnapshot,
  type ProviderConfigLayerUpdate,
} from "@gcode/provider";
import { NodeGCodeBuiltinProviderConfigSource } from "./gcode-builtin-provider-config-source.js";
import {
  EndpointScopedGCodeBuiltinSource,
  type EndpointScopedGCodeBuiltinSourceOptions,
} from "./endpoint-scoped-gcode-builtin-source.js";
import {
  GCodeBuiltinRemoteSynchronizer,
  type GCodeBuiltinRemoteSynchronizerOptions,
  type GCodeBuiltinRefreshResult,
} from "./gcode-builtin-remote-synchronizer.js";
import {
  NodePersonalProviderConfigRepository,
  type PersonalProviderConfigRecoveryEvent,
} from "./personal-provider-config-repository.js";

export interface NodeProviderConfigRuntimeOptions {
  readonly gcodeBuiltinFilePath: string;
  readonly gcodeBuiltinActiveFilePath?: string;
  readonly gcodeBuiltinRemote?: Omit<GCodeBuiltinRemoteSynchronizerOptions, "source">;
  readonly gcodeBuiltinEnvironment?: Omit<
    EndpointScopedGCodeBuiltinSourceOptions,
    "bundledFilePath"
  >;
  readonly onGCodeBuiltinRefreshError?: (error: unknown) => void;
  readonly onPersonalConfigRecovery?: (event: PersonalProviderConfigRecoveryEvent) => void;
  readonly onPersonalConfigPollingError?: (error: unknown) => void;
  readonly personalFilePath: string;
  readonly personalPollingIntervalMs?: number | false;
  readonly importLegacy?: (
    gcodeBuiltin: ProviderConfigLayerSnapshot,
  ) => Promise<ProviderConfigLayerUpdate | null>;
  readonly watch?: boolean;
}

/** 组装一个 Node.js 进程内共享的 GCode Built-in/Personal Config 运行边界。 */
export class NodeProviderConfigRuntime {
  readonly configService: ProviderConfigService;
  readonly #gcodeBuiltinSource:
    | NodeGCodeBuiltinProviderConfigSource
    | EndpointScopedGCodeBuiltinSource;
  readonly #personalRepository: NodePersonalProviderConfigRepository;
  readonly #remoteSynchronizer?: GCodeBuiltinRemoteSynchronizer;
  readonly #onRemoteRefreshError?: (error: unknown) => void;
  #startPromise: Promise<void> | null = null;
  #disposed = false;
  readonly #checkListeners = new Set<() => Promise<void>>();
  #checkTimer: ReturnType<typeof setInterval> | null = null;
  #checkInFlight: Promise<void> | null = null;

  constructor(options: NodeProviderConfigRuntimeOptions) {
    this.#gcodeBuiltinSource = options.gcodeBuiltinEnvironment
      ? new EndpointScopedGCodeBuiltinSource({
          bundledFilePath: options.gcodeBuiltinFilePath,
          ...options.gcodeBuiltinEnvironment,
        })
      : new NodeGCodeBuiltinProviderConfigSource({
          bundledFilePath: options.gcodeBuiltinFilePath,
          activeFilePath: options.gcodeBuiltinActiveFilePath,
          watch: options.watch,
        });
    this.#remoteSynchronizer =
      options.gcodeBuiltinRemote &&
      this.#gcodeBuiltinSource instanceof NodeGCodeBuiltinProviderConfigSource
        ? new GCodeBuiltinRemoteSynchronizer({
            source: this.#gcodeBuiltinSource,
            ...options.gcodeBuiltinRemote,
          })
        : undefined;
    this.#onRemoteRefreshError = options.onGCodeBuiltinRefreshError;
    this.#personalRepository = new NodePersonalProviderConfigRepository({
      filePath: options.personalFilePath,
      onRecovery: options.onPersonalConfigRecovery,
      onPollingError: options.onPersonalConfigPollingError,
      pollingIntervalMs: options.personalPollingIntervalMs,
      ...(options.importLegacy
        ? {
            importLegacy: async () => options.importLegacy!(await this.#gcodeBuiltinSource.read()),
          }
        : {}),
    });
    this.configService = new ProviderConfigService({
      gcodeBuiltinSource: this.#gcodeBuiltinSource,
      personalRepository: this.#personalRepository,
    });
  }

  resolveGCodeBuiltinActiveFilePath(): Promise<string> {
    return this.#gcodeBuiltinSource instanceof NodeGCodeBuiltinProviderConfigSource
      ? Promise.resolve(this.#gcodeBuiltinSource.activeFilePath)
      : this.#gcodeBuiltinSource.resolveActiveFilePath();
  }

  get personalRepository(): import("@gcode/provider").PersonalProviderConfigRepository {
    return this.#personalRepository;
  }

  /** Environment 同一周期检查中恢复未对齐依赖，不被下载 TTL 或失败挡住。 */
  onDidCheckGCodeBuiltin(listener: () => Promise<void>): () => void {
    this.#checkListeners.add(listener);
    return () => this.#checkListeners.delete(listener);
  }

  start(): Promise<void> {
    if (this.#disposed) throw new Error("NodeProviderConfigRuntime 已 dispose");
    if (this.#startPromise) return this.#startPromise;
    const startPromise = this.configService.read().then(() => {
      if (this.#disposed) return;
      void this.#checkBackground();
      // Managed Worker 无下载配置也无恢复 owner，不建立周期任务。
      if (
        this.#remoteSynchronizer ||
        this.#gcodeBuiltinSource instanceof EndpointScopedGCodeBuiltinSource ||
        this.#checkListeners.size > 0
      ) {
        this.#checkTimer = setInterval(() => {
          void this.#checkBackground();
        }, 60_000);
        this.#checkTimer.unref?.();
      }
    });
    this.#startPromise = startPromise;
    void startPromise.catch(() => {
      if (this.#startPromise === startPromise) this.#startPromise = null;
    });
    return startPromise;
  }

  refreshGCodeBuiltin(options?: { readonly force?: boolean }): Promise<GCodeBuiltinRefreshResult> {
    if (this.#disposed) return Promise.resolve("disposed");
    if (this.#gcodeBuiltinSource instanceof EndpointScopedGCodeBuiltinSource) {
      return this.#gcodeBuiltinSource.refresh(options);
    }
    return this.#remoteSynchronizer?.refresh(options) ?? Promise.resolve("skipped");
  }

  #checkBackground(): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    if (this.#checkInFlight) return this.#checkInFlight;
    const check = Promise.allSettled([
      this.refreshGCodeBuiltin(),
      ...[...this.#checkListeners].map((listener) => Promise.resolve().then(listener)),
    ])
      .then((results) => {
        if (this.#disposed) return;
        for (const result of results)
          if (result.status === "rejected") this.#onRemoteRefreshError?.(result.reason);
      })
      .finally(() => {
        if (this.#checkInFlight === check) this.#checkInFlight = null;
      });
    this.#checkInFlight = check;
    return check;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#checkTimer) clearInterval(this.#checkTimer);
    this.#checkTimer = null;
    this.#checkListeners.clear();
    this.#remoteSynchronizer?.dispose();
    this.configService.dispose();
    this.#personalRepository.dispose();
    this.#gcodeBuiltinSource.dispose();
  }
}

export function createNodeProviderConfigRuntime(
  options: NodeProviderConfigRuntimeOptions,
): NodeProviderConfigRuntime {
  return new NodeProviderConfigRuntime(options);
}

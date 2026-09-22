import { loadBootstrapModule } from "./bootstrap-loader.js";
import { loadCliDotenv } from "./env.js";
import type { RunDependencies } from "./cli-types.js";
import type {
  CommandCenterApiKeyOptions,
  CommandCenterBigmodelLoginOptions,
  CommandCenterGrokLoginOptions,
  CommandCenterLoginOptions,
} from "./command-center/types.js";

export async function loginForTui(
  deps: RunDependencies,
  options?: CommandCenterLoginOptions,
) {
  const env = deps.env ?? process.env;
  const workingDirectory = (deps.cwd ?? process.cwd)();
  const dotenvResult = (deps.loadDotenv ?? loadCliDotenv)({
    cwd: workingDirectory,
    env,
  });

  if (dotenvResult.error) {
    throw new Error(`Failed to load environment file: ${dotenvResult.path}`, {
      cause: dotenvResult.error,
    });
  }

  const login = deps.loginGCodeCli ?? (await loadBootstrapModule()).loginGCodeCli;
  return await login({
    abortSignal: options?.abortSignal,
    env,
    onAuthorizeUrl: options?.onAuthorizeUrl,
  });
}

export async function loginBigmodelForTui(
  deps: RunDependencies,
  options?: CommandCenterBigmodelLoginOptions,
) {
  const env = deps.env ?? process.env;
  const workingDirectory = (deps.cwd ?? process.cwd)();
  const dotenvResult = (deps.loadDotenv ?? loadCliDotenv)({
    cwd: workingDirectory,
    env,
  });

  if (dotenvResult.error) {
    throw new Error(`Failed to load environment file: ${dotenvResult.path}`, {
      cause: dotenvResult.error,
    });
  }

  const login =
    deps.loginBigmodelCodingPlan ?? (await loadBootstrapModule()).loginBigmodelCodingPlan;
  return await login({
    abortSignal: options?.abortSignal,
    env,
    onAuthorizeUrl: options?.onAuthorizeUrl,
  });
}

export async function configureApiKeyForTui(
  deps: RunDependencies,
  options: CommandCenterApiKeyOptions,
) {
  const configure =
    deps.configureCodingPlanApiKey ?? (await loadBootstrapModule()).configureCodingPlanApiKey;
  return await configure({
    apiKey: options.apiKey,
    env: deps.env ?? process.env,
    providerId: options.providerId,
  });
}

export async function logoutForTui(deps: RunDependencies) {
  const env = deps.env ?? process.env;
  const workingDirectory = (deps.cwd ?? process.cwd)();
  const dotenvResult = (deps.loadDotenv ?? loadCliDotenv)({
    cwd: workingDirectory,
    env,
  });

  if (dotenvResult.error) {
    throw new Error(`Failed to load environment file: ${dotenvResult.path}`, {
      cause: dotenvResult.error,
    });
  }

  const logout = deps.logoutGCodeCli ?? (await loadBootstrapModule()).logoutGCodeCli;
  return await logout({ env });
}

/** G Code：Grok 订阅设备流登录（浏览器跳转；bootstrap grok-login）。 */
export async function loginGrokForTui(
  _deps: RunDependencies,
  options?: CommandCenterGrokLoginOptions,
) {
  const { loginGrokCli } = await loadBootstrapModule();
  return await loginGrokCli({ abortSignal: options?.abortSignal });
}

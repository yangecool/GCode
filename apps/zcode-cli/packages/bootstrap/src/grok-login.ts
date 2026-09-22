/**
 * G Code — Grok 订阅登录（H3：desktop/TUI 的浏览器跳转登录）。
 *
 * 设备授权流：auth.x.ai 公共客户端（b1a00492-…，grok-build 同款）→ 系统
 * 浏览器打开 verification_uri_complete → 轮询至完成/过期。令牌落在
 * GCODE_HOME/auth.json（GrokAuthService 自管，含单飞刷新）；引擎侧
 * `GCODE_GROK_SUBSCRIPTION=1` 时由 resolveBearer 消费。
 */

import {
  GrokAuthService,
  loginViaBrowser,
  systemBrowserLauncher,
} from "@zcode/adapters/grok-auth";
import type { BrowserLauncher } from "@zcode/adapters/grok-auth";

export interface GrokLoginCliOptions {
  readonly env?: Record<string, string | undefined>;
  readonly abortSignal?: AbortSignal;
  /** 授权 URL 就绪时回调（TUI 侧把它写进 transcript 作为回退链接）。 */
  readonly onAuthorizeUrl?: (url: string) => Promise<void> | void;
  /** 测试注入口；缺省系统浏览器。 */
  readonly launch?: BrowserLauncher;
  readonly pollMs?: number;
  readonly timeoutMs?: number;
}

export interface GrokLoginCliResult {
  readonly status: "complete" | "error" | "expired";
  readonly verificationUrl: string;
  readonly userEmail?: string;
  readonly message: string;
}

/**
 * 运行一次 Grok 订阅设备流登录。
 * @param options - 环境/中止/回调与浏览器注入口。
 * @returns 终态（complete 携带账号 email；error/expired 携带原因）。
 */
export async function loginGrokCli(options: GrokLoginCliOptions = {}): Promise<GrokLoginCliResult> {
  const service = new GrokAuthService();
  const launch = options.launch ?? systemBrowserLauncher;
  const result = await loginViaBrowser(service, {
    launch,
    pollMs: options.pollMs,
    timeoutMs: options.timeoutMs,
  });
  const verificationUrl = result.verificationUriComplete ?? result.verificationUri;
  if (options.onAuthorizeUrl !== undefined && verificationUrl !== undefined) {
    await options.onAuthorizeUrl(verificationUrl);
  }
  if (result.status === "complete") {
    const email = result.auth?.email;
    return {
      status: "complete",
      verificationUrl: verificationUrl ?? "",
      userEmail: email,
      message: email === undefined
        ? "Grok subscription login complete."
        : `Grok subscription login complete (${email}).`,
    };
  }
  if (result.status === "expired") {
    return {
      status: "expired",
      verificationUrl: verificationUrl ?? "",
      message: "Grok subscription login expired before authorization finished. Run /login grok again.",
    };
  }
  return {
    status: "error",
    verificationUrl: verificationUrl ?? "",
    message: `Grok subscription login failed: ${result.error ?? "unknown error"}`,
  };
}

/** 退出订阅登录（清除 GCODE_HOME 下的设备流令牌）。 */
export async function logoutGrokCli(): Promise<void> {
  await new GrokAuthService().logout();
}

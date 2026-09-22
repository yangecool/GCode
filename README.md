# G Code

<div align="center">
  <img src="public/logo/icons/1024x1024.png" alt="G Code" width="128" height="128" />
</div>
<p align="center">
  <a href="https://github.com/yangecool/GCode/actions">CI</a> ·
  <a href="https://github.com/yangecool/GCode/releases">Releases</a>
</p>
<p align="center">
  简体中文 | <a href="README.en.md">English</a>
</p>

G Code 是 **Grok 原生的单引擎编码 Agent harness**：运行时骨架继承自 ZCode（Agent 循环、权限模式、TUI / Web / 桌面壳），引擎语义逐面对齐 grok-build 原版（Rust）——原生 Responses SSE 与无损回放、原版系统提示与子代理方言、压缩与续写策略、订阅 OAuth。除 Grok 外不内置任何模型提供商。

## 安装

从 [GitHub Releases](https://github.com/yangecool/GCode/releases) 下载（`main` 分支每次推送发布滚动 `nightly` 预发布，`v*` tag 发布正式版；均附 SHA256SUMS）。

**GCode CLI**

```bash
# linux-x64 单文件可执行（内嵌 Node 24 SEA，无运行时依赖）；nightly 为滚动预发布 tag
curl -LO https://github.com/yangecool/GCode/releases/download/nightly/GCode-CLI-linux-x64
chmod +x GCode-CLI-linux-x64
./GCode-CLI-linux-x64
```

Windows 下载 `GCode-CLI-win-x64.exe` 直接运行；或用便携 bundle（需本机 Node ≥ 24）：`node GCode-CLI-linux-x64.cjs`。

**GCode Desktop**：linux-x64 提供 AppImage / deb / rpm / pacman 安装包，win-x64 提供 NSIS 安装器（`GCode-<version>-win-x64.exe`）。AppImage 直接 `chmod +x` 运行；deb 用 `sudo apt install ./GCode-*.deb`；Windows 双击安装器按向导完成安装。

## 快速开始

两种认证方式任选其一：

```bash
# 方式一：API key（console.x.ai）
export XAI_API_KEY=xai-...

# 方式二：Grok 订阅账号（设备流 OAuth；GCODE_GROK_SUBSCRIPTION=1 开启）
export GCODE_GROK_SUBSCRIPTION=1
```

启动 CLI 后在会话内执行 `/login grok` 完成订阅登录，然后直接对话；无参数进入 TUI，第一个参数为 `--web` 时启动浏览器工作台。

```bash
./GCode-CLI-linux-x64            # TUI
./GCode-CLI-linux-x64 --web      # Web 界面（默认 127.0.0.1 + 自动开浏览器）
```

## 引擎能力

| 面 | 说明 |
| --- | --- |
| 原生 Responses 通道 | 绕过 AI SDK 提示词往返，直连 `api.x.ai/v1`；SSE 流式解析与无损会话回放 |
| 原版提示方言 | grok-build 原版主/子代理系统提示、工作政策与 memory 段落，按原版模板分支装配 |
| 压缩（compaction） | 原版 9 段总结提示 + 全量替换续写；阈值按目录 `autoCompactThresholdPercent`（grok 默认 80%，基于全窗口） |
| 输出续写（length salvage） | 原版 LENGTH_CONTINUE_REMINDER 文案，预算 2 次续写 |
| 会话缓存 | 每会话 `prompt_cache_key`（主代理与子代理共享槽位） |
| 订阅认证 | 设备流 OAuth（auth.x.ai）+ grok-build 客户端身份头，经 cli-chat-proxy 通道 |
| Hosted 工具 | `GCODE_GROK_HOSTED_TOOLS`（JSON）按部署声明注入 |
| 工具方言 | hashline 编辑协议（ChunkFingerprint anchor）、memory 工具族（search/get）按 grok 目录门控 |
| 韧性 | doom-loop 检测、原版重试预算、流式错误定级为 ZCode 协议错误 |

ZCode 侧机制（四种权限模式、plan mode、folder trust、后台任务、compact 机制、输出续写、Edit/Write 工具）保持原样，由用户仲裁；G Code 只替换引擎方言内容。

## 开发

准备 Git、Node.js **24.14.0** 和 pnpm **10.33.2**（以 [mise.toml](mise.toml) 为准），在仓库根目录：

```bash
pnpm bootstrap          # 安装依赖 + 准备桌面资源 + 串行构建
pnpm dev:desktop        # 桌面应用（Electron）
pnpm --filter @zcode/cli dev   # CLI 源码入口（gcode/zcode）
pnpm build:zcode        # CLI 发行包（tar.gz，需 Node 运行时）
pnpm bundle:desktop -- --os linux --arch x64   # 桌面安装包
```

测试（grok 套件）：

```bash
pnpm -r build
cd apps/zcode-cli && pnpm --filter @zcode/adapters test -- --run
```

CI（[.github/workflows/ci.yml](.github/workflows/ci.yml)）：`main` 每次推送跑 test → build CLI SEA（含 `--version` 冒烟）→ 桌面四格式打包 → 发布 nightly Release；打 `v*` tag 发布正式版。

## 仓库结构

| 目录 | 职责 |
| --- | --- |
| `apps/zcode-cli/packages/core` | Agent 运行时（turn 循环、compact、续写、引擎方言注入点） |
| `apps/zcode-cli/packages/adapters/src/grok` | Grok 引擎移植层（wire、sampler、persona、compaction、hosted tools） |
| `apps/zcode-cli/packages/{cli,bootstrap,provider}` | TUI、组装引导、Provider 注册 |
| `packages/desktop`、`packages/web`、`packages/server` | Electron 桌面、Web 客户端、HTTP/WS 服务 |
| `config/provider` | 内置 Provider / 模型目录（含 grok 规则与压缩阈值） |
| `scripts`、`third-party` | 构建脚本、第三方声明材料 |

## 文档

- [GROK_MIGRATION.md](GROK_MIGRATION.md) — 迁移施工图：范围基准、三源仲裁顺序、验收依据
- [G_CODE_HYPOTHESES.md](G_CODE_HYPOTHESES.md) — 单引擎战略假设集与验证账本（H1–H13）
- [DESIGN.md](DESIGN.md)、[CONTEXT.md](CONTEXT.md) — 架构设计与上下文
- [NOTICE.md](NOTICE.md)、[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) — 项目声明与第三方版权（grok-build 为 Apache-2.0, Copyright SpaceXAI）

## 项目声明

本仓库是 ZCode 的衍生项目（Grok 单引擎化改造）。功能范围、维护规则、执行与数据风险，以及许可和第三方版权说明，详见 [NOTICE.md](NOTICE.md)。

# G Code

<div align="center">
  <img src="public/logo/icons/1024x1024.png" alt="G Code" width="128" height="128" />
</div>
<p align="center">
  <a href="https://github.com/yangecool/GCode/actions">CI</a> ·
  <a href="https://github.com/yangecool/GCode/releases">Releases</a>
</p>
<p align="center">
  <a href="README.md">简体中文</a> | English
</p>

G Code is a **Grok-native, single-engine coding agent harness**: the runtime skeleton is inherited from ZCode (agent loop, permission modes, TUI / web / desktop shells), while the engine semantics are aligned face-by-face with the original grok-build (Rust) — native Responses SSE with lossless replay, the original system prompts and subagent dialects, compaction and continuation policies, and subscription OAuth. No other model provider is bundled.

## Install

Download from [GitHub Releases](https://github.com/yangecool/GCode/releases) — every push to `main` publishes a rolling `nightly` prerelease, `v*` tags publish stable releases; both include SHA256SUMS.

**GCode CLI**

```bash
# linux-x64 single-file executable (embedded Node 24 SEA, no runtime dependency); nightly is the rolling prerelease tag
curl -LO https://github.com/yangecool/GCode/releases/download/nightly/GCode-CLI-linux-x64
chmod +x GCode-CLI-linux-x64
./GCode-CLI-linux-x64
```

On Windows, download `GCode-CLI-win-x64.exe` and run it directly; or use the portable bundle (requires local Node ≥ 24): `node GCode-CLI-linux-x64.cjs`.

**GCode Desktop**: linux-x64 ships AppImage / deb / rpm / pacman installers, win-x64 ships an NSIS installer (`GCode-<version>-win-x64.exe`). The AppImage runs after `chmod +x`; install the deb with `sudo apt install ./GCode-*.deb`; on Windows, run the installer and follow the wizard.

## Quick start

Pick one of the two authentication modes:

```bash
# Option 1: API key (console.x.ai)
export XAI_API_KEY=xai-...

# Option 2: Grok subscription account (device-flow OAuth; enabled by GCODE_GROK_SUBSCRIPTION=1)
export GCODE_GROK_SUBSCRIPTION=1
```

After starting the CLI, run `/login grok` in the session to complete subscription login, then just talk to it. No arguments opens the TUI; `--web` as the first argument starts the browser workbench.

```bash
./GCode-CLI-linux-x64            # TUI
./GCode-CLI-linux-x64 --web      # Web UI (127.0.0.1 by default, opens the browser)
```

## Engine capabilities

| Face | Description |
| --- | --- |
| Native Responses channel | Bypasses the AI SDK prompt round-trip and talks to `api.x.ai/v1` directly; SSE streaming parse with lossless session replay |
| Original prompt dialect | grok-build's original main/subagent system prompts, work policy, and memory sections, assembled per the original template branches |
| Compaction | Original 9-section summary prompt + full-replace continuation; threshold from the catalog `autoCompactThresholdPercent` (grok default 80%, of the full window) |
| Length salvage | Original LENGTH_CONTINUE_REMINDER wording, budget of 2 continuations |
| Session caching | Per-session `prompt_cache_key` (main agent and subagents share one slot) |
| Subscription auth | Device-flow OAuth (auth.x.ai) + grok-build client identity headers, over the cli-chat-proxy channel |
| Hosted tools | Injected per deployment via `GCODE_GROK_HOSTED_TOOLS` (JSON) |
| Tool dialects | hashline edit protocol (ChunkFingerprint anchors), memory tool family (search/get), gated by the grok catalog |
| Resilience | Doom-loop detection, original retry budgets, streaming errors classified into ZCode protocol errors |

The ZCode-side machinery (four permission modes, plan mode, folder trust, background tasks, the compact machinery, output continuation, Edit/Write tools) is kept intact and user-arbitrated; G Code only swaps the engine dialect content.

## Development

You need Git, Node.js **24.14.0**, and pnpm **10.33.2** (see [mise.toml](mise.toml)). From the repo root:

```bash
pnpm bootstrap                 # install deps + prepare desktop assets + build in order
pnpm dev:desktop               # desktop app (Electron)
pnpm --filter @zcode/cli dev   # CLI from source (gcode/zcode)
pnpm build:zcode               # CLI release bundle (tar.gz, needs Node)
pnpm bundle:desktop -- --os linux --arch x64   # desktop installers
```

Tests (grok suites):

```bash
pnpm -r build
cd apps/zcode-cli && pnpm --filter @zcode/adapters test -- --run
```

CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)): every push to `main` runs test → build the CLI SEA (with a `--version` smoke test) → bundle the desktop in four formats → publish the nightly Release; pushing a `v*` tag publishes a stable release.

## Repository layout

| Directory | Responsibility |
| --- | --- |
| `apps/zcode-cli/packages/core` | Agent runtime (turn loop, compaction, continuation, engine-dialect injection point) |
| `apps/zcode-cli/packages/adapters/src/grok` | Grok engine port (wire, sampler, persona, compaction, hosted tools) |
| `apps/zcode-cli/packages/{cli,bootstrap,provider}` | TUI, bootstrap wiring, provider registry |
| `packages/desktop`, `packages/web`, `packages/server` | Electron desktop, web client, HTTP/WS server |
| `config/provider` | Built-in provider/model catalog (grok rules and compaction thresholds) |
| `scripts`, `third-party` | Build scripts, third-party notice materials |

## Docs

- [GROK_MIGRATION.md](GROK_MIGRATION.md) — migration blueprint: scope baseline, three-source arbitration order, acceptance basis
- [G_CODE_HYPOTHESES.md](G_CODE_HYPOTHESES.md) — single-engine strategy hypotheses and verification ledger (H1–H13)
- [DESIGN.md](DESIGN.md), [CONTEXT.md](CONTEXT.md) — architecture design and context
- [NOTICE.md](NOTICE.md), [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) — project notice and third-party copyrights (grok-build is Apache-2.0, Copyright SpaceXAI)

## Notice

This repository is a derivative of ZCode (rebuilt as a Grok single-engine harness). Scope of features, maintenance rules, execution and data risks, and licensing and third-party copyright notes are in [NOTICE.md](NOTICE.md).

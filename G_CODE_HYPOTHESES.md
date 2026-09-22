# G Code 战略假设集（大胆假设）

> **指令记录（2026-09-21）**："我们没有什么接入的概念，这个项目后面会直接改名为 G Code，并为 Grok 4.7 做好准备。所以大胆地提出假设。"
>
> 本文档是假设账本，与施工图 [GROK_MIGRATION.md](GROK_MIGRATION.md) 配套：本文定方向，施工图定落点。每条假设给出**依据、判据（怎样算成立）、反例（怎样算被推翻）、落地动作**。假设验证或推翻后回写本文，并同步修订施工图对应章节。大胆的意义在于**提前建好接缝**，不是赌死方向——所以每条都带反例条件。

## 0. 总纲：从"接入 Grok"到"成为 G Code"

一句话：**G Code 不是"支持 Grok 的 ZCode"，而是"以 ZCode 机体孵化的 Grok 原生 harness"**。三条立即推论：

1. **Grok 不是 provider 之一，是唯一引擎。** 多 provider 产品面（模板市场、provider 设置 UI、三协议分支、20 个模板）从产品面降级为内部实现细节，分阶段收敛。
2. **迁移对象从"外挂层"变成"本体"。** grok 的 wire 契约、工具目录、行为语义（重试/doom-loop/压缩/plan）就是 G Code 的产品语义，不是兼容模式。
3. **"为 4.7 做准备" = 给未知版本预建接缝**，不是预测并写死 4.7 的行为。手段：版本化 wire 词汇表、开放枚举、catalog 驱动参数、模型自动发现。

## A. 产品与定位

### H1 单引擎假设
G Code 永远只有 xAI 一个模型引擎，产品面上不存在"换模型厂商"这个动作。
- 依据：指令原文"没有接入的概念"；grok-harness 全部行为以 grok-build 为唯一蓝本。
- 判据：主循环、子代理、权限旁路问询、压缩摘要等**所有**模型调用都路由到 grok 序列化层，产品面不暴露第二协议选项。
- 反例：出现必须旁路的需求（如本地小模型做权限分类降本）→ 收缩为"内部允许第二引擎，产品面永不暴露"。
- 动作：M6 收敛 provider 设置 UI 为 Grok 单面；三协议分支按 knip/architecture 检查清理；测试基建保留一个本地 fake provider（不进产品面）。

### H2 改名即重定位
改名不是换字，是产品承诺：**bin `gcode`，主张"Grok 原生 + 缓存/账单透明"**。
- 分层改名清单（生态兼容优先）：

| 层 | 动作 | 说明 |
| --- | --- | --- |
| 产品名 / 文档 / 发布物料 | 立即改 G Code | M1 起步 |
| bin 名 | `zcode` → `gcode`，双名过渡一个版本 | 安装脚本同步 |
| env 前缀 | 新增 `GCODE_*`，`ZCODE_*` 别名保留一个版本 | 之后清理 |
| 数据目录 | 规划 `~/.gcode`，迁移策略同上 | 会话数据不丢 |
| 协议 id / 插件市场 id | **后行，最后决定** | 插件生态与 Desktop/Web 兼容优先 |
| npm scope（`@zcode/*`） | 后行 | 内部细节，用户无感 |

- 品牌主张直接把 cache-monitor（缓存命中/成本观测）从 P2 升为一等 UI：单引擎产品最大的可讲故事就是"你的 token 花在哪、缓存省了多少"。
- 反例：xAI 商标/服务条款对"G Code/Grok"关联命名有约束 → 命名回退，主张不变（见 R2）。
- 动作：M1 改名起步；品牌视觉 M6。

### H3 订阅受众假设
G Code 的主用户是 **Grok 订阅者**（supergrok / cli-chat-proxy 人群），不是 API-key 开发者。
- 依据：grok-build 本体默认订阅态；grok-harness 已完整实现 auth.x.ai device-flow。
- 判据：订阅 OAuth 与 api-key 从 M2 起并行可用，且 OAuth 是设置页的第一顺位入口。
- 反例：早期用户以 API-key 为主（订阅不可用/区域限制）→ OAuth 顺位后移，但实现不砍。
- 动作：OAuth 从原计划 P1 提前到 M2。

### H4 差异化假设
G Code 对官方 grok-build 的差异化 = **开放可编程 + 多端 + 会话资产**：沿用 ZCode 的插件/skills/workflow/市场生态（这些与单引擎正交，全保留），Desktop/Web/TUI 三端一致，durable session 可恢复可导出。官方 CLI 是单机 TUI，这是 G Code 的生存空间。
- 判据：插件生态在改名后无破坏性迁移；三端对同一会话协议行为一致。
- 反例：xAI 官方发布等价多端开放 harness → 差异化收窄为"社区/可控/自托管"，生态仍是护城河。
- 动作：协议 id 与市场 id 的改名决策延后到 M6/M7（H2 表格），先保生态。

## B. 架构（最大胆的部分）

### H5 原生 wire 假设
**会话与请求的规范表示直接采用 xAI Responses item 形态**（reasoning item、function_call、hosted tool call、加密 reasoning 原样保存），不是"通用消息 + 边界翻译"。grok/model 移植后不是 adapter，是**核心序列化层**；AI-SDK 中间层从 grok 主路径退役。
- 依据：grok-harness 刻意绕开通用 SDK 保 wire 保真；缓存/账单 P0 约束（施工图 §5）在"无翻译层"结构下最易满足。
- 判据（M0 fixture 裁决）：双表示（通用消息+翻译）与单表示（Responses item 为规范态）在 item round-trip 保真、毒 attempt 丢弃、代码复杂度三项上对比，单表示占优或不劣。
- 反例：ZCode 特有事件（审批、权限、计划、工作流）无法干净地映射进 item 时间线 → 退为**双表示**：模型层 items 是规范重放态，展示层事件由其派生 + 少量 sidecar。
- 动作：新增 `grok-responses` api 类型走移植的 serialize/stream/replay/proxy（施工图 §4.1 主路线）；AI-SDK 通道保留给过渡与测试。

### H6 工具名单名假设
**模型可见工具名/schema = grok catalog 的 wire names，永久生效**。没有 dual-naming、没有投影开关；ZCode 原生工具名（Read/Edit/Bash…）退到内部与 UI。`hideGenericTools` 式共存只是过渡态。
- 判据：M3 后模型请求、会话日志、UI 显示三者工具名一致且只有一套。
- 反例：某 grok wire 工具与 ZCode 执行器语义差距过大 → 按 grok schema **重写执行器**，而不是换名投影。名字让位于语义，语义不让位于名字。
- 动作：toolset（standard/concise/hashline）成为 G Code 设置项，切换 = 显式 cache break。

### H7 版本化词汇表假设
wire 词汇（item 类型、SSE 事件、字段名）抽成**版本化注册表**（`grok-wire/vN`），未知项策略可配置：语义未知 → fail-loud；"仅新增且无语义影响" → 透传 + 诊断事件。这是 4.7 就绪的第一手段：新版本上线 = 注册表加条目，不是改代码。
- 依据：grok-build 的 `UNSUPPORTED_RESPONSE_ITEM` fail-loud 纪律对已发布协议正确，对未来版本过于僵硬；4.7 必然加东西。
- 判据：向 fixture 注入一个未知 item 类型，默认策略下会话不崩、诊断可见、可选严格模式仍 fail-loud。
- 动作：M0 建注册表骨架，M3 随 catalog 落地。

### H8 枚举开放化假设
`reasoningEffort`/`reasoningSummary` 等从闭枚举改为 **catalog 驱动的开放字符串 + advisory 校验**。4.7 新增"思考档位"零代码上线。
- 判据：catalog 里加一个新 effort 值，请求路径不改动即可携带；未知值有诊断不拦截。
- 动作：随 M1 模型目录落地。

## C. Grok 4.7 外推（诚实声明：无内部信息）

以下基于 4.x 轨迹与 **grok-build 原版源码**（本地 `../grok-harness/grok-build/`，HEAD `a28ee2b2` = catalog v5 pin，1.0.35）外推。原版的机制级证据：模型目录数据驱动（`xai-grok-models/default_models.json` + `/v1/models` 远端覆盖 + `ModelsManager`——原版自己就把"新模型上线"做成数据变更）；app-builder 未发布工具桩（feature 关闭时 stub）；服务端可调拨码（`compaction_at_tokens` 提示、`x-grok-doom-loop-check` 头）；行为版本目录（`versions.rs` + `legacy-0.4.10` 预设）作为 1.x 行为演进通道。注意：原版目录只有 `grok-4.6`/`grok-4.5`，**没有** `grok-build` 型号 id——ZCode 内置目录里的 `grok-build-0.1` 是外部信号（见 H9 修正）。**每条只决定"建什么接缝"，不决定"写死什么行为"。**

### H9 build 调优产品线延续
4.7 大概率伴随面向 coding 的调优供给。修正：原版目录**无** build 型号 id——"grok-build"是产品线/referrer/测试 fixture 名，不是型号名；ZCode 目录的 `grok-build-0.1` 是外部信号（可能预示 xAI 后续放出 build 调优型号，待 `/models` 证实）。→ 默认模型策略支持 **coding 调优优先**（catalog 标记驱动，不硬编码型号名）；`/models` 发现为主、内置目录为兜底（原版 `ModelsManager` 机制照搬）；4.7 上线 = catalog 刷新，不是发版。

### H10 上下文继续增长
500k → ≥1M 或动态。→ compaction 阈值、缓存前缀预算、microcompact 触发点**全部从 catalog 读取并运行时可调**，禁止写死 500k。**原版直接机制先例**：`auto_compact_threshold_percent` 已是每模型字段（默认 85，grok-4.6=80），grok-harness 把它写死成 0.85 正是应消灭的转译漂移。

### H11 hosted tools 扩容
`web_search`/`x_search` 之后会有更多 provider 侧工具。→ hosted-tools owner 从封闭集改**开放注册**；未 owner 剔除、同名本地工具丢弃的规则保留。**原版证据**：树内已有未发布的 app-builder 工具桩（`deploy_app`/`init_or_update_app`，feature 关闭时 stub），且 Responses 输出项词汇已含 `CodeInterpreterCall`/`McpCall`——工具面持续扩容是既定方向。

### H12 服务端状态选项
4.7 可能提供 server-side 会话状态/agentic 执行。→ 默认**保持 stateless full-history replay**（缓存与账单安全），session store 预留 `server_state` 模式开关，启用前必须过施工图 §7 的账单验收。**方向证据**：原版 wire 已带 `compaction_at_tokens`/`compactions_remaining` 服务端提示字段——服务端参与状态管理的拨码已在铺设。

### H13 缓存与计费强化
cache key 粒度、TTL、usage 报告只会更细。→ `prompt_cache_key`/会话身份/usage 观测做成**一等指标**，cache-monitor UI 一等公民（与 H2 品牌主张互锁）。

## D. 对冲

- **R1 假设打脸**：每条带反例条件；M0/M1/M2 各验证一批；4.7 公告后全量回写（M8 门）。
- **R2 命名与商标**：Grok/xAI 商标与再分发约束在品牌落地（M6）前需用户确认；约束生效则改名回退、主张不变。
- **R3 测试基建**：收敛多 provider 可能伤及依赖多协议的测试 → 内部 fake provider 永久保留，不进产品面。

## E. 验证时间表

| 假设 | 验证点 |
| --- | --- |
| H5 原生 wire | M0 fixture（双表示 vs 单表示裁决） |
| H8 枚举开放 | M1 模型目录 |
| H3 订阅受众 | M2 OAuth 并行 |
| H6 工具单名 / H7 词汇表 | M3 catalog 落地 |
| H1 单引擎收敛 / H2 品牌 | M6 |
| H9–H13 | 4.7 公告或发布时 + M8 就绪门逐条标记 已验证/修正/放弃 |

## F. 4.7 发布回写（2026-09-22，M8 门部分通过）

- **H8 已验证**：`grok-4.7` 目录规则零引擎改动上线（revision 32；efforts low/medium/high/xhigh 默认 high，contextWindow 500k，图像输入——docs.x.ai 模型页核实）。
- **H10 修正**：4.7 上下文仍为 500k，未增长；「阈值从 catalog 读取」的接缝主张不变（原版每模型字段 `auto_compact_threshold_percent`，全局默认 85、模型覆盖 80——GCode 目录 schema 尚无该字段，记录为接线债务）。
- **H11 未触发**：hosted 工具面无扩容；`max` 档位在 Rust 词汇表（`low..max` 七值）存在但 4.7 API 未开放——目录不含 `max`，若后续开放经 H8 接缝加值即可。
- **新增事实**：4.7 在 Responses API 上**始终返回 `reasoning.encrypted_content`（即使 include 未列出）**——引擎已无条件携带该 include 且回放容忍，无需改动。
- **引擎零跟随确认**：grok-build `a28ee2b2 → 4247f661`，`xai-grok-sampler`/`xai-grok-sampling-types`/`xai-grok-models` 三 crate 零改动；客户端版本 1.0.35 → 1.0.38 已跟进。

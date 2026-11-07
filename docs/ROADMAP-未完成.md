# 未完成清单（Roadmap）

> 基线：审计时 `dsh-memory` **v1.5.4**（295/295 测试通过）；本文件创建后 P1-4 已落地为 **v1.5.5**（303/303 测试通过）。
> 来源：工作区代码审计 + 两份交接文档（`确认海马体插件进度.md`、`1M上下文成本权衡.md`）+ 2026-11-03 的《5 项硬核确认》与《Dream LLM 语义提炼》指令。
> 纪律：每项都给出「动机 / 现状证据（文件:行）/ 验收标准」。标 ✅ 的为本次核对确认已落地，仅作为对照，不再重复实现。

## 状态图例

| 标记 | 含义 |
| --- | --- |
| ✅ | 已完成，有测试锁定 |
| 🟡 | 半成品：有代码但有明确缺口 |
| ❌ | 未做：代码 0 命中或整块功能不存在 |

---

## 一、已落地（对照基线，不展开）

v1.0.0 → v1.5.4：append-only 事件日志 / tombstone 防复活 / A-B 双缓冲索引 / L1·L1.5·L2·L3 金字塔 /
L2.5 趋势隔离 / 幽灵节点 / 上下文分页 / cron+dream 单一闸门 / 多空间物理隔离 / 跨空间 copy-move 两阶段删除 /
`requireExplicitConsentForTransfer` 显式授权 / UI 三件套（`SpaceSelector`、`StorageMigratorUI`、
`CrossSpaceTransferUI`）/ 空间创建 404 修复与路由漂移锁 / `minInjectConfidence` 死代码移除 /
`tools.disabled` 工具税裁剪 / 基准协议 `bench-protocol.mjs` / 交接状态机加固 / 多空间懒启动。

---

## 二、未完成

### P0 — 稳定性与峰值资源（“稳态轻、偶发重”的爆点）

#### P0-1 ✅ raw 按行游标扫描（分行索引）—— v1.5.6 已落地

- **状态**：✅ 已实现 —— `src/rawStore.js` 新增 `readLinesReverse()`（64KB 反向分块、逐行产出、`onBuffer` 可观测）、`readLinesForward()`、`readLinesForwardSync()`；`scan` / `restoreByHash` / `_loadTombstones` / `_hashesFor` 全部流式化（`RawStore.capture()` 因此改为 async，公开 `captureRaw()` 契约不变）；`hit.line` 通过“仅命中分片才做的 O(chunk) 行数统计”保持绝对行号；新增引擎结果硬上限 `MAX_SCAN_RESULTS = 500` 与 `scanned.peakBufferBytes`。
- **测试**：`test/v156.rawscan.test.js`（5 个用例，含 5000 行分片绝对行号、预算截断、结果上限、2 万行反向读取峰值缓冲 ≤ chunk+一行、流式 hash 恢复）。
- **保留的要求（留档）**：
  1. 逐行读取，每行独立 `JSON.parse`，命中入结果、未命中即释放 ✅；
  2. 峰值内存只与结果集/chunk 相关，不随文件总大小线性增长 ✅（`peakBufferBytes` 测试锁定）；
  3. `hit.line` 仍为正整数且与真实行号一致 ✅；
  4. 单次检索结果条数硬上限（引擎侧）✅。

#### P0-2 ✅ Event Loop 延迟监控 —— v1.5.6 已落地

- **状态**：✅ `src/eventLoop.js`（`createLagMonitor`，包 `perf_hooks.monitorEventLoopDelay`）；`maintain()` 各阶段之间 + `IndexManager.rebuild` 的 read/build/catch-up/swap 之间 `yieldIfLagging()`（`max ≥ 100ms` → `await` 50ms，累计 `yields`）；报告带 `eventLoop: {maxMs, p99Ms, meanMs, yields, thresholdMs}`。
- **诚实边界**：同步的 `buildIndex` 不能被 JS 抢占，所以让渡粒度是"阶段/异步循环之间"；监控数据用于暴露过大的阶段。测试：`test/v156.hardening.test.js` 的 lag monitor 用例 + `maintain()` 报告字段。

#### P0-3 ✅ recall 单次 payload token 上限 —— v1.5.6 已落地

- **状态**：✅ `context.maxInjectTokens`（默认 4000，256–100 000，fail-fast，HTTP 可编辑，设置页带 Tooltip）；`Memory.applyPayloadBudget()` 按排序保留 hits/semantic/tempSemantic，第一项总保留；截断返回 `truncated:true` + `payload:{maxTokens,estimatedTokens,dropped}` + `payload-budget` note。
- **验收**：`test/v156.hardening.test.js` 覆盖 300 token 预算下 6 条长命中被截断、预算内不截断、配置越界 fail-fast。

#### P0-4 ✅ `Memory.close()` 彻底释放 —— v1.5.6 已落地

- **状态**：✅ `RawStore.close()` 清 flush timer、同步落盘 pending 队列、清缓存；`Memory.close()` 先关 raw 再关 log、detach scheduler、清 oversized hints、`IndexManager.release()` 释放 A/B 视图；幂等。
- **验收**：`test/v156.hardening.test.js` 断言 timer 清空、两轮 close 幂等、落盘内容完整、索引视图释放。

---

### P1 — 记忆闭环（“标签关联率低 / 主动召回 0 次”的根因链）

#### P1-1 ✅ 入库即打标（Pre-Ingest Tagging）—— v1.5.6 已落地

- **状态**：✅ `src/tagging.js`（`extractTags()` 确定性规则：错误类型 / errno / 代码块语言 / HTTP 状态 / 文件路径 / 任务语句）+ `Memory.stage()` 写入闸门。模型手传 tags 优先、启发式不运行；raw 保持四字段；推断结果写 `meta.auto_tagged/auto_tags`；未提取到记 `MEM_E_AUTO_TAG_MISS`（Host 日志 + `panel.autoTag.misses`），写入不阻断；`tagging.autoTag` / `tagging.maxTags` fail-fast、HTTP 可编辑、设置页可调。
- **验收**：`test/v156.tagging.test.js`（7 个用例）覆盖提示词要求的全部断言。

#### P1-2 ✅ L2 Pinned 机制与置顶召回 —— v1.5.6 已落地

- **状态**：✅ `remember({pinned:true})` → `meta.pinned`（参与 `content_hash`）；缺 tags 抛 `MEM_E_PINNED_TAG_REQUIRED` 且零写入；`projectEpisode` 暴露 `pinned`，`deriveTagTable` 取 `decay=1`、标签不归档、截断优先保留；`deriveActiveSet` 无条件纳入；检索 pinned 命中 `decay=1`、豁免 `minScore`、置顶（`pinned-first:N`）；`panel.global.pinned` 可观测；工具 `memory_remember.pinned` 已暴露。
- **验收**：`test/v156.pinned.test.js`（3 个用例）覆盖提示词要求。

#### P1-3 ✅ 极简线索注入（相关性优先）—— v1.5.6 已落地

- **状态**：✅ `src/utils/memoryHints.js`（`selectRelevantTags` / `renderMemoryHints`）；`promptState` 移除全局 `[Memory Map]`，只渲染与当前用户输入词法重叠的最多 5 个标签，内部标签（`status:* / month:* / context:* / active_task`）永不注入，无匹配则整段缺席；`[Memory Hints]` 位于 `[Memory Blocks]` 之后（易变尾巴，不破坏前缀缓存）；输入来源为 `session/event` 跟踪的 `runtime.lastUserText`（PromptContext 不含消息文本）。
- **验收**：`test/v156.hints.test.js`（4 个用例）+ `plugin.test` 提示契约更新（输入 React 时不含 java 标签、无匹配无该段、召回前后前缀不变）。

#### P1-4 ✅ Dream 的 LLM 语义提炼与降级保底（已在 v1.5.5 落地）

- **状态**：✅ 已于 v1.5.5 实现 —— `src/dream.js`（`DreamEngine`）+ `Memory.executeDream()`；维护闸门 `dream` 分支调用；测试 `test/v155.dream.test.js`（7 个用例）。下列要求作为实现留档与验收依据。

- **动机**：纯本地字符串拼接只是物理压缩，不是经验蒸馏；但 LLM 故障绝不能拖死 Dream 或丢数据。
- **现状证据**：`executeDream` grep 0；当前 Dream = 空闲触发的本地 `maintain()`（`index.js:378-381`）。
- **红线（宪章第 1 条）**：不得引入任何第三方 LLM SDK（`openai` 等）；只用 Node 内置原生 `fetch`；Endpoint / Model / API Key 全部来自插件配置 `dream.llm.*` 或 `DSH_DREAM_LLM_*` 环境变量，插件本体不存任何硬编码凭证，也不把 key 写进日志 / HTTP 响应 / UI。
- **任务一：零依赖接入 + 结构化输出**
  - `executeDream()` 中把同一标签下多条 L2 记录（错误堆栈、上下文）拼成 prompt，要求严格 JSON：`{"summary": string, "confidence": number}`（`response_format: json_object`）；
  - `summary` 字数硬上限（默认 200 字符），超限、缺字段、非 JSON 一律视为 LLM 失败；
  - 调用只允许出现在 `executeDream()` 内，任何在线 `recall`/`remember` 路径不得触发网络。
- **任务二：离线异步与串行背压**
  - Dream 单飞：并发 `executeDream()` 直接拒绝（`dream-in-flight`），不排队、不堆积；
  - 单次运行内按组严格串行（一次只有 1 个在途请求），不会耗尽连接池；
  - 超时用 `AbortController` + `Promise.race` 双重控制（默认 15s，可配置），`finally` 必须清理定时器。
- **任务三：绝对降级保底**
  - 以下任一情况都必须**瞬间静默降级**到纯本地启发式合并：未配置 LLM、网络断开、超时、HTTP 非 2xx、返回不是合法 JSON；
  - 本地合并规则：最早/最晚时间 + 去重后的核心文本拼接，整体不超过 `maxSummaryChars`；
  - 每次降级记录 `MEM_E_DREAM_LLM_FALLBACK` 警告（日志 + `state/dream.json.lastFallback` + 面板 `dream.lastFallback`）；
  - Dream 永不因 LLM 故障失败、死锁或丢数据。
- **任务四：防幻觉与数据溯源**
  - 无论 LLM 成功还是本地降级，新记录的 `meta.source_event_ids` 必须**强制**继承原始事件 id（去重、排序）；`meta.distilled_by` 标记 `llm|local`。
- **任务五：熔断**
  - 连续失败达到阈值（默认 3）→ 熔断 LLM，冷却期（默认 60min）内只走本地降级；
  - 冷却结束半开：只放 1 次试探，成功闭合、失败重新计时；
  - 状态（`circuit: closed|open|half-open`、`consecutiveFailures`、`openUntil`）暴露到面板 `dream` 字段。
- **TDD 验收（锁死）**：
  1. 不提供任何 LLM 配置时，`executeDream()` 仍成功跑完，输出 `distilled_by:"local"` 且 `source_event_ids` 完整；
  2. mock `fetch` 超时 / 抛错 / 返回非法 JSON 时，捕获异常并降级，日志含 `MEM_E_DREAM_LLM_FALLBACK`；
  3. 连续阈值次失败后，下一次运行不再发起 `fetch`（熔断生效），冷却后半开只试探 1 次；
  4. 并发调用第二个 `executeDream()` 返回 `skipped: dream-in-flight`；
  5. 读取 `package.json` 断言**没有任何第三方依赖**（`dependencies` 为空）——零依赖红线由测试守卫。

---

### P1 — 架构边界（v2.0 前置）

#### P1-5 ✅ Orchestrator 插件骨架（已完成，**未安装**）

- **状态**：✅ 新建同级独立包 `../dsh-orchestrator`（`dsh-layers-orchestrator` v0.1.0，零外部依赖，纯 ESM）：
  - `src/federation.js`：全局大标签映射（同名标签跨空间合并为一个节点，`spaces` 数组记录来源）
  - `src/dedupe.js`：`content_hash` 认领 + 读取时按 `source_event_ids` 增量合并（月记优先）
  - `src/router.js`：`spaceId` → 绝对 `dataDir`，懒加载 + 并发共享同一 open promise，`close()` 统一释放
  - `src/consent.js`：显式授权闸门（闸门先于校验/IO；一次性 token + TTL + payload 绑定；未授权 → `ORCH_E_CONSENT_REQUIRED`）
  - `index.js`：`createOrchestrator()` 组合 + `apply()` 空壳（**不注册任何工具/路由/监听**）
- **验收**：`dsh-orchestrator/test/run.mjs` → **20/20 通过**（联邦、去重、路由、授权、零依赖清单）。
- **明确未做**：没有安装进任何 profile（`package.json` 里没有它、没有跑 `install_bundle`），运行中的宿主不受影响；Dream 调度/`SessionStart` 补偿仍属 P1-7。

#### P1-6 ✅ 微内核切割与 Feature Flags —— 物理切割完成（v1.5.6）

- **已完成**：
  - `features.multiSpace` / `features.crossSpaceTransfer` 配置组：fail-fast、HTTP 可编辑、设置页开关；关多空间隐含关迁移，显式矛盾配置激活即失败。
  - 严格单空间模式：非 `default` 的 targetSpaceId 在 I/O 前抛 `MEM_E_FEATURE_DISABLED`；`createSpace`/`ensureSpace`/`warmup` 同样拒绝；`/spaces` 只回 `default` 且 `capabilities.spaces=false`。
  - 工具与提示同步消失：`space_transfer` / `transfer_to_global` 不注册、不宣传；迁移引擎在 consent 之前拒绝。
  - `Memory.open('/abs/dir')` 单空间入口；`Memory.warmup({targetSpaceId?, dataDir?})` 只读懒加载。
  - **物理切割**：`src/spaces/spaceRouter.js` / `transfer.js` 已移出本包 → `dsh-orchestrator/src/`；本体只保留 `src/spaces/singleSpace.js`。Host 可选 `orchestrator` 服务注入 `createSpaceAdapter` + `transfer`；无服务时插件只注册 8 个工具、`capabilities.spaces=false`，有服务时恢复完整多空间面。
  - 测试：`test/v156.features.test.js`（5）+ `test/v156.singleSpace.test.js`（3）；Orchestrator `test/spaces.test.js`（3）。
- **仍未完成（本项剩余）**：`dsh-orchestrator` 的**正式安装**（未安装）；安装后插件自动恢复多空间路由/迁移（服务注入已就绪）。联邦/跨空间去重的本体调用点仍未接线。
- **验收**：关闭 flags 后工具与路由同步消失 ✅；「本体不再含多空间路由」✅；「安装 Orchestrator 后多空间自动恢复」⬜（需真实安装验证）。

#### P1-7 🟡 宿主生命周期接入（SessionStart / Dream 调度）—— 第一阶段完成（v1.5.6）

- **已完成**：`src/hostBridge.js` 订阅 Host 进程内事件 `agent/created` / `session/created`（会话开始）与 `agent/disposed`；会话开始时若 `lastDreamAt` 超过 `dream.compensateAfterHours`（默认 24h，1–720，fail-fast）且价格窗口允许 → 经**同一** `runtime.runMaintenance('compensate')` 闸门补跑一次 Dream（在途直接拒绝，不排队）；价格可注入（`setPriceProbe`）或 `DSH_DREAM_PRICE=low|high`，未知价格对 LLM Dream 跳过；`runtime.hostStatus()` 与 `/stats.host` 可观测；`MockHostEnvironment` 测试宿主（`test/v156.host.test.js`，6 个用例）走通 `apply()` 全链路。
- **仍未完成**：`dsh-price-tip` / `dsh-peak-runner` / `dsh-notify-plugin` 的真实接线；「高峰期排队」目前实现为**跳过**（不排队）；`dsh-hooks-plugin` 作为独立插件不存在时使用 Host 原生事件（已完成）。
- **验收**：mock 低谷 + 会话开始触发 Dream ✅；高峰跳过 ✅；「高峰排队」⬜。

---

### P2 — 高阶能力与发布卫生

| 项 | 现状 | 要求 |
| --- | --- | --- |
| L2 多合一蒸馏（`merged_into`） | ✅ `src/l2Merge.js`（1.5.6）：pinned/普通严格分组、时间范围 + 去重文本、`state/l2-merge.json` 标记源记录、幂等；4 个用例 | 保持；旧套件夹具默认关闭以避免计数污染 |
| 大标签联邦（`meta.global_tags`） | 🟡 Orchestrator 侧已实现联邦映射（`dsh-orchestrator/src/federation.js`，未安装）；本体仍 grep 0 | 子空间只存元数据、不写倒排；装 Orchestrator 后接线 |
| 跨空间内容去重（`source_event_ids`/`content_hash`） | 🟡 Orchestrator 侧已实现认领+读取合并（`dsh-orchestrator/src/dedupe.js`，未安装）；本体仍 grep 0 | 月记/日记写入前查重，跨空间由 Orchestrator 协调 |
| L3 标签 Fail-Fast | ✅ `SemanticStore.upsert()` 空标签抛 `MEM_E_SEMANTIC_TAG_REQUIRED`（1.5.6）；离线路径自动派生锚点；历史空标签摘要 `degraded`；4 个用例 | 保持 |
| 索引式提示注入 | 🟡 现注入块全文 | 只注入 标签 + 标题 + eventId |
| Dream 配置 UI 化 | ✅ 安全子集已进设置页 / HTTP 白名单 / `/stats`（1.5.6）；`dream.llm.*` 凭据永不下发 | 保持；凭据只走 profile 或 `DSH_DREAM_LLM_*` |
| 工作模式（Host agent preset）跨交接保持 | ✅ marker 记录 `agentPreset`；新会话首轮前 `agentPresets.select` 恢复；旧 marker 自动补写；`/stats` 可观测；6 个用例（1.5.6） | 保持；宿主需重载插件后生效 |
| `maxPostingsPerTag` 质量保障 | ✅ `src/index/buildIndex.js:293-309` 已排序截断 + `postingsTruncated` | 保持 |
| 市场 PR | ⏳ 需 GitHub 凭据与网络；命令已整理在 `docs/RELEASE-1.5.6.md` | fork → 提交 `data/plugins/382quaii__dsh-Layers-Hippocampus.yml` → PR |
| npm 发布（可选） | ⏳ 需 npm 凭据；命令见 `docs/RELEASE-1.5.6.md` | `npm publish --access public` |
| Git tag 补齐 | ⏳ 打 tag/推送需凭据；命令见 `docs/RELEASE-1.5.6.md` | 按 CHANGELOG 补 v1.5.6 及历史 tag 并 push |

---

## 三、执行顺序（建议）

1. ✅ **P1-4 Dream LLM**（v1.5.5 已落地：`src/dream.js` + 8 个用例；剩余仅 `dream.*` 设置页 UI 化）；
2. ✅ **P0-1 raw 按行游标 + 分行索引**（v1.5.6：`readLinesReverse()` 流式扫描 + 绝对行号 + 结果硬上限，5 个用例；**注意：尚未建立持久化的“行号→offset”索引**，见第五节 5.1）；
3. ✅ **P0-2 / P0-3 / P0-4**（v1.5.6 同批落地：事件循环延迟监控 / `context.maxInjectTokens` 响应上限 / `close()` 资源释放，5 个用例）；
4. ✅ **P1-1 入库即打标**（v1.5.6：`src/tagging.js` + 写入闸门 + `MEM_E_AUTO_TAG_MISS`，7 个用例）；✅ **P1-2 L2 Pinned**（v1.5.6：永不衰减 + 置顶召回 + `MEM_E_PINNED_TAG_REQUIRED`，3 个用例）；✅ **P1-3 极简线索注入**（v1.5.6：相关性 `[Memory Hints]` 替代全局 Map，4 个用例）；
5. ✅ **P1-5 Orchestrator 骨架**（新建 `dsh-orchestrator` 独立包，20/20 用例；**未安装**）；
6. ✅ **P1-6 微内核切割（物理切割完成）**：`features.*` 开关 + 严格单空间模式 + 工具/路由同步消失 + `Memory.open(dir)` / `warmup()` + **多空间引擎移入 `dsh-orchestrator`、本包只留 `singleSpace.js`**（5+3 个用例）；剩余 Orchestrator 正式安装（接线已就绪）；
7. 🟡 **P1-7 宿主接入（第一阶段完成）**：`agent/created`/`session/created` 监听 + 补偿 Dream + 注入式价格窗口 + `MockHostEnvironment`（6 个用例）；剩余 `dsh-price-tip`/`peak-runner`/`notify-plugin` 接线与「高峰排队」；
8. 🟡 **P2（部分完成）**：Dream 配置 UI 化 ✅；发布准备文档 `docs/RELEASE-1.5.6.md` ✅；**L2 多合一蒸馏 ✅**（`src/l2Merge.js` + 设置页，4 个用例）；**L3 标签不变量 ✅**（`MEM_E_SEMANTIC_TAG_REQUIRED` + 离线派生锚点 + 历史 `degraded`，4 个用例）；**工作模式跨交接 ✅**（`agentPreset` 随 marker，新会话首轮前恢复，6 个用例）；市场 PR / npm / tag 推送 ⏳（需你的账号凭据，未执行）；大标签联邦落地、跨空间去重落地仍待 Orchestrator 安装。

## 四、共同验收口径

- 每个功能必须先有测试（`test/v15x.*.test.js`），全量 `node test/run.mjs` 保持 0 fail；
- 新增配置必须走 `resolveConfig` fail-fast、进 HTTP 可编辑白名单、进设置页（宪章第 5 条）；
- 新错误码进 `src/errors.js` 与 `docs/ARCHITECTURE.zh.md` 错误码表；
- 核心路径禁止 TODO 占位；
- 版本与 CHANGELOG 同步（`package.json`、`CHANGELOG.md`、`docs/ARCHITECTURE.zh.md` 测试数）。

---

## 五、追加：未完成事项与问题（2026-11-03 23:00 审计）

> 口径：以工作区实际代码为准。`dsh-memory` **358/358**（53 个测试文件）；`dsh-orchestrator` **23/23**。
> 宿主仍运行旧进程：以下所有改动都要重启 / 重载 desktop profile 后才生效。

### 5.1 未完成事项（主线）

| 事项 | 状态 | 说明 |
| --- | --- | --- |
| P1-5 Orchestrator **服务注册** | ✅ | `apply()` 直接 `ctx.provide('orchestrator', service)`；`apply` 返回 undefined（Cordis 把返回值当 effect，返回对象会 `TypeError: Invalid effect`） |
| P1-5 Orchestrator 正式安装 | ✅（本地 link） | desktop profile 已加 `link:` 依赖 + 在 hippocampus 条目之前 insert；`pnpm install` 完成；插件列表 `include:orchestrator` = **active**。插件市场仍无条目（未发布 npm） |
| P1-6 安装后端到端验证 | ❌ | 物理切割已完成（本包只剩 `singleSpace.js`），真实安装未验证 |
| P1-6 联邦 / 跨空间去重本体调用点 | ❌ | 引擎在 Orchestrator，海马体写入/读取还没调用 `federation` / `dedupe` |
| P1-7 外部价格/调度插件 | ❌ | `dsh-price-tip` / `peak-runner` / `notify-plugin` 未接 |
| P1-7 **纯本地低谷调度（推荐替代）** | ❌ | `isPeakHour()`、`dream-queue.json` 持久化、休眠补偿、启动自愈：代码 grep 全 0 |
| P0-1 持久化**分行索引** | ❌ | 只有 `readLinesReverse()` 反向分块扫描；没有“行号 → offset”索引文件，`hit.line` 是扫描得到的绝对行号 |
| P2 大标签联邦落地 | ❌ | 依赖 Orchestrator 安装 |
| P2 跨空间内容去重落地 | ❌ | 依赖 Orchestrator 安装 |
| P2 索引式提示注入（只注入 标签+标题+eventId） | ❌ | 当前注入块仍是全文 |
| P2 市场 PR / npm 发布 / 历史 tag | ⏳ | 需 GitHub/npm 凭据；命令在 `docs/RELEASE-1.5.6.md`，**未执行** |
| 仓库提交 / 版本 tag | ⏳ | 1.5.6 全部改动仍在工作区，未 commit、未 tag |

### 5.2 早前讨论过、代码里仍未做的任务

| 任务 | 证据 | 影响 |
| --- | --- | --- |
| 过滤系统保留标签（`status:*` / `folded-summary` / `status:handoff` 不进 tag-tree 与图谱） | `buildIndex.js` / `tagTreeCache.js` 无 `status:` 过滤；grep 0 | 元标签仍可能在图谱里喧宾夺主 |
| 强制注入 `[Active Task]` 块 | grep `[Active Task]` = 0；现有 `memory_admin action="active_task"` 只是读写接口 | 新会话开局仍可能“发呆” |
| 简单输入的兜底线索（“继续/在吗” → 上一轮高优标签） | `memoryHints.js` 只做词法匹配，无兜底路径 | `[Memory Hints]` 可能为空 |
| 图谱 **Ctrl + 拖拽** / **Ctrl + 滚轮缩放** | `ui/client.js` grep `ctrlKey` / `metaKey` / `wheel` = 0（现有普通 pointer 拖拽） | 误触/甩飞风险仍在 |
| 图谱初始节点防重叠 | 只有 `repulsion=900`，无随机扰动/初始布局证据 | 刚打开时节点可能堆叠 |
| 会话级注入去重（`injectedIds`） | grep = 0 | 99% 缓存命中/复读问题无代码级修复 |
| 单轮 Prompt 内去重 | 无实现 | 同一轮可能重复拼接相同标签/正文 |

### 5.3 已知问题与风险

1. **物理切割的运行时代价**：未安装 `dsh-orchestrator` 时，重载后多空间能力**显式消失**——只注册 8 个工具、`capabilities.spaces=false`、`/spaces` 只回 `default`、命名空间操作返回 `MEM_E_FEATURE_DISABLED`；单空间记忆不受影响。`features.multiSpace:true` 会每次启动告警。
2. **“安装即恢复”目前是假承诺**：见 5.1 第一行，`apply()` 未注册服务。
3. **测试跨包耦合**：`test/v150.space.test.js` / `v150.transfer.test.js` 相对路径 import `../../dsh-orchestrator/src/*`（工作区集成测试）；发布包/CI 独立性待处理。
4. **错误码契约混用**：迁入的引擎保留 `MEM_E_*`（`src/compat.js`），与包自身 `ORCH_E_*` 并存；调用方需同时识别两套前缀。
5. **工作模式 marker 补写时机**：当前 marker（`ev_e35c65b61360b1fcd4611145c5`）写于该功能之前，没有 `agentPreset`；重载后需在本对话走一步才会补写，立刻新开会话则本次模式不继承。
6. **当前会话已超交接阈值**：ratio 1.4789（阈值 0.6），`rolloverDue=true`、marker 已 active；建议“重载 → 本对话走一步 → 新开会话”。
7. **文档数字**：`docs/RELEASE-1.5.6.md` 顶部测试数已修正为 358/358（53 文件）；其余旧文档如再发现过期数字按同一口径更新。
8. **`features.multiSpace` 默认值**：默认 `true` 但无 Orchestrator 时只能告警降级；是否改为默认 false / 按服务能力探测需产品决策。
9. **会话注入去重缺失**：99% 缓存命中根因未修；`[Memory Hints]` 每轮重算，标签未变会重复出现，recall 块也可能重复同 event。
10. **图谱元标签过滤缺失**：`status:folded` / `folded-summary` / `status:handoff` 仍可能作为节点进入图谱。
11. **工作区未提交**：1.5.6 全部改动（含物理切割）未 commit；建议先本地 commit（不 push）降低回滚风险。
12. **测试依赖固定 Node 路径**：两包测试都用 `C:\Users\86135\.dsh\…\node.exe`；换机器/CI 应改为 `process.execPath`。

### 5.4 需要用户执行 / 决策

1. **是否安装 `dsh-orchestrator`**（安装前先补 5.1 的服务注册，否则装了也不生效）；安装会改 profile，需显式同意。
2. **是否把“纯本地低谷调度”排进下一批**（无需外部插件）；建议优先级高于等 `dsh-price-tip`。
3. **重载后按顺序操作**：重载插件 → 本对话发一句话（补 `agentPreset`）→ 新建对话；否则工作模式不继承。
4. **发布**：commit / tag / push、npm publish、awesome PR 需要凭据；可先只做本地 commit。
5. **产品决策**：`features.multiSpace` 默认值；无 Orchestrator 时空间入口是否彻底隐藏（当前已 `capabilities.spaces=false`，客户端应已隐藏）。

### 5.5 建议的下一批顺序

1. 补 `dsh-orchestrator` 的 `ctx.provide('orchestrator', …)` 服务注册（否则多空间永远“代码可用、运行时不可用”）；
2. 系统保留标签过滤（图谱/标签树）——纯本地、见效快；
3. `[Active Task]` 强制注入 + 线索兜底；
4. 图谱 Ctrl 拖拽/滚轮缩放 + 初始防重叠；
5. 会话级注入去重（修 99% 缓存命中/复读）；
6. 纯本地低谷调度（替代外部插件）；
7. 发布卫生（本地 commit → tag → push → npm → 市场 PR）。

### 5.6 第一批冲刺完成（2026-11-03，5.1/5.2 的对应项已落地）

- ✅ **Orchestrator 服务注册**：`apply()` 在 `ctx.effect` 内 `ctx.provide('orchestrator', service)`，暴露 `createSpaceAdapter` / `transfer` / `dirFor` / `status` / `federation` / `dedupe` / `consent` / `router`；卸载自动注销。海马体用 `config.multiSpaceActive(config, hasOrchestrator)` 判定能力。
- ✅ **保留标签物理隔离**：`status:*`、`folded-summary`、`active_task` 不再进入图谱（`buildGraph` + 防御性 `view`）与 L1.5 标签树（`rebuildTree` + 持久树/幽灵过滤）；倒排索引仍保留（handoff/recall 内部依赖）。
- ✅ **`[Active Task]` 强注**：优先 active handoff 摘要，否则最新 `task:` 事件；`[Active Task]` 置于 prompt 顶部，每会话只注入一次。
- ✅ **兜底线索**：`selectRelevantTags` 新增 `fallbackTags`，短输入（“继续/在吗”）复用上一轮匹配标签（最多 2 个）。
- ✅ **会话级注入去重**：`runtime.injection` 的 `ids`/`tags` 过滤 hints、`[Active Task]` 与 recall 块；SessionStart / Rollover 重置，新会话可再次收到交接内容。
- ✅ **空间删除（UI + 引擎）**：`SpaceRouter.deleteSpace(id,{confirm})` 先关子句柄再删目录，拒绝 `default`；`Memory/runtime.deleteSpace` 同规则；`POST /spaces {action:'delete'}`（未知 action 400，绝不落到 CREATE）；SpaceSelector 仅对命名空间显示 `🗑 删除空间` 并二次确认；新增 `capabilities.spacesDelete` 版本握手，旧宿主隐藏按钮；`capabilities.spaces=false` 时整个空间 UI 静默消失。
- ✅ **dsh-orchestrator 已本地安装并激活**：desktop profile 加 `link:` 依赖，`cordis.patch.yml` 在 `- id: memory` **之前** insert；`pnpm install` 完成；`include:orchestrator` fiberPhase=active。**插件市场仍不显示**：本地包未发布 npm、无市场目录条目；要上市场需 `npm publish` + 目录提交（需凭据）。
- ✅ **图谱交互完成**：Ctrl/Cmd+拖拽平移画布（普通拖拽仍移动节点）、Ctrl/Cmd+滚轮按光标缩放（native `passive:false`，普通滚轮不拦截）、双击空白重置视图、冻结布局先过 `separateOverlaps()` 防初始堆叠；头尾均有提示。4 个用例 `test/v156.graph.test.js`。
- ✅ **安装后实测**：重启后 `panel.spaces.ids = ["default","work"]`，orchestrator fiber=active，多空间在真实宿主生效。
- ✅ **纯本地低谷调度 Phase 1**：`src/priceWindow.js`（北京时区工作日 09–12/14–18 峰，其余谷；节假日未建模）；HostBridge 默认价格探针；峰时 idle LLM Dream 写 `state/dream-queue.json` 延后、谷时自动补跑（重启后仍在）；`dream.onlyLowValley` fail-fast/HTTP/设置页；`/stats` 暴露 `dreamWindow` / `dreamQueue`。4 个用例 `test/v156.lowValley.test.js`。
- ✅ **低谷调度 Phase 2**：`src/dreamTimer.js` 注入式唤醒定时器（`unref`），按 dueAt/下一个谷点 arm；触发时重读时钟与窗口——睡过头则 `lateMs`/`catchUp` 补跑，落在峰时则重新 arm 不花钱；启动从持久队列 delay 0 catch-up；dispose 取消；`/stats.dreamTimer` 暴露 arms/wakes/lateWakes/reschedules/runs。4 个用例 `test/v156.lowValley2.test.js`。
- ✅ **联邦 / 跨空间去重已接线**：写成功后把业务标签（跳过 `status:*`/`month:*`/`active_task`）注册进 Orchestrator `FederationMap`（带 spaceId；同一标签跨空间=一个全局节点）；`generateMonthlyMemos()` 用 `sha256(content)` 在 `ContentRegistry` 以 `monthly:<spaceId>` 认领，兄弟空间相同月记跳过并报 `monthly.skipped`。2 个用例 `test/v156.federation.test.js`。
- ✅ **读时 merge 已接 recall**：月记持久化 `meta.source_event_ids`，`projectEpisode` 暴露 `sourceEventIds`；`mergeRecallHits()` 走 `ContentRegistry.mergeForRead()`——月记覆盖其 owned 事件、重复内容折叠（monthly first），payload 带 `merge` 统计。仅在 dedupe 服务存在时生效，纯核心形状不变。2 个用例 `test/v156.readMerge.test.js`。
- ✅ **跨空间 recall 聚合**：`Memory.recallAcrossSpaces()` 逐空间加锁查询（`mergeRecall:false` 拿原始命中）、带 `spaceId` 合并；返回 `mode:'cross-space'` / `spaces` / `merge` / 每命中 `spaceId`。**默认关闭**：`features.crossSpaceRecall`（默认 false，fail-fast、HTTP、设置页）为 true 时才由 `runtime.recall()` 自动聚合；显式 `targetSpaceId` 仍单空间。2+3 个用例（`v156.crossSpaceRecall` / `...Flag`）。
- ✅ **Orchestrator 状态持久化**：`<root>/state/orchestrator.json` 原子写入联邦映射与月记认领，服务可见前恢复；损坏文件按空处理不阻断激活。3 个用例 `test/persistence.test.js`；`dsh-orchestrator` **31/31**。
- ✅ **设置页 GitHub 安装按钮**：`POST /api/hippocampus/orchestrator/install`（必须 `{confirm:true}`）→ Host `pluginManager.installBundle('git+https://github.com/382quaii/dsh-Layers-Orchestrator.git')`；已安装短路、无管理器给手动步骤、回报 applied/restart-required；设置页按钮 + 仓库链接 + 人类确认框。5 个用例。
- ✅ **自动开启新会话（已验证可行并落地）**：Host `agents.create/resume` 存在；客户端服务 `uiWorkspace.startSession()` 即“+”按钮同一动作。客户端半区轮询 `/stats`，`handoff.active && handoff.autoNewSession` 时每个标记调用一次 `startSession(undefined,{agentPreset})`（sessionStorage 去重、生命周期清理、旧宿主 no-op）；`context.autoNewSession` 默认 true；**检测方式 UI 可选**：`context.autoNewSessionPoll`（`interval` 轮询 / `once` 只检查一次）+ `context.autoNewSessionIntervalSeconds`（5–3600，默认 15），设置页 Select + Slider，客户端按首个 stats 响应配置定时器。5 个用例。工作区交接文件方案改为后备。
- ✅ **跨插件服务 M1/M2/M7/M8（2026-11-05）**：`ctx.provide('hippocampus', service)`（`apiVersion=1`；`ready/capabilities/remember/recall/runMaintenance/stats/handoffView/promptState/onDispose`）；`remember` 仅写 L2，非 L2 层重定向+告警；`runMaintenance` 不排队（运行中返回 `MEM_E_MAINTENANCE_RUNNING`，手动 30s 频控、cron 绕过）；服务随插件卸载消失，之后调用返回 `MEM_E_SERVICE_DISPOSED`；新增错误码 `MEM_E_MAINTENANCE_RUNNING` / `MEM_E_SERVICE_DISPOSED` / `MEM_E_FEDERATION_FAILED`。8 个用例 `test/v157.service.test.js`。**按裁决不新增任何 HTTP 写接口。**
- ✅ **修复：新建会话报 `tool "subagent" is already registered`**：handoff 预设继承在“新会话已经组合为该预设”时**不再调用** `agentPresets.select()`（冗余 recompose 会二次挂载 preset 的 `@deepseek-ai/dsh-tool-subagent` 并中止建会话）；记录 `presetInherit.reason='already-composed'`，1 个回归用例。
- ✅ **通用衰减参数（替代 M4，2026-11-05）**：`remember()` 支持 `customDecayRate`（(0,10]）或 `customHalfLifeDays`（[1,36500]），二选一；统一转成 `meta.decay_rate` 存条目，`projectEpisode` 暴露 `decayRate`，检索按 `halfLife/rate` 计算该条目的衰减。**记忆插件内零标签前缀判断**，情感长效保留由调用方传参。
- ✅ **M3 Persona 独立注入区（2026-11-05）**：新增 prompt section `persona` order=100，从 L3 语义日志实时取 confidence 最高 ≤10 条渲染 `[Persona & Traits]`；`memory:policy`(2455)/`memory`(2450)/`memory:reflection`(2460) 不变。
- ✅ **profile 重复挂载清理（2026-11-04）**：desktop `cordis.patch.yml` 的旧 `- id: memory` 行已证明为 unaddressable no-op（实时只有 `include:hippocampus`），已删除并备份 `cordis.patch.yml.bak-20261104-221007-dedupe`。
- ✅ **冷启动防呆与注入开关（1.6.0，2026-11-06）**：`memory:policy` 静态前缀新增【状态唤醒】（禁止客服腔、先回看 L3 再 recall、自然接续）；新会话首轮附加 `[Cold-Start Detected: Active Space=…, Recent Topic=…]`，按两个独立开关注入 `[Cold-Start Summary]`（`context.coldStartInjectSummary`，默认 true；交接摘要优先、回退 L3 top3，≤800 字）与 `[Previous Context Tail]`（`context.coldStartInjectRecentTurns`，默认 false；最近 ≤5 条业务事件，每条 ≤200 字）。双关时不注入任何历史块，静态防呆仍在；冷启动块只在易变尾巴、每会话消费一次。5 个用例 `test/v160.coldStart.test.js`。
- ✅ **检索上限剪枝（1.6.1，2026-11-07，性能审计 A）**：每个命中分数 = `salience × decay × tagAffinity(≤3) × lexicalBoost(≤1) × association(≤1) × timeBoost(≤1.3) × handoff(≤1)`，故 `salience × 3.9` 是硬上界；候选按 salience 降序访问，一旦上界打不过当前第 k 名分数即停止评分（严格 `<` 保证并列仍被访问）。pinned 命中绕过剪枝，best-k 窗口保证上界精确；结果带 `pruned` 与 `notes: pruned:<n>`。最坏复杂度仍为 O(K log K)（排序），但长尾候选的 decay/similarity 计算被跳过。4 个用例 `test/v170.pruning.test.js`。
- ✅ **段记 Token 审计（1.6.1，2026-11-07）**：`docs/AUDIT-2026-11-07-segment-token.md` — 无 P0 重复注入；6 个注入面分别有会话级/标签级去重；记录 2 个 P3 优化点（Active Task 跨面去重、Persona 按 L3 版本 memo）。
- ✅ **版本解冻（2026-11-07）**：移除 1.5.7 的“版本冻结/不再升版本号”表述，自 1.6.0 起恢复语义化版本节奏；当前 **1.6.1**。
- ✅ **P3 Token 收紧（1.6.1，2026-11-07）**：`[Active Task]` 的 eventId 同步进块去重池（同一事件不再以 Active Task + 召回块双形态注入）；`[Persona & Traits]` 按 L3 形状（`summaryId`+`updatedAt`+数量）memo 化，L3 不变时零渲染成本。2 个用例 `test/v161.p3.test.js`。
- ✅ **raw 冷热分层压缩（1.6.1，2026-11-07）**：`maintain()` 中月度门控（每月最多一次）把超过 `raw.archiveAfterDays`（默认 7）的日分片按自然月合并为 `raw-archive-YYYY-MM.jsonl.gz`（Node 原生 `zlib`），成功后删除明文分片。三项豁免：近 30 天有访问（`state/raw-access.json`）、含 `pinned`、含 `status:handoff`、或含活跃高频标签。`deep_raw` 与 hash 恢复用 `createGunzip()` 流式逐行读取，命中即停；损坏归档记 `MEM_E_CORRUPTED_ARCHIVE` 并跳过该分片。`raw.retentionDays` 默认 **30 → 90**，且必须严格大于 `archiveAfterDays`（否则 fail-fast）。7 个用例 `test/v161.archive.test.js`。
- ✅ **压缩引擎可选（1.6.1，2026-11-07）**：`raw.compressionEngine`（`gzip` 默认 / `zstd`）+ 设置页引擎选择与启用/停用按钮；Zstd 使用 Node 内置 `node:zlib`，**无需下载任何包，也没有可卸载的包**（“停用”= 切回 gzip）。归档扩展名 `.jsonl.gz` / `.jsonl.zst` 按扩展名分派解压，切换后旧 gzip 归档仍可读；运行时无 zstd 时静默回退并在 `capabilities.compression` 报告 `{engine, fallback, zstd, node}`。4 个用例 `test/v161.compression.test.js`。
- **测试**：`dsh-memory` **436/436**（64 文件）；`dsh-orchestrator` **31/31**。
- **M3/M4 状态更新**：M3 已落地（独立 `persona` section order=100）；M4 已改为通用 `customDecayRate`/`customHalfLifeDays`，由情感插件调用时传参，插件内不再判断 `emotion:` 前缀。
- ✅ **版本冻结 1.5.7 + 本地发布卫生**（历史，2026-11-04）：`package.json` 升到 1.5.7；本地 commit `release: v1.5.7 …` + tag `v1.5.7`（**未 push**）。该冻结已于 2026-11-07 解除，当前 1.6.1。
- **仍未完成**：`git push` → npm publish（两个包）→ 市场目录 PR（需 GitHub/npm 凭据）。

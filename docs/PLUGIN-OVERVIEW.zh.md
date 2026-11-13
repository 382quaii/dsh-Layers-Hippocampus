# dsh-layers-hippocampus · 功能 / 实现 / 版本演进

> 版本基线：**v1.6.3（2026-11-13 补丁：配置 schema 迁移 + `strictStartup` 启动安全降级 + 设置页简洁模式 + 交接冷启动按会话注入）**
> 验证状态：**476 / 476 测试通过**（77 个测试文件 · 50 个源码文件 · 零运行时依赖）
> 数据位置（本机当前）：`D:\Users\86135\memory`（本地 JSONL，可迁移）
> 本文与 `README.md`、`docs/ARCHITECTURE.zh.md`、`CHANGELOG.md`、`docs/RELEASE-1.6.3.md` 配套。

---

## 1. 定位

DeepSeek Harness（DSH）的**本地优先长期记忆 Host 插件**。它不把聊天记录塞进向量库，而是构建一条可审计、可重建、可删除的记忆管线：

```
唯一真相源（L1 追加日志）
   ├─ L2 可重建索引（A/B 双缓冲）── 标签表 / 活跃集合 / 日记 / 墓碑
   ├─ L2.5 趋势隔离 ── 短命观察，晋升后才成为记忆
   ├─ L3 语义摘要 ── 独立于原始事件生死
   ├─ 图谱 ── 标签共现的离线投影
   ├─ L1.5 标签树 ── root/mid/leaf 生命周期与级联剪枝
   └─ raw 黑匣子 ── 原始回合，四字段，不参与索引
```

所有投影（索引、日记、图谱、标签树、活跃集合）都是**可丢弃、可重建**的派生数据；写入路径绝不直接改投影结构，重建统一在 `maintain()` 中完成。

---

## 2. 功能清单

### 2.1 模型工具（10 个 `memory_*`）

| 工具 | 作用 | 可关闭性 |
|---|---|---|
| `remember` | 追加记忆；支持 `pinned`（永不衰减、优先召回，必须带标签）、`media_url/media_type` | **核心，不可关** |
| `recall` | 检索：标签 + 词法 + 衰减加权 + 图谱联想；`mode="deep_raw"` 走原始层；`hash` 精准恢复 | **核心，不可关** |
| `admin` | `status / maintain / active_tags / semantic / active_task / reviews / pending_deletes` | **核心，不可关** |
| `capture` | 手动写入一条原始回合（自动捕获之外的显式入口） | 可关 |
| `bulk_ingest` | 批量导入，每批 50 条，逐条失败隔离 | 可关 |
| `reinforce` | 强化记忆：移动衰减锚点并推进复习档位 | 可关 |
| `forget` | 两阶段删除入口（宽限期可反悔 → 四阶段管线） | 可关 |
| `checkpoint` | 记录唯一进行中的重任务（`task_id/progress/updated_at`），7 天自动降级 | 可关 |
| `space_transfer` | 跨物理空间复制/移动（**必须用户显式授权** `user_approved:true`） | 可关/随能力关闭 |
| `transfer_to_global` | 迁入 global 空间（同上安全约束） | 可关/随能力关闭 |

- `tools.disabled` 是**闭集校验**：拼错会 fail-fast，不会静默留着工具开着。
- `CORE_TOOL_SUFFIXES = ['remember','recall','admin']` **永远不可关闭**——否则配置文件就能把插件“锁死”。
- 多空间能力关闭时，两个 transfer 工具**既不注册也不在提示词中宣传**。

### 2.2 HTTP 路由（同源、复用宿主鉴权，所有响应带 `state`）

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/hippocampus/stats` | 面板、briefing、可写配置；启动期返回 503 + `state` |
| GET | `/api/hippocampus/config` | 可编辑配置子集（`ready` 前也可读，供表单回填） |
| POST | `/api/hippocampus/config` | 校验 → 生效 → 尽量持久化；`ready` 前 409 |
| GET | `/api/hippocampus/graph` | 图谱切片（含 ghost 历史节点可选） |
| POST | `/api/hippocampus/retry` | `failed` 启动的重试（202） |
| GET/POST/DELETE | `/api/hippocampus/spaces` | 多空间列表/创建/删除（需 Orchestrator 能力） |

读路由支持 `?space=<id>` 路由到指定空间；删除空间要求 `confirm:true`，`default` 永不可删。

### 2.3 Web UI（三个插槽）

| 插槽 | 内容 |
|---|---|
| `sidebar.panellist` | 图标（SVG，消费 `size/active`） |
| `main` | 主面板：存储环、统计卡、知识图谱（拖拽/缩放、幽灵节点、活跃/全貌切换）、SpaceSelector |
| `settings.section` | 设置页：生命周期、raw、删除宽限、Dream 安全子集、tagging、L2 合并、能力开关、工具开关、迁移入口等（均带 Tooltip） |

### 2.4 配置分组（25 组，全部 fail-fast 校验）

`dataDir`、`migrateFrom`、`briefing`、`promptSection`、`autoMaintainOnBoot`、`enableDream`、`dreamIdleMinutes`、`dream`、`enableReflection`、`graphMaxEdges`、`storageBudgetMb`、`maxRecallTopK`、`retrieval`、`index`、`context`、`temp`、`decay`、`activeSet`、`raw`、`delete`、`review`、`migration`、`tagTree`、`identity`、`tools`、`tagging`、`features`、`policy`。

关键项：

- `context.maxInjectTokens`（默认 4000）：一次召回返回的硬上限，超限裁剪并显式 `truncated`；
- `raw.maxScanTurns / maxScanMb / maxResultTokens / captureRatio(0|0.5|1)`；
- `delete.graceHours`（默认 24）；`review.intervals`（1/2/4/7/15/30）；
- `tagTree.midHalfLifeMultiplier / midGracePeriodDays / pruneBatchSize / leafDecayFloor`；
- `features.multiSpace / crossSpaceTransfer / crossSpaceRecall`；
- `tagging.autoTag / maxTags`；`tools.disabled`。

---

## 3. 实现方法

### 3.1 模块地图（`src/`）

| 模块 | 职责 | 方法要点 |
|---|---|---|
| `memory.js` | 记忆门面（12 万行级核心） | 组合各层；`stage()/commitMany()` 批量提交；`maintain()` 单一维护入口 |
| `log/logStore.js` | 追加日志与代际 | 分段 + manifest；**批量 append + 200ms 延迟 checkpoint（close/rewrite 强制 flush）**；`unflushedBytes` 暴露崩溃窗口 |
| `identity.js` / `log/identityLedger.js` | 身份与幂等 | `content_hash` 等价、`event_id` 身份、独立幂等账本、墓碑 |
| `index/buildIndex.js` / `indexManager.js` | 索引投影 | 从日志重建；A/B 代际 + 原子 CURRENT 切换；`maxPostingsPerTag` 封顶 |
| `retrieval.js` | 召回打分 | 标签亲和 × 词法 × 衰减(salience)；图谱邻居以 0.5 惩罚进入候选；pinned 优先；低置信短提示 |
| `context/contextEngine.js` | 上下文页管理 | 测量后按分数驱逐（阈值→目标滞回）；rollover 阈值；驱逐块交给折叠 |
| `rawStore.js` | 原始黑匣子 | 四字段记录；64 KiB 倒序分块扫描（峰值内存=一个 chunk）；按哈希流式恢复；墓碑跳过；读出脱敏 |
| `tagTreeRebuild.js` / `tagTreeCache.js` | L1.5 标签树 | 纯函数重建（顺序无关）；严格 forget 驱动的 Leaf 剪枝；Mid 宽限期 + ghost；扁平标签永不剪枝 |
| `l2Merge.js` | L2 合并 | 同标签重复 episode 离线合并为一条 `merged_into`；原记录只加标记不删除 |
| `semantic/*` | L3 与趋势隔离 | 无标签摘要拒绝（`MEM_E_SEMANTIC_TAG_REQUIRED`）；历史数据只读降级 |
| `deletePipeline.js` / `pendingDelete.js` | 两阶段删除 | index→archive→consolidation→purge 四阶段 journal；宽限期队列；崩溃可续 |
| `dream.js` / `priceWindow.js` / `eventLoop.js` | 离线整理与稳定性 | Dream 分组摘要；价格窗口注入（未知价格则跳过 LLM）；事件循环延迟监控 + 分阶段 yield |
| `hostBridge.js` | Host 生命周期桥 | 订阅 `agent/created`、`session/created`、`agent/disposed`；会话启动补偿 Dream；交接继承 agent preset |
| `spaces/singleSpace.js` | 单空间核心 | 多空间引擎已外置到 `dsh-orchestrator`；无 Orchestrator 时严格降级并告警 |
| `webRoutes.js` | HTTP 面 | 统一 `sendState`（每个响应带 `state`）、配置写隔离、迁移 202、空间路由 |
| `utils/*` | 横切能力 | 提示布局（稳定前缀+动态尾）、相关性提示、正则实体提取、工具输出瘦身、写入队列、保留标签 |

### 3.2 关键机制

**批量写入（性能）**
`remember` = `stage()`（验重/构造/预算检查）+ `commitMany()`（一次 append、一次 ledger checkpoint、一次惰性索引增量、一次 briefing 失效）。实测：~100 events/s → **5.7k–8.8k events/s**（1.5.3 基线；不同轮次有噪声）。

**召回**
候选预算内打分：`salience × decay × tagAffinity × lexicalBoost × associationFactor × timeBoost`；低置信命中不注入正文，只给一句“不确定”提示 + `low-confidence-hints:N`；pinned 强制 `decay=1` 且排最前。

**两阶段删除**
`forget` 先写 `state/pending-deletes.json`（默认 24h，可 `restore` 取消）→ 到期由 `maintain()` 推入四阶段管线 → purge 后按内容哈希写 raw 墓碑，扫描跳过。高价值事实在 purge 前先沉淀 L3 摘要。

**raw 黑匣子**
`{turn_id, timestamp, role, content}` 四字段；日分片；不索引、启动不加载；自动捕获订阅 `session/event`（剥离宿主注入的 runtime-context；`isError` 工具结果强制留存）；`captureRatio` 用哈希取模确定性采样；读出脱敏（Bearer/sk-/长 base64）；token 预算 + `truncated` 显式。

**标签树（L1.5）**
`tech/frontend/vue3` → root/mid/leaf；无 `/` 的扁平标签视为 root 且**永不剪枝**；Leaf 仅由 forget 驱动剪枝（`leafDecayFloor>0` 时才允许衰减剪枝）；Mid 在失去全部子节点后进入宽限期（默认 30 天），期间有新增则复活；Root 免死。重建是纯函数，重放日志得到字节一致的结果。

**提示词与缓存**
静态规则段（含读取纪律）→ `[Memory Blocks]`（动态）→ `[Memory Hints]`（仅与当前输入词法重叠的标签，最多 5 个）。所有动态内容放在可缓存前缀之后。

**多空间**
引擎外置到 `dsh-orchestrator`；插件通过 Host `orchestrator` 服务注入 `createSpaceAdapter/transfer/consent/federation/dedupe`。缺少服务时：单空间严格模式、8 个工具、`/spaces` 只报 `default`、日志明确告警。

---

## 4. 数据布局

```
<dataDir>/
  log/          gen-*/ + CURRENT        追加式真相
  index/        gen-*/ + CURRENT        A/B 投影
  identity/     ledger.json             幂等 + 墓碑
  semantic/     摘要 + temp.json        独立语义流
  state/        context / maintenance / graph / months / reviews / pending-deletes / tag-tree / l2-merge / migration
  journal/      删除流水账
  raw/          YYYY-MM-DD.jsonl        四字段原始回合 + raw_tombstone
  spaces/       子空间目录（Orchestrator 管理）
```

删除 `index/`、`state/graph.json`、`state/tag-tree.json`、`state/months.json` 都安全——它们会从日志重建。

---

## 5. 版本演进（1.4.0 → 1.5.7）

| 版本 | 主题 |
|---|---|
| **1.4.0** | 基础分层落地：raw 四字段黑匣子、间隔复习、两阶段删除、UI 数据目录迁移；零依赖 JSONL |
| **1.4.1** | 冷启动 404 修复（`ctx.inject(['webServer'])` 延迟注册）；前端 404 指数退避；提示词纪律 + 自有工具瘦身（`[Slimmed]` + recovery hash） |
| **1.4.2** | L1.5 标签树首版（root/mid/leaf、ghost、宽限期、扁平标签保护） |
| **1.4.3** | 写路径批量化（stage/commitMany，~100→数千 events/s）、`deep_raw` 尾扫最新优先、崩溃窗口可见（`unflushedBytes`）、提示词接线、置信度 A/B 脚本 |
| **1.5.0–1.5.3** | 多空间（spaces）+ 迁移同意（consent）+ 上下文交接（rollover）+ 索引封顶 + UI 大幅扩展；1.5.3 修 UI wiring 后 277 测试全绿 |
| **1.5.4** | 交接加固、标签治理、空间 UI、**工具裁剪（`tools.disabled`，三核心不可关）** |
| **1.5.5** | 维护性修复（tag `v1.5.5`） |
| **1.5.6** | **raw 游标倒序扫描（O(chunk) 内存）**、响应 payload 上限（`maxInjectTokens`）、写入前启发式打标、pinned 记忆、相关性提示、L2 合并、L3 标签不变量、交接继承工作模式、Dream 补偿、多空间引擎外置到 `dsh-orchestrator` |
| **1.5.7** | Orchestrator federation/dedupe 接线、读取时合并、跨空间召回（opt-in）、Orchestrator 状态持久化、设置页 GitHub 安装器、自动新会话交接、低峰 Dream Phase 2、空间删除、图谱交互（曾临时冻结，已被 1.6.0 解冻） |
| **1.6.0** | 冷启动防呆（状态唤醒）、`coldStartInjectSummary` / `coldStartInjectRecentTurns` 两个注入开关、泛型 `customDecayRate` / `customHalfLifeDays`、`persona` section order=100、跨插件 `ctx.provide('hippocampus')` 服务 |
| **1.6.1** | **检索上限剪枝**：`salience × 3.9` 硬上界 + 降序早停（pinned 绕过），结果带 `pruned` 观测；段记 Token 审计（无 P0 泄漏）；**版本全面解冻**，恢复语义化发布 |
| **1.6.2** | 冷归档保留期修复（`archiveAfterDays=90` / `retentionDays=365` / `coldAccessWindowDays=90`）；多档保留策略 `off`/`salience`/`all` + `distillPrune`（经 Tombstone 清理已蒸馏 raw）；冷归档默认 **Brotli 11**（`.jsonl.br`）；索引层 `templates.json` + `contentRef` 高频引用去重；L3 `semantic.maxEntries=100` LRU 熔断；`CAPABILITIES.version` 对齐 1.6.2 |
| **1.6.3** | **配置 schema 版本与迁移机制**（`CONFIG_SCHEMA_VERSION=3`，先迁移后严格校验，迁移只补值不覆盖、必告警）；**`strictStartup` 启动安全降级**（默认 `true`；显式 `false` 时越界值回退安全默认并降级启动，类型错误/未知键仍 fail-fast）；启动状态进入 `CAPABILITIES.startup` 与 `panel.startup`/`panel.configVersion`/`panel.configWarnings`；**设置页简洁模式**（纯显示层，只留身份 / 上下文窗口 / 存储位置迁移 / raw 三项）；**交接冷启动按会话幂等注入**（`session\|handoffEpoch` 键，兄弟 agent 先装配不吞注入；`handoff.json` 带 `tailTurns` 回放最后 5 轮原话；`coldStartInjectRecentTurns` 默认改开）；**移除 `context.autoNewSession*`**（交接继续同一对话，不再弹出第二个空会话） |

---

## 6. 测试与质量

- **476 / 476 通过**，77 个测试文件；进程内 `node --test`（`test/run.mjs`），30 秒看门狗，时间一律注入 `FakeClock`。
- 覆盖维度：身份幂等、索引重建一致性、召回排序与置信度、raw 四字段与游标扫描、哈希恢复、两阶段删除与墓碑、标签树生命周期与重放一致性、多空间降级、配置 fail-fast、UI 源码契约、崩溃恢复（200ms checkpoint 窗口）、事件循环让出。
- 运维脚本：`scripts/bench-protocol.mjs`（基准协议）、`scripts/repair-handoff.mjs`（交接修复）。

---

## 7. 已知边界与风险（诚实清单）

1. **多空间依赖外部能力**：无 `dsh-orchestrator` 时只有单空间与 8 个工具，这是显式降级，不是 bug；
2. **版本节奏**：1.5.7 的临时冻结已于 2026-11-07 全面解除，恢复语义化版本（当前 1.6.3）；
3. **保存窗口**：日志 append 是 durable 的，但 manifest checkpoint 有 200ms 延迟；崩溃后依赖 `unflushedBytes` + 重建兜底；
4. **raw 尾扫偏置**：单分片超过 `maxScanTurns`（默认 5000）时一次只看最新 N 条，更早历史需调大预算或按时间窗分页；
5. **置信度阈值**：在高度同质的数据上不触发（A/B 已验证为 0 收益），不适合当作默认的“省 token”手段；
6. **上下文税**：10 个工具 schema ≈ 2.3k tokens；提示词新增块很小，但工具数量本身是固定成本；
7. **跨空间传递**：`space_transfer/transfer_to_global` 必须显式用户授权，模型不得自行调用（`MEM_E_REQUIRE_USER_CONSENT` 是硬拦截，不是可绕过的错误）。

---

## 8. 快速开始（本机）

```powershell
cd C:\Users\86135\Documents\deepseek-harness\default-workspace\dsh-memory
node test/run.mjs                 # 399 测试
node scripts/bench-protocol.mjs   # 写入/召回基准
```

插件已在 profile 中启用（`cordis.patch.yml` → `id: hippocampus`），数据目录当前为 `D:\Users\86135\memory`；UI 设置页可改参数并热生效，迁移入口带进度与回滚。

# @local/dsh-memory — 分层长期记忆 Host 插件

给 DSH 智能体一份"活得比会话久"的记忆：**追加式原始日志是唯一真相源**，标签索引、日记、活跃集合全部是可丢弃、可重建的读模型，语义摘要独立于原始日志生死。

- 零运行时依赖（只用 Node 内置模块），不 import `@deepseek-ai/*`。
- Host 平面插件：`export const inject = ['tools','systemPrompt']` + `export function apply(ctx, config)`。
- 所有时间判定走注入的 `Clock`，测试用 `FakeClock`，从不读真实时间。

## 安装

```powershell
# 已安装的 DSH 里（需审批）：
#   plugin_manager  action=install_bundle  target=<本目录绝对值>
# 或 profile 行配置里追加：
- insert:
    - id: memory
      name: "@local/dsh-memory"
      config: { dataDir: "C:/Users/<you>/.dsh/memory" }
```

单个 profile 停用而不卸载：在该 profile 的 patch 里写 `- id: memory` + `disabled: true`。

## 数据布局（`dataDir` 下）

```
log/CURRENT                      "gen-000003"   ← 日志代指针
log/gen-000003/seg-000001.jsonl  追加式事件（唯一真相源）
log/gen-000003/manifest.json     {gen,recordCount,segments:[{file,count,sha256}],...}
log/tombstones.jsonl             墓碑（删除意图与已删 event_id；重建时排除）
log/dlq.jsonl                    拒收事件（空内容/不可解析），绝不覆盖已存事件
identity/ledger.jsonl            身份账本：event_id ↔ (content_hash,event_time,occurrence_index)，幂等键 → event_id
archive/cold-<ts>.jsonl          删除流水线的冷备（可回滚窗口）
index/CURRENT                    当前发布的索引代（A/B 双缓冲的读指针）
index/gen-000007/{events,tags,active-set,diary,tombstones,aliases,manifest}.json
semantic/sem.log.jsonl           语义事件流（semantic_upsert / semantic_retire）
semantic/temp.log.jsonl          L2.5 趋势隔离层（temp_observe / temp_promote / temp_purge）
journal/delete-dl_*.json         每个删除任务的阶段状态机
state/maintenance.json           最近一次维护报告
```

**身份三层（不可混用）**：`entity_id` = 实体（跨修订恒定）；`event_id` = 某一次发生，`ev_` + 26 位，由 `content_hash + event_time + occurrence_index` 确定性推出；`content_hash` = 载荷等价类（JSON 键排序、空白折叠、`1.0 → 1`、全半角统一后哈希）。**随机数与写入时钟都不进哈希**，所以同一输入重放得到同一 id 序列。

**真相源**：`log/gen-*/seg-*.jsonl`、`log/tombstones.jsonl`、`identity/ledger.jsonl` 与 `semantic/sem.log.jsonl`（+ `semantic/temp.log.jsonl` 的隔离账本）。
**可重建**：`index/**`、`active-set.json`、`diary.json`、`temp.log.jsonl` 的折叠视图。删掉 `index/` 后 `action=maintain` 可逐字节重建（digest 相同，见测试）；重建的输入是 **日志 − 墓碑**，因此已删事件不会被"重建复活"。

## 配置

```yaml
- id: memory
  name: "@local/dsh-memory"
  config:
    # ---- 路径与迁移 ----
    dataDir: ""                       # 空 = <DSH_HOME>/memory；非空即最终目录
    migrateFrom: ""                   # 旧数据目录；非空且未迁移过时执行一次性迁移
    # ---- 调度 ----
    maintenanceCron: "0 */6 * * *"    # 5 段 cron（本地时区）；旧键 maintenanceIntervalMinutes 已被移除
    enableDream: true                 # 空闲时自动跑一次维护（与 cron 共用同一闸门）
    dreamIdleMinutes: 180             # 空闲判定窗口（≥1；默认 180）
    autoMaintainOnBoot: true          # 开机一致性检查不通过时后台重建（不阻塞激活）
    # ---- 提示词 ----
    enableReflection: true            # 连续工具调用超阈值后动态追加反思提示
    # ---- 在线检索 ----
    maxRecallTopK: 100                # 工具 top_k 的硬上限
    retrieval: { topK: 20 }           # 默认 top-k
    # ---- 上下文窗口（模块 3，引擎测量，非模型指令）----
    context:
      maxTokens: 4000                 # 注入记忆块的 token 预算
      threshold: 0.85                 # 用量 > 该比例即触发淘汰（0,1)
      target: 0.7                     # 淘汰到该比例以下才停（必须 < threshold）
      injectPrompt: true              # 把存活块渲染进系统提示（淘汰即真消失）
    # ---- L2.5 趋势隔离 ----
    temp:
      ttlDays: 30
      promotionWindowDays: 20         # 必须 ≤ ttlDays
    # ---- 事件时间来源 ----
    identity:
      eventTimePolicy: content        # content | explicit | ingest
    # ---- 提示词 ----
    briefing: true                    # 系统提示里的状态行
    promptSection: true               # 系统提示里的使用说明节（order 2450）
    toolPrefix: memory
    # ---- 策略表（只写要覆盖的字段，深合并）----
    policy:
      activeSet: { cap: 200, tagBudget: 8, minEvents: 1, minMass: 0.3, massScale: 4 }
      candidates: { topK: 20, maxTopK: 100, blockTopK: 5, minScore: 0.02 }
      decay: { halfLifeDays: 30, blockHalfLifeDays: 90, semanticHalfLifeDays: 180, floor: 0.02 }
      tags:
        synonyms:
          typescript: [ts, tsx]
          javascript: [js, nodejs]
          postgres: [postgresql, psql]
          preference: [pref, preferences]
        mergeJaccard: 0.8
        archiveAfterDays: 120
        archiveMinEvents: 3
      retrieval: { degradedRecentBlocks: 3, maxScannedEvents: 5000, prefilterFactor: 4 }
      delete: { consolidateSalience: 0.6, consolidationMode: auto }  # auto | strict | off
      temp: { burstWindowDays: 3, burstMinOccurrences: 3, retrievalPenalty: 0.4, maxEntries: 500 }
      maintenance: { compactAfterSegments: 8, maxSegmentRecords: 5000, bootCheck: light }
```

### 配置参数指南

**Fail-Fast，绝不静默降级。** `resolveConfig()` 在任何 I/O 之前完成全部校验，任一条不满足都抛 `MEM_E_CONFIG_*` 并让激活失败；不存在"越界就 clamp""未知枚举取默认"的分支。

| 配置键 | 类型 / 取值 | 越界或非法时 | 落到存储的哪里 |
| --- | --- | --- | --- |
| `dataDir` | 路径；空 → `<DSH_HOME>/memory` | `CONFIG_OUT_OF_RANGE`（空字符串视为未设置之外的值） | 所有子目录的根 |
| `migrateFrom` | 路径或空 | `CONFIG_MIGRATION_*`（见"数据迁移"） | 一次性拷贝源 |
| `maintenanceCron` | 5 段 cron | `CONFIG_INVALID_CRON` | 不落盘；`state/maintenance.json` 记 `lastSuccessAt` |
| `maintenanceIntervalMinutes` | **已移除** | `CONFIG_DEPRECATED`（`details.replacement`） | — |
| `maxRecallTopK` | 正整数 | `CONFIG_OUT_OF_RANGE` | 仅运行时 |
| `retrieval.topK` | 1..`maxRecallTopK` | `CONFIG_OUT_OF_RANGE` | 运行时默认 top-k |
| `context.maxTokens` | 正整数 | `CONFIG_OUT_OF_RANGE` | `state/context.json: maxTokens` |
| `context.threshold` | (0,1) | `CONFIG_OUT_OF_RANGE` | `state/context.json` 不存；运行时判定 |
| `context.target` | (0,1) 且 `< threshold` | `CONFIG_OUT_OF_RANGE` | 同上 |
| `context.injectPrompt` | boolean | `CONFIG_INVALID_TYPE` | 决定 `memory:window` 提示节是否注册 |
| `temp.ttlDays` | 正整数天 | `CONFIG_OUT_OF_RANGE` | `temp.log.jsonl: expiresAt = observedAt + ttlDays·86400s` |
| `temp.promotionWindowDays` | 正整数天，`≤ ttlDays` | `CONFIG_OUT_OF_RANGE` | 晋升判定窗口（不落盘） |
| `identity.eventTimePolicy` | `content\|explicit\|ingest` | `CONFIG_UNKNOWN_ENUM` | `log` 记录 `time_source`、`time_uncertain` |
| `policy.*` | 见"策略表" | `MEM_E_INVALID_POLICY` | `index/gen-*/manifest.json: policyHash` |
| 其它未知键（非 `_` 前缀） | — | `CONFIG_UNKNOWN_KEY` | — |
| 扁平别名 + 嵌套同时出现 | — | `CONFIG_CONFLICT` | — |

扁平别名（用于 `cordis.patch.yml` 不好写嵌套的场合）：`retrievalTopK`、`contextMaxTokens`、`contextThreshold`、`contextTarget`、`contextInjectPrompt`、`tempTtlDays`、`tempPromotionWindowDays`、`eventTimePolicy`。别名与嵌套键同时出现不是"后者覆盖前者"，而是 `CONFIG_CONFLICT`——两个来源给出不同意图时，猜错的代价比报错高。

**存储 schema 字段 ↔ 配置键**：`state/context.json` 的 `savedTokens/evictedBlocks` 来自 `context.*` 的驱逐结果；`index/gen-*/active-set.json` 的 `cap/budget` 来自 `policy.activeSet.*`；`temp.log.jsonl` 的 `expiresAt` 来自 `temp.ttlDays`；`log/seg-*.jsonl` 的 `time_source/time_uncertain` 来自 `identity.eventTimePolicy`；`state/maintenance.json` 的 `lastSuccessAt` 来自调度器，而不是任何配置键的回写。

### Cron 语法

5 段：`分 时 日 月 周`（**本地时区**，不写秒，6 段直接 `CONFIG_INVALID_CRON`）。

| 形式 | 例子 | 含义 |
| --- | --- | --- |
| `*` | `* * * * *` | 每分钟 |
| 数字 | `0 3 * * *` | 每天 03:00 |
| 列表 | `5,35 * * * *` | 每小时 05 分和 35 分 |
| 区间 | `0 9-17 * * *` | 09:00–17:00 每小时整点 |
| 步进 | `*/15 * * * *`、`9-17/2 * * *` | 每 15 分钟 / 9、11、13、15、17 点 |
| 组合 | `5,35 9-17/2 * * 1-5` | 工作日 9–17 点（步进 2）的 05/35 分 |

- 周字段 `0` 与 `7` 都是周日。
- **日与周同时受限时按 OR**（Vixie cron 语义）：`0 0 13 * 5` = 每月 13 号**或**每周五。
- 调度纪律：上一轮 maintain 未结束 → 该 tick 跳过（`reason:"maintenance-in-flight"`，`skipped++`），**永不并发**；进程停机错过的窗口**不补跑**，只更新 `lastSuccessAt`；失败记 `lastError` 后下个窗口照常尝试。
- `nextRunAt` 由 `nextRun(now)` 逐分钟向前扫描得出（供面板显示），不是估算。

## 工具

| 工具 | 作用 | 关键参数 |
| --- | --- | --- |
| `memory_remember` | 追加一条 episode；`is_transient_trend` 时同时开隔离条目 | `content`*、`tags`、`salience`、`happened_at`、`is_transient_trend` |
| `memory_recall` | 两段式检索（日记粗筛 → 块内打分），返回显式 `mode`；附 `tempSemantic` 与 `context` 分页结果 | `query`、`tags`、`top_k`、`verbose` |
| `memory_reinforce` | 追加 reinforce 事件（这就是衰减锚点，不存字段） | `event_ids`*、`weight` |
| `memory_forget` | 四阶段删除：索引 → 冷备 → 巩固 → 物理删除 | `event_ids`*、`mode`(purge/archive)、`reason` |
| `memory_admin` | `status` / `maintain` / `active_tags` / `semantic` / `temp` / `context` | `action`* |

失败一律返回 `{"ok":false,"error":{"code":"MEM_E_*","message":...}}`，不向上抛异常。

## 评分与预算

- 事件分：`salience × decay × (1 + min(2, tagAffinity)) × (纯文本时 0.6+0.4×lexical)`
- `decay = max(floor, 0.5^(age/halfLife))`，`age` 基于 `recency anchor`：`effective_time = max(anchor, 最近 reinforce 的 log_time)`，其中 `anchor = log_time`（`time_source === 'content'`，即时间由内容推导时）否则 `= event_time`。**身份坐标与"何时为真"分离**：推导时间只保证可重放，不会把旧内容的记忆算成一年前。
- 活跃集合条目 `priority = 0.55·min(1,mass/4) + 0.30·recency + 0.15·reinforced`（都归一化，**连续分**）。
- 超预算按 `priority × decayScore` 升序挤出；同分先挤出 `lastReinforcedAt` 最旧者。
- 在线候选 `top-k = 20`（上限 100）；只读活跃集合，不裁决。
- 活跃集为空 → `mode:"degraded"`，扫**最近** `degradedRecentBlocks=3` 个日记块 + 标签前缀匹配，并写 `degraded:empty-active-set:recentBlocks=3`；绝不静默返回空、绝不全量扫。

## L2.5 趋势隔离层（晋升 / 淘汰）

大语料喂出来的模型会把**语料统计热词**（梗、一时流行语、群体腔调）当成用户特质，于是变成"不正经"的助手：它学的是人群，不是这个人。所以趋势不得直接成为特质。

- 入口两条：① `memory_remember({ is_transient_trend: true })`；② 维护时**爆发检测**（同内容在 `burstWindowDays=3` 天内出现 ≥ `burstMinOccurrences=3` 次）。入口只创建隔离条目，不写 L3。
- 收益比：`temp_observe` 记录来源 eventId（去重），`hitCount` = 聚合确认次数；重复维护对同一批事件是**幂等**的（同源事件不重复计数）。
- 出口只有两条，在 TTL 到期时由维护裁决：
  1. **晋升**：`lastHitAt ≥ expiresAt - promotionWindowDays`（到期前 20 天窗口内有强化）**且** `hitCount ≥ 2`（聚合确认）→ 写入 L3（`title: "Trend: …"`，confidence `0.5+0.1·hitCount`），隔离条目冻结为 `permanent`。没有调用就不晋升：晋升是维护的产出，不是交互的一部分。
  2. **淘汰**：其余一律物理删除，并重写 `temp.log.jsonl`（临时文件 + rename），不留字节。
- 检索兼容：隔离条目可被召回，但 `priority: "temp"`，分数乘 `retrievalPenalty=0.4`，并带 `ttlDays`/`expiresAt`；已过期未裁决的不返回（否则 TTL 是假的）。
- 幂等与不复活：已晋升的条目再被提及 → `{action:"ignored", reason:"status:permanent"}`，不会重新进入隔离。

## 上下文窗口分页（模块 3，引擎驱动）

"上下文太长就自己精简"是**请求**，模型会漂移；测量 token 再按确定性分数淘汰**无法漂移**。

- `ContextEngine` 持有块表：`inject({id, kind, text, tokens, salience, at, pinned})`，同 id 原地刷新（不改变顺序）。
- `tokens > threshold × maxTokens`（默认 0.85×4000）触发，按 `salience × decay(now - at)` **升序**淘汰，直到 `≤ target × maxTokens`（默认 0.7）。滞回避免"每轮挤一块"。
- `pinned` 块永不淘汰；若全是 pinned 则返回 `pinnedFloorReached: true`，报告而不强删。
- 淘汰只作用于提示窗口：日志与索引不变（测试断言 `recordCount` 不变）。`memory_recall` 注入召回块 + 语义摘要，返回 `context:{tokens,maxTokens,evicted:[...]}`；系统提示 `memory:window`（order 225）只渲染存活块，淘汰即真消失。
- 纪律写进 `memory:policy` 提示节：晋升、裁决、分页都由引擎在维护时钟上执行，模型不得自行裁剪上下文或晋升模式。

## 数据迁移（`migrateFrom` → `dataDir`）

把 `dataDir` 从旧路径搬到新路径（或把裸 JSON 时代的存储搬进本格式），**只拷贝、不删除、不二次拷贝**。

- **标记即状态**：迁移成功的唯一证据是目标目录下的 `.migration-complete`（JSON：`{plugin,from,to,recordCount,generation,at,methodology}`）。标记**最后写**，先拷数据后写标记，故"有数据无标记"必然是中断。
- **三种入口判定**：

| 目标状态 | 结果 |
| --- | --- |
| 无 `migrateFrom` | `status:"disabled"`，什么都不做 |
| 源目录不存在 | `status:"no-source"`，什么都不做（新装用户的正常路径） |
| 目标有数据 + 有标记 | `status:"already-migrated"`（幂等，不重复拷贝） |
| 目标有数据 + 无标记 | **抛 `MEM_E_CONFIG_MIGRATION_INTERRUPTED`**，不覆盖、不猜、不二次整拷 |
| 源无 `log/CURRENT` | **抛 `MEM_E_CONFIG_MIGRATION_MISMATCH`**（源不是本格式，拷过去也是坏数据） |

- **锁**：进程内 `ACTIVE_LOCKS` + 磁盘 `<dataDir>.migration.lock`（`wx` 独占创建，含 pid/时间）。**持锁进程存活即视为活锁**（`process.kill(pid, 0)`，EPERM 也算存活）；只有 pid 已不存在的陈旧锁才会被接管，mtime 仅作兜底提示。取锁失败抛 `MEM_E_CONFIG_MIGRATION_LOCKED`，锁在 `try/finally` 的 `finally` 里释放（幂等）。
- **校验口径与业务一致**：`recordCount` 用 `LogStore.status()` 统计，即"append-only 日志里的记录数"；DLQ 与非法占位事件**天然不计入**（它们不在日志里）。拷贝前后两次计数不等 → `MIGRATION_MISMATCH` 且**不写标记**，留给下一次人工判断。
- **失败回滚**：迁移失败时源目录未动；删掉目标目录（或恢复备份）后重跑即可。成功时**默认保留源目录**作为冷备：确认新目录工作正常后可手动删除，例如
  ```powershell
  Remove-Item -Recurse -Force 'C:\Users\86135\.dsh\memory-old'
  ```
- **顺序纪律**：迁移必须在 `memory.init()` **之前**执行——`init()` 会创建目录，先 init 会让"目标已存在"误判为中断。

## UI 面板数据字典（`memory_admin action=status`）

一次调用返回 `{ok, panel, boot, policyHash, config, briefing}`。`panel` 是**只读快照**，不触发维护、不推进删除。

| 字段 | 含义 | 来源 |
| --- | --- | --- |
| `generatedAt` | 快照时刻（注入时钟，不是 wall clock 混用） | `clock.now()` |
| `global.events` | 日志内事件总数（episode + control 记录） | `logStore.status().recordCount` |
| `global.activeTags` | 常驻活跃标签条数 | `index/gen-*/active-set.json` |
| `global.semanticSummaries` | 语义摘要条数（独立于日志生死） | `semantic/sem.log.jsonl` 折叠后 |
| `global.tempQuarantined` | L2.5 隔离区未裁决条目数 | `temp.log.jsonl` |
| `tokens.contextTokens` | 当前窗口占用 token（`ceil(len/4)` 估算） | `ContextEngine.snapshot()` |
| `tokens.contextMaxTokens` | 窗口预算 | 配置 `context.maxTokens` |
| `tokens.evictedBlocks` | 累计被驱逐块数 | `state/context.json`（派生状态，可重建） |
| `tokens.cumulativeSavedTokens` | 累计节省 token = 历次驱逐块 token 之和 | `state/context.json` |
| `storage.dataDir` | 实际数据目录（绝对路径） | 配置解析结果 |
| `storage.diskBytes` | 目录磁盘占用（递归求和，含日志/索引/语义） | 文件系统 |
| `maintenance.lastSuccessAt` | 上次**成功**维护结束时刻（失败不更新） | `maintenance.lastReport().finishedAt` |
| `maintenance.nextRunAt` | 下次预计运行时刻；cron 非法时 `null` | `nextRun(spec, now)` 逐分钟扫描 |
| `maintenance.maintenanceCron` | 生效的 cron 表达式 | 配置 |
| `maintenance.running` | 当前是否有维护在跑（面板读状态，不触发） | 调度器 `running` |
| `maintenance.queuedDeletes` | 排队删除任务数 | `deletePipeline.jobs()` 中 `status ∈ {running, pending-consolidation}` |
| `generations.logGen` | 日志当前代指针（如 `gen-000007`） | `log/CURRENT` |
| `generations.indexGen` | 索引当前代（双缓冲的 A 面） | `index/CURRENT` |
| `generations.logGeneration` | 日志代序号（整数，便于比较单调性） | `genNumber(logGen)` |
| `generations.indexGeneration` | 索引代序号（每次 rebuild +1） | `genNumber(indexGen)` |

`boot` 是开机一致性检查结果：`{status: ok|stale|missing|rebuilt, logGen, indexGen, reason?}`。

## 启动状态机（不阻塞激活）

插件激活只做**同步、可失败**的事：解析配置（fail-fast）→ 建 runtime → 注册工具与提示段 → 返回。真正的 I/O（打开日志、引导索引、执行迁移）跑在 `queueMicrotask` 里的 `bootstrap()` 上，激活不需要等它。

```
pending ──start()──▶ in_progress ──(打开日志/迁移/引导索引)──▶ ready
                         │
                         └──(任何一步失败)──▶ failed（错误写 phaseError，ready 仍会 reject 一次）
```

- **READY 之前**：读走 `MEM_E_NOT_READY`；**写一律拒**（同一错误码）。唯一的例外是迁移窗口内：若 `migrateFrom` 生效且旧目录可打开，读会被**重定向到旧目录**并在结果里带 `readFrom: "legacy"`，这样迁移期间助手仍能检索到历史记忆，而写入保持拒绝——宁可失败，也不把新写入落进正在被覆盖的目录。
- **status 面板同理**：READY 前 `memory_admin action=status` 返回 `MEM_E_NOT_READY`，UI 据此渲染"启动中"，而不是渲染一屏 0。
- **失败不自动重试**：`failed` 是终态，需重启插件（`failed` 后 `ready` 已 reject，`phaseError` 保留原因）。

## 单一调度闸门（cron 与 dream 共用）

`cron` 与 `dream` 都调用 `runtime.runMaintenance(source)`，闸门是同一个 `maintenanceInFlight`：

| 情况 | 行为 |
| --- | --- |
| 未就绪 | 直接拒绝（`MEM_E_NOT_READY`），不排队 |
| 已有维护在跑 | 返回 `{ran:false, skipped:true, reason:"maintenance-in-flight"}`，**不排队、不补跑** |
| 正常 | `ran:true`，成功后 `scheduler.lastSuccessAt = clock.now()` |

- **dream 触发条件**：`enableDream` 且 `now - lastActiveAt ≥ dreamIdleMinutes`；`touch()` 在每次 remember/reinforce/forget 与 recall 命中时刷新活动时间，所以忙碌的会话不会 dream。
- **错过窗口不补跑**：`tick` 每分钟跑一次，cron 只匹配当前时刻；重启后错过的窗口不追溯。`skipped` 计数用于观测"闸门撞车"频率。

## 提示注入按需（不预加载）

- `memory` 段（order 2450）只讲工具契约与写入纪律，不拼接历史。
- `memory-state` 段（order 220）每次装配时读 `runtime.promptState()`，只渲染**当前上下文窗口**的存活块，没有历史快照。
- `memory:reflection` 段默认不注册内容：只有连续工具调用达到 `REFLECTION_THRESHOLD`（12）次，才在 `text()` 里返回反思提示；`enableReflection:false` 时整段不注册。

## UI：Client 插件 + Slot 注册

UI 是**独立的 Client 半包**（`ui/client.js`，浏览器侧），经由 `window.__ModuleLoader__` 工厂加载；Host 侧不渲染任何东西。三个注册缺一不可：

| Slot | 注册参数 | 作用 |
| --- | --- | --- |
| `sidebar.panellist` | `{id:'memory-panel', order:60, label:'Memory'}` | 侧边栏图标（`ownerProps.size/active`，只画图标） |
| `main` | `{key:'memory-panel'}` | 点图标后打开的中央面板（list id 对应 main 的同 key） |
| `settings.section` | `{id:'memory-settings', order:25, label:'记忆'}` | 设置页一栏（`ownerProps.close`） |

```js
// ui/client.js（节选）
window.__ModuleLoader__.load({
  id: '@local/dsh-memory',
  factory(require) {
    const React = require('react');
    return {
      inject: ['slots'],
      apply(ctx) {
        const disposers = [];
        return (ctx.effect(() => {
          disposers.push(ctx.slots.register({ name: 'sidebar.panellist', id: 'memory-panel', order: 60, label: 'Memory' }, MemoryIcon));
          disposers.push(ctx.slots.register({ name: 'main', key: 'memory-panel' }, MemoryPanel));
          disposers.push(ctx.slots.register({ name: 'settings.section', id: 'memory-settings', order: 25, label: '记忆' }, MemorySettings));
          return () => disposers.forEach((dispose) => { try { dispose(); } catch { /* already gone */ } });
        }));
      },
    };
  },
});
```

包清单要点：

```json
{
  "exports": { ".": "./index.js", "./client": "./ui/client.js" },
  "files": ["index.js", "src/**/*.js", "ui/**/*.js"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" }, "client": { "platform": "web", "immediately": true, "inject": [] } }
}
```

纪律：factory 无副作用（只返回 `{inject, apply}`）；样式/定时器/监听在 `apply` 里经 `ctx.effect` 注册；React 由宿主提供，**不许自带**、不许二次挂载、不许替换 app root；颜色走宿主主题变量（`--dsh-*`，带回退值）。

状态渲染：`pending/in_progress` 显示"正在迁移/加载索引…"，`failed` 显示 `phaseError` 的 code 与 message 以及 `dataDir`，`ready` 才显示卡片。

## HTTP 路由（Client → Host 的唯一通道）

浏览器不能调 Agent 工具，面板数据与配置写回都走这两条路由（`src/webRoutes.js`，挂在 `ctx.webServer.register`，`kind:'exact'`，同源，无需鉴权）：

| 方法 | 路径 | 返回 / 语义 |
| --- | --- | --- |
| `GET` | `/api/memory/stats` | `{ok, phase, phaseError, panel, briefing, config}`；**未 READY 回 503**（`{ok:false, code:'MEM_E_NOT_READY', phase}`），面板据此渲染启动态 |
| `GET` | `/api/memory/config` | 只含可编辑子集：`enableDream/enableReflection/dreamIdleMinutes/context.{maxTokens,threshold,target}/temp.ttlDays` |
| `POST` | `/api/memory/config` | body `{patch:{...}}`（≤16 KiB）→ 校验 → 内存生效 → 尝试持久化 → `{ok, config, persisted, note?}` |

- 未知键 → `400 MEM_E_CONFIG_UNKNOWN_KEY`；值越界 → `400 MEM_E_CONFIG_OUT_OF_RANGE`；坏 JSON → `400 MEM_E_INVALID_INPUT`；非 GET/POST → `405`。
- **生效与持久化分离**：`runtime.updateConfig(patch)` 先 `resolveConfig` 校验再原子替换运行配置（失败则运行配置不动）；持久化走 `configEditor.entries()/edit()`（Loader 自己的写配置路径）。没有 `configEditor` 时返回 `persisted:false` 与 `note`，前端如实显示"已生效，重启前不持久"。
- 热更新的落地字段：`context.maxTokens/threshold/target` 直接写 `ContextEngine` 的 override（下一次 `enforce()` 即生效）；`dreamIdleMinutes/enableDream/enableReflection` 由 runtime 每 tick 读取。

### 错误码表

| 码 | 何时 | 调用方处置 |
| --- | --- | --- |
| `MEM_E_INVALID_INPUT` | 参数类型/形状错误、非法时间、空 eventIds | 修参数 |
| `MEM_E_INVALID_CONFIG` | 配置形态错误（非 fail-fast 类） | 修 `cordis.patch.yml` |
| `MEM_E_CONFIG_UNKNOWN_KEY` | 未知配置键（非 `_` 前缀） | 删掉或改名 |
| `MEM_E_CONFIG_INVALID_TYPE` | 类型不符 | 改类型 |
| `MEM_E_CONFIG_OUT_OF_RANGE` | 越界/交叉约束不成立 | 改数值 |
| `MEM_E_CONFIG_UNKNOWN_ENUM` | 枚举不在允许集合 | 改枚举 |
| `MEM_E_CONFIG_CONFLICT` | 扁平静名与嵌套键同时给出 | 只保留一处 |
| `MEM_E_CONFIG_INVALID_CRON` | cron 段数/范围/步进非法 | 改表达式 |
| `MEM_E_CONFIG_DEPRECATED` | 使用了已移除的键（`details.replacement` 指出新键） | 换新键 |
| `MEM_E_CONFIG_MIGRATION_INTERRUPTED` | 目标有数据但无完成标记 | 人工确认后清理目标目录再跑 |
| `MEM_E_CONFIG_MIGRATION_LOCKED` | 已有迁移在跑（同机并发） | 等待或清理 `<dataDir>.migration.lock` |
| `MEM_E_CONFIG_MIGRATION_MISMATCH` | 源不是本格式 / 计数不一致 | 检查源目录 |
| `MEM_E_EVENT_TIME_REQUIRED` | `eventTimePolicy:"explicit"` 但缺 `happened_at` | 补时间 |
| `MEM_E_LOG_CORRUPT` | 日志行不可解析 / id 与内容不符 | 该行跳过并记录，人工排查 |
| `MEM_E_INDEX_CORRUPT` / `MEM_E_INDEX_MISSING` | 索引代损坏/缺失 | `action=maintain` 重建 |
| `MEM_E_NOT_FOUND` | 引用不存在的 event_id | 修 id |
| `MEM_E_ALREADY_PURGED` | 对已物理删除的事件再次操作 | 无需处理 |
| `MEM_E_CONSOLIDATION_REQUIRED` | `consolidationMode:"strict"` 需人工确认 | 先 `action=semantic` 再推进 |
| `MEM_E_NOT_READY` | 插件尚在 `pending`/`in_progress`（或已 `failed`），读或写被拒 | 等 `ready`；迁移窗口读旧目录，写仍拒 |
| `MEM_E_WRITER_BUSY` | 写者互斥争用 | 重试 |
| `MEM_E_CLOCK_INVALID` / `MEM_E_IO` | 时钟回退 / 磁盘错误 | 检查环境 |

## 测试

```powershell
# 本机沙箱里 node --test 的子进程 spawn 会 EPERM，用进程内运行器：
& "C:\Users\86135\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" test/run.mjs
# 只看一组：$env:MEM_TEST_ONLY='lifecycle'
# 加长看门狗：$env:MEM_TEST_TIMEOUT_MS='120000'
```

运行器带**看门狗**：默认 **30s**（`MEM_TEST_TIMEOUT_MS` 可调）仍未退出，就打印**卡住时正在导入/执行的文件、最后完成的测试名与完成数、活动资源、尚未触发的定时器**，然后 `process.exit(1)`。它不会用 `process.exit(0)` 掩盖超时——挂起即失败。`MEM_TEST_TRACE=1` 可看文件级进度，`MEM_TEST_ONLY=<子串>` 只跑一组。

95 个用例（14 个文件）覆盖：

- 索引与标签：重建 digest 一致、行号漂移防护（eventId 不变、行号变）、同义合并、活跃集 cap 挤出、规则变更不改清单、空活跃集降级、top-k 有界有序去重。
- 衰减与删除：30 天半衰期、reinforce 移动锚点（不存字段）、仅文本粗筛、标签过滤、维护代切换且旧代可读、boot 检查、压缩不丢记录、并发维护串行化、四阶段删除、archive 可回滚 vs purge 不可、strict 巩固暂停与恢复、任务重放幂等、错误 id 零变更。
- 插件面：配置默认值与非法输入、非法策略在激活前拒绝、五个工具与两层提示注册/卸载、工具 JSON 往返、结构化错误。
- 新增 L2.5 / 分页：爆发隔离不晋升、仅窗口内强化才晋升（早强化被淘汰）、未强化到期物理删除、已晋升不被重新隔离、按分数淘汰到 target 且存储不变、pinned 不淘汰 + 衰减排序。
- 身份与幂等：规范化对抗（键序/空白/`1.0` vs `1`/全半角 → 同 hash）、`event_id` 纯函数性（同输入同 id、换 occurrence 或时间即换 id）、确定性重放（两次运行 id 序列相同）、同载荷同时间 → `duplicate` 且日志不增、同秒不同内容 → 两个 id、非法内容进 DLQ 且不覆盖已存事件。
- 双缓冲与防复活：在 `beforeSwap` 屏障挂起写线程时，读线程解析到**完整旧快照**；放行后见到**完整新快照**。重建输入 = 日志 − 墓碑，按 tag 比对 `event_id` 集合（无序相等）、关联强度 1e-9 容差、共用同一注入时钟；`stats.suppressedByTombstone` 计数。
- 配置与调度（新增 4 个文件 / 30 个用例）：默认值、非法 cron、越界阈值、未知枚举、未知键、别名冲突全为 `MEM_E_CONFIG_*` 硬失败；deprecated 键抛 `CONFIG_DEPRECATED` 并带 `replacement`；cron 匹配/步进/DOM-DOW OR/`nextRun` 严格递进；维护重入时下一 tick 跳过且不并发、错过窗口不补跑、失败记录后继续；迁移的已迁移幂等、无标记中断、源不存在、锁冲突、无源禁用。
- 生命周期（`test/lifecycle.test.js`，10 个用例）：工具 schema 根对象（含 `memory_admin`）；READY 前读写均为 `MEM_E_NOT_READY`；迁移窗口读旧目录并标 `readFrom:"legacy"`；dream 空闲触发；重入只跑一次；反思段达阈值才出文本；迁移锁的活 pid/死 pid/释放；uiPayload 由 Host 提供而 Host 不注册视觉面；运行器看门狗断言。
- HTTP 路由（`test/webRoutes.test.js`，10 个用例）：stats 的 200/503；config 的 GET 子集与 POST 生效+持久化；未知键/越界/坏 JSON 的 400 与错误码透传；405；`registerMemoryRoutes` 注册与 dispose；`validatePatch` 拒绝非对象。
- Client 包（`test/clientSlot.test.js`，4 个用例）：`__ModuleLoader__` 工厂纯度、`inject:['slots']`、三个注册的 id/key 与顺序、dispose 全部执行、图标是纯 SVG、`index.js` 不含 React/DOM。
- 面板：`status().panel` 形状快照（键全集，防漏字段）+ 值快照；写入后 `events/activeTags` 跟随；`cumulativeSavedTokens` 跨 reopen 保持（`state/context.json`）；`queuedDeletes` 取自删除流水线而非独立计数器；`indexGeneration` 每次 rebuild 恰好 +1。


## SLO / 容量

| 指标 | 目标 |
| --- | --- |
| 活跃标签集 | 200 条（硬上限，超限挤出） |
| 在线候选 top-k | 默认 20，上限 100 |
| 日记块 | 1 天/块；每块 `maxSegmentRecords` 事件上限 5000 |
| recall P99 | < 50 ms @ 10⁵ 事件 / 5 年日记（索引常驻内存，A/B 双缓冲，切换为单次指针赋值） |
| maintain | 10⁵ 事件 < 3 s，且**不阻塞** recall（写新代，读旧代） |
| 单次 append | < 5 ms（fsync 每次追加，可选批量） |
| L2.5 隔离条目 | ≤ 500 条（`temp.maxEntries`，超限拒绝新条目并回报 `over-cap`） |
| 上下文窗口 | 4000 token 预算，0.85 触发 / 0.7 收敛；每次召回注入 ≤ `context.blockTopK=8` 块 |

## 失败模式与回滚

| 失败 | 表现 | 处置 |
| --- | --- | --- |
| `index/CURRENT` 丢失/损坏 | `recall` 返回 `mode:"degraded"` + `notes:no-index` | `action=maintain` 从日志重建 |
| 日志半行（断电） | `parseRecord` 抛 `MEM_E_LOG_CORRUPT` 带 `{segment,line}` | 该行被跳过并记录；不静默丢弃 |
| 维护中途崩溃 | 只有 `index/.tmp-*` 残留，`CURRENT` 未变 | 下次维护 `prune()` 清理，读路径不受影响 |
| 删除中途崩溃 | journal 停在某 phase，事件已被 tombstone | `maintain` 继续推进（幂等重放） |
| 误删 | archive 模式可 `restore`；purge 后只能靠语义摘要 | 删除前要求 `mode:archive` 试运行 |
| 配置非法 | 激活失败，`MEM_E_INVALID_CONFIG/POLICY` | 修正 `cordis.patch.yml` 重启 |
| 趋势误判（把真偏好当梗） | 隔离期内不晋升，30 天后删除 | 用 `salience ≥ 0.8` 记一次明确偏好（不进隔离），或在窗口内再确认一次以晋升 |
| 趋势爆发但无聚合确认 | 到期删除，L3 无模式 | 若确为长期偏好，重新记录并打 `preference:*` 标签 |
| `temp.log.jsonl` 半写 | 折叠跳过坏行，隔离视图可少一条 | 重放 `temp_observe`（幂等，同源事件不重复计数） |
| 上下文窗口淘汰了仍需要的内容 | `context.evicted` 显式回报 id | 再次 `memory_recall` 即可重新注入（存储未被删） |

## 迁移（破坏性变更）

- **数据目录搬迁**：见上文"数据迁移（`migrateFrom` → `dataDir`）"——标记文件、业务同口径计数、锁、源目录保留。
- **配置键破坏性变更**：`maintenanceIntervalMinutes` 已移除，改用 `maintenanceCron`；旧键不会静默失效，而是 `MEM_E_CONFIG_DEPRECATED`（`details.replacement='maintenanceCron'`），激活即失败，逼出显式修改。`bootCheck`、`maxSegmentRecords` 顶层键同样不再接受，分别由 `policy.maintenance.bootCheck` / `policy.maintenance.maxSegmentRecords` 表达。
- 索引 schema 版本在 `index/gen-*/manifest.json` 的 `version`；旧代不兼容时由维护重建，`recall` 期间继续读旧代（双缓冲），不需要停服。
- 日志 `record.v` 升版：新代码必须能读旧 `v`，写永远写最新 `v`；不提供回写旧版工具（append-only）。
- 语义事件只增不改；`semantic_retire` 表达退场，便于审计。

## 已知取舍

1. 文本向量用词集 Jaccard 而非 embedding：零依赖、可测试；换成向量只需替换 `src/retrieval.js` 的 `similarity()`。
2. 巩固摘要是抽取式（模板 + 前 600 字符），不是 LLM 生成：可回滚、可复现；LLM 摘要应作为后续迭代的可选 provider。
3. 活跃集合只由维护任务改写；`remember` 通过 A/B 双缓冲把新事件写进 standby 缓冲并翻转指针，立即可检索但不即时改常驻集（在线不裁决）。
4. L2.5 只在维护时晋升/淘汰（不阻塞在线路径），代价是"热点趋势"最多延迟一个维护周期才被隔离；爆发检测用内容归一化分组（去掉空白/大小写差异），不做语义聚类。
5. 上下文分页的 token 数是 `ceil(len/4)` 估算，不是真实 tokenizer：预算偏保守（少注入比溢出安全），接真实 tokenizer 只需替换 `estimateTokens()`。
6. `event_time` 默认由内容推导意味着"日期是内容的函数、不是现实的函数"：这换来可重放的身份，但把日期当新鲜度用会失真。因此**检索新鲜度不用它**：`time_source==='content'` 的事件用 `log_time` 做 recency anchor（见"评分与预算"），推导日期只作为身份坐标与展示。调用方知道真实发生时间时仍应传 `happened_at`——它会把 `time_source` 变成 `explicit`，从而锚点也换成真实时间。

## 身份、幂等与双缓冲（v2）

- **规范化**：`canonicaliseValue()` 递归排序对象键、折叠空白、`-0 → 0`、小数整数化（`1.0 → 1`）、NFC + 全角→半角。`content_hash = sha256(canonicalPayload({content,tags(有序),salience,meta,entity}))`，不含 `event_time`/写入时钟。
- **确定性 id**：`event_id = 'ev_' + f(content_hash, event_time, occurrence_index)`；`controlId` 同法用于 reinforce/forget/restore 记录，故重放整条日志得到同一 id 序列。
- **独立幂等索引**：`identity/ledger.jsonl` 保存 `(content_hash,event_time) → event_id` 与 `clientKey → event_id`；命中即返回既有 id 且**不写主日志**。`occurrence_index` 让"同一内容、同一时间、两次真实发生"各得其 id。
- **event_time 来源**：`policy.identity.eventTimePolicy`，默认 `content`（从内容哈希映射到 `[2024-01-01, +400d)`，纯确定性）；`explicit` 要求调用方给时间，缺失抛 `MEM_E_EVENT_TIME_REQUIRED`；`ingest` 才允许用注入时钟。**测试与生产都不让 `now()` 进入身份**。
- **DLQ**：空内容/不可解析事件写入 `log/dlq.jsonl` 并返回 `status:'dead-letter'`，绝不覆盖已存事件（同名同秒内容不同 → 两个 occurrence，各自 id）。
- **A/B 双缓冲**：`IndexManager` 持有 `_active`(A) 与 `_standby`(B)。重建三阶段 `BUILD → CATCH-UP(≤3 轮重放水位后新记录) → SWAP`；读路径只解析一次 `_active`，切换是一次指针赋值，无锁、无半成品可见。`hooks.beforeSwap` 暴露屏障供测试挂起写线程。
- **防复活**：重建的输入是 `日志 − Tombstones`，`foldRecords` 先过滤墓碑；删除流水线在 purge 阶段写墓碑，`restore` 才撤销。

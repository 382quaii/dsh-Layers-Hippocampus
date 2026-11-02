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
state/graph.json                 知识图谱缓存（派生）
state/tag-tree.json              L1.5 标签层级树 + 幽灵宽限 + 待修剪队列（派生）
```

**身份三层（不可混用）**：`entity_id` = 实体（跨修订恒定）；`event_id` = 某一次发生，`ev_` + 26 位，由 `content_hash + event_time + occurrence_index` 确定性推出；`content_hash` = 载荷等价类（JSON 键排序、空白折叠、`1.0 → 1`、全半角统一后哈希）。**随机数与写入时钟都不进哈希**，所以同一输入重放得到同一 id 序列。

**真相源**：`log/gen-*/seg-*.jsonl`、`log/tombstones.jsonl`、`identity/ledger.jsonl` 与 `semantic/sem.log.jsonl`（+ `semantic/temp.log.jsonl` 的隔离账本）。
**可重建**：`index/**`、`active-set.json`、`diary.json`、`temp.log.jsonl` 的折叠视图、`state/graph.json`、`state/tag-tree.json`。删掉 `index/` 后 `action=maintain` 可逐字节重建（digest 相同，见测试）；重建的输入是 **日志 − 墓碑**，因此已删事件不会被"重建复活"。

**L1.5 的例外与代价**：标签树的**活树**同样由 `maintain()` 从索引重建；但"幽灵"（宽限中的 mid）是**跨维护的生命周期状态**，纯重建看不到已经死掉的子树，所以维护会读取上一份 `state/tag-tree.json` 做 carry-forward（失去全部活引用的节点以 `refCount=0` 接回，孤儿丢弃）。因此删除该文件只会丢失**幽灵历史**，不会影响活树——与 `graph.json` 同级的派生缓存定位。

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
    # ---- L1.5 标签层级树（幽灵宽限）----
    tagTree:
      midHalfLifeMultiplier: 3        # mid 半衰期 = 倍率 × leaf 半衰期（1 天）
      midGracePeriodDays: 30          # 失去最后一个叶子后的宽限天数
      pruneBatchSize: 100             # 每次维护最多修剪的叶子数（有界批次）
      leafDecayFloor: 0               # 0 = 只按引用归零死亡
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
| `tagTree.midHalfLifeMultiplier` | 1 – 10 | `CONFIG_OUT_OF_RANGE` | mid 半衰期；`state/tag-tree.json: nodes[].halfLifeDays` |
| `tagTree.midGracePeriodDays` | 7 – 180 | `CONFIG_OUT_OF_RANGE` | `state/tag-tree.json: nodes[].graceUntil` |
| `tagTree.pruneBatchSize` | 10 – 500 | `CONFIG_OUT_OF_RANGE` | 每次维护的修剪批上限；剩余队列落盘 |
| `tagTree.leafDecayFloor` | 0 – 1 | `CONFIG_OUT_OF_RANGE` | 排队的死叶是否按衰减地板修剪 |
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

## 写入路径（1.4.3：stage → commitMany / 缓冲 / 崩溃可见）

顺序写入曾经只有 ~100 条/秒：每条 `remember` 都重写 ledger、重写日志 manifest，并**整表重建索引**（O(n²)）。现在的纪律：

- **`stage()` → `commitMany()`**：`remember` 先 stage（校验 + 身份解析 + 构造记录，只改内存 ledger，不碰日志/索引），再 commitMany（**一次** append + **一次** ledger checkpoint + **一次** lazy 索引 delta + **一次** briefing 失效）。`bulkIngest` 每 50 条调用一次 commitMany，所以一个 chunk 是一次真实写入，而不是 50 次。
- **日志追加缓冲**：热路径保留一个 append 句柄，`fs.writeSync` 落 page cache（本进程立即可读）；fsync + manifest 由 200ms 定时器、`close()`、以及任何 `rewrite()/compact()` 前的 `flushSync()` 完成。跨进程崩溃最多丢/滞后 **200ms** 的 checkpoint，不会丢已写的日志行。
- **崩溃可见**：`LogStore.status().unflushedBytes` = 分片文件大小 − manifest 计数字节。boot check 见到它 > 0 就判 `stale` 并重建索引——否则崩溃前的尾记录会被"计数恰好相等"的假象藏起来。
- **ledger 延迟 checkpoint**（500ms / close）：它是可从日志重建的启动提示，不是真相源，所以不需要每条都 O(n) 重写。
- **索引追加惰性化**：`applyRecords` 只拼接 `_records` 并置 `_dirty`；下一次 `snapshot()` 一次折叠。读路径的 `snapshot()` 是同步纯函数折叠，因此"await 完 remember 立刻 recall"仍然读得到；N 次写只付一次建索引成本。
- **briefing 脏标记**：写只置脏，下一次 `briefing()`/面板轮询才重算一次。
- **实测**：顺序 `remember` ×1000 **119/s → 9104/s**（8.4s → 110ms），10⁵ 事件的回归测试仍全绿。

## 原始回合取证：`deep_raw` 扫描顺序（1.4.3）

- **最新优先**：分片内从尾部倒序扫描（先 newest shard、再 newest line），时间窗仍是硬约束。旧实现从文件头正序扫描，5000 回合预算永远花在最旧的数据上——10k 分片里最新的记录根本查不到，这是黑匣子语义的反转。单分片大小本身由 `raw.maxBytesPerDay` 约束（默认 8MB），整片读入是有界的。
- **预算来自 config**：`raw.maxScanTurns`（默认 5000，范围 500–50 000，UI 可调），不再使用隐藏常量；`raw.maxScanMb` 仍限制累计字节。命中超出任一预算 → `truncated: true` + `notes` 说明，绝不静默假装"没有"。
- **⚠ 尾扫偏置（明确的已知代价）**：单分片超过 `maxScanTurns` 时，一次调用只覆盖该分片**最新的 N 条**；更早的历史需要 ① 调大 `raw.maxScanTurns`（上限 50 000），或 ② 按时间窗分页（逐步前移 `end_time`，多次查询不同窗口）。这是"查新优先"的直接代价，返回体用 `truncated: true` + notes 明确告知未扫完；不存在静默的空结果。
- 回归护栏：四字段 schema、tombstone 跳过、read-side 脱敏、token 预算、`hash_` 精确恢复全部不变。

## L2.5 趋势隔离层（晋升 / 淘汰）

大语料喂出来的模型会把**语料统计热词**（梗、一时流行语、群体腔调）当成用户特质，于是变成"不正经"的助手：它学的是人群，不是这个人。所以趋势不得直接成为特质。

- 入口两条：① `memory_remember({ is_transient_trend: true })`；② 维护时**爆发检测**（同内容在 `burstWindowDays=3` 天内出现 ≥ `burstMinOccurrences=3` 次）。入口只创建隔离条目，不写 L3。
- 收益比：`temp_observe` 记录来源 eventId（去重），`hitCount` = 聚合确认次数；重复维护对同一批事件是**幂等**的（同源事件不重复计数）。
- 出口只有两条，在 TTL 到期时由维护裁决：
  1. **晋升**：`lastHitAt ≥ expiresAt - promotionWindowDays`（到期前 20 天窗口内有强化）**且** `hitCount ≥ 2`（聚合确认）→ 写入 L3（`title: "Trend: …"`，confidence `0.5+0.1·hitCount`），隔离条目冻结为 `permanent`。没有调用就不晋升：晋升是维护的产出，不是交互的一部分。
  2. **淘汰**：其余一律物理删除，并重写 `temp.log.jsonl`（临时文件 + rename），不留字节。
- 检索兼容：隔离条目可被召回，但 `priority: "temp"`，分数乘 `retrievalPenalty=0.4`，并带 `ttlDays`/`expiresAt`；已过期未裁决的不返回（否则 TTL 是假的）。
- 幂等与不复活：已晋升的条目再被提及 → `{action:"ignored", reason:"status:permanent"}`，不会重新进入隔离。

## L1.5 标签层级树（幽灵宽限）

层级标签（`tech/frontend/vue3`）先于 L2.5 成为"记忆的形状"：一棵**派生**的三层树，由 `maintain()` 从收敛后的索引投影，写在 `state/tag-tree.json`。宪章约束与实现纪律：

- **引擎主导**：树的生长/衰亡只在维护时钟上发生；读取路径（`memory_recall`、图谱路由）只读缓存，绝不扫描或裁决。
- **三种寿命**：`root` 永生（含无 `/` 的扁平根 `project:dsh`）；`leaf` 引用归零即死；`mid` 失去最后一个孩子后进入 `midGracePeriodDays` 宽限，期内**幽灵**（可被新叶子复活），到期且衰减 `decayScore < 0.05` 才消亡。
- **有界批次 + 落盘队列**：死叶先入 `pendingQueue`，每次维护只消费 `pruneBatchSize` 条，剩余队列与整棵树在**同一次原子写**里落盘。10k 死叶分多次排空，绝不制造"剪枝风暴"；重启不丢队列。
- **衰减按实时 `now` 重算**：节点上的 `decayScore` 只是上一轮投影的展示值；生死判定一律以 `updatedAt` 与本次维护的 `now` 现算。冻结分数会让宽限期永远不到期——这是 v1.4.2 修掉的真实缺陷。
- **carry-forward**：纯重建只看活事件，一个只剩死亡的子树会在同一次 rebuild 里整体消失，宽限/幽灵就永远观察不到。因此维护把上一份缓存里"失去全部活引用"的节点以 `refCount=0` 接回（**孤儿直接丢弃，不伪造根**），再走同一套 prune。这使 `tag-tree.json` 成为与 `graph.json` 同级的派生缓存：可删，代价仅是幽灵历史。
- **反幻觉降级（`memory_recall`）**：只经由宽限 mid 到达的命中，其正文（`snippet`/`content`/`score`）被**整条移除**，改为一组元数据 `ghostHints[]`：`mid / path / count / graceUntil / graceDaysLeft / window / hint`；`hint` 引导 `deep_raw` 并给出时间窗（取 `day`＝anchorTime 的日界，而非可能由内容哈希推导的 `event_time`）。查询点名宽限 mid 而索引无实体命中时返回 `count:0` 的同一提示，绝不静默空答。语义层（L3）**豁免**：它是蒸馏出的模式而非模糊的实例，"用户以前做前端"不是幻觉。
- **UI 历史视图**：图谱路由同响应带 `tagTree.ghosts`（渲染上限 **50** 条 + `totalGhosts/truncated`；图谱是 O(n²) 力导向，历史全量灌进去就是 UI 性能风暴）；前端把幽灵画成半透明虚线圆节点、挂在父 `root` 下，用 CSS `opacity 420ms` 做"仅活跃 / 历史全貌"的淡入淡出，布局键不含开关状态，切换不重排。

## 大标签治理（1.5.0，防 OOM / 防上下文爆炸）

海量数据下"标签爆炸"会把倒排索引与上下文同时撑爆。1.5.0 在**物理层**加三道闸门，全部只增不减地保留日志真相：

- **索引截断**：`deriveTagTable` 每个标签最多保留 `index.maxPostingsPerTag`（默认 500）个 postings。超限时保留序为 `salience desc → eventTime desc → eventId asc`，再按检索序 `eventTime desc` 重排；`eventCount` / `mass` / `lastSeen` 仍按**全部事件**聚合（降级提示里的 N 才是真实总数），被丢弃的只是内存指针。标签带 `postingsLimit/postingsTruncated/postingsDropped`，索引 `stats` 带汇总。重建与惰性折叠（`_ensureFresh`）走同一条上限（`IndexManager.getMaxPostingsPerTag` 实时读配置）。
- **检索降级**：显式 `tags` 命中 `eventCount > 50`（`TAG_OVERFLOW_THRESHOLD`）时不展开候选、不唤醒图关联、也抑制 coarse-block 回退；返回一条 `oversizedTagHints`（含该标签 postings 的时间窗）与固定提示文案。调用方"坚持"（同标签再次查询，进程内记录）时只返回最近 3 条摘要（`OVERSIZED_TAG_RECENT`），绝不返回全量列表。
- **深层检索时间窗**：`deep_raw` 命中关联数 > 500（`SUPER_TAG_THRESHOLD`）的标签时**必须**给时间窗，缺失抛 `MEM_E_TIME_RANGE_REQUIRED`；非超级标签保持原 `MEM_E_INVALID_INPUT`。判定只在引擎一处，工具不再前置校验。

## 多空间路由与会话交接（1.5.0，纯物理层）

权限编排留给未来的 Orchestrator 插件；海马体只做物理路由与上下文记账。

- **空间 = 独立存储目录**：`default` 复用原 dataDir（旧行为字节不变），`<dataDir>/spaces/<spaceId>/` 是子空间（各自 log/index/state/semantic/raw）。`remember`/`recall` 的 `targetSpaceId` 由 `SpaceRouter` 解析；id 即目录名，故强校验 `^[a-z0-9][a-z0-9._-]{0,63}$`，非法直接 `MEM_E_INVALID_INPUT`，绝不静默落默认空间。
- **每空间一条 FIFO 锁**：同空间操作串行、跨空间并发（`SpaceRouter.run` 每 id 一条 promise 链）。单一全局锁会把两个独立空间变回一条队列，正是要消除的跨空间停顿；`runMany` 按 id 排序嵌套加锁，避免 ABBA 死锁。
- **原生保真 / 分层折叠**：`ContextEngine.nativeState()` 有效占用 = `max(块表 token, 会话 token)`；`< nativeTokenLimit` 为 `native` 模式（Qwen：逐字保留，**绝不折叠**），`>=` 为 `layered`（允许 L1.5 折叠）。旧 `maxTokens` 分页阈值与淘汰算法完全未动，`enforce()` 只是**新增** `native-force` 分支。
- **自动交接（转生）**：有效占用达到 `autoRolloverThreshold × nativeTokenLimit` 时，`Memory.checkHandoff()` 把窗口末尾（或最新索引事件）提炼为**一条** L1.5 摘要（`status:handoff`，含 `status:folded` 标记），写 `state/handoff.json`（含 tokenSource/sessionId/ratio/summaryEventId），`runtime.promptState()` 在**易变尾部**追加 `[交接标记]`。幂等：marker 已 active 不再重复提炼；新会话（`observeSessionTokens` 检测到新 id）消费 marker（`active:false, consumedBy`）。会话 token 由 `session/event` 逐轮估算，**独立于 raw 门控**，raw 关闭也能交接。
- **关闭交接**：不写 marker；`enforce()` 在 95% 时强制驱逐到 `min(target×maxTokens, target×nativeTokenLimit)`，返回 `reason:"native-force"`。
- **状态面**：`panel.session`（mode/tokens/nativeTokenLimit/threshold/remainingTokens/rolloverEnabled/handoffActive…）与 `panel.spaces`（current/ids/open）是 UI 状态栏与空间面板的数据源。

## 跨空间安全迁移（1.5.0）与显式用户授权闸门（1.5.1）

`memory_space_transfer` / `memory_transfer_to_global` / `POST /api/hippocampus/transfer` → `Memory.transferEvents` → `transferBetweenSpaces`：

- **SECURITY：迁移 = 数据外发，模型绝无自主权**（1.5.1）。`context.requireExplicitConsentForTransfer`（默认 **true**）为真时，`Memory.transferEvents` 在**校验空间 id、打开存储、读取内容、挂起待删之前**检查 `userApproved === true`；缺失即抛 `MEM_E_REQUIRE_USER_CONSENT`（固定文案 `[系统拦截] 跨空间传递需要用户明确授权。请向用户确认后再试。`），被拒绝的调用零副作用。工具层只把模型显式给出的 `user_approved:true` 传下去；模型看到拦截必须停下、向用户确认后才能重试。
- **两条通道严格分离**：Agent 工具 → 引擎闸门（需 `user_approved`）；浏览器面板 → `POST /api/hippocampus/transfer`，该路由是**人类通道**，自身标记 `userApproved:true`（同源已鉴权浏览器请求）。Agent 半边无法访问 HTTP 路由，因此不存在“模型自己点按钮”的绕过路径；面板“最近记忆”每行的「分享/转移」按钮走的就是这条通道。
- **提示词层红线**：`memory:policy` 常驻 `【🚨最高安全红线】` 静态段，点名两个工具、禁止自行判断/同情心/“更好地跨端共享”触发、唯一允许条件与不确定时的询问话术，并说明 `MEM_E_REQUIRE_USER_CONSENT` 的重试协议（且明令不可自我批准）。
- **先校验、再读、后写**：mode ∈ {copy, move}；id 必须存在（墓碑事件按缺失处理）；**隐私安检**命中身份证/手机号/银行卡/邮箱/凭据赋值/PEM 私钥时整批 `MEM_E_PRIVACY_BLOCKED`，目标与源都不写、不挂删除，`details.ids/categories` 绝不回传命中原文；`meta` 深拷贝并剥离 `raw_turn/rawTurn/raw_*`。
- **身份重生**：目标空间用 `remember({dedupe:false})` 重新分配 `event_id`（绝不复用源 id），并打 `transferred:from:<src>` / `transferred:to:<dst>` 标签。
- **copy vs move**：`copy` 源保持 `retained`；`move` 仅在**全部目标写入成功后**调用 `source.pendingDeletes.request({graceHours ≥ 1})`，源进入两阶段删除（可 `restore` 取消），**绝不直接物理删除**；目标部分失败则源完全不动。
- **`GET /api/hippocampus/memories`**（1.5.1）：只读最近记忆投影（`limit`/`space`，索引快照排序，不发全文），供面板逐条展示与人工触发迁移。

## UI 架构纠偏（1.5.2）：物理迁移与业务迁移解耦 + 全局空间选择器

纠偏前的 UI 把两件无关的事混在一个面板：`dataDir` 物理换盘迁移 与 业务 `event_ids` 跨空间复制/剪切；且让用户手填 `target_space_id`。1.5.2 重构为三条互不共享状态的链路：

- **物理迁移（系统级）**：`StorageMigratorUI`（设置页底部独立 Section）→ `POST /config { dataDir }` → `runtime.startMigration` → `MigrationRunner`（A/B 双缓冲、`state=migrating`、复制→校验→切换、旧目录保留为备份）。与业务迁移**不共享队列、不共享状态、不共享 UI**：失败不会产生 `pending_delete`，被拒绝的迁移也不碰任何记忆。Fail-Fast 在 `validateMigrationPaths` 同步完成：空/相对/等于当前/位于当前内/磁盘根 → `MEM_E_MIGRATION_PATH`；目标存在且非空 → `MEM_E_MIGRATION_TARGET_BUSY`；目标存在但不是目录 → `MEM_E_MIGRATION_PATH`。全部发生在返回 202、启动后台任务之前。
- **全局空间选择器（SpaceSelector）**：面板 Header 一个 `<select>`（默认/工作/私人/全局 + `＋ 新建空间`），选中即全局状态（`spaceStore` + `space-changed` bus），面板与设置页共用。所有读取 hook 追加 `?space=<id>`：`stats` / `graph` / `memories`；后端 `runtime.uiPayload(spaceId)` / `graphPayload(spaceId)` 调用 `Memory.status({targetSpaceId})` / `Memory.graphForSpace({targetSpaceId})`，命名空间走各自子存储与独立锁。因此记忆列表、图谱、L1 日志/索引、L2.5、L3、L1.5 标签树与会话状态栏全部是**选中空间的数据**，切换不串流（`panel.spaces.current` 也报告选中空间，不再恒为 default）。`POST /spaces { space_id }` 创建**空**空间，绝不是复制。
- **业务迁移（受控流程）**：面板勾选记忆 → `移动到…` → 第一步 `即将向 [目标空间] 发起迁移请求` → 第二步 `二次确认 · 安全红线`（剪切另有警告）→ 才发送 `user_approved: true`。目标空间来自下拉，**没有 `target_space_id` 文本输入**。HTTP 路由不再自行标记授权：缺失 `user_approved` 与 AI 工具调用一样被引擎闸门拦截（`MEM_E_REQUIRE_USER_CONSENT`），所以“底层 API 绕 UI”也被堵死。

## 自动交接状态机加固（1.5.4）

交接已从"尽力而为的摘要"升级为**不可死锁的状态机**：

- `checkHandoff()` 永不 reject：摘要抛错、蒸馏超时（默认 5s，可注入测试）或 marker 写入失败，都会降级为 `state:"failed"` 的 active marker（含 `summaryError`），并立即返回；新会话照常启动。
- `observeSessionTokens()`：新 session id **立即建立自己的基线**、消费不属于本 session 的 marker、释放 `_handoffInFlight`；同 key 但 token 估计腰斩视为重启，同样重置。
- `_distillHandoffTail()`：按 `status:handoff` 标签与 `交接摘要` 文本前缀双重过滤（索引回退路径同样过滤），输出硬上限 1200 字符，杜绝"摘要套娃"。
- `status:handoff` 摘要在普通 recall 中按 **2% 权重**排序、永不进入普通记忆列表；真实事实优先。
- 逃生舱：`resetSessionState()`、`memory_admin action=reset_session`、`POST /api/hippocampus/session/reset`、设置页按钮；脏数据由 `repairHandoffSummaries()` / `scripts/repair-handoff.mjs` 默认 dry-run 后进入两阶段待删队列。

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
| `tagTree.available` | 标签树缓存是否已生成（首次维护前为 `false`） | `state/tag-tree.json` 是否存在且 schema 匹配 |
| `tagTree.nodeCount` | 树节点总数（root+mid+leaf） | `state/tag-tree.json: stats.nodes` |
| `tagTree.ghostCount` | 宽限期内的 mid 数（幽灵） | `stats.ghosts` |
| `tagTree.roots` / `mids` / `leaves` | 各层节点数 | `stats.*` |
| `tagTree.pendingQueue` | 待修剪队列剩余条数（跨维护排空中） | `state/tag-tree.json: pendingQueue` |
| `tagTree.generatedAt` / `sourceIndexGeneration` / `stale` | 生成时刻、来源索引代、与当前索引代是否不一致 | 缓存文件与 `indexManager.generation` |

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
- `memory-state` 段（order 220）每次装配时读 `runtime.promptState()`，由 `composePrompt()` 按**缓存稳定顺序**拼装：
  `[稳定规则] → [Memory Map]（活跃标签+计数，慢变） → [Memory Blocks]（存活块，唯一的每轮易变尾巴）`。
  前缀（规则+地图）在配置/标签集合不变时逐字节稳定，只有尾巴随召回块变化；旧的"一行 briefing 直接返回"已废弃（那行含 `events=`，每次写入都会击穿前缀缓存）。回归测试在 `test/plugin.test.js`：同一次会话内召回前后，前缀必须完全相等。
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

- **L1.5 设置**：四个 `tagTree.*` 旋钮用"滑块 + 数字框"双控件（滑块探索、数字框精确），label 的 `title` 是场景化 Tooltip，hint 同时渲染在下方（触屏可读）；保存时以点号路径随整份 patch 提交，最终仍由后端 `resolveConfig` fail-fast 裁决。
- **幽灵节点**：`GET /api/hippocampus/graph` 的 `tagTree.ghosts` 与本图谱同响应返回；前端合成 `root → ghost` 两条边和半透明虚线节点，`仅活跃 / 历史全貌` 只改 CSS opacity（420ms 过渡），不触发力导向重排。`title` 元素展示路径与剩余宽限期。

## HTTP 路由（Client → Host 的唯一通道）

浏览器不能调 Agent 工具，面板数据与配置写回都走这两条路由（`src/webRoutes.js`，挂在 `ctx.webServer.register`，`kind:'exact'`，同源，无需鉴权）：

| 方法 | 路径 | 返回 / 语义 |
| --- | --- | --- |
| `GET` | `/api/hippocampus/stats` | `{ok, phase, phaseError, panel, briefing, config}`；**未 READY 回 503**（`{ok:false, code:'MEM_E_NOT_READY', phase}`），面板据此渲染启动态 |
| `GET` | `/api/hippocampus/config` | 只含可编辑子集：`enableDream/enableReflection/dreamIdleMinutes/context.{maxTokens,threshold,target}/temp.ttlDays/tagTree.*/…` |
| `POST` | `/api/hippocampus/config` | body `{patch:{...}}`（≤16 KiB）→ 校验 → 内存生效 → 尝试持久化 → `{ok, config, persisted, note?}` |
| `GET` | `/api/hippocampus/graph` | 缓存图谱 `.slice(0, graphMaxEdges)` + `tagTree.ghosts`（历史视图元数据，≤200 条） |

- 未知键 → `400 MEM_E_CONFIG_UNKNOWN_KEY`；值越界 → `400 MEM_E_CONFIG_OUT_OF_RANGE`；坏 JSON → `400 MEM_E_INVALID_INPUT`；非 GET/POST → `405`。
- **生效与持久化分离**：`runtime.updateConfig(patch)` 先 `resolveConfig` 校验再原子替换运行配置（失败则运行配置不动）；持久化走 `configEditor.entries()/edit()`（Loader 自己的写配置路径）。没有 `configEditor` 时返回 `persisted:false` 与 `note`，前端如实显示"已生效，重启前不持久"。
- 热更新的落地字段：`context.maxTokens/threshold/target` 直接写 `ContextEngine` 的 override（下一次 `enforce()` 即生效）；`dreamIdleMinutes/enableDream/enableReflection` 由 runtime 每 tick 读取；其余分组（`raw.*`、`tagTree.*`、`delete.*`、`context.*` 的运行时旋钮等）由 `applyConfig` 投影到运行中的 `Memory.config`，下一个使用点/下一次维护即生效——设置页"保存后立即生效"不是口号。`context.minInjectConfidence` 已于 1.5.3 移除，旧配置带该键会 fail-fast。

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
| `MEM_E_TIME_RANGE_REQUIRED` | `deep_raw` 命中超级大标签（>500 关联）但缺 `start_time`/`end_time`（1.5.0） | 补时间窗（或改用窄查询） |
| `MEM_E_PRIVACY_BLOCKED` | 跨空间迁移命中隐私敏感内容，整批被拦（1.5.0） | 先脱敏/移除该事件再迁移 |
| `MEM_E_REQUIRE_USER_CONSENT` | 模型侧迁移调用缺 `user_approved:true` 且 `context.requireExplicitConsentForTransfer` 为真（1.5.1） | 停下向用户确认，用户同意后带 `user_approved:true` 重试（UI 人工通道不受影响） |
| `MEM_E_SPACE_INVALID` | 新建空间名非法/保留/已存在/路径冲突（1.5.3），写盘前拦截 | 换一个合法且未占用的空间名（小写字母/数字开头，a-z 0-9 . _ -，≤64） |
| `MEM_E_INVALID_TOOL_NAME` | `tools.disabled` 含未知工具名（如 `remeber`）、核心工具（remember/recall/admin）或重复项（1.5.3） | 只写无 `toolPrefix` 的后缀名；核心工具不可关闭 |
| `MEM_E_HANDOFF_FAILED` | 自动交接摘要生成失败/超时/写 marker 失败（1.5.4）；引擎已降级放行新会话 | 用设置页逃生舱或 `memory_admin action=reset_session` 清状态；不阻塞新会话 |
| `MEM_E_WRITER_BUSY` | 写者互斥争用 | 重试 |
| `MEM_E_CLOCK_INVALID` / `MEM_E_IO` | 时钟回退 / 磁盘错误 | 检查环境 |

## 测试

```powershell
# 本机沙箱里 node --test 的子进程 spawn 会 EPERM，用进程内运行器：
& "C:\Users\86135\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" test/run.mjs
# 只看一组：$env:MEM_TEST_ONLY='lifecycle'
# 加长看门狗：$env:MEM_TEST_TIMEOUT_MS='120000'
```

运行器带**看门狗**：默认 **60s**（`MEM_TEST_TIMEOUT_MS` 可调）仍未退出，就打印**卡住时正在导入/执行的文件、最后完成的测试名与完成数、活动资源、尚未触发的定时器**，然后 `process.exit(1)`。它不会用 `process.exit(0)` 掩盖超时——挂起即失败。`MEM_TEST_TRACE=1` 可看文件级进度，`MEM_TEST_ONLY=<子串>` 只跑一组。

295 个用例（40 个文件）覆盖：

- 索引与标签：重建 digest 一致、行号漂移防护（eventId 不变、行号变）、同义合并、活跃集 cap 挤出、规则变更不改清单、空活跃集降级、top-k 有界有序去重。
- 衰减与删除：30 天半衰期、reinforce 移动锚点（不存字段）、仅文本粗筛、标签过滤、维护代切换且旧代可读、boot 检查、压缩不丢记录、并发维护串行化、四阶段删除、archive 可回滚 vs purge 不可、strict 巩固暂停与恢复、任务重放幂等、错误 id 零变更。
- 插件面：配置默认值与非法输入、非法策略在激活前拒绝、五个工具与两层提示注册/卸载、工具 JSON 往返、结构化错误。
- 新增 L2.5 / 分页：爆发隔离不晋升、仅窗口内强化才晋升（早强化被淘汰）、未强化到期物理删除、已晋升不被重新隔离、按分数淘汰到 target 且存储不变、pinned 不淘汰 + 衰减排序。
- 身份与幂等：规范化对抗（键序/空白/`1.0` vs `1`/全半角 → 同 hash）、`event_id` 纯函数性（同输入同 id、换 occurrence 或时间即换 id）、确定性重放（两次运行 id 序列相同）、同载荷同时间 → `duplicate` 且日志不增、同秒不同内容 → 两个 id、非法内容进 DLQ 且不覆盖已存事件。
- 双缓冲与防复活：在 `beforeSwap` 屏障挂起写线程时，读线程解析到**完整旧快照**；放行后见到**完整新快照**。重建输入 = 日志 − 墓碑，按 tag 比对 `event_id` 集合（无序相等）、关联强度 1e-9 容差、共用同一注入时钟；`stats.suppressedByTombstone` 计数。
- 配置与调度（新增 4 个文件 / 30 个用例）：默认值、非法 cron、越界阈值、未知枚举、未知键、别名冲突全为 `MEM_E_CONFIG_*` 硬失败；deprecated 键抛 `CONFIG_DEPRECATED` 并带 `replacement`；cron 匹配/步进/DOM-DOW OR/`nextRun` 严格递进；维护重入时下一 tick 跳过且不并发、错过窗口不补跑、失败记录后继续；迁移的已迁移幂等、无标记中断、源不存在、锁冲突、无源禁用。
- 生命周期（`test/lifecycle.test.js`，10 个用例）：工具 schema 根对象（含 `memory_admin`）；READY 前读写均为 `MEM_E_NOT_READY`；迁移窗口读旧目录并标 `readFrom:"legacy"`；dream 空闲触发；重入只跑一次；反思段达阈值才出文本；迁移锁的活 pid/死 pid/释放；uiPayload 由 Host 提供而 Host 不注册视觉面；运行器看门狗断言。
- HTTP 路由（`test/webRoutes.test.js`，12 个用例）：stats 的 200/503；config 的 GET 子集与 POST 生效+持久化；未知键/越界/坏 JSON 的 400 与错误码透传；405；`registerMemoryRoutes` 注册与 dispose；`validatePatch` 拒绝非对象；四个 `tagTree.*` 在可编辑白名单内且嵌套成组。
- Client 包（`test/clientSlot.test.js`，19 个用例）：`__ModuleLoader__` 工厂纯度、`inject:['slots']`、三个注册的 id/key 与顺序、dispose 全部执行、图标是纯 SVG、`index.js` 不含 React/DOM、设置页覆盖全部键、L1.5 滑块+数字框+Tooltip、幽灵节点与"仅活跃/历史全貌"淡入淡出（并锁定布局键不含开关状态）；`ghostGraphParts()` 纯函数直接断言幽灵节点/root 锚点/边。
- L1.5 标签树（`test/tagTree.test.js` 11 + `test/tagTreeMaintenance.test.js` 8）：纯函数（层级解析、实时衰减重算、release 队列、carry-forward、孤儿丢弃、配置半衰期）；集成（原子发布/来源代/顺序稳定、leaf→ghost→mid 死亡级联、复活、25 死叶分批 10/10/5/0、损坏缓存自愈、删缓存只丢幽灵、`tagTreeView` 只发幽灵元数据）。
- 反幻觉召回（`test/ghostRecall.test.js`，3 个用例 + `test/retrieval.test.js` 单元）：宽限 mid 命中正文被物理移除、按 mid 聚合计数、点名宽限 mid 无命中时 `count:0` 提示、维护复活后正文恢复、`panel.tagTree.ghostCount` 跟随。
- 写入路径与 `deep_raw`（`test/v143.test.js`，9 个用例）：`stage` 不写日志、`commitMany` 一次写、`bulkIngest` 分块/幂等/失败隔离、briefing 脏刷新、日志 `close()` checkpoint、崩溃可见字节、**200ms 窗口内被 kill 后重启检测 stale 并重建尾索引**、`raw.maxScanTurns` 默认值/范围/HTTP 可编辑、最新优先扫描与预算截断。
- 全链路接线（`test/plugin.test.js` 新增 2 个用例）：`memory-state` 由 `composePrompt` 输出 `规则 → [Memory Map] → [Memory Blocks]`，召回注入后**前缀逐字节不变**、尾巴出现召回块；`memory_admin maintain` 真正落盘 `state/tag-tree.json`，`memory_forget`+maintain 后工具层 `memory_recall` 只返回 `ghostHints`（正文不泄漏、含 `deep_raw` 提示），`memory_admin status` 的 `panel.tagTree.ghostCount` 与缓存一致。
- 面板：`status().panel` 形状快照（键全集，防漏字段）+ 值快照；写入后 `events/activeTags` 跟随；`cumulativeSavedTokens` 跨 reopen 保持（`state/context.json`）；`queuedDeletes` 取自删除流水线而非独立计数器；`indexGeneration` 每次 rebuild 恰好 +1。
- v1.5.0 六组新用例：`v150.index.test.js`（截断保序/真实计数/降级→坚持 3 条/超级标签时间窗）；`v150.space.test.js`（跨空间并发 vs 同空间 FIFO/目录隔离/非法 id/native 边界/95% 强驱逐/旧阈值回归）；`v150.transfer.test.js`（copy 保留、move 两阶段、隐私拦截、raw_turn 剥离、新 id、部分失败不改源）；`v150.ui.test.js`（bundle 契约、状态栏/过滤/软跟随纯函数、无防抖、Footer 文案、transfer 路由）；`v150.lifecycle.test.js`（Qwen 原生折叠门、阈值交接+标记注入+新会话消费、空间隔离、第九工具）；`v150.config.test.js`（两个新组默认值/范围/HTTP 可编辑）。
- v1.5.1 安全补丁（`test/v151.consent.test.js`，9 个用例）：默认开闸 + 布尔 fail-fast；闸门先于校验/IO（非法目标也先回 CONSENT、不挂待删、源不变）；工具无 `user_approved` 被拦、带 `user_approved:true` 成功；`memory_transfer_to_global` 同契约并落到 `global`；显式关闭配置后才放行；`Memory.transferEvents` 引擎层同契约；`memory:policy` 红线文案标记；HTTP 路由不再伪造授权（缺 `user_approved` 与工具同拦）；面板使用 SpaceSelector + 勾选 `移动到…` 流程，手动 id 文本框已删除。
- v1.5.2 架构纠偏（`test/v152.refactor.test.js`，7 个用例）：`dataDir` 校验矩阵（空/相对/相同/内部/根/非空/非目录）与 `startMigration` fail-fast（旧目录完好）；`?space=` 下 stats/graph/memories/session/recall 逐项隔离不串流；`ensureSpace` 创建空空间 + `/spaces` 路由；未授权迁移在引擎与 HTTP 双点被拦、显式授权通过；UI 接线（SpaceSelector 挂载、勾选流程、无手动输入、StorageMigratorUI 独立）。
- v1.5.3 空间创建热修（`test/v153.spaces.test.js`，7 个用例）：客户端 `API` 常量表与后端 `MEMORY_API`/注册路由逐路径相等（路由漂移锁，防再次 404）；用客户端真实路径对注册表派发 POST 并断言 handler 应答 201（不是 router 404）；`validateNewSpaceId` 非法/保留矩阵（空、字符集、`..`、尾点、Windows 设备名、超长）；`Memory.createSpace` 冲突/路径冲突在写盘前抛 `MEM_E_SPACE_INVALID`；HTTP `POST /spaces` 成功 201、重复/非法 400 + `capabilities` 握手；客户端错误映射（404/网络 → 固定人话，绝不泄漏 `HTTP 404`）与能力握手降级（旧宿主显示版本提示而非发请求）。
- v1.5.3 工具裁剪（`test/v155.tools.test.js`，7 个用例）：`tools.disabled` 默认空数组、后缀词表闭集；`remeber`/带前缀名/核心工具/重复项全部 `MEM_E_INVALID_TOOL_NAME`；HTTP 可编辑并走同一校验器；默认 10 个工具零回归；`disabled:["capture","bulk_ingest"]` 时注册表与 `memory` 提示段同时剔除这两个工具；非法名称在 `apply()` 阶段阻断激活且零工具注册。
- v1.5.4 交接状态机加固（`test/v156.handoff.test.js`，9 个用例）：递归摘要同时按 tag 与 `交接摘要` 前缀过滤且输出硬上限 1200 字符；蒸馏抛错/挂起（timeout 可注入）时 `checkHandoff` 不 reject、写 `failed` 降级 marker；新会话必然重置 token 基线、消费旧 marker、释放 in-flight；`status:handoff` 在 recall 中 2% 权重且不进普通列表；`resetSessionState`/admin 工具/HTTP 逃生舱；`repairHandoffSummaries` dry-run 与 pending_delete 归档。
- v1.5.3 发布卫生（`test/v154.release.test.js`，3 个用例）：`minInjectConfidence` 端到端移除（配置 fail-fast、不在 HTTP 白名单、retrieval 无导出、recall 无 confidence/low-confidence 注解、UI 无该键与旧文案）；多空间固定开销（N=10：建空间/写入耗时、每空间字节数 max/min≤1.35、总字节随 N 线性、单空间固定开销<256KB、逐空间冷启动中位耗时<500ms、根启动不 eager 打开子空间 `spaces.open=[]`）；基准协议 `scripts/bench-protocol.mjs` 独立临时库 + 同进程预热 + 5 次取中位数，报告必须带离散度。


## SLO / 容量

| 指标 | 目标 |
| --- | --- |
| 活跃标签集 | 200 条（硬上限，超限挤出） |
| 在线候选 top-k | 默认 20，上限 100 |
| 日记块 | 1 天/块；每块 `maxSegmentRecords` 事件上限 5000 |
| recall P99 | < 50 ms @ 10⁵ 事件 / 5 年日记（索引常驻内存，A/B 双缓冲，切换为单次指针赋值） |
| maintain | 10⁵ 事件 < 3 s，且**不阻塞** recall（写新代，读旧代） |
| 顺序写入 | 1000 条 ≈ 110 ms（实测 9104 条/s；stage 无 I/O，commit 一次 append） |
| 单次 append | < 1 ms 到 page cache；fsync + manifest 每 200ms checkpoint，close()/rewrite() 强制 |
| deep_raw | 分片内最新优先，回合预算 `raw.maxScanTurns`（默认 5000），超出即 `truncated:true` |
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
7. **幽灵历史不是日志的纯函数**：L1.5 的活树可由索引逐字节重建，但"宽限中的 mid"依赖**死亡被观察到的时刻**。因此 `state/tag-tree.json` 采用 carry-forward，与 `graph.json` 同级视为派生缓存：删掉它 = 丢历史幽灵、保活树，不丢任何真相。这是为"不扫全量日志"付出的唯一代价，并且已被测试锁定。
8. **写入路径用 200ms 的 checkpoint 窗口换吞吐**：日志行 `writeSync` 后立刻可读，但 fsync 与 manifest 发布是延迟的（200ms / close / rewrite）。这换来 ~90× 的顺序写入提升；跨进程崩溃最多让最后 200ms 的 checkpoint 滞后，而 `unflushedBytes` + boot check 保证这种滞后会被识别为 stale 并重建，而不是被隐藏。代价与检测手段同时写进了 `test/v143.test.js`。

## 身份、幂等与双缓冲（v2）

- **规范化**：`canonicaliseValue()` 递归排序对象键、折叠空白、`-0 → 0`、小数整数化（`1.0 → 1`）、NFC + 全角→半角。`content_hash = sha256(canonicalPayload({content,tags(有序),salience,meta,entity}))`，不含 `event_time`/写入时钟。
- **确定性 id**：`event_id = 'ev_' + f(content_hash, event_time, occurrence_index)`；`controlId` 同法用于 reinforce/forget/restore 记录，故重放整条日志得到同一 id 序列。
- **独立幂等索引**：`identity/ledger.jsonl` 保存 `(content_hash,event_time) → event_id` 与 `clientKey → event_id`；命中即返回既有 id 且**不写主日志**。`occurrence_index` 让"同一内容、同一时间、两次真实发生"各得其 id。
- **event_time 来源**：`policy.identity.eventTimePolicy`，默认 `content`（从内容哈希映射到 `[2024-01-01, +400d)`，纯确定性）；`explicit` 要求调用方给时间，缺失抛 `MEM_E_EVENT_TIME_REQUIRED`；`ingest` 才允许用注入时钟。**测试与生产都不让 `now()` 进入身份**。
- **DLQ**：空内容/不可解析事件写入 `log/dlq.jsonl` 并返回 `status:'dead-letter'`，绝不覆盖已存事件（同名同秒内容不同 → 两个 occurrence，各自 id）。
- **A/B 双缓冲**：`IndexManager` 持有 `_active`(A) 与 `_standby`(B)。重建三阶段 `BUILD → CATCH-UP(≤3 轮重放水位后新记录) → SWAP`；读路径只解析一次 `_active`，切换是一次指针赋值，无锁、无半成品可见。`hooks.beforeSwap` 暴露屏障供测试挂起写线程。
- **防复活**：重建的输入是 `日志 − Tombstones`，`foldRecords` 先过滤墓碑；删除流水线在 purge 阶段写墓碑，`restore` 才撤销。

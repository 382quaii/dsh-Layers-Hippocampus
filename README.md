# dsh-layers-hippocampus · 海马体记忆

> **本插件不能保证一个会话永生不死，只能保证人格不死。**
>
> 给 DeepSeek Harness（DSH）智能体的分层长期记忆：会话会被截断、被压缩、被交接，
> 但人格、经验与用户偏好沉淀在独立的记忆层里，下一个会话接着活。

| | |
| --- | --- |
| 版本 | **1.6.3** |
| 包名 | `dsh-layers-hippocampus` |
| 仓库 | <https://github.com/382quaii/dsh-Layers-Hippocampus> |
| 许可证 | MIT |
| 运行时依赖 | **零**（Host 只用 Node 内置模块；React 由 Harness 注入） |
| 详细设计 | [docs/ARCHITECTURE.zh.md](docs/ARCHITECTURE.zh.md) |
| 变更记录 | [CHANGELOG.md](CHANGELOG.md) |

---

## 核心特性

以下每一条都对应代码中的真实实现，没有规划中的占位功能。

### 事件溯源（append-only 是唯一真相源）

- 原始事件以 JSONL 追加写入，**不可变**；`event_id` 由内容哈希推导，重复写入天然幂等。
- 标签倒排索引、天日记、语义摘要、知识图谱**全部是可重建的读模型**：删掉 `index/`、
  `state/graph.json`、`state/tag-tree.json` 都安全，下次维护从日志重建。
- **A/B 双缓冲索引**：新索引写入独立代目录（`.tmp-*` → 原子 rename 发布），读者要么看到
  完整旧代、要么看到完整新代，永不加读锁、永不读到半成品。

### 墓碑防复活（Tombstone）

- 删除是**两阶段**的：先进入 `pending_delete` 宽限期（默认 24h，可 `restore`），到期后走
  `tombstone → archive → consolidation → purge`。
- Tombstone 哈希参与 recall 与 `deep_raw` 的过滤：**已遗忘的内容不会因为日志冗余而复活**，
  即使同一段文本再次出现在磁盘上也会被剔除。

### L1–L3 记忆金字塔

| 层 | 内容 | 位置 |
| --- | --- | --- |
| **L1 raw** | 逐回合原始取证（未索引、永不进 prompt，只供 `deep_raw` 与恢复） | `raw/` |
| **L1.5 段记** | L1 内、**日记的下一级**：标签层级树投影（活树 + **幽灵节点**），与 raw 一样**逐日落盘保存** | `state/tag-tree.json` |
| **L2 日记** | 按天滚动的原始日记摘要，带 pinned / 合并逻辑 | `journal/`、`archive/` |
| **L2.5 趋势隔离** | 防热词隔离区：趋势先进这里接受 TTL 考察，**永不直接成为 L3 特质** | `semantic/temp.log.jsonl` |
| **L3 语义** | 独立语义层摘要（置信度、标签、来源事件溯源） | `semantic/` |

- **L1.5 幽灵节点**：叶子归零不会立刻消失，`mid` 半衰期是叶子的 3 倍，修剪按批限量执行；
  历史可见但不占活跃预算。它和 raw 一样是**每日落盘的持久结构**，但属于派生缓存：
  删掉只会丢失幽灵历史，活树由 `maintain()` 从日志重建。

### L2.5 防热词结构（趋势隔离层）

威胁：喂进上万条对话后，模型会把语料里的**统计热词**（网络梗、一次性流行语、群体腔调）
当成用户特质，于是它学到的是人群，不是这个人——这就是“助手变味”。

所以趋势**永远不能直接进 L3**：

- **入口两条**：`memory_remember({ is_transient_trend: true })`，或维护时的**爆发检测**
  （同内容在 `temp.burstWindowDays=3` 天内出现 ≥ `temp.burstMinOccurrences=3` 次）。
  入口只创建隔离条目，**不写 L3**。
- **隔离期**：`temp.ttlDays` 内按 `temp_observe` 累计 `hitCount`，同源事件去重（幂等）。
- **出口只有两条**，到期由维护裁决：
  1. **晋升**：在最后 `promotionWindowDays` 窗口内被强化 **且** `hitCount ≥ 2` → 写入 L3
     （`title: "Trend: …"`，置信度 `0.5 + 0.1·hitCount`）；
  2. **淘汰**：其余一律物理删除并重写 `temp.log.jsonl`，不留字节。
- **检索惩罚**：隔离条目仍可被召回，但 `priority: "temp"`、分数乘 `retrievalPenalty=0.4`，
  并带 `ttlDays` / `expiresAt`；已过期未裁决的不返回。
- **容量闸门**：最多 `temp.maxEntries=500` 条，超限拒绝新条目并回报 `over-cap`。
- **不可复活**：已晋升条目再次被提交 → `{action:"ignored", reason:"status:permanent"}`。

### 自动交接（Handoff）与新会话防呆

- 上下文接近窗口上限时，引擎生成**交接摘要**并写 marker；新会话读取 marker 恢复工作模式
  （`agentPreset`）与进行中的任务，而不是从零开始。
- 交接状态机 `active → consumed | failed`，带超时看门狗：**任何异常都降级为可继续的标记**，
  绝不会把会话卡死。
- 新会话首轮可注入 `[Cold-Start Detected]` 与两段可独立开关的历史块
  （`context.coldStartInjectSummary` 默认开、`context.coldStartInjectRecentTurns` 默认开）；
  **注入按会话幂等**（键为 `session|交接批次`），兄弟 agent 先装配不会吞掉用户新对话的注入；
  「前几轮原话」取自交接标记里的 `tailTurns`（最后 ≤5 轮原话），摘要之外还能接上具体语境。
  静态「状态唤醒」策略常驻，两个开关都关时也不会退化成客服腔。
- 交接**不会**自动弹出新对话：交接发生在对话中间，宿主在标记后继续同一对话；是否需要另开
  新对话由用户自己决定（v1.5.6 的 `context.autoNewSession*` 已在 1.6.3 移除）。
- **窗口分母来自宿主，而不是配置文件**（1.6.3）：真实上限取
  `llm.resolveModelInfo().context.contextWindow`（或 `tokenMeter.contextPressure().contextWindow`），
  `context.nativeTokenLimit` 降级为“用户覆盖”，只在宿主无法上报时兜底；
  `panel.session.windowSource` 会显示这次用的是 `host` / `config` / `default`。
- **交接判定 = 已用 + 预留输出**：`used_tokens + reserved_completion_tokens >= window × threshold`。
  已用优先取宿主 `tokenMeter` 的测量值（含系统提示、工具 schema、历史），不再是
  `字符数 ÷ 4`。**必定放不进窗口的请求会在本地 fail-fast**，抛 `MEM_E_CONTEXT_EXCEEDED`
  并说明 used / reserved / window，不会发出去再被 API 拒绝。
- **同会话可续交**：交接后同一对话若压力继续上涨（比上次交接时高 ≥5 个百分点，或投影
  ≥95% 硬上限），会重新蒸馏交接摘要，不会出现“第一次交接后就再也不交接”。
- **单轮超大工具输出熔断（Live Compact）**：单个 `tool/result` 超过
  `context.liveCompact.thresholdChars`（默认 200,000 字符）时，保留头 4000 / 尾 2000 字符，
  中间压成一行指向 raw 日志的指针（带 `seq` / `call` / `tool` 坐标），原文仍可用
  `deep_raw` 取回。宿主自带 `toolResultPruner` 时优先交给它。

### 打破线性增长：压缩 / 编码 / 语义三层

append-only 日志天然是 O(n)，只压不改斜率。三层各自掰弯一段曲线：

**① 压缩层（冷数据极限压榨）**

- 原始回合按天分片（`raw/YYYY-MM-DD.jsonl`）；热数据保持明文，供 `deep_raw` **倒序流式扫描**
  （64 KiB 反向分块，峰值内存 = 一个 chunk + 一行）。
- **多维冷热判定**（严禁只看时间）：同时满足 `生成时间 > raw.archiveAfterDays`（默认 **90 天**）、
  近 `raw.coldAccessWindowDays`（默认 **90 天**）**零访问**、且不含 `pinned` / `status:handoff` /
  高频标签，才进入归档。
- **极限分层压缩**：冷数据按月合并为 `raw-archive-YYYY-MM.jsonl.br`，默认 **Brotli quality 11**；
  可切 `gzip` / `zstd`（全部 Node 内置，**零依赖**）。旧格式历史归档依然可读。
- 读取归档时用 `createBrotliDecompress()` / `createGunzip()` / `createZstdDecompress()`
  **流式逐行解压**，命中即停，绝不把整个归档读进内存。
- **稀疏行索引**：每个分片旁挂 `<day>.jsonl.idx.json`（每 64 行采样），`deep_raw` 据此跳过
  时间窗不重叠的分片并复用行数，索引缺失/陈旧/损坏时自动降级为顺序扫描。

**② 编码层（引用去重，不碰列式存储）**

- 明确拒绝 Parquet / 列式：那会摧毁事件溯源的行级读取能力。
- 重复的超长内容（工具 schema、系统提示块，≥512 字符且出现 ≥2 次）在**索引层**只存一份
  （`templates.json`），事件用 `contentRef` 指向它；索引加载时还原成原文，读者无感。
- **日志本身一字不改**：raw 仍是逐行原文，`deep_raw`、哈希恢复、行级游标全部不受影响。

**③ 语义层（从线性到亚线性）**

- 哲学：**无损存记忆、有损存过程**。原始 raw 降级为可选审计层，蒸馏后的 L2/L3 才是长期主体。
- 热窗口内保留 raw 原文；超出 `raw.hotWindowDays`（默认 30 天）且**已被 L3 摘要覆盖**的 raw
  分片，可在 `raw.distillPrune: true` 下被物理清理——**必经 Tombstone 路径**，删除即不可复活。
- **L2 走同类项合并**（`l2Merge`），绝不无限追加。
- **L3 硬熔断**：`semantic.maxEntries`（默认 **100**），超限按 LRU 淘汰最久未更新的摘要，
  淘汰以 append-only 的 `semantic_retire` 记录落盘（决策本身可审计）。
- 结果：L2/L3 随**事件重要性**增长，而不是随对话条数线性膨胀。

### raw 保留三档

raw 层提供三档，覆盖从“只留关键”到“全留”：

| `raw.mode` | 行为 |
| --- | --- |
| `off` | 不保存任何原始回合（只保留 L1 之上的记忆） |
| `salience` | **默认**。只保留高价值回合：`salience ≥ raw.minSalience`、代码块、栈轨迹、错误类型等形态 |
| `all` | 全部保存，受 `maxTurnKb` / `maxBytesPerDay` / `maxTotalMb` 预算约束 |

配合 `raw.retentionDays`（默认 **365 天**，必须严格大于 `archiveAfterDays`）与 `pinned` 永不清除，
形成“高价值永存 / 全量长期存 / 按需不存”的完整谱系。

### 检索、衰减与面板

- 综合打分 `salience × decay × tagAffinity × lexicalBoost × association × timeBoost`；
  半衰期默认 30 天，`pinned` 与月记永不衰减。
- **上限剪枝**：`salience × 3.9` 是分数硬上界，候选按 salience 降序早停，长尾不再计算 decay。
- 全量 Web 面板：图谱、标签树、记忆列表、空间管理、设置页、raw 归档与索引统计。

---

## 快速开始

### 1. 安装

```bash
# npm
pnpm add dsh-layers-hippocampus

# 或从 GitHub 指定 tag
pnpm add "github:382quaii/dsh-Layers-Hippocampus#v1.6.3"
```

### 2. 挂到 profile

```yaml
- insert:
    - id: hippocampus
      name: "dsh-layers-hippocampus"
      config:
        briefing: true
```

宿主启动后 UI 半边随页面加载生效。确认路由就绪：

```bash
node scripts/wait-for-routes.mjs
```

### 3. 最小配置

```yaml
- insert:
    - id: hippocampus
      name: "dsh-layers-hippocampus"
      config:
        dataDir: "C:/Users/<you>/.dsh/memory"  # 可选；默认 <DSH_HOME>/memory
        raw:
          mode: salience          # off | salience | all
          retentionDays: 365      # 必须 > archiveAfterDays
          archiveAfterDays: 90    # 超过该天数的分片按月归档
          coldAccessWindowDays: 90  # 近 N 天零访问才允许归档
          compressionEngine: brotli # brotli(11) | gzip(9) | zstd
```

### 4. 配置版本与启动安全

配置对象带 `configVersion`（当前 **3**）。加载顺序是 **迁移 → 严格校验**：

- **迁移**：缺少 `configVersion` 的旧配置视为 legacy，先补齐版本号与新增默认值
  （例如 `archiveAfterDays` 缺失且 `retentionDays` 不大于新默认 90 时，派生为
  `retentionDays - 1`），每条迁移都会 `console.warn` 并记录在 `config.warnings` 里。
  迁移只补值、不覆盖你显式写下的键，也从不抛错。
- **严格校验**：迁移之后仍按类型/取值范围/未知键严格检查。
- **安全降级**：`strictStartup: false`（默认 `true`）时，若严格校验发现取值越界，
  引擎回退到安全值并继续启动，同时把 `startup.degraded` 置为 `true`、记录
  `degradedReason` 并输出 `hippocampus/config-degraded:` 警告。
  类型错误与未知键**不会**被降级吞掉。

启动结果可在 `memory_admin action=status` 的 `panel.startup` / `panel.configVersion` /
`panel.configWarnings` 里看到——插件绝不会静默地以与你写的不一样的配置运行。

> 2026-11-13 的生产事故正是这一层缺失造成的：新默认值与旧 profile 冲突，`apply()`
> 抛错导致插件整体不加载，UI 只能看到 HTTP 404。1.6.3 起该路径由
> `test/v163.migration.test.js` 锁定。

### 5. 设置页的两种视图

设置 → 海马体记忆 顶部可切换 **简洁模式 / 专业模式**：

- **简洁模式**只显示四块：**身份**（事件时间策略）、**上下文窗口**（预算 / 注入上限 /
  淘汰阈值 / 收敛目标 / 是否注入）、**系统级存储位置迁移**、**原始回合留存**
  （只留 `raw.mode`、总量上限、冷压缩引擎三项）。
- 它是**纯显示层**：隐藏项不渲染，也不参与保存——POST 只携带可见键，文件里其余配置
  保持原值（新装即默认值，专业模式下调过的不会被覆盖）。
- 视图选择只存在浏览器 `localStorage`（`hippocampus:settings-mode`），不进插件配置、
  不影响引擎行为；默认是专业模式。

### 6. 验证

```bash
npm test        # 进程内全量用例（494 个）
npm run check   # 语法检查 + 全量测试
```

---

## 工具一览

| 工具 | 用途 |
| --- | --- |
| `memory_remember` | 追加长期记忆；`pinned: true` 永不衰减（必须带 tags） |
| `memory_recall` | 检索记忆；`mode="deep_raw"` 走时间窗流式扫描 |
| `memory_capture` | 保留单条原始回合（取证用，不入索引） |
| `memory_bulk_ingest` | 批量入库，单条失败隔离 |
| `memory_reinforce` | 奖励有用记忆，推进衰减锚点 |
| `memory_forget` | 两阶段删除（宽限期 → 墓碑 → 归档 → 清理） |
| `memory_checkpoint` | 记录唯一进行中的重任务 |
| `memory_admin` | 状态 / 维护 / 活跃标签 / 语义 / 待删队列 |
| `memory_space_transfer` | 跨空间迁移（**必须用户显式授权**） |
| `memory_transfer_to_global` | 迁移到全局空间（**必须用户显式授权**） |

---

## 数据目录

```
<dataDir>/
  log/          追加式事件日志（真相源）
  archive/      归档的旧日志段
  index/        A/B 代索引（可删，重建）
  semantic/     L3 语义摘要
  journal/      L2 日记
  state/        图、标签树、handoff marker、raw 归档索引等
  identity/     身份账本
  raw/          原始回合分片 + 月度归档 + 稀疏索引
```

---

## 开发与验证

```bash
npm test                                        # node test/run.mjs
npm run bench                                   # 基准协议（5 次取中位数）
npm run check                                   # 语法检查 + 全量测试
node scripts/wait-for-routes.mjs 55879          # 冷启动验收（指定端口）
node scripts/check-binding.mjs --port 55879     # 绑定/注册体检
node scripts/compact-raw.mjs --apply            # raw 黑匣子整理（先备份）
node scripts/repair-handoff.mjs --data-dir ...  # 交接脏数据修复（默认 dry-run）
```

时间相关测试一律注入 `FakeClock`，不读真实时钟、不访问网络、不 spawn 子进程。

> 提示：`context.minInjectConfidence` 已在 1.5.3 移除；旧配置带该键会 fail-fast 报
> `MEM_E_CONFIG_UNKNOWN_KEY`。

---

## 从旧名字迁移

存储位置不变（`<DSH_HOME>/memory`）。旧目录名（`memory`、`dsh-memory`、`hippocampus`、
`Layers-Hippocampus`、`dsh-Layers-Hippocampus`）在 `migrateFrom` 未设置且目标目录为空时会
**自动识别为迁移源**；迁移带 PID 存活锁与完成标记，可重复执行。

---

## 许可证

MIT

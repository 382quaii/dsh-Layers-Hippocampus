# dsh-layers-hippocampus · 海马体记忆

给 DeepSeek Harness（DSH）智能体的**分层长期记忆**：追加式事件日志、可重建标签索引、按天日记、独立语义层、L2.5 趋势隔离、离线知识图谱，以及一个完整的 Web 面板。

| | |
| --- | --- |
| 版本 | **1.4.2** |
| 包名 | `dsh-layers-hippocampus`（npm 只允许小写；仓库名保留 `dsh-Layers-Hippocampus`，*Hippocampus* 双 **p**） |
| 仓库 | <https://github.com/382quaii/dsh-Layers-Hippocampus> |
| 许可证 | MIT |
| 运行时依赖 | **零**。Host 半边只用 Node 内置模块，React 由 Harness 提供 |
| 详细设计 | [docs/ARCHITECTURE.zh.md](docs/ARCHITECTURE.zh.md) |

---

## 安装

### 从 GitHub

```bash
pnpm add "github:382quaii/dsh-Layers-Hippocampus#v1.4.2"
```

### 从 npm

```bash
pnpm add dsh-layers-hippocampus
```

### 通过插件管理器（推荐）

```
plugin_manager action=install_bundle target="C:\Users\86135\Documents\deepseek-harness\default-workspace\dsh-memory"
```

安装后 profile 会得到这一行：

```yaml
- insert:
    - id: hippocampus
      name: "dsh-layers-hippocampus"
      config:
        briefing: true
```

Host 半边随下一次宿主启动生效；UI 半边在页面加载时从 boot graph 取得。**冷启动后**用下面的脚本确认路由已就绪：

```bat
node scripts/wait-for-routes.mjs
```

---

## 工具

| 工具（`memory_*`） | 用途 |
| --- | --- |
| `remember` | 追加一条长期记忆（内容哈希幂等）；可带 `media_url` + `media_type` 指向附件 |
| `checkpoint` | 记录**唯一**进行中的重任务：`task_id`、`progress`（0–100）、`updated_at` |
| `recall` | 关键词 + 标签检索，衰减加权，含图谱联想；宽限中 mid 的命中只回**元数据**并引导 `deep_raw`；`mode: "deep_raw"` 走受限 raw 扫描 |
| `capture` | 把**一轮原始对话**存入取证层（受门控与预算限制，不进索引） |
| `reinforce` | 确认一次记忆，不重写内容，并推进复习档位 |
| `forget` / `restore` | 两阶段删除（`pending_delete` 倒计时）与取消/反墓碑 |
| `admin` | `status` / `maintain` / `active_tags` / `semantic` / `active_task` / `reviews` / `pending_deletes` |

### 原始回合留存（raw）与 `deep_raw`

- **极简黑匣子**：每行恰为 `{ turn_id, timestamp, role, content }`；不写 tags / salience / decay / event_id / 图谱关系 / metadata。寻址用 `(日期文件, 行号)`——append-only 保证行号稳定（这是“禁止行号指针”在 raw 层的唯一合法例外）。
- 独立日分片 `raw/YYYY-MM-DD.jsonl`，**不进主日志、不进索引、启动不加载**；只有 `deep_raw` 和 `maintain()` 的 TTL 会读它。
- **异步写盘**：捕获只入内存队列，每 10 条或 1 秒批量 `appendFile`，绝不阻塞 `session/event` 回调。
- **明文存储 + 读出脱敏**：落盘保留 100% 原文（黑匣子完整性）；`deep_raw` 返回前对 snippet 做脱敏（Bearer、`sk-`、长 base64 串 → `[redacted]`），防止密钥进入云端 prompt。**注意：本地磁盘为明文。**
- **墓碑**：`forget` 真正执行 purge 后，按内容 hash 追加 `{ type: "raw_tombstone", hash, timestamp }`；扫描时命中墓碑的记录直接跳过（防死灰复燃）。
- **强制时间窗**：`memory_recall mode="deep_raw"` 必须同时给 `start_time` 与 `end_time`，缺失直接 `MEM_E_INVALID_INPUT`。
- **Token 预算**：结果上限 `raw.maxResultTokens`（默认 1000），超出截断并在 `notes` 末尾注明「由于预算限制，部分原始记录已被截断」。
- **TTL**：`maintain()` 删除文件名日期早于 `今天 - retentionDays` 的整文件；**今天正在写的文件绝不删**。raw 体积计入 Dashboard 存储环（`panel.storage.rawBytes` + 总 `diskBytes`）。
- 自动捕获：订阅 `session/event`，只收 user/assistant 原文（剥离宿主注入的 `Current runtime context.` 段），工具输出默认不收、但 `isError` 的失败结果强制入库。

### 两阶段删除与间隔重复

- `forget` 先挂起（默认 24h，`delete.graceHours`），`restore` 在到期前直接取消；到期由 `maintain()` 推进到 tombstone→archive→consolidation→purge。未知 id 在挂起前就报 `MEM_E_NOT_FOUND`。
- 复习排期 `1,2,4,7,15,30` 天，持久化在 `state/reviews.json`；`reinforce` 推进一档，`maintain()` 汇总到期项，`memory_admin action="reviews"` 可查。

### 数据目录迁移（UI）

设置页 `dataDir` 可编辑：保存后返回 **202 + state=migrating**，后台 `fs.promises.cp` 拷贝、两端 `recordCount` 校验、写入 `.migration-complete` 后才切换 `dataDir` 并重开存储；校验失败删除目标、旧目录仍权威；源目录保留为备份。并发请求由 `.migration.lock` 阻断（`MEM_E_MIGRATION_LOCKED`），面板显示进度条。

`active_task` 直查底层索引，**不受活跃集合 cap 200 限制**；写入新 checkpoint 会降级旧记录，7 天未刷新由 `maintain()` 自动降级，模型的 `forget` 只是 happy path。

### 提示词软引导与自有工具瘦身

- 系统提示新增 `memory:policy`（静态段，保持前缀缓存稳定）：要求模型在需要回忆历史、查阅文件、获取系统信息时**优先调用 `memory_recall`**，禁止盲目读取外部超长文件或让原生工具输出全文。
- 本插件工具返回超长 JSON（默认 >2000 tokens）时，由 `slimToolPayload` 先**把完整内容写入 raw**，再返回带 `[Slimmed]` 的瘦身版：保留 `summary` / `topics` / `key_entities` / `recovery_hash`。
- 恢复原文：`memory_recall(mode="deep_raw", hash="…")`，按内容 sha256 精确返回；这是"软拦截"能覆盖的最大范围——其他插件的工具输出仍由宿主投射，插件无法改写。

### 多模态与防爆仓

- `media_url` 只接受 **http(s) URL 或绝对路径**；`media_type` ∈ `image | video | document | audio`，缺一即 `MEM_E_INVALID_MEDIA`。
- 内联 base64 **不落库**：`content` 中连续 base64 字符 ≥ **256** 即抛 `MEM_E_INVALID_MEDIA`；200 字符以内视为普通文本，不会误杀。

### 记忆流转（上下文 → 长期 → 联想 → 月记）

1. **推币机折叠**：上下文触发 evict 时被驱逐的块不再丢弃，引擎把最近一批折成一条 `folded_summary` 事件写回 L1（标签 `status:folded`），抽取人名、任务语句与核心结论。
2. **在线联想唤醒**：查询命中某个 Tag 时读取 `state/graph.json`，取该节点最强的 **3** 个邻居，把邻居事件以 **0.5 惩罚系数**放进候选池；命中标记 `association.via`，直连结果永远排在联想结果之前。
3. **月记（Monthly Memo）**：`maintain()` 发现某个自然月已完整，就把该月日记压成一条 `status:monthly` 记忆；月记**不参与日常衰减**（`decay = 1`），模糊时间查询（“上个月”“2023-10”“去年”）会优先召回它。

一切都从**唯一真相源**（追加式日志）派生；索引、日记、活跃标签集、知识图谱都是可丢弃、可重建的投影。

### 分层

1. **L1 事件日志**：追加式 JSONL 代际 + `CURRENT` 指针。
2. **L2 索引**：标签表、活跃集合、日记、墓碑；A/B 双缓冲，读者永远看不到半成品。
3. **L1.5 标签层级树**：root/mid/leaf 三层寿命 + 宽限幽灵；派生缓存，`state/tag-tree.json`。
4. **L2.5 趋势隔离**：短命观察，经晋升窗口与突发检测才升级为记忆（情景可删，模式不删）。
5. **L3 语义层**：摘要独立于原始日志生死。
6. **图谱**：标签共现网络的离线投影。

### L1.5 标签层级树与幽灵节点

层级标签按 `/` 解析为 **root / mid / leaf** 三层（`tech/frontend/vue3`），三种寿命：

- **root 永生**：`tech` 这类命名空间根，永不删除；无 `/` 的扁平标签（`project:dsh`）同样是受保护的根。
- **leaf 引用归零即死**：它的所有事件被遗忘后进入待修剪队列；`maintain()` 每次只消费 `tagTree.pruneBatchSize`（默认 100）条，队列落盘、跨重启分批排空——**绝不一次维护风暴**。
- **mid 宽限**：失去最后一个叶子后进入 `midGracePeriodDays`（默认 30 天）宽限期（`graceUntil`）。期内挂上新叶子会立即复活；期内它叫**幽灵节点（ghost）**，只存在于 `state/tag-tree.json` 的 `ghosts` 里；宽限到期且衰减低于地板后才真正消亡。
- **反幻觉降级**：`memory_recall` 对只经由宽限 mid 到达的命中，**整条正文（snippet/content）不会进入结果或提示词**，只返回一条元数据：`幽灵节点 path、共 N 条、宽限期还剩几天、deep_raw 时间窗`，引导模型去查原话。点名一个宽限 mid 却没有实体命中时，也返回 `count: 0` 的同一提示而不是静默空结果。
- **派生缓存**：整个标签树由 `maintain()` 从收敛后的索引投影，随后与上一份缓存**carry-forward**（已失去全部活引用的节点以 `refCount=0` 接回，孤儿丢弃），所以生命周期跨维护可观察。`state/tag-tree.json` 可随时删除——只会丢失幽灵历史，活树下次维护照常重建。

### 身份纪律

- `content_hash` 规范化（标签排序、文本规整）用于**等价**。
- `event_id = hash(content_hash + event_time + occurrence_index)` 用于**身份**。
- 重复写通过独立幂等索引抑制；墓碑在日志压实后仍然存在，遗忘的事件不会复活。

---

## 配置

全部由 `resolveConfig` **fail-fast 校验**（绝不静默取整），启动与 HTTP 热更新走同一个校验器。设置页覆盖了全部可编辑项。

| 键 | 默认 | 范围 / 取值 |
| --- | --- | --- |
| `dataDir` | `<DSH_HOME>/memory` | 绝对路径（只读，不在 UI 内编辑） |
| `migrateFrom` | `null` | 路径；留空时自动探测旧目录 |
| `maintenanceCron` | `0 */6 * * *` | 5 段 cron，必须能触发 |
| `briefing` / `promptSection` / `autoMaintainOnBoot` | `true` | 布尔 |
| `enableDream` | `true` | 布尔 |
| `dreamIdleMinutes` | `180` | 1 – 525 600 |
| `enableReflection` | `true` | 布尔 |
| `graphMaxEdges` | `500` | 100 – 2000 |
| `storageBudgetMb` | `50` | 10 – 1000（软上限：超限只标红，不删档） |
| `decay.halfLifeDays` | `30` | 7 – 365；调大记得更久 |
| `activeSet.cap` | `200` | 100 – 1000；多项目并行可调 500（下次维护生效） |
| `maxRecallTopK` | `100` | 1 – 1000 |
| `retrieval.topK` | `20` | 1 – `maxRecallTopK` |
| `context.maxTokens` | `4000` | 256 – 1 000 000 |
| `context.threshold` / `context.target` | `0.85` / `0.7` | target < threshold < 1 |
| `context.injectPrompt` | `true` | 布尔 |
| `temp.ttlDays` / `temp.promotionWindowDays` | `30` / `20` | promotion ≤ ttl |
| `identity.eventTimePolicy` | `content` | `content` \| `explicit` \| `ingest` |
| `raw.mode` | `salience` | `off` \| `salience` \| `all` |
| `raw.minSalience` | `0.6` | 0 – 1 |
| `raw.maxTurnKb` | `64` | 8 – 1024 |
| `raw.maxBytesPerDay` | `8` | 1 – 128 MB |
| `raw.maxTotalMb` | `256` | 16 – 4096 MB |
| `raw.retentionDays` | `30` | 1 – 365（按文件日期整文件清理） |
| `raw.maxScanMb` | `16` | 1 – 256 MB |
| `raw.maxResultTokens` | `1000` | 50 – 20000 |
| `raw.autoCapture` | `true` | 布尔 |
| `raw.captureTools` | `false` | 布尔（`isError` 工具结果始终捕获） |
| `delete.graceHours` | `24` | 0 – 168（0 = 立即执行） |
| `review.enabled` | `true` | 布尔 |
| `tagTree.midHalfLifeMultiplier` | `3` | 1 – 10；mid 半衰期 = 倍率 × leaf 半衰期（1 天） |
| `tagTree.midGracePeriodDays` | `30` | 7 – 180；mid 失去最后一个叶子后的宽限天数（幽灵期） |
| `tagTree.pruneBatchSize` | `100` | 10 – 500；每次维护最多修剪的待删叶子数（有界批次） |
| `tagTree.leafDecayFloor` | `0` | 0 – 1；0 = 只按引用归零死亡，>0 时低于地板的排队叶子被修剪 |
| `migration.timeoutMs` | `600000` | 10000 – 3600000 |

错误码稳定：`MEM_E_CONFIG_INVALID_CRON`、`MEM_E_CONFIG_OUT_OF_RANGE`、`MEM_E_CONFIG_UNKNOWN_KEY` 等。

### 调度纪律

Cron **和** 空闲 Dream 触发调用同一个入口 `runtime.runMaintenance(source)`。执行中再次触发直接拒绝（`maintenance-in-flight`）——不排队、不补跑。

### 启动状态机（前后端协议）

`pending → in_progress → ready | failed`。

**每个 HTTP 响应都带 `state`**（包括 400/405/409/500）。前端**只按 `body.state` 决定重试**，不按状态码：

| `state` | 前端行为 |
| --- | --- |
| `pending` / `in_progress` | 2s 轮询 + Skeleton，不报错 |
| `ready` | 正常渲染 |
| `failed` | 1.2s × 5 次短重试，然后显示「重新连接 / 重试」 |
| 无 body 的 404 | 指数退避（1→2→4→5s 封顶）最多等 **10 分钟**，之后 `MEM_E_BOOT_TIMEOUT` + 手动重连 |

**写请求隔离**：`ready` 之前 `POST /config` 返回 `409 + MEM_E_NOT_READY + state`；工具返回同样带 `state` / `retryable` 的 `MEM_E_NOT_READY`——绝不静默吞掉。

> **冷启动 404 的根因（1.3.1 修复）**：`webServer` 由 web-app 行提供，而它在本插件 `apply()` **之后**才激活。旧代码只在 `apply()` 里 `ctx.get('webServer')` 一次，拿不到就静默跳过注册——冷启动永远没有路由，热重载却正常。现在注册放在 `ctx.inject(['webServer'], child => …)` 的子 fiber 里：服务一出现就注册。`apply()` 本身不 `await` 任何 I/O，bootstrap 由 `runtime.start()` 放进微任务。成功注册会打印 `[Hippocampus] Route registered at <iso> (…)`，失败会打印 `[Hippocampus] Route registration FAILED: <reason>`。
>
> 冷启动验证：重启 DSH 后运行 `node scripts/wait-for-routes.mjs`（自动找端口、自动带会话 Cookie）。它逐行打印状态，路由可用时输出 `OK: routes served … (state=ready)`；在此之前是 `state=(none)` 的 404，客户端会一直退避等待，不会 6 次就死锁。

---

## Web UI

三个注册，全部经 Harness 插槽服务：

| 插槽 | id / key | 内容 |
| --- | --- | --- |
| `sidebar.panellist` | `hippocampus-panel` | 图标（SVG，消费 `size` / `active`） |
| `main` | `hippocampus-panel` | 面板：存储环形图、统计卡、知识图谱 |
| `settings.section` | `hippocampus-settings` | 完整配置表单 |

- **环形图**：纯 SVG，预算来自 `storageBudgetMb`；中心同时显示用量与百分比，超预算时弧线截断为整圈并整体标红。
- **知识图谱**：力导向布局**只计算一次**并冻进 ref（弹簧 + 斥力 + 向心），随后节点逐个入场；边只在**两端节点都已入场**后绘制，不会有悬空线；孤立节点带随机抖动。
  - **拖拽**：`onPointerDown/Move/Up` + `setPointerCapture`；拖拽期间只改 ref 坐标并直接写 DOM（`transform` 与线段端点），**不触发 setState**；松手后解除 pin，对 1 跳邻域做 alpha 衰减的局部松弛；位移 < 4px 仍算点击（切换标签）。
  - **幽灵节点与历史开关**：图谱接口在同一次响应里带 `tagTree.ghosts`（渲染上限 50 条，含 `totalGhosts`/`truncated`）；"仅活跃 / 历史全貌"开关用 CSS `opacity` 420ms 过渡淡入淡出（布局键不含开关状态，切换**不会重排**）。历史里的 mid 渲染为半透明虚线圆，挂在父 root 下，hover 有 `title` 提示剩余宽限期。
- **设置页**：开关（Dream / Reflection / briefing / promptSection / autoMaintainOnBoot / injectPrompt）、数字（含上下限与客户端预检）、滑块 + 数字框（L1.5 四个寿命旋钮，label 的 `title` 是场景化 Tooltip）、下拉（`identity.eventTimePolicy`）、Cron 文本框；保存一次性提交带点号路径的 patch，后端 fail-fast 失败时顶部红色横幅显示 `MEM_E_CONFIG_*`，成功后广播 `config-changed`，面板立即重拉 stats 与 graph。
- UI 不调用 Agent 工具，只读下面的 JSON 路由。

### 截图

![主面板](assets/screenshot-panel.png)

![设置页](assets/screenshot-settings.png)

![知识图谱](assets/screenshot-graph.png)

> 三张为**占位预览图**；替换 `assets/` 下同名 PNG 即可，`screenshots.json` 无需改动。

## HTTP API

挂在 Host Web 服务上的同源路由，复用宿主浏览器鉴权。**所有响应都带 `state`。**

| 方法 | 路径 | 返回 |
| --- | --- | --- |
| `GET` | `/api/hippocampus/stats` | `{ ok, state, phase, panel, briefing, config }`；未就绪 `503` |
| `GET` | `/api/hippocampus/config` | 可编辑配置子集（`ready` 前也可读，用于回填表单） |
| `POST` | `/api/hippocampus/config` | `{ patch }` → fail-fast 校验 → 生效 → 尽量持久化 |
| `GET` | `/api/hippocampus/graph` | 缓存图谱，`.slice(0, graphMaxEdges)`；同时带 `tagTree.ghosts`（历史视图的幽灵元数据） |
| `POST` | `/api/hippocampus/retry` | 重试 `failed` 启动（`202`） |

图谱路由**不排序、不读日志**：缓存由 `maintain()` 写入，路由只做切片。

---

## 数据布局

```
<dataDir>/
  log/          gen-*/ + CURRENT          追加式真相
  index/        gen-*/ + CURRENT          A/B 投影
  identity/     ledger.json               幂等 + 墓碑
  semantic/     摘要 + temp.json          独立语义流
  state/        context.json、maintenance.json、graph.json、tag-tree.json、months.json、active-task.json
  journal/      删除流水账
```

删掉 `index/`、`state/graph.json`、`state/tag-tree.json`、`state/months.json` 都安全：它们会从日志重建（月记会按已生成月份重新补齐；标签树会重建活树，只丢失幽灵历史）。

## 从旧名字迁移

存储位置不变（`<DSH_HOME>/memory`）。若数据在旧目录（`memory`、`dsh-memory`、`hippocampus`、`Layers-Hippocampus`、`dsh-Layers-Hippocampus`），在 `migrateFrom` 未设置且目标目录无数据时会**自动识别为迁移源**。迁移有 PID 存活锁与完成标记，可重复执行。

---

## 开发与验证

```bash
npm test      # node test/run.mjs —— 189 个进程内用例，30 秒看门狗
npm run check # 语法检查 + 全量测试
```

全部用例在进程内运行（不 spawn 子进程），时间相关测试一律注入 `FakeClock`，不读真实时钟、不访问网络。

冷启动验收：

```bash
node scripts/wait-for-routes.mjs            # 自动找端口
node scripts/wait-for-routes.mjs 55879      # 指定端口
```

raw 黑匣子整理（旧 15 字段记录 → 四字段 schema，剔除 tool 噪音 / 注入段落 / 测试残留，按内容去重）：

```bash
node scripts/compact-raw.mjs                 # 干跑，只打印计划
node scripts/compact-raw.mjs --apply         # 先备份到 raw/.backup-<ts>/ 再原地重写
node scripts/compact-raw.mjs --data-dir "D:\Users\86135\memory" --apply
```

绑定/注册体检（检查 package.json 名、patch 行名、profile 依赖、Junction 与实时路由）：

```bash
node scripts/check-binding.mjs --port 55879
```

## 变更记录

见 [CHANGELOG.md](CHANGELOG.md)（当前 **1.4.2**：L1.5 标签层级树 / 宽限幽灵 / 检索降级 / 图谱历史视图；1.4.1：提示词软引导 / 工具瘦身 / 置信度 / 洪峰防护；1.4.0：raw 原始回合取证 / 间隔重复 / 两阶段删除 / UI 数据目录迁移）。

## 许可

MIT © 2026 382quaii

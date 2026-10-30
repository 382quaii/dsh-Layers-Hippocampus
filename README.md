# dsh-layers-hippocampus · 海马体记忆

给 DeepSeek Harness（DSH）智能体的**分层长期记忆**：追加式事件日志、可重建标签索引、按天日记、独立语义层、L2.5 趋势隔离、离线知识图谱，以及一个完整的 Web 面板。

| | |
| --- | --- |
| 版本 | **1.3.1** |
| 包名 | `dsh-layers-hippocampus`（npm 只允许小写；仓库名保留 `dsh-Layers-Hippocampus`，*Hippocampus* 双 **p**） |
| 仓库 | <https://github.com/382quaii/dsh-Layers-Hippocampus> |
| 许可证 | MIT |
| 运行时依赖 | **零**。Host 半边只用 Node 内置模块，React 由 Harness 提供 |
| 详细设计 | [docs/ARCHITECTURE.zh.md](docs/ARCHITECTURE.zh.md) |

---

## 安装

### 从 GitHub

```bash
pnpm add "github:382quaii/dsh-Layers-Hippocampus#v1.3.1"
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
| `recall` | 关键词 + 标签检索，衰减加权，含图谱联想 |
| `reinforce` | 确认一次记忆，不重写内容 |
| `forget` / `restore` | 墓碑与反墓碑 |
| `admin` | `status` / `maintain` / `active_tags` / `semantic` / `active_task` |

`active_task` 直查底层索引，**不受活跃集合 cap 200 限制**；写入新 checkpoint 会降级旧记录，7 天未刷新由 `maintain()` 自动降级，模型的 `forget` 只是 happy path。

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
3. **L2.5 趋势隔离**：短命观察，经晋升窗口与突发检测才升级为记忆（情景可删，模式不删）。
4. **L3 语义层**：摘要独立于原始日志生死。
5. **图谱**：标签共现网络的离线投影。

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
- **设置页**：开关（Dream / Reflection / briefing / promptSection / autoMaintainOnBoot / injectPrompt）、数字（含上下限与客户端预检）、下拉（`identity.eventTimePolicy`）、Cron 文本框；保存一次性提交带点号路径的 patch，后端 fail-fast 失败时顶部红色横幅显示 `MEM_E_CONFIG_*`，成功后广播 `config-changed`，面板立即重拉 stats 与 graph。
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
| `GET` | `/api/hippocampus/graph` | 缓存图谱，`.slice(0, graphMaxEdges)` |
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
  state/        context.json、maintenance.json、graph.json、months.json、active-task.json
  journal/      删除流水账
```

删掉 `index/`、`state/graph.json`、`state/months.json` 都安全：它们会从日志重建（月记会按已生成月份重新补齐）。

## 从旧名字迁移

存储位置不变（`<DSH_HOME>/memory`）。若数据在旧目录（`memory`、`dsh-memory`、`hippocampus`、`Layers-Hippocampus`、`dsh-Layers-Hippocampus`），在 `migrateFrom` 未设置且目标目录无数据时会**自动识别为迁移源**。迁移有 PID 存活锁与完成标记，可重复执行。

---

## 开发与验证

```bash
npm test      # node test/run.mjs —— 133 个进程内用例，30 秒看门狗
npm run check # 语法检查 + 全量测试
```

全部用例在进程内运行（不 spawn 子进程），时间相关测试一律注入 `FakeClock`，不读真实时钟、不访问网络。

冷启动验收：

```bash
node scripts/wait-for-routes.mjs            # 自动找端口
node scripts/wait-for-routes.mjs 55879      # 指定端口
```

绑定/注册体检（检查 package.json 名、patch 行名、profile 依赖、Junction 与实时路由）：

```bash
node scripts/check-binding.mjs --port 55879
```

## 变更记录

见 [CHANGELOG.md](CHANGELOG.md)（当前 **1.3.1**：修复冷启动 404 与前端 404 死锁；1.3.0：折叠 / 联想 / 月记）。

## 许可

MIT © 2026 382quaii

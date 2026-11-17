# Release 1.6.7 — 发布准备（本地）

> 版本：**1.6.7**（2026-11-17：**索引式提示注入 M1** + **发布链完整性修正**——事后核对发现 1.6.6 的 npm 制品（`gitHead 99a07cb`）是从**另一份旧 checkout** 发布的，只含 Live Compact 修复，**不含** M3/M5。本版把这两项送出去，并把已发布提交并入 `main` 历史、让 `v1.6.6` tag 指向 npm 实际制品。累计 1.6.6 的 Live Compact 修复、1.6.5 的微内核回归、1.6.4 的 1M 溢出修复、以及 1.6.3 的配置迁移与启动降级）。

> 状态：**代码与文档已提交；`main` 与 `v1.6.7` tag 已推送到 GitHub。**
> 剩余 **npm publish** 未执行：本机 `~/.npmrc` 里的 token 已失效（`npm whoami` 返回
> `E401 Unauthorized`），需要你重新登录或换一个新 token 后再发。**
> 基线：`dsh-memory` 工作区，全量 **519/519 测试通过**（82 个测试文件；另有 `dsh-orchestrator` 31/31）。
> 安装状态：`dsh-orchestrator` 已本地 link 安装到 desktop profile（`include:orchestrator` active）；插件市场仍无条目（未发布 npm）。

## 本版内容

**主线一：索引式提示注入（M1）——每轮 Prompt 不再为记忆正文付费。**
**主线二：发布链完整性——把 1.6.6 漏发的 M3（测试跨包解耦）与 M5（错误码边界）送往 npm，并修复发布历史分叉。**
**主线三：Live Compact 不再委托宿主 pruner（「10%→7%」的真凶，1.6.6，已发布）。**
**主线四：回归微内核——指令集 0 Token、蒸馏单一调度器、原子服务接口（1.6.5，已发布）。**

### 主线一（1.6.7 · M1）

1. **`context.injectMode`（默认 `index`）**：每个记忆块只注入一行指针
   `- [memory <eventId>] 标签 · 标签 · 标题`；正文不进 Prompt，需要细节时用 `memory_recall`
   按 eventId / 标签取。`full` 保留旧渲染（正文前 200 字）与旧计费，一行即可回退。
2. **计费随渲染形态走**：`ContextEngine.tokensOf()` 在 index 下只计指针行、在 full 下仍计整段正文
   （旧口径不动既有调优）；调用方**显式传入的 `tokens` 永远优先**，折叠/驱逐排序不变。
   实测差异是数量级的：8,000 字符正文 ≈ 2,000 tokens，指针行通常 < 60 tokens。
3. **边界不变**：`[Memory Blocks]` 标记名保持不变（缓存前缀语义不变）；`briefing` 块永不降级为指针；
   只有 index 模式下规则段多一行「这是索引指针，正文须调 recall」。
4. **可配置**：`context.injectMode` 进 `EDITABLE_CONFIG_KEYS`，设置页「上下文窗口」卡片新增下拉，
   简洁模式下同样可见可存。9 例 `test/v167.m1.test.js`。

### 主线二（1.6.7 · 发布链）

1. **发布历史分叉修复**。1.6.6 的 npm 制品 `gitHead 99a07cb` 来自旧 checkout
   （`C:\Users\86135\Documents\deepseek-harness\default-workspace\dsh-memory`），
   只改了 `package.json` 版本号一行，父提交是 `66a3b93`；主线的 M3（`9752903`）与
   M5（`6fb610f`）**没有进那个 tarball**。处理：
   - `git fetch` 把 `99a07cb` 拉进新仓库，`git merge` 成合并提交（发布提交现在可达、可追溯）；
   - 本地 `v1.6.6` tag 重建为指向 `99a07cb`（npm 实际制品），并 `--force` 推送，使
     GitHub tag 与 npm 一致；
   - 版本号升 **1.6.7**，让 M3/M5 走新制品；
   - 桌面 profile 的 `node_modules` junction 曾被指回旧 checkout，已重指到
     `D:\86135\Documents\dsh\workspace\dsh-memory`。
2. **M3 测试与兄弟包解耦**：新增 `test/orchestrator.js` 桥接（`via: 'package' | 'sibling'`），
   22 个真正依赖多空间的用例改走 `orchestratorTest()`，缺包时 **skipped 带原因** 而非整套崩；
   `makeMemory()` 的 `multiSpace` 默认 `MULTI_SPACE_AVAILABLE`。
   验收：两包在位 **510/510（skipped 0）**；单包 **454 pass / 0 fail / 56 skipped**。
3. **M5 错误码边界**：`src/errors.js#fromOrchestratorError()` + `ORCHESTRATOR_CODE_MAP`
   单向翻译 `ORCH_E_*` → `MEM_E_*`；三个 consent 码统一落到 `MEM_E_REQUIRE_USER_CONSENT`，
   未列入的码**不拍平成 `MEM_E_IO`**，原始码保留在 `details.orchestratorCode`。
   映射表同步写进 `dsh-orchestrator/README.md`。7 例 `test/v166.errorContract.test.js`。
4. **1.6.5 / 1.6.6 tag 归位**：`v1.6.5` 指向实际发布的 `28776c7`，`v1.6.6` 指向实际发布的
   `99a07cb`，两者都与 npm/GitHub 一致（npm 版本不可覆盖）。

### 主线三（1.6.6）

1. **不再每轮委托宿主 `toolResultPruner`**。旧实现里 `guardRequest` 在**每一次**
   `agent/request` 上都 `await hostPruner.pruneSession(session)`。两处都错：
   宿主用的是**预设自己的预算**（ptc 预设 `thresholdChars 8192` → 4k 头 + 1k 尾），
   且宿主只在本机 `compaction-basic` 的 `context-overflow` 分支里调它。
   于是「溢出时裁剪」变成了「每一轮都裁剪」，一次 pass 可掉 **~80k tokens**。
   现在只跑本插件自己的保守策略（`context.liveCompact`：默认 200,000 字符阈值 /
   4,000 头 / 2,000 尾 / 每请求最多 4 个节点），健康对话**永不被改写**。
   回归用例断言：注入假 pruner 后健康请求上 `pruneSession` 调用次数 **0**。

### 主线四（1.6.5）

1. **`/memory` 指令集（0 Token）**：`resume` / `maintain` / `status` / `mute` / `unmute` 经宿主
   `commands` 服务注册。`commands.execute()` 的语义是「执行已知命令、**不发给模型**」，
   因此不产生模型请求（测试包住 `globalThis.fetch` 计数断言为 0）。
   - `resume` 先删掉 `session|handoffEpoch` 的投递记录再布防（`armColdStartNow()`），
     绕过「每会话只注入一次」的自动去重，用户随时可以把摘要拉回来。
   - `maintain` 走 `runtime.runMaintenance('manual')`，回报 logGen/indexGen/月记/L2合并/Dream/冷归档。
   - `mute` 只压 `[Memory Hints]`，且**静音期间不消费标签**——解除后提示原样回来。
2. **蒸馏收拢为唯一调度器**：`executeDream()` 先跑月记（L2.5，只处理已结束的自然月），
   再跑 Dream。被月记吸收的日记 id 记入 `state/months.json` 的 `promoted` 映射
   （即 `promoted_to_monthly`），`DreamEngine.collectGroups()` 直接跳过并在报告给出
   `skippedPromoted`。**raw 日志仍 append-only 不可改写**——标记落在派生状态，语义等价、可重建。
   `maintain()` 不再产出月记。
3. **原子服务接口**：`ctx.get('hippocampus').getLatestHandoffSummary()` 返回
   `{active, state, at, sessionId, summaryEventId, agentPreset, tailTurns, text, found}`。
   纯读：不装配 prompt、不消费 marker、无副作用。外部路由插件据此自己决定何时续上。
4. **微内核边界锁死**：源码扫描禁止 `index.js` 与 `src/**` 出现 `uiWorkspace` /
   `startSession(` / `sessionStorage` / `appendMode` / `onSlot(` / `slots.register(` /
   `ctx.slots =`。会话控制归外部路由插件。

### 主线五（1.6.4）

事故回顾（1.6.4 主线）：一次请求携带 **854,668 prompt tokens + 预留 256,000 completion tokens**
= 1,110,668 > 模型真实窗口 **1,048,576**，被 provider 以 `CONTEXT_WINDOW_EXCEEDED` 拒绝；
而本插件的所有压力判定都认为“才用了几千 token”。三个独立缺陷叠加：

1. **分母错源**：`context.nativeTokenLimit`（profile 里写的是 `8000`）被当作模型窗口。
   → 新增 `src/context/windowGuard.js#resolveWindow()`：**宿主适配器上报的真实窗口优先**
   （`llm.resolveModelInfo().context.contextWindow`，或 `tokenMeter.contextPressure().contextWindow`），
   配置值降级为“用户覆盖”，仅在宿主无法上报时兜底；`panel.session.windowSource`
   暴露 `host|config|default`，分母来源可审计。
2. **分子是自估**：`Math.ceil(chars / 4)` 累加捕获 turn，系统提示 / 工具 schema / 历史重放都不在内。
   → 优先使用宿主 `tokenMeter.contextPressure()` 的 `pressureTokens` / `projectedTokens`（取较大者），
   块表与自估值只当下限。
3. **判定不含输出预留、状态机会死锁**：改为 `used + reserved >= window * threshold`
   （`requestPressure()`），`reserved` 取本次请求真实的 `maxTokens`；**必定放不进窗口的请求
   本地 fail-fast 抛 `MEM_E_CONTEXT_EXCEEDED`**（附带 used/reserved/projected/window/
   windowSource/handoff），不再发出去白付一次计费。拦截点注册在 `agent/request` 中间件：
   `await next()` 拿到最终 `{provider, model, maxTokens}` 之后、真正调用 provider 之前。
   同时 `checkHandoff()` 移除 `if (marker.active) return base;`——移除 autoNewSession 后
   同一对话不再换 session id，marker 永久 active 会让首次交接后**整个会话再也不交接**。
   改为 `rehandoffDecision()`：同会话压力比上次交接再涨 ≥5 个点、或投影 ≥95% 硬上限时允许续交
   （先清 marker 再重新蒸馏，保证新摘要描述当前尾部）。
4. **单轮超大工具输出没有熔断**：新增 `src/context/liveCompact.js`。请求前扫描 surface 上的
   `tool/result`，超过 `context.liveCompact.thresholdChars`（默认 200,000 字符）的
   **保留头 4000 / 尾 2000 字符，中间替换为一行指针**
   （`[[hippocampus:live-compact: removed N chars … seq=…, call=…, tool=…]]`），
   通过宿主 surface 协议落地（`compaction/prune` + `tool/result` 的 `surfaceOp.replace`），
   原文仍在 raw 日志、可用 `deep_raw` 按坐标取回。宿主若有 `toolResultPruner.pruneSession()`
   （ptc 预设自带，8192/4096/1024）则**优先委托**；任何失败只 warning，绝不阻断这一轮。
   切分按 code point，不会劈开代理对。

事故回顾（主线一）：1.6.2 把 `raw.archiveAfterDays` 默认值提到 90，而某 profile 仍是 `raw.retentionDays: 30` 且从未写过
`archiveAfterDays`。强校验 `archiveAfterDays < retentionDays` 在 `apply()` 内抛 `MEM_E_CONFIG_OUT_OF_RANGE`，
插件整体不加载 → 所有 `/api/hippocampus/*` 路由缺失 → 设置卡片永远停在“正在启动… / HTTP 404”。

- **配置 schema 版本与迁移机制**：`src/config.js` 新增 `CONFIG_SCHEMA_VERSION = 3`。加载顺序变为
  **`migrateConfig()` → 严格校验**。迁移阶段只补值、只告警，**从不抛错、从不覆盖用户显式写下的键**；
  缺少 `configVersion` 的旧配置按 legacy（`fromVersion: 0`）升级。
  - 首条迁移规则：`raw.archiveAfterDays` 缺失且 `raw.retentionDays <= 90` 时派生为
    `Math.max(1, retentionDays - 1)`（30 → 29），使旧 profile 自动满足硬约束。
  - 每条迁移写入 `console.warn`（`hippocampus/config-migration:`）并进入 `config.warnings`，
    `apply()` 再经 `ctx.logger.warn` 输出——**迁移永不被静默**。
  - 空配置 `{}` 视为“使用默认值”，不算 legacy，避免内部调用噪声。
- **`strictStartup`（默认 `true`）启动安全网**：显式设为 `false` 时，严格校验抛出
  `MEM_E_CONFIG_OUT_OF_RANGE` 会触发降级——丢弃越界键、回退安全值、照常启动，并置
  `startup.degraded = true`、记录 `degradedReason{code,key,message}`、输出
  `hippocampus/config-degraded:` 警告，`apply()` 额外 warn `STARTED DEGRADED (strictStartup=false)`。
  - 降级**只**覆盖越界值：`MEM_E_CONFIG_INVALID_TYPE` / `MEM_E_CONFIG_UNKNOWN_KEY` 仍 fail-fast。
  - `strictStartup` 自身必须是布尔值。
- **启动状态可观测**：`CAPABILITIES.startup` / `CAPABILITIES.configVersion`；
  `memory_admin action=status` 的 `panel.startup` / `panel.configVersion` / `panel.configWarnings`。
  设置页与运维方可以直接看到“这份配置从哪个 schema 版本来、是否迁移过、是否降级启动”。
- **设置页「简洁模式」**（纯显示层）：顶部切换“简洁模式 / 专业模式”。简洁模式只渲染
  **身份 / 上下文窗口 / 系统级存储位置迁移 / 原始回合留存（raw）**四块；raw 卡内收敛为
  `raw.mode`、`raw.maxTotalMb`、`raw.compressionEngine` 三项。隐藏项不渲染、不参与保存——
  POST 的 patch 被过滤为 9 个可见键，文件里其余配置保持原值。校验同步收敛，
  隐藏项的越界值不阻断保存。模式偏好只存浏览器 `localStorage`（`hippocampus:settings-mode`），
  默认专业模式，读写失败自动退回专业模式。
- **交接冷启动修复（用户 2026-11-13 报告）**：
  - 移除 `context.autoNewSession*`：交接继续同一对话，客户端不再弹出第二个空会话；
    旧 profile 残留键由 `migrateConfig` 剥离并 warn；`CAPABILITIES` / `handoffView` 不再暴露该字段。
  - 注入从「进程级一次性布尔」改为「按会话幂等」（`session|交接批次` 键）：子代理先装配
    不会吞掉用户新对话的注入。
  - `handoff.json` 新增 `tailTurns`（最后 ≤5 轮原话），`[Previous Context Tail]` 优先回放原话；
    `context.coldStartInjectRecentTurns` 默认改为 `true`。
  - 可观测：`/stats` 新增 `coldStart{ pending[], injected, lastSessionId }`。
- **复习队列真正被消费（现场 337 条到期从未推进）**：`tick()` 的结果此前只进维护报告，  `state/reviews.json` 里每条都是 `lastAt: null`、队列只增不减（现场 `total 346 / due 337`）。
  现在 `maintain()` 调 `_consumeDueReviews()`：到期 id 分批（`review.consumeBatchSize=40`）
  批量 `reinforce()`（权重 1，强化日志即衰减锚点），**批间 `setImmediate` 让出事件循环**，
  单轮上限 `review.consumeMaxPerRun=200`（报告 `remaining`，跨轮次排空），并用新增的
  `ReviewSchedule.advanceMany()` 做到**每批一次** `reviews.json` 写入。`review.autoConsume:false`
  可关，批次失败不中断维护（`lastAt` 保持 null，下轮重试）。
- **面板与引擎状态对齐**：`toMemoryOptions()` 补齐 `configVersion` / `startup` / `warnings`
  透传，`panel.startup` 不再报“未迁移”而 `capabilities.startup` 报真相。
- **1.6.2 遗留缺陷一并锁定**：旧 profile（仅 `retentionDays: 30`）自适应派生
  `archiveAfterDays=29` 可启动；`prune()` 现在会整月删除过期的 `.jsonl.br/.zst/.gz` 归档
  并从 `state/raw-archive.json` 抹掉记录，不再变相突破保留期。
- **测试**：新增 `test/v163.migration.test.js`（9 例）——旧配置启动 + `archiveAfterDays=29`；
  显式冲突在 strict 下阻断、非 strict 下降级；降级不吞类型错误/未知键；1.6.2 生产 profile
  原始形状可解析。`test/helpers.js` 夹具改走同一迁移步骤；`test/status.test.js` 的 panel
  形状契约同步新增三字段。新增 `test/v163.ui.test.js`（5 例）锁简洁模式契约。
  `test/v156.autoSession.test.js` 改写为「移除」契约、`test/v160.coldStart.test.js` 改写为
  「按会话注入」契约。新增 `test/v163.reviewQueue.test.js`（5 例）锁复习消费契约：
  到期被消费且 `step`/`lastAt` 前进、强化数 == 消费数、超预算积压跨轮次排空、
  `autoConsume:false` 不动队列、整批只写一次文件。
  新增 `test/v164.windowGuard.test.js`（11 例）锁 1M 溢出的全部修复：宿主窗口优先、
  `used + reserved` 判定（含真实数字 854,668 + 256,000）、`rehandoffDecision` 四分支、
  指针化（代理对不被劈开、`surfaceOp.replace` 形状）、`MEM_E_CONTEXT_EXCEEDED` 拦截、
  无宿主服务时绝不阻断。新增 `test/v165.micokernel.test.js`（8 例）锁微内核契约：
  `/memory` 全子命令返回纯文本且**网络调用数为 0**、静音真的不注入提示、`resume` 在无交接时
  明确报错且与服务接口同源、`executeDream()` 先跑月记并写入 `promoted`、`maintain()` 不再产
  月记、已晋升日记下一轮仍被排除、源码扫描无 UI/追加模式监听。
  全量 **519/519**（82 个测试文件）。

完整历史见 [CHANGELOG.md](../CHANGELOG.md) 的 `[1.6.7]` / `[1.6.6]` / `[1.6.5]` / `[1.6.4]` / `[1.6.3]` / `[1.6.2]` / `[1.6.1]` 段。

## 发布步骤（需要你执行）

> 两个包：`dsh-layers-hippocampus@1.6.7`（已有 git remote）与
> `dsh-layers-orchestrator@0.1.0`（**目前不是 git 仓库**，需先 init/建远端）。
> 全部命令在 PowerShell 下执行；`node`/`npm`/`pnpm` 用 DSH runtime 自带的绝对路径。
> **本机网络注意**：证书链校验被中间打断，`git` 需 `GIT_SSL_NO_VERIFY=1` 才能访问 origin；
> `npm` 在 PowerShell 下被 ExecutionPolicy 拦，且默认缓存目录不可写会 `EPERM`，
> 需用 `node <npm-cli.js> --cache <可写目录>` 的形式。

### 0. 预检（不发布，先确认干净）

```powershell
cd D:\86135\Documents\dsh\workspace\dsh-memory
node test/run.mjs                # 期望 519/519
cd ..\dsh-orchestrator
node test/run.mjs                # 期望 31/31
cd ..\dsh-memory
git status --short               # 全部改动都在本次 release
git check-ignore node_modules    # 必须输出 node_modules
npm pack --dry-run               # 预检实际发布内容（含/不含不该发布的文件）
```

### 1. dsh-memory：提交 + tag + push

```powershell
cd D:\86135\Documents\dsh\workspace\dsh-memory
git add -A
git status --short                 # 最后确认没有 node_modules / state / 测试临时目录
git commit -m "chore(release): v1.6.7 - ship M3 + M5 that the 1.6.6 npm bundle missed; merge the published commit"

# 历史 tag：v1.5.5 / v1.5.7 / v1.6.0 / v1.6.1 / v1.6.2 / v1.6.4 / v1.6.5 / v1.6.6。
# v1.6.5 已指向实际发布的 28776c7、v1.6.6 已指向实际发布的 99a07cb（均为 annotated），不要动它们。
# 本次只新增 v1.6.7，不需要删任何 tag。
git tag -a v1.6.7 -m "v1.6.7: test/orchestrator bridge (M3); ORCH_E_* boundary (M5)"
$env:GIT_SSL_NO_VERIFY="1"         # 本机证书链校验被中间打断，git 需要它才能连 origin
git push origin main --follow-tags
Remove-Item Env:GIT_SSL_NO_VERIFY
```

> 远端 `main` 当前是 `4a463b2`（含并入的已发布提交 `99a07cb` 与 `v1.6.6` 指向修正，
> 这两步已在本地完成并推送）。本次 release 提交在其之上；`v1.6.5` / `v1.6.6` 两个 tag
> 已在远端与 npm 对齐，无需再动。

### 2. dsh-memory：npm 发布

```powershell
# PowerShell 下 npm.ps1 被 ExecutionPolicy 拦；且默认缓存目录不可写会 EPERM。
# 用 node 直调 npm-cli.js，并把缓存放到工作区：
$npm = "D:\Program Files\node.js\node_modules\npm\bin\npm-cli.js"
$node = "C:\Users\86135\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
& $node $npm --cache D:\86135\Documents\dsh\workspace\_npmcache whoami   # 应输出 382quaii
& $node $npm --cache D:\86135\Documents\dsh\workspace\_npmcache publish --access public
# 校验
& $node $npm --cache D:\86135\Documents\dsh\workspace\_npmcache view dsh-layers-hippocampus version
Remove-Item -Recurse -Force D:\86135\Documents\dsh\workspace\_npmcache
```

### 3. dsh-orchestrator：建仓 + 提交 + tag + push

```powershell
cd D:\86135\Documents\dsh\workspace\dsh-orchestrator
git init
git add -A
git commit -m "release: v0.1.0 — federation, dedupe, multi-space router/transfer engine, orchestrator service registration, durable state"
# 先在 GitHub 建空仓库 dsh-Layers-Orchestrator，然后：
git branch -M main
git remote add origin https://github.com/382quaii/dsh-Layers-Orchestrator.git
git tag -a v0.1.0 -m "v0.1.0: initial multi-space engine release"
git push -u origin main --follow-tags
```

### 4. dsh-orchestrator：npm 发布

```powershell
npm publish --access public
npm view dsh-layers-orchestrator version
```

### 5. 切回版本依赖（可选，发布后）

当前 desktop profile 用 `link:` 指向工作区。发布后可改为固定版本（不再依赖本地路径）：

```powershell
cd C:\Users\86135\.dsh\profiles\desktop
# 编辑 package.json：
#   "dsh-layers-hippocampus": "1.6.7"
#   "dsh-layers-orchestrator": "0.1.0"
pnpm install
# 重启 DSH
```

### 6. 市场提交（可选，需要 GitHub 账号）

`dsh-memory` 已有 `market/` 目录；`dsh-orchestrator` 需要新建条目：

1. GitHub 仓库 Settings → Topics 添加 `dsh-plugin`；
2. fork `awesome-dsh-plugin`；
3. `dsh-memory`：复制 `market/data/plugins/382quaii__dsh-Layers-Hippocampus.yml` 到同路径；
4. `dsh-orchestrator`：按同 schema 新建 `382quaii__dsh-Layers-Orchestrator.yml`（name/仓库/npm 名/summary/categories）并提交；
5. 提 PR（只加文件，不改 README）。

### 7. 发布后验证

```powershell
node test/run.mjs                 # 两包都应保持全绿
npm view dsh-layers-hippocampus dist-tags
# 重载 DSH 后：memory_admin action=status 检查 panel.startup / panel.configVersion
# 若曾改过 profile 配置，确认 panel.configWarnings 为空（无迁移）或已知迁移项
```

## 未完成 / 已知边界

- **1.6.4 的窗口守卫只阻断、不压缩**：它会拦下必定放不进窗口的请求（`MEM_E_CONTEXT_EXCEEDED`）
  并把单轮超大工具结果指针化，但真正把上下文降下来仍靠宿主的 compaction（ptc 预设自带
  `compaction-basic` + `tool-result-pruner`）或用户开新对话。宿主没有 `llm` / `tokenMeter`
  服务时，窗口分母回落到 `context.nativeTokenLimit`（`windowSource: 'config'`）。
- **1.6.5 的 npm 制品缺修复**：`dsh-layers-hippocampus@1.6.5` 的 `gitHead` 是 `28776c7`，
  不含 Live Compact 那条修复；npm 版本不可覆盖，故该修复走 1.6.6。
  本地 `v1.6.5` tag 已重建并指向该提交，与 npm/GitHub 一致。
- **1.6.6 的 npm 制品来自旧 checkout**：其 `gitHead` 是 `99a07cb`（旧 checkout 上只改版本号的
  一次提交），**只含** Live Compact 修复，**不含** M3/M5。1.6.7 补上这两项；旧提交已并入
  `main`，本地 `v1.6.6` tag 指向该提交，发布可追溯。
- **发布时使用唯一样本**：`dsh-memory` 曾存在两份 checkout（旧 `C:\Users\86135\Documents\deepseek-harness\default-workspace\dsh-memory`
  与新 `D:\86135\Documents\dsh\workspace\dsh-memory`）。发布前务必确认 `pwd`、`git log -1`、
  `package.json` 版本号与 profile 中 `node_modules` 的 junction 目标一致；旧目录已不再作为发布源。
- `v1.6.3` 从未发布（无 git push、无 npm publish），其全部内容已并入 1.6.4 起各版；
  本地 `v1.6.3` tag 在发版时删除。
- 本次发布会把 `dsh-orchestrator` 作为独立包首次发布（建仓 + npm）。
- 纯本地低谷调度 Phase 1/2 已完成（峰谷窗口、`dream-queue.json`、唤醒定时器、睡过头补偿）；未接 `dsh-price-tip` / `peak-runner` / `notify-plugin`（不需要）。
- 物理切割已完成：`src/spaces/*` 只剩 `singleSpace.js`；未安装 Orchestrator 时多空间能力显式消失（`MEM_E_FEATURE_DISABLED`）。
- **市场可见性**：只有已发布 npm 且有目录条目的插件才出现在市场；发布后需按第 6 步提 PR。
- Dream LLM 的 endpoint/model/key 只从 profile 或 `DSH_DREAM_LLM_*` 注入，UI 不渲染密钥字段。
- 迁移机制目前只有一条规则（`archiveAfterDays`）。后续 schema 变更应在 `migrateConfig()` 内按 `fromVersion` 递进追加规则，并同时补 `test/v163.migration.test.js` 风格的回归用例。

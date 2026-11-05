# Release 1.5.7 — 发布准备（本地）

> 版本冻结：**1.5.7 是本次发布版本，后续不再升版本号**。

> 状态：**代码与文档已就绪；仓库推送 / npm 发布 / 市场 PR 需要你的 GitHub 与 npm 凭据，代理与网络，本会话未执行。**
> 基线：`dsh-memory` 工作区，全量 **411/411 测试通过**（64 个测试文件；另有 `dsh-orchestrator` 31/31）。
> 安装状态：`dsh-orchestrator` 已本地 link 安装到 desktop profile（`include:orchestrator` active）；插件市场仍无条目（未发布 npm）。

## 本版内容

- **P0-1** `deep_raw` 按行游标扫描：`readLinesReverse()` 64 KiB 反向分块、逐行产出；`hit.line` 仍为绝对行号；引擎结果硬上限 `MAX_SCAN_RESULTS=500`；`restoreByHash` / tombstone / hash 读取全部流式化。
- **P0-2** maintain 事件循环延迟监控：`perf_hooks.monitorEventLoopDelay`，阶段间 `yieldIfLagging()`（>100ms 让出 50ms），报告 `eventLoop:{maxMs,p99Ms,yields}`。
- **P0-3** recall 响应上限 `context.maxInjectTokens`（默认 4000，256–100 000），超限 `truncated:true` + `payload` 计数。
- **P0-4** `Memory.close()` 资源释放：raw flush timer 同步落盘、scheduler detach、索引视图 release。
- **P1-1** 入库即打标：`src/tagging.js` 确定性锚点（错误类型/errno/代码块/HTTP/路径/任务语句）；手传 tags 优先；miss 记 `MEM_E_AUTO_TAG_MISS`；`tagging.*` 可配。
- **P1-2** L2 Pinned：`remember({pinned:true})` 永不衰减、命中标签置顶、缺 tags 抛 `MEM_E_PINNED_TAG_REQUIRED`；`panel.global.pinned`。
- **P1-3** 相关性线索：移除全局 `[Memory Map]`，只注入与当前输入词法匹配的最多 5 个标签（`[Memory Hints]`，位于易变尾巴）。
- **P1-4** Dream LLM：原生 `fetch`、零依赖、结构化 JSON、15s 超时、本地降级 + `MEM_E_DREAM_LLM_FALLBACK`、`source_event_ids` 溯源、熔断/半开。
- **P1-5** Orchestrator 独立包 `dsh-orchestrator`：联邦映射 / 认领去重 / 路由 / 显式授权 / 服务注册 / 状态持久化（已本地安装，本版首次正式发布）。
- **P1-6** 能力开关：`features.multiSpace` / `features.crossSpaceTransfer`，关闭即工具与路由 `MEM_E_FEATURE_DISABLED`；`Memory.open('/abs/dir')`；`Memory.warmup()`。
- **P1-7** 宿主生命周期：`agent/created`/`session/created` → 补偿 Dream（`dream.compensateAfterHours`，价格窗口注入）；`MockHostEnvironment` 测试。
- **P2 部分**：Dream 配置 UI 化（安全子集，`dream.llm.*` 永不下发浏览器）；L2 多合一蒸馏（同标签重复经验合并、pinned 与普通严格分组、`global_tags` 只进 meta、`state/l2-merge.json` 标记 `merged_into`）；L3 标签不变量（显式写入空标签 `MEM_E_SEMANTIC_TAG_REQUIRED`，离线路径自动派生锚点，历史空标签 `degraded`）；工作模式跨交接保持（marker 记录 `agentPreset`，新会话首轮前恢复，旧 marker 自动补写）；**物理切割**（多空间 `spaceRouter`/`transfer` 移入 `dsh-orchestrator`，本体只留 `singleSpace.js`；未安装 Orchestrator 时空间工具与迁移按 `MEM_E_FEATURE_DISABLED` 显式消失，安装后经 `orchestrator` 服务自动恢复）。

## 发布步骤（需要你执行）

> 两个包：`dsh-layers-hippocampus@1.5.7`（版本冻结，已有 git remote）与
> `dsh-layers-orchestrator@0.1.0`（**目前不是 git 仓库**，需先 init/建远端）。
> 全部命令在 PowerShell 下执行；`node`/`npm`/`pnpm` 用 DSH runtime 自带的绝对路径。

### 0. 预检（不发布，先确认干净）

```powershell
cd C:\Users\86135\Documents\deepseek-harness\default-workspace\dsh-memory
node test/run.mjs                # 期望 411/411
cd ..\dsh-orchestrator
node test/run.mjs                # 期望 31/31
cd ..\dsh-memory
git status --short               # 全部改动都在本次 release
git check-ignore node_modules    # 必须输出 node_modules
npm pack --dry-run               # 预检实际发布内容（含/不含不该发布的文件）
```

### 1. dsh-memory：提交 + tag + push

```powershell
cd C:\Users\86135\Documents\deepseek-harness\default-workspace\dsh-memory
git add -A
git status --short                 # 最后确认没有 node_modules / state / 测试临时目录
git commit -m "release: v1.5.7 — raw cursor scan, payload cap, tagging, pinned memory, hints, feature flags, federation/dedupe, cross-space recall, orchestrator installer, durable state, auto new conversation, low-valley scheduler"

# 版本冻结：只打 v1.5.7；1.5.6 是未发布草稿，已并入本版
git tag -a v1.5.5 -m "v1.5.5: offline Dream LLM distillation with local fallback" 2>$null
git tag -a v1.5.7 -m "v1.5.7: final release (version freeze) — 1.5.6 features + federation, read merge, cross-space recall, durable state, installer, auto new conversation"
git push origin main --follow-tags
```

### 2. dsh-memory：npm 发布

```powershell
npm whoami                        # 必须先登录；否则 npm login
npm publish --access public
# 校验
npm view dsh-layers-hippocampus version
```

### 3. dsh-orchestrator：建仓 + 提交 + tag + push

```powershell
cd C:\Users\86135\Documents\deepseek-harness\default-workspace\dsh-orchestrator
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
#   "dsh-layers-hippocampus": "1.5.6"
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
# 重载 DSH 后：/stats 检查 capabilities.spaces / spacesDelete / crossSpaceRecall
# 插件列表检查 include:orchestrator = active
```

## 未完成 / 已知边界

- `dsh-orchestrator` 已本地 link 安装并激活（`include:orchestrator` active）；本次发布把它作为独立包首次发布（建仓 + npm）。
- 纯本地低谷调度 Phase 1/2 已完成（峰谷窗口、`dream-queue.json`、唤醒定时器、睡过头补偿）；未接 `dsh-price-tip` / `peak-runner` / `notify-plugin`（不需要）。
- 物理切割已完成：`src/spaces/*` 只剩 `singleSpace.js`；未安装 Orchestrator 时多空间能力显式消失（`MEM_E_FEATURE_DISABLED`）。
- 第一批冲刺 + 空间删除 + 图谱交互 + 联邦/去重 + 跨空间 recall（默认关 `features.crossSpaceRecall`）均已完成。
- **市场可见性**：只有已发布 npm 且有目录条目的插件才出现在市场；发布后需按第 6 步提 PR。
- Dream LLM 的 endpoint/model/key 只从 profile 或 `DSH_DREAM_LLM_*` 注入，UI 不渲染密钥字段。

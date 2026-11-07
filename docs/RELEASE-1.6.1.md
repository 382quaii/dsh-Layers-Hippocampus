# Release 1.6.1 — 发布准备（本地）

> 版本：**1.6.1**（2026-11-07：全面解除 1.5.7 的版本冻结，恢复语义化版本；本版新增检索上限剪枝与段记 Token 审计）。

> 状态：**代码与文档已就绪；仓库推送 / npm 发布 / 市场 PR 需要你的 GitHub 与 npm 凭据，代理与网络，本会话未执行。**
> 基线：`dsh-memory` 工作区，全量 **433/433 测试通过**（64 个测试文件；另有 `dsh-orchestrator` 31/31）。
> 安装状态：`dsh-orchestrator` 已本地 link 安装到 desktop profile（`include:orchestrator` active）；插件市场仍无条目（未发布 npm）。

## 本版内容

- **A 检索上限剪枝（1.6.1 新增）**：命中分数上界 `salience × 3.9`（tagAffinity≤3、timeBoost≤1.3 等因子封顶），候选按 salience 降序访问，上界打不过第 k 名即停止评分；pinned 绕过剪枝；`pruned`/`notes` 可观测；4 个用例 `test/v170.pruning.test.js`。
- **压缩引擎可选（1.6.1）**：`raw.compressionEngine` 支持 `gzip`（默认）/ `zstd`，设置页可选择并一键启用/停用。Zstd 走 Node 内置 `node:zlib`，**不下载任何包、也没有可卸载的包**——“停用”即切回 gzip。归档扩展名 `.jsonl.gz` / `.jsonl.zst` 按扩展名分派解压，旧格式切换后仍可读；运行时无 zstd 则静默回退，`capabilities.compression` 报告可用性。4 个用例 `test/v161.compression.test.js`。
- **段记 Token 审计（1.6.1）**：`docs/AUDIT-2026-11-07-segment-token.md` 证明无 P0 重复注入，列出 6 个注入面；2 个 P3 已实施：Active Task 事件进块去重池、Persona 按 L3 形状 memo 化。
- **raw 冷热分层压缩（1.6.1，零依赖）**：`maintain()` 月度门控，把超过 `raw.archiveAfterDays`（默认 7）的日分片按月合并为 `raw-archive-YYYY-MM.jsonl.gz`（Node 原生 `zlib`）后删除明文；豁免近 30 天有访问、`pinned`、`status:handoff`、高频标签；`deep_raw`/hash 恢复用 `createGunzip()` 流式逐行读、命中即停；损坏归档 `MEM_E_CORRUPTED_ARCHIVE` 跳过。`raw.retentionDays` 默认 30→90 且必须大于阈值（fail-fast）。7 个用例 `test/v161.archive.test.js`。
- **版本解冻（2026-11-07）**：删除全部“版本冻结/不再升版本号”表述，自 1.6.0 起恢复正常版本节奏。
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

> 两个包：`dsh-layers-hippocampus@1.6.1`（已解冻，已有 git remote）与
> `dsh-layers-orchestrator@0.1.0`（**目前不是 git 仓库**，需先 init/建远端）。
> 全部命令在 PowerShell 下执行；`node`/`npm`/`pnpm` 用 DSH runtime 自带的绝对路径。

### 0. 预检（不发布，先确认干净）

```powershell
cd C:\Users\86135\Documents\deepseek-harness\default-workspace\dsh-memory
node test/run.mjs                # 期望 433/433
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
git commit -m "release: v1.6.1 — recall bound pruning; segment-token audit; version un-frozen"

# 历史 tag 已存在（v1.5.5 / v1.5.7 / v1.6.0）；本次新增 v1.6.1
git tag -a v1.6.1 -m "v1.6.1: recall bound-based early exit; segment-token audit; version un-frozen"
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

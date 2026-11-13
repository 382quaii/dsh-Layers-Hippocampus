# Release 1.6.3 — 发布准备（本地）

> 版本：**1.6.3**（2026-11-13：配置 schema 迁移 + `strictStartup` 启动安全降级 + 设置页简洁模式 + 交接冷启动按会话注入；`CAPABILITIES.version` 与测试断言同步）。

> 状态：**代码与文档已就绪；仓库推送 / npm 发布 / 市场 PR 需要你的 GitHub 与 npm 凭据，代理与网络，本会话未执行。**
> 基线：`dsh-memory` 工作区，全量 **477/477 测试通过**（77 个测试文件；另有 `dsh-orchestrator` 31/31）。
> 安装状态：`dsh-orchestrator` 已本地 link 安装到 desktop profile（`include:orchestrator` active）；插件市场仍无条目（未发布 npm）。

## 本版内容

**主线：把 2026-11-13 的“旧配置启动阻断”事故固化为引擎能力。**

事故回顾：1.6.2 把 `raw.archiveAfterDays` 默认值提到 90，而某 profile 仍是 `raw.retentionDays: 30` 且从未写过
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
- **测试**：新增 `test/v163.migration.test.js`（9 例）——旧配置启动 + `archiveAfterDays=29`；
  显式冲突在 strict 下阻断、非 strict 下降级；降级不吞类型错误/未知键；1.6.2 生产 profile
  原始形状可解析。`test/helpers.js` 夹具改走同一迁移步骤；`test/status.test.js` 的 panel
  形状契约同步新增三字段。新增 `test/v163.ui.test.js`（5 例）锁简洁模式契约。
  `test/v156.autoSession.test.js` 改写为「移除」契约、`test/v160.coldStart.test.js` 改写为
  「按会话注入」契约。全量 **477/477**。

完整历史见 [CHANGELOG.md](../CHANGELOG.md) 的 `[1.6.3]` / `[1.6.2]` / `[1.6.1]` 段。

## 发布步骤（需要你执行）

> 两个包：`dsh-layers-hippocampus@1.6.3`（已有 git remote）与
> `dsh-layers-orchestrator@0.1.0`（**目前不是 git 仓库**，需先 init/建远端）。
> 全部命令在 PowerShell 下执行；`node`/`npm`/`pnpm` 用 DSH runtime 自带的绝对路径。

### 0. 预检（不发布，先确认干净）

```powershell
cd C:\Users\86135\Documents\deepseek-harness\default-workspace\dsh-memory
node test/run.mjs                # 期望 477/477
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
git commit -m "release: v1.6.3 — config schema migration and strictStartup degraded boot"

# 历史 tag 已存在（v1.5.5 / v1.5.7 / v1.6.0 / v1.6.1 / v1.6.2）；本次新增 v1.6.3
git tag -a v1.6.3 -m "v1.6.3: configVersion=3 migration-first loading; strictStartup degraded boot; startup surfaced in panel"
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
#   "dsh-layers-hippocampus": "1.6.3"
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

- 本次发布会把 `dsh-orchestrator` 作为独立包首次发布（建仓 + npm）。
- 纯本地低谷调度 Phase 1/2 已完成（峰谷窗口、`dream-queue.json`、唤醒定时器、睡过头补偿）；未接 `dsh-price-tip` / `peak-runner` / `notify-plugin`（不需要）。
- 物理切割已完成：`src/spaces/*` 只剩 `singleSpace.js`；未安装 Orchestrator 时多空间能力显式消失（`MEM_E_FEATURE_DISABLED`）。
- **市场可见性**：只有已发布 npm 且有目录条目的插件才出现在市场；发布后需按第 6 步提 PR。
- Dream LLM 的 endpoint/model/key 只从 profile 或 `DSH_DREAM_LLM_*` 注入，UI 不渲染密钥字段。
- 迁移机制目前只有一条规则（`archiveAfterDays`）。后续 schema 变更应在 `migrateConfig()` 内按 `fromVersion` 递进追加规则，并同时补 `test/v163.migration.test.js` 风格的回归用例。

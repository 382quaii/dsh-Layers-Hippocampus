# Release 1.7.3 — 上下文物理折叠 · raw 墓碑移位 · 敏感硬拦截 · 交接标记随压力过期

> 版本：**1.7.3**（2026-11-27）
> 基线：`dsh-memory` 工作区，全量 **571/571 测试通过**（88 个测试文件；`dsh-orchestrator` 31/31）
> 运行时依赖：**零**（只用 Node 标准库）
> 状态：代码 + 测试 + 文档已本地提交并打 tag `v1.7.3`；npm 侧仍由用户执行 `npm publish`。

## 一句话

以前「上下文快满了」只能靠原生压缩或直接报错，「删掉的记忆」还会在 raw 里留下只会增长的行，
「密钥」只能整条记录藏起来，「上下文快满了」这个断言还**不会过期**（于是模型总是提前交接）。
1.7.3 把四件事都落到插件自己的层里：**折叠留指针**、**墓碑进覆盖层**、
**敏感标签在读路径上硬拦截**、**交接标记随压力解除**。

## 模块一：上下文物理折叠（`src/context/smartPrune.js`）

- `guardRequest` 在原 fail-fast **之前**插入「2.5 physical pruning」：当
  `context.smartPrune.enabled !== false` 且 `projectedRatio >= context.smartPrune.threshold`
  （默认 `0.85`）时触发。
- 挑选规则：按 `keepRecentTurns`（默认 3，以 **USER 轮**计）保护最近对话；跳过
  `tool/call`（工具调用必须与结果成对）、跳过已折叠节点；按字符数降序最多折叠 `maxNodes`
  （默认 8）个长轮，单个至少 `minChars`（默认 1200）字符。
- 折叠方式：`session.append('compaction/prune', { shadowedRange, shadowedSeqs, shadowedTokenCount, reason: 'hippocampus:smart-context-prune', pointer })`
  记录被遮蔽区间，然后以
  `surfaceOp: { op: 'replace', startSeq, endSeq }` + `sourceEventSeqs: [seq]`
  写回同类型事件，内容只剩一行指针：

  ```text
  [System: 此段包含 5 轮关于 [deploy] 的细节，已折叠。原文 ID: ev_01H...。若需要，请使用 recall 工具检索。]
  ```

  没有事件 ID 时退化为 `raw:turn_<seq>_<role>` —— raw 存储的 `turn_id` 是确定性的，
  指针永远能反查回来。
- 折叠后重新测量压力并写 `runtime.lastSmartPrune = { ratioBefore, ratioAfter, folded, charsBefore, charsAfter, pointers }`；
  `MEM_E_CONTEXT_EXCEEDED` 的 details 里也带上它，所以「折叠了还不够」是可诊断的，而不是黑箱。
- 单节点失败不中断整轮：`failed` 计数带在返回值里。

配置项（都可在设置页编辑）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `context.smartPrune.enabled` | `true` | 总开关 |
| `context.smartPrune.threshold` | `0.85` | 触发比例（0.5–0.99） |
| `context.smartPrune.keepRecentTurns` | `3` | 保护最近 N 个用户轮 |
| `context.smartPrune.minChars` | `1200` | 小于此长度的轮次不值得折叠 |
| `context.smartPrune.maxNodes` | `8` | 单次最多折叠节点数 |

## 模块二：raw 墓碑移位（`src/tombstones.js` + `state/raw-tombstones.json`）

- 旧行为：`forget` 往 `raw/*.jsonl` **追加** `{type:'raw_tombstone'}`。
  raw 是追加日志 → 文件只增不减；每次 `deep_raw` 要扫全部分片才知道哪些内容已死。
- 新行为：墓碑只写覆盖层 `state/raw-tombstones.json`，**双层键**：
  - `turnIds` —— 整回合（`turn_<seq>_<role>`），O(1) 命中；
  - `contentHashes` —— 片段级 `sha256(content)`，覆盖同一句话在别处的复读。
- `forget()` / pending-delete flush 先 `raw.turnIdsForHashes()` 反查 turn_id，再
  `raw.tombstone({ hashes, turnIds, at })` 双键一起写。
- 读取路径（热分片扫描、归档扫描、`has()`、`restoreByHash`）统一走 `_isTombstoned()`。
- 老数据迁移：`maintain()` 里 `stripLegacyTombstoneLines()` 逐分片「读全文 → 保留非墓碑行 →
  先 `tombstones.add()` 保住键 → 写 `.tmp-clean` 再 rename」，报告
  `report.rawTombstoneMigration = { shards, removedLines, bytesBefore, bytesAfter }`。
  升级后 raw 字节数**下降**。

## 模块三：敏感标签与读时硬拦截（`src/sensitive.js`）

- 废弃「整条记录一刀切」的 `privacy:secret` 语义，改为 Pre-Ingest 内容分类：
  - `sensitive:credential`（`password=…`、`-----BEGIN … PRIVATE KEY-----`、connection string）
  - `sensitive:api_key`（`sk-…`、`ghp_…`、`AKIA…`、`xox[abposr]-…`、`AIza…`）
  - `sensitive:pii`（邮箱、手机号、身份证、银行卡形态的长数字串）
  - 同时写 `meta.sensitive: ['api_key', …]` 作为证据，tag 仍是权威。
- 读取层默认**物理剔除**：
  - `recall`：从 hits 里移除，notes 记 `sensitive-withheld:<n>`；
  - `deep_raw`：连 snippet 都不给（snippet 本身就是泄漏面），`scanned.skipped.sensitive` 计数；
  - 只有显式 `allow_sensitive: true`（工具参数同名 `allow_sensitive`）才放行。
- 审计用途：不知道内容、但要知道「被拦了多少」时看 `sensitive-withheld:N`。
- `normaliseTagToken` 对 `sensitive:` 家族开了例外（保留 `_`），因为它写的是**读取契约**，
  不能被归一化成 `sensitive:api-key`。
- `MEM_E_SENSITIVE_ACCESS_DENIED` 为强行调用（`allow_sensitive` 缺失且策略要求拒绝）预留的错误码。

## 模块四：交接标记随压力过期（`src/context/windowGuard.js` + `Memory#maintainHandoffMarker()`）

- **症状**：`[Task State] desktop · window 120k/1049k`（约 11%）时，提示词尾部仍然每轮注入
  `[交接标记] 上下文已接近原生窗口上限，末尾摘要已存为 L1.5。`，模型于是**主动提前交接**。
- **根因（三条同时成立）**：① `runtime.promptState()` 只看 `handoff.active` 就追加标记；
  ② 唯一会清标记的 `checkHandoff()` 只在 `guardRequest` 的 `hardExceeded`（真塞不下）分支里跑；
  ③ 1.6.3 起同一会话不再换 session id，stale-session 分支（`marker.sessionId !== usage.sessionId`）
  也不触发。⇒ 外部压缩（host compaction / billion-context）把 900k 压回 120k 之后，
  标记仍然字面为真，永远不消失。
- **判据**（`relievedDecision()`，两条任一成立即「压力已解除」）：
  - 绝对：`projectedRatio <= context.handoffClearRatio`（默认 `0.5`，可配 `0.1–0.9`）；
  - 相对：`projectedRatio <= markerRatio - RELIEF_COLLAPSE_DELTA`（`0.3`）——「这段对话被压缩过」。
- **保守规则（必须写死）**：**「没有测量」不等于「压力为 0」**。真实宿主从不调用
  `observeSessionTokens()`，本地会话计数器通常是空的；把它读成 0 会清掉一条仍然真实的标记，
  所以缺测量时返回 `reason: 'no-pressure'` 并保持标记不动。
- **读数来源唯一**：`guardRequest` 每次请求都写 `runtime.lastPressure = { ratio, tokens, at }`
  并在**所有**请求上跑一次 upkeep；`promptState()` 只复用**新鲜**（`HANDOFF_PRESSURE_FRESH_MS = 5 分钟`）
  的读数，过期/缺失时保持标记。`onAgentCreated` 重置读数，新会话不继承旧读数。
- 清除时写 `clearHandoff({ reason: 'pressure-relieved:<reason>', consumedBy: '<session>:ratio=<r>' })`，
  所以事后能查出「谁、按什么比例清掉的」。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `context.handoffClearRatio` | `0.5` | 绝对解除阈值（0.1–0.9） |

## 契约变更（旧测试同步更新）

- `test/v14.test.js`：「deep_raw 返回脱敏片段」→「默认拦截、放行后可见」；
  「forget 追加墓碑行」→「写覆盖层、分片不增长」。
- `test/v162.nonlinear.test.js`：distill-prune 的墓碑断言改查覆盖层文件。
- 顺手修的真 bug：`pruneDistilled()` 还在用定位参数 `tombstone([...hashes], {at})`，
  1.7.3 换成对象签名后它**静默写不进键**——是测试把它抓出来的。

## 验证

```text
✔ foldPointer names the raw turn and never returns an empty pointer
✔ smart prune replaces the long turn through surface-replace and leaves tool/call pairs intact
✔ plan protects the most recent user turns and skips already-folded nodes
✔ forget writes the overlay, leaves the shard size unchanged, and deep_raw cannot see the turn
✔ detectSensitive classifies an API key and a plain text differently
✔ a record with an API key is tagged sensitive:api_key and is blocked on every read path
✔ filterSensitive reports a count without leaking the body
✔ relievedDecision clears below the absolute ratio and ignores small jitter
✔ relievedDecision treats a compression collapse as relief even above the absolute threshold
✔ maintainHandoffMarker never clears on an empty local counter
✔ maintainHandoffMarker clears the marker on low pressure and records the reason
✔ a fresh low-pressure reading stops the marker from being injected again
```

全量：`node test/run.mjs` → **571/571 通过**（88 个测试文件）。

## 发布步骤（本地已完成 / 远端待用户）

```powershell
cd /d D:\86135\Documents\dsh\workspace\dsh-memory
git add -A
git commit --amend -m "feat: physical context folding, raw tombstone overlay, sensitive read gate, handoff marker expiry (v1.7.3)"
git tag -f -a v1.7.3 -m "v1.7.3: smart prune + tombstone overlay + sensitive hard block + handoff marker expiry"
npm publish --access public
git push origin main --follow-tags
```

- 插件代码**不会热重载**：装完/升级完需要重启 DSH 才生效。
- 若 npm 仍受账号级封控，可用 `pnpm add "github:382quaii/dsh-Layers-Hippocampus#v1.7.3"` 装同一份代码。

## 未包含（留给后续版本）

- 原生大模型压缩：**不做**，本插件只在上下文层物理折叠，不引入任何模型调用。
- Zstd 可插拔安装器 UI、L1.5 Segment 存储、Token 泄漏审计：仍在路线图上。
- 1.7.3 是**未发布**版本，所以「交接标记过期」这个修复直接并进 1.7.3（不另开 1.7.4），
  历史 commit 用 `--amend` 重写、tag 用 `-f` 移动都安全（远端从未推送过）。

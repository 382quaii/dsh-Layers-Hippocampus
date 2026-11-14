# 诊断报告：`ptc` 预设丢失与 1M 上下文爆炸的责任边界

> 版本基线：dsh-memory `1.6.3`（未发布）｜ DSH `0.2.2-rc.3` 打包版 Electron ｜ profile `desktop` ｜ 2026-11-14
> 本报告**只做诊断，不含修复代码**（按 m05321 要求）。

---

## 0. 结论先行

| 问题 | 归属 | 与另一个问题是否相关 |
| --- | --- | --- |
| `agent-preset/not-found: Unknown agent preset: ptc` + 预设页空白 | DSH 内置预设的就绪时序 × `billion-context` 对 preset 行的 `inject` 改写 | **不相关** |
| 854668 + 256000 > 1,048,576 导致 `CONTEXT_WINDOW_EXCEEDED` | 海马体自身三条缺陷 | **不相关** |

架构侧的假设「ptc 丢失 → 海马体拿不到正确 max_tokens → 1M 灾难」**不成立**：

1. `ptc` 不是任何插件「提供」的，它是 DSH 内置 bundle 的产物；`billion-context` 无法提供它。
2. 海马体**从不读取**预设、模型 `contextWindow` 或 `maxTokens` 来决定交接；它只用自己的 `context.nativeTokenLimit`（本机 = 8000）。所以 ptc 在不在，都不改变它的交接阈值。
3. 1M 爆炸的算式是宿主侧固定值造成的：`854668`（本轮 message tokens）+ `256000`（`DEFAULT_MAX_TOKENS`，单请求输出上限）= `1,110,668 > 1,048,576`。这个 256000 与预设无关，是 `@deepseek-ai/dsh-llm-deepseek/src/defaults.ts` 的常量。

---

## 1. 任务一：`ptc` 是谁提供的

### 1.1 `ptc` 由 DSH 内置 web-app bundle 提供（已确证）

`@deepseek-ai/dsh-web-app/package.json`：

```json
"dsh": { "bundle": { "patch": [
  "./cordis.patch.yml",
  "./presets/standard.patch.yml",
  "./presets/ptc.patch.yml",
  "./presets/minimal.patch.yml",
  "./presets/cordis.patch.yml"
] } }
```

`presets/ptc.patch.yml` 的实质是一行 insert：

```yaml
- insert:
    - id: preset-ptc
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: ptc
        order: 2
        plugins: [...]
```

四个内置预设同构：`preset-standard` / `preset-ptc` / `preset-minimal` / `preset-cordis`。该文件**不含 `inject`**（实测 `inject` 出现次数 = 0）。

### 1.2 profile 只是「选中」了 ptc，没有「定义」它

`C:\Users\86135\.dsh\profiles\desktop\cordis.patch.yml`（150 行）里与预设相关的只有一处：

```yaml
- id: agent-preset-registry
  name: '@deepseek-ai/dsh-agent-preset-registry'
  config: { default: standard, selectedDefault: ptc }
```

全部 6 个历史备份（`.bak-1793197966878`、`.bak-2026-10-30T13-18-59-041Z`、`.bak-2026-11-03T15-36-32-268Z`、`.bak-2026-11-13T15-26-40-839Z`、`.bak-2026-11-13T15-26-59-787Z`、`.bak-20261104-221007-dedupe`）内容一致，**没有任何 `preset-*` 行**。

注册表语义（`@deepseek-ai/dsh-agent-preset-registry/src/index.ts`，415 行）：

```ts
static Config = z.object({ default: z.string().required(), selectedDefault: z.string().volatile() })
get defaultId() { return this.config.selectedDefault.get() ?? this.config.default }
register(definition) { /* 只写 definitions Map */ }
resolve(id) { const d = this.definitions.get(id); if (d === undefined) throw new RemoteError('agent-preset/not-found', `Unknown agent preset: ${id}`, { agentPreset: id, available: [...keys] }) }
```

因此：`selectedDefault: ptc` 是**指针**，指针指向的 definition 必须先被 `preset-ptc` 行 `register()` 出来。`Unknown agent preset: ptc` 的**唯一含义**是：`definitions` 里根本没有 `ptc`，即 `preset-ptc` 这一行从未完成初始化。

### 1.3 `billion-context` 只 patch 行，不创建预设（已确证）

`C:\Users\86135\.dsh\profiles\desktop\node_modules\billion-context\dsh.bundle.patch.yml`（55 行）核心内容：

```yaml
- insert:
    - { id: bili-native, name: billion-context }
    - { id: bili-compaction-gate, name: billion-context/dsh-compaction-gate }
- id: compaction-basic
  config: { auto: false }
- id: preset-standard
  inject: [biliBasicCompactionPolicy]
- id: preset-ptc
  inject: [biliBasicCompactionPolicy]
- id: preset-minimal
  inject: [biliBasicCompactionPolicy]
- id: preset-cordis
  inject: [biliBasicCompactionPolicy]
```

文件内注释（关键，原文）：

> `# #3354: keep in sync with writeDshAcpPatch in src/launcher.ts — entry inject lists are REPLACED by patches, not concatenated`
> `# #3662: the gate lives in its OWN always-on entry, not in bili-native — disabling or kill-switching bili-native must leave the gate service alive so the presets fall back to STOCK dsh compaction instead of pending forever (the old wiring bricked session creation on exactly that path).`

`billion-context/dist/index.js` 里也只有一个 inject 写入器，且只写 profile/patch 层，不写 definition：

```js
var BILI_COMPACTION_DISABLE_SERVICE = "biliBasicCompactionPolicy";
var DSH_WEB_PRESET_IDS = ["preset-standard","preset-ptc","preset-minimal","preset-cordis"];
function compactionDisablePatchRows(){
  return DSH_WEB_PRESET_IDS.map(id => `- id: ${id}\n  inject: [${BILI_COMPACTION_DISABLE_SERVICE}]\n`).join("")
}
```

`biliBasicCompactionPolicy` 这个服务由 `bili-compaction-gate` 条目提供（`dist/agent/dsh-compaction-gate.js`）：

```js
var name = "bili-compaction-gate"; var inject = [];
function apply(ctx){ registerCompactionDisable(ctx) }
// registerCompactionDisable 内：
ctx.on("internal/config", function(_raw, next){ ... }, { global: true })
ctx.reflect?.provide?.(BILI_COMPACTION_DISABLE_SERVICE, Object.freeze({ owner: "billion-context", issue: "#3354" }))
```

### 1.4 最可能的机制（推断，机制自洽但缺一条现场证据）

1. 组合时 `preset-*` 行的 `inject` 被 bili 的 patch **替换**成 `[biliBasicCompactionPolicy]`（替换而非追加 —— 注释明说）。
2. Cordis 的服务注入是**阻塞式**的：条目的 `inject` 未满足 → 该条目一直 pending，`Service.init` 不执行 → `agentPresets.register()` 不跑 → `definitions` 里没有 ptc。
3. 于是：新建会话 / `/stats` 里 `selectedDefault` 解析 → `resolve('ptc')` 抛 `agent-preset/not-found`；预设页调 `list()` → 若有 pending 行会等 loader settle → 页面空白。
4. 装回（或修复）bili → `bili-compaction-gate` 条目在场并提供 `biliBasicCompactionPolicy` → 四条 preset 行完成初始化 → 恢复正常。

**这条链要求一个额外前提**：空白发生时 bili 的 patch 层仍然生效，但 gate 服务没有就位。只把 bili 从 `dsh.profile.bundles` 里删掉不足以留下这个状态（patch 层会整体消失），因此当时的现场更可能是其中之一：

- bili 还在 bundles 里，但 `bili-native` 或其依赖加载失败/被禁用，而旧版 bili 曾把 gate 内嵌在 `bili-native` 里（`#3662` 修的正是这个「bricked session creation」的老接线）；
- profile 的 `cordis.patch.yml` 里残留过 bili 托管块（`# bili begin … # bili end`），卸载时未被 strip。

**现场证据缺失（诚实说明）**：本机当前 `.dsh` 下**没有任何 `*-bili` 目录、没有 `.bili-acp.patch.yml`**，profile 的 `cordis.patch.yml` 也不含 preset 行或 bili 托管块；`C:\Users\86135\.dsh` 全盘检索 `Unknown agent preset` **零命中**。因此上面第 4 条无法用当前文件系统证实，只能靠「当时 stderr 的 `skipping profile bundle "<name>"` 输出」或「当时的 `cordis.patch.yml` 内容」回头确认。

### 1.5 可以立即做的三个探针（不改任何代码）

```powershell
# 探针 A：宿主是否跳过了某个 bundle（bundle 层被整体丢弃）
#   重启 dsh 时把 stderr 抓下来，找这一行：
#   skipping profile bundle "<name>": <reason>

# 探针 B：当前 profile 里 preset 行是否带 bili 的 inject
Select-String -Path "C:\Users\86135\.dsh\profiles\desktop\cordis.patch.yml" -Pattern "preset-|biliBasicCompactionPolicy"

# 探针 C：注册表里到底有哪些 preset（运行态）
#   GET /api/hippocampus/stats 不含此项；直接用宿主预设法：
#   在设置 → Agent 预设页看列表；或从会话里让模型调用 agentPresets 的远程方法
```

---

## 2. 任务二：预设缺失对海马体的影响

### 2.1 宿主不会「因为 ptc 不在」而回退到 256000

`256000` 来自 `@deepseek-ai/dsh-llm-deepseek/src/defaults.ts`：

```ts
export const DEFAULT_CONTEXT_WINDOW = 1_000_000
/** Default per-request output-token cap. */
export const DEFAULT_MAX_TOKENS = 256_000
```

调用链（`@deepseek-ai/dsh-llm/src/index.ts`）：

```ts
resolveCallWithInfo(config, info) {
  const defaulted = config.maxTokens === undefined && info.defaultMaxTokens !== undefined
    ? { ...config, maxTokens: info.defaultMaxTokens }   // ← 没配置就用 256000
    : config
  ...
}
```

`defaultMaxTokens` 来自适配器（`model-info.ts`：`configured?.maxTokens ?? connection.maxTokens`），**与 agent preset 无关**。预设只决定「这轮会话由哪些插件组成」，不决定输出上限。所以「ptc 丢了 → completion 变成 256000」这个因果**不存在**：256000 本来就是默认值。

### 2.2 海马体感知不到真实 1M 上限（已确证，与 ptc 无关）

海马体全仓检索 `contextWindow` / `modelInfo` / `resolveModelInfo`：**零命中**。它只读自己的配置：

```js
// dsh-memory/src/context/contextEngine.js
get nativeTokenLimit() { return this.nativeTokenLimitOverride ?? pol.nativeTokenLimit ?? 8000 }
nativeState({ now, sessionTokens }) {
  const tokens = Math.max(this.tokens(), session)
  const ratio = round(limit > 0 ? tokens / limit : 0, 4)
  rolloverDue: enabled && ratio >= threshold       // threshold 默认 0.85
  forceEvictionDue: !enabled && ratio >= 0.95
}
```

本机 profile 里 `context.nativeTokenLimit: 8000`，于是「85%」= 6800 个**自估** token。而对宿主来说真实窗口是 1,048,576，85% = 891,290。海马体的分子分母都在自己的坐标系里，**永远无法预警真实越界**。

### 2.3 token 数是估算的，不是宿主 usage（已确证）

```js
// dsh-memory/src/memory.js
observeSessionTurn(sessionId, text) {
  const tokens = previous + Math.max(1, Math.ceil(String(text ?? '').length / 4))
  return this.observeSessionTokens(key, tokens)
}
```

只统计「被捕获的 surface turn」，不含工具结果、系统提示、历史重放、图片等。本轮真实 854,668 message tokens，海马体看到的只是其中一小部分。

### 2.4 状态机会卡死（已确证，这是「80% 没触发 autoHandoff」的直接原因）

```js
// dsh-memory/src/memory.js  checkHandoff()
let marker = this.handoffState();
...
if (marker.active) return base;          // ← 一旦有 active marker，后续全部提前返回
```

marker 只有 `observeSessionTokens()` 的 `isNewSession` / `isSameKeyRestart` 分支才会 `clearHandoff()`。1.6.3 移除了「交接后自动开新会话」之后，**同一对话不会换 session id** → 第一次交接写下的 marker 永久 `active` → 之后所有 `_maybeAutoHandoff` 都在 `checkHandoff` 里提前返回。即使比例继续涨到 100%，也不会有第二次交接。

### 2.5 兜底：没有

`_maybeAutoHandoff()`：

```js
if (this._closed || this._handoffInFlight) return;
const state = this.context.nativeState({ sessionTokens: this.sessionUsage().tokens });
if (!state.rolloverDue && !state.forceEvictionDue) return;
Promise.race([this.checkHandoff(), watchdog]).finally(...)
```

没有任何「请求本身必超限 → 拒绝发送」的分支。宿主报 `CONTEXT_WINDOW_EXCEEDED` 时，海马体这边既不拦截、也不补一次交接。

---

## 3. 任务三：责任边界与后续路径

### 3.1 责任边界

| 现象 | 判定 | 依据 |
| --- | --- | --- |
| `Unknown agent preset: ptc` / 预设页空白 | **不是海马体**。海马体从不写 `presets.json`、从不写 profile 的 `cordis.patch.yml`，只 `ctx.get('agentPresets')` 读 `composedPreset()` 与 `select()`，且两处都 `try/catch` 成 best-effort | `dsh-memory/index.js:332,1437,1496` |
| 预设丢失后海马体是否还能正确交接 | **不能，但原因不是预设** —— 它压根不读模型窗口 | `contextEngine.nativeTokenLimit` 只有配置值 |
| 1M 溢出 | **是海马体**，三条独立缺陷叠加：阈值错源、token 自估、marker 卡死；再加「无必超限拦截」 | 见 2.2–2.5 |
| bili 是否「强行覆盖 DSH 预设」 | **不覆盖 definition，只改写 inject**；但它把宿主预设的就绪性绑定到自己的 gate 服务上 | `dsh.bundle.patch.yml` + `#3662` 注释 |

一句话：**ptc 是宿主/插件之间的事，1M 爆炸是海马体自己的事，两者只是同一天出现。**

### 3.2 后续修复路径（本次不实施）

- **bili/宿主侧（解决 ptc）**：
  1. 短期：把 bili 从 `dsh.profile.bundles` 里**整体移除**（而不是只禁用 `bili-native`），patch 层随之消失，preset 行恢复无 inject 状态。
  2. 中期：把 `inject: [biliBasicCompactionPolicy]` 改成**软依赖**（`ctx.get('biliBasicCompactionPolicy')` 探测 + 缺失时走 stock compaction），避免「服务不在 → 预设永不注册」的硬耦合。
  3. 宿主侧：`agent-preset-registry` 在 `selectedDefault` 指向不存在的 definition 时，应**降级到 `default` 并告警**，而不是抛 `not-found` 让新建会话失败（这是 DSH 上游的事）。
- **海马体侧（解决 1M）**，三条，按收益排序：
  1. **接入真实窗口与真实用量**：`nativeState` 的分子改用宿主上报的 usage（或 `agent` 侧真实 token 计数），分母改用 `llm.resolveModelInfo(...).context.contextWindow`（已确证宿主提供该值，`1_048_576`）；配置项降级为「用户覆盖」，不再是默认来源。
  2. **交接触发计入 completion 预留**：判定条件改成 `used + reserved(maxTokens) >= window * threshold`，并在「必超限」时直接阻断本轮请求（fail-fast），而不是让宿主报 `CONTEXT_WINDOW_EXCEEDED`。
  3. **解除 marker 死锁**：marker 处于 `active` 且同一会话继续时，不应直接 `return base`；应允许在同一会话内「续交」（覆盖 marker、重算摘要），或至少在 `active` 期间仍让 `_maybeAutoHandoff` 走一遍「是否该告警/阻断」。
- **单轮大工具输出熔断**（m05318 任务二）与上面的 1M 修复是同一个问题的另一个入口：一个超大工具结果就能把 next request 顶过窗口，需要在注入前就指针化。

---

## 4. 附：本次取证用到的文件位置

- `@deepseek-ai/dsh-web-app`：`package.json` 的 `dsh.bundle.patch`；`presets/{standard,ptc,minimal,cordis}.patch.yml`
- `@deepseek-ai/dsh-agent-preset`：`src/index.ts`（`static inject = ['agentPresets']`）
- `@deepseek-ai/dsh-agent-preset-registry`：`src/index.ts`（`register` / `resolve` / `defaultId`）
- `@deepseek-ai/dsh-llm`：`src/index.ts`（`resolveModelInfo` / `resolveCallWithInfo`）
- `@deepseek-ai/dsh-llm-deepseek`：`src/{models,defaults,model-info}.ts`
- `billion-context`：`dsh.bundle.patch.yml`、`dist/index.js`、`dist/agent/dsh-compaction-gate.js`
- 海马体：`src/context/contextEngine.js`、`src/memory.js`（`observeSessionTurn` / `checkHandoff` / `_maybeAutoHandoff`）、`index.js`（`syncAgentPreset` / `inheritHandoffPreset`）

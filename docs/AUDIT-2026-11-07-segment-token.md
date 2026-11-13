# 段记（Segment）Token 审计报告 — 2026-11-07

> 版本：1.6.3（当前发布版本；配置迁移与启动安全降级随本版发布）
> 审计对象：`dsh-memory` 的注入面与去重池（在线 prompt 组装），不涉及 raw / maintain。
> 约束：只读代码 + 测试；结论附证据行号。

## TL;DR

1. **没有 P0 级“同一段记在同一会话里反复注入”的泄漏。**
2. 注入面共 6 类：`memory-state`（块）、`[Active Task]`、`[Memory Hints]`、
   `[Persona & Traits]`、冷启动块、`memory:policy`。前 4 类都有会话级去重或按标签
   过滤；冷启动块每会话只注入一次；policy 是静态常量。
3. 两个 **P3 级优化点**（非泄漏，只是可省 token）：
   - `[Active Task]` 只按 `active:${eventId}` 去重，未把该 eventId 同时加入块去重池，
     同一事件可能以 “Active Task 正文 + 召回块” 两种形态出现（内容相近、非完全重复）。
   - `[Persona & Traits]` 每轮重新读取并渲染 L3 top-10（≤10×240 字符），多数轮次内容
     不变；可改为按 L3 版本号缓存渲染结果。
4. `contextEngine.inject()` 的唯一调用点是 recall 之后的 `injectRecall()`
   （`index.js:2347-2387`），块 id 用 `eventId`/`summaryId`，同 id 原地替换，
   `promptState` 再用 `excludeIds` 排除已注入块（`index.js:545`）——去重生效。

## 逐项证据

| 注入面 | 触发条件 | 去重机制 | Token 风险 |
|---|---|---|---|
| `[Memory Blocks]`（recall 块） | recall 后 `injectRecall` | id=`eventId`；`runtime.injection.ids` 排除（`index.js:545`） | 低 |
| L3 语义块 | recall 时 top-2 semantic | id=`summaryId`，同上排除 | 低 |
| `[Active Task]` | handoff 摘要或最新 `task:` 事件 | `active:${eventId}` 一次性（`index.js` promptState 内） | 低（P3 跨面重复） |
| `[Memory Hints]` | 每轮词法匹配的标签，最多 5 个 | `injection.tags` 只放 freshTags（`index.js` promptState） | 低 |
| 冷启动块 | `coldStartPending` 且新会话首轮 | 消费即清除；每会话一次 | 低 |
| `[Persona & Traits]` | 每轮 assemble | 按 L3 内容变化，无会话去重（设计如此） | 中（P3 可缓存） |
| `memory:policy` | 静态 | 常量文本 | 无 |

## 建议修复 Diff（P3，可选）

### 1) Active Task 与召回块跨面去重
```js
// index.js promptState 内，Active Task 分支：
runtime.injection.ids.add(`active:${activeTask.eventId}`);
// 追加：同一事件不再作为召回块重复注入
runtime.injection.ids.add(activeTask.eventId);
```
效果：同一事件只出现一次（优先 Active Task 形态），不会因两处渲染各自付费。

### 2) Persona 按 L3 版本缓存
在 `runtime.personaTraitsText()` 里按 `(summary count, max updatedAt, max summaryId)`
做一次 memo，内容未变直接返回上次字符串。效果：L3 不变时零重复渲染成本，
且保证 order=100 的段落字节恒定，不破坏前缀缓存。

## 未发现的问题（明确排除）

- 不存在“段记摘要每轮全量注入”：`memory-state` 只注入块摘要（snippet ≤200 字符）
  且按 id 去重；完整正文只在 recall 结果里（受 `context.maxInjectTokens` 上限）。
- 不存在“幽灵段记正文泄露”：`degradeGhostHits` 会剥离 ghost 命中正文。
- 冷启动块不在 stable prefix 内（位于 marker 之后的易变尾巴），不会污染缓存前缀。

## 归属说明

当前代码没有独立的 `segments/` 存储；L1.5 段记由标签树 + recall 块 + Active Task
共同承载。若未来引入真正的 Segment 存储，本报告的注入面清单与去重池可直接复用。

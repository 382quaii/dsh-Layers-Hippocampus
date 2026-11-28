# Release 1.7.4 — 图谱布局世界 · 节点上限 80 · recall 光效

> 版本：**1.7.4**（2026-11-28）
> 基线：`dsh-memory` 工作区，全量 **590/590 测试通过**（92 个测试文件；`dsh-orchestrator` 31/31）
> 上一版：`docs/RELEASE-1.7.3.md`（上下文物理折叠 / raw 墓碑覆盖层 / 敏感硬拦截 / 交接标记过期）

---

## 1. 问题：为什么图谱会「挤成一团」且「拖不出边界」

用户的原话是「侧边 ui 存在标签原点集中密集，有边界无法移到边界外」。定位到三处叠加的原因：

1. **画布是写死的 640×320**。`ui/client.js` 里 `const width = 640; const height = 320;`，
   `viewBox` 固定成这个尺寸，而 `svg` 的 `width: '100%'` —— 侧边栏越窄，整张图（圆点和文字一起）越缩越小。
2. **向心力压过斥力**。`computeLayout()` 的向心力是 `((width/2 - x) / width) * 2 * alpha`：
   在 640 宽下，边缘处约为 `0.9 * alpha`；而同一次迭代里 40–80px 距离上的斥力只有
   `900 / d² ≈ 0.14–0.56`。中心弹簧永远赢，所有点被吸回中心。
3. **三处硬夹**。布局（`Math.max(24, Math.min(width - 24, x))`）、拖拽
   （`Math.max(24, Math.min(width - 24, point.x + drag.offsetX))`）、`relaxAround()`
   各自把坐标夹进 `[24, width-24]` —— 即使力模型对了，节点也**永远出不了那个框**。

后端当时只有 31 个节点 / 54 条边（远低于任何上限），所以这不是「节点太多」，而是**坐标系统错了**。

## 2. 布局世界（`ui/client.js`）

- **世界坐标与视口分离**：`layoutWorld({ width, height, count })` 按节点数放大世界
  （`cell = 96`，`factor = clamp(sqrt(count·cell² / (w·h)), 1, 3)`）。放不下就**放大世界**，
  而不是把点挤进固定框。
- **容器实测**：`ResizeObserver` 量容器宽度（变化 > 24px 才重算），`viewBox` 跟随容器，
  高度 `clamp(round(width * 0.55), 280, 520)`。节点半径 `4–14px` 是**屏幕像素**，不随缩放变化。
- **力模型**：`spacing = clamp(sqrt(area · 0.08 / count), 44, 150)`；
  斥力 `0.9 · spacing² / d²`（`d = max(6, distance)` 防爆）；中心弹簧 `(cx - x) · 0.02 · alpha`；
  连边目标长度 `46 + 0.9 · (r_i + r_j)`；阻尼 `0.72`；迭代 `min(600, 80 + count · 8)`；
  最大速度 < 0.05 早停；`separateOverlaps()` 以 `r_i + r_j + GRAPH_LABEL_ROOM(26)` 为最小间距
  再做 16 轮边界感知的分离。
- **看得全**：`fitView()` 一次把整张图放进视口（`k ≤ 1.4`，单点也不会被放大成球），
  `resetView = fitToContent`；标题栏新增「适应视图」按钮，双击空白同样复位。
- **拖得出边界**：拖拽节点时**画布完全不移动**（早期实现的边缘自动平移会让节点与指针失配、
  每动一下就朝一个方向跳一段，已废弃），节点跟随指针，坐标夹取放宽到 world 外
  `GRAPH_DRAG_GUTTER = 240` 的走廊 ⇒ 节点可以被带到可见范围之外，随时靠「适应视图」/双击空白找回；
  只有拖空白处才平移画布。画一条**虚线世界边界**，让「边界」本身可见。

## 3. 节点上限 80（`src/graph.js#trimGraph`）

- `graphMaxNodes` 默认 **80**（10–2000，设置 UI 可改）。
- 超出时**事件数最少优先隐藏**：排序 `events` ASC → `weight` ASC → `id` ASC。
  事件多的节点是记忆里更扎实的那些，所以先淘汰稀疏点，而不是砍掉主干。
- 边同步过滤（引用已删节点的边丢弃）并按 `weight` DESC 截断到 `graphMaxEdges`。
- payload 增加 `totalNodes` / `droppedNodes` / `droppedEdges`，面板显示
  「+N 节点未显示（按事件数从少到多隐藏）」。

## 4. recall 光效（`src/activity.js` + `GET /api/hippocampus/activity`）

- `_recallLocal()` 在读取成功后 best-effort 记一条活动：`kind: 'recall'`、命中 tags、eventIds。
  **`sensitive:` 与 `privacy:` 标签在入口就被剥离**，活动流本身不构成泄漏面。
- `ActivityStore`：环形缓冲（默认 64 条）、tags ≤ 12、eventIds ≤ 8、字符串截 64；
  `file` 为空则纯内存（默认）；开启持久化后 `state/activity.json`，5s 节流原子写。
- 图谱每 1000ms 拉一次增量（`document.visibilityState === 'hidden'` 时跳过，失败静默）：
  命中标签**强光呼吸**（最多 6 个）、1 跳邻居**弱光**（最多 24 个）、
  新写入标签**脉冲 620ms**，2400ms 后自动熄灭；`prefers-reduced-motion` 下只保留静态高亮。
- 颜色：默认跟随主题强调色（`ui.graphGlowPreset: 'accent'`），另有 `vivid` / `warm`
  预设与 `ui.graphGlowCustom` 十六进制自定义；白底刺眼时用 `ui.graphCanvasTint`
  给画布加一层极淡底色（`auto` / `tint` / `none`）。

## 5. 配置与契约变更

| 配置 | 默认 | 范围 |
| --- | --- | --- |
| `graphMaxNodes` | 80 | 10–2000 |
| `ui.graphGlowEnabled` | true | boolean |
| `ui.graphGlowPreset` | `'accent'` | `accent` / `vivid` / `warm` |
| `ui.graphGlowCustom` | null | `#rrggbb` |
| `ui.graphCanvasTint` | `'auto'` | `auto` / `tint` / `none` |
| `ui.graphActivityPersist` | false | boolean |

- MEMORY 路由表 **9 → 10 条**：新增 `GET /api/hippocampus/activity`（GET/HEAD only，`since`/`limit`/`space`）。
- `test/v150.ui.test.js`、`test/v156.handoff.test.js`、`test/startup.test.js`、`test/webRoutes.test.js`
  的「九路由 / 可编辑键集合」断言同步升到十路由与新配置键。

## 6. 测试

- `test/v174.ui.test.js`（8 例）：`graphGeometry` 导出齐全；`layoutWorld` 随节点数增长且 ≤3×；
  `computeLayout` 全部落在世界内、半径 4–14、x/y 铺开 > 世界 30%；`separateOverlaps`
  不越界且保持间距；`fitView` 整图入视口且缩放有上限；`glowColors` 三预设 + 自定义均为 hex；
  源码契约（`ResizeObserver`/`fitToContent`/`GRAPH_DRAG_GUTTER`/`useActivity`/`hp-glow-strong`，
  且不再有 `const width = 640;` 与旧拖拽夹取；拖拽节点区间内**不得**出现 `applyView()` /
  `viewRef.current =`——节点拖拽绝不移动画布）。
- `test/v174.graph.test.js`（5 例）：`trimGraph` 的事件数排序、边过滤、上限与 payload 字段。
- `test/v174.activity.test.js`（6 例）：环形缓冲、敏感标签剥离、游标、持久化开关、损坏文件容错。
- 全量：`node test/run.mjs` → **590/590 通过**（92 个测试文件）。

## 7. 发布

```powershell
cd /d D:\86135\Documents\dsh\workspace\dsh-memory
git add -A
git commit -m "feat: graph layout world, node cap 80, recall glow (v1.7.4)"
git tag -a v1.7.4 -m "v1.7.4: layout world + node cap + recall glow"
git push origin main --follow-tags   # 需要凭据；失败时 GIT_SSL_NO_VERIFY=1 + 完整访问权限
npm publish --access public          # 用户自行执行
```

安装同一份代码（未发布时）：

```powershell
pnpm add "github:382quaii/dsh-Layers-Hippocampus#v1.7.4"
```

## 8. 未包含（后续版本）

- 图谱的「标签簇」分组与折叠（大图聚类）。
- 光效的事件驱动实时推送（现在是 1s 轮询；宿主若提供 SSE 可换）。
- 活动流的长期统计（哪些标签最常被召回）与 UI 面板。

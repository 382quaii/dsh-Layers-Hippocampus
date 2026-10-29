# 提交到 DSH 插件市场（awesome-dsh-plugin）

`dshmarket` 只是市场前端，**不接收投稿**；插件列表由
[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
维护，一个插件一个 YAML 文件。收录 = 往那个仓库提 **一个文件** 的 PR。

本仓库已备好该文件：

```
market/data/plugins/382quaii__dsh-Layers-Hippocampus.yml
```

提交时把它放到注册表仓库的 **同路径** `data/plugins/382quaii__dsh-Layers-Hippocampus.yml`。

## 条目内容（已按官方 schema 校验）

```yaml
url: https://github.com/382quaii/dsh-Layers-Hippocampus
name: 382quaii/dsh-Layers-Hippocampus
category: memory
description:
  en: 'Layered long-term memory for DeepSeek Harness: append-only event log, rebuildable tag index, day diaries, semantic layer, trend quarantine, and an offline knowledge-graph panel.'
  zh: '为 DeepSeek Harness 提供的分层长期记忆：追加式事件日志、可重建标签索引、按天日记、语义层、趋势隔离，以及离线知识图谱面板。'
icon: https://raw.githubusercontent.com/382quaii/dsh-Layers-Hippocampus/main/assets/icon-180.png
```

要点：

- `description.en` 含 `: `，**必须加引号**，否则 YAML 会把它当嵌套键；这里用单引号包裹。
- 分类只能取注册表给定的 slug，本插件是 `memory`。
- `icon` 必须是 **GitHub 托管的位图**（png/jpg/webp），SVG 会被拒。
- 文件名必须严格是 `<owner>__<repo>.yml`，区分大小写。

## CI 会检查什么

| 检查 | 本仓库状态 |
| --- | --- |
| 仓库声明 `dsh.bundle` | ✅ `"bundle": { "patch": "./cordis.patch.yml" }` |
| 仓库根有 `cordis.patch.yml`，行名与包名一致 | ✅ `id: hippocampus` / `name: dsh-layers-hippocampus` |
| 仓库创建满 1 天 | ⏳ 首次推送后次日再提 |
| 仓库带 `dsh-plugin` topic | ⏳ 需在 GitHub 仓库设置里添加 |
| `description` 属实、无营销词 | ✅ 描述只列实际能力 |
| 截图：仓库根 `screenshots.json`，1–8 张相对路径的 GitHub 位图 | ✅ `assets/screenshot-{panel,settings,graph}.png` |
| awesome-lint / README 双语一致性 | 由注册表在合并时重新生成，无需改动 |

## 提交步骤

1. 推送仓库到 GitHub，打 `v1.0.0` tag（见 `docs/PUBLISHING.md`）。
2. 仓库 Settings → Topics 添加 `dsh-plugin`。
3. Fork 注册表仓库，把本条 YAML 放到 `data/plugins/382quaii__dsh-Layers-Hippocampus.yml`。
4. 提 PR：`feat: add 382quaii/dsh-Layers-Hippocampus (layered long-term memory)`。
5. CI 失败会指名要改什么；`held: author` 标签表示等待修改，不是拒绝——改完推同一分支并留一条评论即可。

## 可选：npm 与 tarball

- npm 发布是可选的；条目不写 `npm:` 字段（手写会被校验拒绝，映射自动采集）。
- 若仓库无法从源码安装，必须在条目里加 `tarball:`，指向 GitHub Release 上的 `https` `.tgz`。
- 本仓库可直接从源码安装（无构建步骤、零依赖），因此**不需要** tarball。

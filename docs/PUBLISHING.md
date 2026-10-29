# 推送与提交指南

三件事：推仓库、加 topic、向注册表提 PR。

## 1. 首次推送

```bash
cd dsh-memory
git init -b main
git add -A
git commit -m "feat: dsh-layers-hippocampus 1.0.0"

git remote add origin https://github.com/382quaii/dsh-Layers-Hippocampus.git
git push -u origin main

git tag -a v1.0.0 -m "v1.0.0"
git push origin v1.0.0
```

推送前自查：

```bash
npm run check                      # 语法 + 107 个用例
node -e "console.log(require('./package.json').dsh)"   # 必须有 bundle.patch
git status --short                 # 不应出现 node_modules、.dsh
```

## 2. 添加 `dsh-plugin` topic

网页：仓库首页 → About 右侧齿轮 → Topics 填 `dsh-plugin` → 保存。

命令行（需已登录 `gh`）：

```bash
gh repo edit 382quaii/dsh-Layers-Hippocampus --add-topic dsh-plugin
```

注册表 CI 会检查这个 topic；同时建议加：`deepseek`、`harness`、`memory`、`knowledge-graph`。

## 3. 向 awesome-dsh-plugin 提 PR

```bash
# fork 后克隆自己的 fork
git clone https://github.com/<your-name>/awesome-dsh-plugin.git
cd awesome-dsh-plugin
git checkout -b add-382quaii-dsh-layers-hippocampus

mkdir -p data/plugins
cp <path-to-plugin>/market/data/plugins/382quaii__dsh-Layers-Hippocampus.yml \
   data/plugins/382quaii__dsh-Layers-Hippocampus.yml

git add data/plugins/382quaii__dsh-Layers-Hippocampus.yml
git commit -m "feat: add 382quaii/dsh-Layers-Hippocampus (layered long-term memory)"
git push -u origin add-382quaii-dsh-layers-hippocampus
```

然后在 GitHub 上对该分支开 PR：

- 标题：`feat: add 382quaii/dsh-Layers-Hippocampus (layered long-term memory)`
- 一个 PR 只加这一个文件（注册表上限 3 条，且不要改别人的条目）
- 不要手工编辑 README——它们由 `data/plugins/*.yml` 生成

> 仓库需创建满 1 天才能通过 CI；刚推送就提会被 age 检查拦下，隔天重跑即可，不必重开 PR。

## 4. 合并之后

- 市场站点通常一天内自动收录，无需再操作。
- 后续更新：只改自己的 `data/plugins/382quaii__dsh-Layers-Hippocampus.yml` 再提 PR。
- 截图改自己仓库的 `screenshots.json` 与 `assets/` 即可，下一次构建自动生效。

## 可选：发布 npm

```bash
npm publish --access public
```

发布前提：发版前把 `repository` 指回本仓库（已配置），npm 侧才会与注册表关联。
不发布也不影响收录与安装：

```bash
dsh plugin --profile web add github:382quaii/dsh-Layers-Hippocampus
```

# @dsh-external/skillmcp-gate

DSH 插件：按会话/全局管控 **skill** 与 **MCP 工具**的暴露集——勾掉即从模型的工具/技能目录移除，下一条消息生效。

## 特性

- **右侧栏面板**（默认入口）：按 MCP server 分组勾选工具 + Skill 单独开关，勾选进入草稿，「批量应用」一次提交（减少 prompt 缓存失效）
- **DSH 设置页**（账号菜单 → 设置 → Skill & MCP 管控）：全局默认 + debug 概要 + 「在会话顶部显示入口」开关
- **变更下一条消息生效**（DSH 原生语义），会话重开自动重放
- 持久化：`~/.dsh/storages/skillmcp-gate.json`（global + sessions delta）

## 管控语义（实测定案）

| 对象 | 粒度 | 机制 |
|------|------|------|
| MCP 工具 | **会话级**（面板勾选只影响当前会话）+ 全局默认（设置页，新会话继承） | 官方 scoped seam `agent.ctx.tools.restrict({deny})` |
| Skill | **全局**（勾哪里都影响所有会话，UI 已明示） | `skills.snapshot` monkey-patch 按会话过滤目录 |

## 安装

```bash
dsh plugin --profile web add dsh-external-skillmcp-gate-<version>.tgz
```

装入后**重启 DSH 实例**生效（插件的 client 代码由 host 进程内存下发，不重启不生效）。

## 构建

```bash
# 在 src/ 内；DSH_CHECKOUT 指向 DSH 安装目录（monorepo 布局）
DSH_CHECKOUT=<checkout> bash scripts/build.sh   # host: tsc → lib/index.js
npx tsdown                                       # client: bundle → lib/client.js
npm pack                                         # → dsh-external-skillmcp-gate-<version>.tgz
```

## 已知限制

- Skill 不支持单会话级管控（DSH `skills.register` 解析到 root SkillRegistry 的架构限制）
- 内置工具暂不管控（数据模型已预留）
- 会话面板提交 Skill 清单会**覆盖**全局清单（非合并）

## 实测环境

DSH ≥ 0.2.x（Windows 10 LTSC / Node 24 / pnpm）；官方 `sidebarRightTabs` + `sidebar.right.pane.tab(.title)` slots、`settings.section` slot、`tools.restrict` scoped seam。

# Skill Sync

[English](./README.md)

Skill Sync 是一个本地优先的 skill 同步工具。它目前支持 Codex 和 Agents 的本地 skill 目录，并通过你自己的 Git 仓库在多台电脑之间同步。

Codex / Agents skills 本质上就是本机文件夹。这很适合快速创建和修改，但当你有多台电脑、越来越多 skills、或者同时使用 `~/.codex/skills` 和 `~/.agents/skills` 时，就需要一个小型控制台来管理它们。Skill Sync 用 Git 做同步源，提供 Web UI 和 CLI，帮助你选择要跟踪的 skill、查看本地/仓库差异、处理冲突，并自动 commit/push。

## 截图

这里先保留截图位置。发布文章或分享前，把真实截图放到 `docs/screenshots/`。

| Skills 主面板 | 冲突 / 版本比较 |
| --- | --- |
| ![Skills dashboard placeholder](docs/screenshots/dashboard-placeholder.svg) | ![Conflict resolution placeholder](docs/screenshots/conflict-placeholder.svg) |

推荐截图文件名：

- `docs/screenshots/skills-dashboard.png`
- `docs/screenshots/codex-archive.png`
- `docs/screenshots/compare-conflict.png`
- `docs/screenshots/dark-mode.png`

## 功能

- 跟踪 `~/.codex/skills` 和 `~/.agents/skills` 中选中的 skills。
- 通过你自己的 Git 仓库同步 skill 文件夹。
- 支持添加到同步、安装、更新本地、停止同步、删除本地 copy。
- 已跟踪 skill 本地变化后自动同步到 sync repo，并 commit/push。
- 从另一台电脑 pull 远程变化，并安装或更新本机 skills。
- 展示 `In sync`、`Local only`、`Repo only`、`Local changed`、`Repo changed`、`Conflict` 等状态。
- 支持比较版本，并选择本地或仓库版本作为最终版本。
- 从本地 Codex session traces 记录 skill 使用时间，展示 last used。
- 支持浏览 Codex App 的 archived sessions，并软删除、恢复、取消归档。
- 本机配置和 cache 不进入 Git。

## 不做什么

- 不提供 SaaS 托管服务。
- 不需要中心化后端，只依赖你的 Git remote。
- 停止同步时不会删除本机已安装的 skill。
- 不改变 Codex 加载 skills 的方式；Codex 仍然读取本机 skill 目录。

## 快速开始

前置要求：

- Node.js `>=20`
- Git
- macOS 上支持原生目录选择器
- 一个本地目录或 Git clone，用作 sync repo

安装：

```bash
npm install -g @nameczz/skill-sync
skill-sync serve
```

打开：

```text
http://127.0.0.1:3017
```

第一次启动：

1. 选择 Git sync repository 目录。
2. 初始化 Skill Sync。
3. 把本机 `Local only` skills 添加到同步。
4. 后续由 auto-sync 自动监听已跟踪 skill 的变化，也可以手动执行操作。

## 常用 CLI

```bash
skill-sync status
skill-sync status --json
skill-sync pull
skill-sync sync <skill-id>
skill-sync update-local <skill-id>
skill-sync stop-syncing <skill-id>
skill-sync serve --port 4100
```

## Agent / Headless 用法

对 agents 来说，`skill-sync serve` 就是长期运行的同步进程。它会启动本地 API server、Web UI、auto-sync watcher 和 usage scanner。

先初始化一次，明确指定 sync repo：

```bash
skill-sync init --sync-repo /path/to/skills-sync
```

然后保持监听进程运行：

```bash
skill-sync serve
```

agent 可以直接修改 `~/.codex/skills` 或 `~/.agents/skills` 下已跟踪的 skills。Skill Sync 会检测本地变化，复制到 sync repo，commit，并 push。

agent 读取机器可解析状态：

```bash
skill-sync status --json
```

如果出现冲突，不要静默覆盖。应该通过 Web UI 或明确的 CLI/API 操作解决。

## 同步模型

sync repo 保存共享状态：

```text
skills/                 # tracked skill folders
metadata/skills.json    # tracked skill metadata
metadata/usage-events.jsonl
.gitignore
```

本机状态保存在 Git 之外：

```text
~/.skill-sync/config.json
~/.skill-sync/cache/
```

停止同步只会从 sync repo 移除该 skill 的跟踪状态，不会删除本机 skill copy。刷新后，如果本机 copy 仍在，它会显示为 `Local only`。

## 另一台电脑怎么同步

1. clone 同一个 sync repo。
2. 安装并启动 Skill Sync：

```bash
npm install -g @nameczz/skill-sync
skill-sync serve
```

3. 第一次初始化时选择同一个 sync repo。
4. 点击 `Pull` / `Apply repo changes`，把 repo 里的 skills 安装到本机。

## 开发

```bash
yarn install
npm run typecheck
npm test
npm run build
```

本地运行：

```bash
npm run dev -- serve
```

## License

MIT. See [LICENSE](./LICENSE).

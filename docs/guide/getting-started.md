# Getting Started

## Prerequisites

- Node.js 20 or newer
- Git
- macOS for the native directory picker
- A local folder or Git clone to use as the skill sync repository

## Install from npm

```bash
npm install -g @nameczz/skill-sync
skill-sync serve
```

## Run from Source

```bash
yarn install
npm run dev -- serve
```

The server listens on `http://127.0.0.1:3017` by default.

## First Setup

1. Choose the Git sync repository directory.
2. Initialize the manager.
3. Add local-only skills to sync.
4. Let auto-sync watch managed skills, or use manual actions when needed.

## Common Commands

```bash
skill-sync status
skill-sync pull
skill-sync sync <skill-id>
skill-sync update-local <skill-id>
skill-sync stop-syncing <skill-id>
```

## Agent / Headless Usage

Agents can use `skill-sync serve` as the long-running watcher process. It starts the local API server, web UI, auto-sync watcher, and usage scanner.

Initialize once:

```bash
skill-sync init --sync-repo /path/to/skills-sync
```

Then keep the watcher running:

```bash
skill-sync serve
```

While `serve` is running, tracked skill edits under `~/.codex/skills` or `~/.agents/skills` are detected and synced to the Git repository. Agents can inspect state with:

```bash
skill-sync status --json
```

Conflicts should be resolved explicitly, not overwritten silently.

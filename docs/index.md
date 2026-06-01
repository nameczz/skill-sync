# Skill Sync

Local-first workbench for syncing AI agent skills through a Git repository. It currently supports Codex and Agents skill folders.

## What It Does

- Tracks selected local skills in a sync repository.
- Applies repo changes back to local Codex or Agents skill folders.
- Watches managed skills for auto-sync.
- Shows Codex archived sessions with soft-delete and restore.
- Keeps local cache and machine-specific configuration out of Git.

## Start Here

```bash
yarn install
npm run dev -- serve
```

After npm install, use `skill-sync serve`.

Open `http://127.0.0.1:3017`.

See [Getting Started](./guide/getting-started.md) for the full flow.

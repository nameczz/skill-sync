# Configuration

Skill Sync stores machine-local configuration outside the sync repository.

## Paths

| Path | Purpose |
| --- | --- |
| Sync repo | Git-tracked skills and metadata |
| Codex skills | Local `~/.codex/skills` runtime folder |
| Agents skills | Local `~/.agents/skills` runtime folder |
| Cache | Local-only app state |

The sync repository is the only folder intended for Git commits. The cache directory should never be synced.

## Environment Overrides

For isolated tests, use temporary paths:

```bash
SKILL_SYNC_REPO=/tmp/skill-sync-repo \
SKILL_SYNC_CODEX_SKILLS_DIR=/tmp/skill-sync-codex \
SKILL_SYNC_AGENTS_SKILLS_DIR=/tmp/skill-sync-agents \
SKILL_SYNC_CONFIG_DIR=/tmp/skill-sync-config \
SKILL_SYNC_CACHE_DIR=/tmp/skill-sync-cache \
npm run dev -- serve
```

Legacy `CSM_*` environment variables are still supported for existing local setups.

## Git Remote

If the sync repository has an upstream remote, the manager can show whether local changes need to be pushed or remote changes need to be pulled.

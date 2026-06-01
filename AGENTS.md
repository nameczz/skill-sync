# Codex Skill Manager Agent Rules

This repository is an open-source local tool for managing Codex skills through an independent Git-backed sync repository.

## Product Context

- Product context lives in `PRODUCT.md`.
- Default register is `product`: task-focused app UI, not a marketing site.
- Brand personality: expert, restrained, precise.
- Primary user: personal Codex power user managing skills across multiple computers.
- Primary UI job: quickly tell whether sync is safe.

## Required Product Process

For new product or feature scope, do not jump straight to implementation.

1. Product draft.
2. Design review or `impeccable shape` for UI work.
3. Engineering review for architecture, data flow, persistence, safety, tests.
4. Challenger review for missing decisions and failure modes.
5. Final implementation-ready spec.
6. Implement only after explicit user approval.

## Slice Discipline

Implement in slices. Do not merge future slices into the current one without user approval.

Current slice status:

- Slice 1 complete: CLI, config, repo initialization, scanning, metadata, `status`, `import`.
- Slice 2 complete: local Web UI foundation, real API, skills list, detail drawer, import/install actions.
- Slice 3 complete: hash-based sync state, local/repo diff states, conflict blocking.
- Slice 4 complete: Git pull, commit, push, selected-skill sync, and repository metadata sync.
- Slice 5 complete: `record`, confirmed usage events, and optional Codex `UserPromptSubmit` hook for explicit skill mentions.
- Slice 6 later: Codex sessions inference cache.
- Slice 7 partial: remove-local and archive are implemented; restore and danger-zone redesign are later.
- Slice 8 later: CI and npm publish prep.

## UI Rules

Use the `impeccable` workflow for frontend work.

- Run the context loader before UI design or file edits:
  `node /Users/zilliz/.agents/skills/impeccable/scripts/load-context.mjs`
- If `PRODUCT.md` is missing or stale, run the teach flow first.
- For new UI surfaces, run shape and get explicit user confirmation before implementation.
- Before UI file edits, state:
  `IMPECCABLE_PREFLIGHT: context=pass product=pass command_reference=pass shape=pass image_gate=pass|skipped:<reason> mutation=open`
- If `DESIGN.md` is missing, mention that `$impeccable document` can generate it, but do not block implementation after the user confirms the shape brief.

Design direction for Slice 2:

- Product UI, not landing page.
- Restrained color strategy.
- Light mode first, with tokens that can support system theme later.
- References: Linear, Raycast, GitHub Desktop.
- First screen: Skills list, sync consistency as the dominant visual state.
- Details: right-side drawer.
- Empty state: initialize/check repo first, then import local skill.
- Avoid flashy AI dashboard patterns, decorative gradients, glassmorphism, gradient text, hero metrics, emoji decoration, and toy-like copy.

## Filesystem Safety

- Do not modify a user's real `~/.codex/skills` during tests or smoke runs unless explicitly requested.
- Use temporary directories with `CSM_CONFIG_DIR`, `CSM_SYNC_REPO`, and `CSM_CODEX_SKILLS_DIR`.
- All write operations must stay inside the configured sync repo, configured managed skills directory, or local cache directory.
- Reject skill ids with absolute paths, `..`, empty path segments, or hidden directory targets.
- Do not manage `.system` by default.
- Do not follow suspicious symlinks when copying skill directories.

## Sync Model

- Managed skills live canonically in `repo/skills/<skill-id>/`.
- Local Codex runtime copies live in `~/.codex/skills/<skill-id>/`.
- Use copy plus hash manifest, not symlink, as the default model.
- Unmanaged local skills must never be auto-added or auto-pushed.
- One-click Sync produces one commit whose message says which skills or repository metadata were synced and why.
- Conflicts must block push. Never silently overwrite both-changed local/repo state.

## Privacy Rules

- Confirmed usage events may be synced to Git, but only with:
  `skillId`, `invokedAt`, `source: "record"`.
- The Codex hook may parse only the submitted prompt for explicit `SKILL.md` links or paths under configured local skill roots.
- Do not sync hostnames, cwd, project paths, session ids, log snippets, or inferred evidence.
- Codex session inference is local-cache only and planned for Slice 6.

## Tooling And Verification

Use Node.js 20+.

Before claiming an implementation slice is complete, run:

- `npm run typecheck`
- `npm test`
- `npm run build`
- A CLI smoke test using temporary `CSM_*` paths when CLI behavior changed.

Prefer `rg` or `rg --files` for searching. Use `apply_patch` for manual edits.

## Git And Release Rules

- This repository is independent from `/Users/zilliz/working/czz-project`.
- Do not modify `ai-builders-digest/` or `ai-cloth/` from this project.
- Do not push, tag, publish to npm, or create releases without explicit user instruction.
- Do not change git config unless explicitly requested.
- Commit messages, when requested, must explain why, not only what.


<claude-mem-context>
# Memory Context

# [codex-skill-manager] recent context, 2026-05-27 10:23pm GMT+8

No previous sessions found.
</claude-mem-context>
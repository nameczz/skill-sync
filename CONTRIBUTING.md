# Contributing to Skill Sync

Thanks for helping improve Skill Sync.

## Development Setup

1. Use Node.js `>=20`.
2. Install dependencies:

```bash
yarn install
```

3. Start local server:

```bash
npm run dev -- serve
```

4. Run checks before opening a PR:

```bash
npm run typecheck
npm test
npm run build
```

## Scope and Design Principles

- Keep the project local-first.
- Preserve safe Git sync semantics and conflict visibility.
- Keep Codex/Agents directory behavior explicit and predictable.
- Avoid adding network-dependent behavior for core workflows.

## Pull Request Guidelines

- Use small, reviewable commits with clear intent.
- In commit messages, explain why, not only what.
- Include tests for behavior changes in `src/`.
- Update docs when CLI flags, workflows, or UX behavior changes.

## Reporting Bugs and Requesting Features

Open a GitHub Issue with a clear summary. For bugs, include reproduction steps, expected behavior, actual behavior, and logs or screenshots when useful. For feature requests, describe the workflow you want to improve and any constraints you care about.

## Community Standards

By participating, you agree to follow [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).

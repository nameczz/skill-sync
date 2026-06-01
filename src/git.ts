import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);

export type GitCommandResult = {
  stdout: string;
  stderr: string;
};

export type GitBranchSyncStatus = {
  upstream: string | null;
  ahead: number;
  behind: number;
  state: "up-to-date" | "ahead" | "behind" | "diverged" | "no-upstream" | "unknown";
};

export type GitBranchSyncStatusOptions = {
  fetch?: boolean;
};

export async function ensureGitRepository(syncRepo: string): Promise<boolean> {
  if (existsSync(path.join(syncRepo, ".git"))) {
    return false;
  }

  await execFileAsync("git", ["init"], { cwd: syncRepo });
  return true;
}

export async function gitStatus(syncRepo: string): Promise<string> {
  if (!existsSync(path.join(syncRepo, ".git"))) {
    return "not a git repository";
  }

  const { stdout } = await runGit(syncRepo, ["status", "--short"]);
  return stdout.trim();
}

export async function gitBranchSyncStatus(syncRepo: string, options: GitBranchSyncStatusOptions = {}): Promise<GitBranchSyncStatus> {
  if (!existsSync(path.join(syncRepo, ".git"))) {
    return { upstream: null, ahead: 0, behind: 0, state: "unknown" };
  }

  const branch = await currentBranch(syncRepo);
  const upstream = await branchUpstream(syncRepo);
  if (!upstream) {
    return { upstream: null, ahead: 0, behind: 0, state: "no-upstream" };
  }

  const remote = remoteFromUpstream(upstream);
  if (!remote) {
    return { upstream, ahead: 0, behind: 0, state: "unknown" };
  }

  try {
    if (options.fetch) {
      await runGit(syncRepo, ["fetch", "--prune", remote]);
    }

    const branchStatus = await runGit(syncRepo, ["rev-list", "--left-right", "--count", `${upstream}...${branch}`]);
    const [rawBehind, rawAhead] = branchStatus.stdout.trim().split(/\s+/);
    const behind = Number.parseInt(rawBehind ?? "", 10);
    const ahead = Number.parseInt(rawAhead ?? "", 10);

    if (!Number.isFinite(ahead) || !Number.isFinite(behind) || Number.isNaN(ahead) || Number.isNaN(behind)) {
      return { upstream, ahead: 0, behind: 0, state: "unknown" };
    }

    return {
      upstream,
      ahead,
      behind,
      state:
        ahead === 0 && behind === 0
          ? "up-to-date"
          : ahead > 0 && behind > 0
            ? "diverged"
            : ahead > 0
              ? "ahead"
              : "behind"
    };
  } catch {
    return {
      upstream,
      ahead: 0,
      behind: 0,
      state: "unknown"
    };
  }
}

export async function gitAdd(syncRepo: string, paths: string[]): Promise<void> {
  if (paths.length === 0) {
    return;
  }

  await runGit(syncRepo, ["add", "-A", "--", ...paths]);
}

export async function gitHasStagedChanges(syncRepo: string): Promise<boolean> {
  try {
    await runGit(syncRepo, ["diff", "--cached", "--quiet"]);
    return false;
  } catch (error) {
    if (isGitExitCode(error, 1)) {
      return true;
    }
    throw error;
  }
}

export async function gitCommit(syncRepo: string, message: string): Promise<string> {
  await runGit(syncRepo, [
    "-c",
    "user.name=Skill Sync",
    "-c",
    "user.email=skill-sync@local",
    "commit",
    "-m",
    message
  ]);
  const { stdout } = await runGit(syncRepo, ["rev-parse", "--short", "HEAD"]);
  return stdout.trim();
}

export async function gitPush(syncRepo: string): Promise<void> {
  const remotes = await gitRemotes(syncRepo);
  if (remotes.length === 0) {
    throw new Error("No Git remote is configured for the sync repository.");
  }

  const branch = await currentBranch(syncRepo);
  const remote = remotes.includes("origin") ? "origin" : remotes[0];

  const shouldUseUpstream = await hasUpstream(syncRepo);
  const pushArgs = shouldUseUpstream ? ["push"] : ["push", "-u", remote, branch];

  try {
    await runGit(syncRepo, pushArgs);
    return;
  } catch (error) {
    if (!isNonFastForwardPushError(error)) {
      throw error;
    }

    await runGit(syncRepo, ["fetch", "--prune", remote]);
    try {
      await runGit(syncRepo, ["rebase", `${remote}/${branch}`]);
    } catch (rebaseError) {
      await safeAbortRebase(syncRepo);
      throw new Error(
        `Cannot push because ${branch} on ${remote} has diverged and remote changes could not be replayed cleanly. ` +
          `Resolve the conflict and re-run sync.\n${(rebaseError as Error).message}`
      );
    }

    await runGit(syncRepo, pushArgs);
  }
}

export async function gitPull(syncRepo: string): Promise<void> {
  const status = await gitStatus(syncRepo);
  if (status.trim()) {
    throw new Error(`Cannot pull: sync repo has local uncommitted changes.\n${status}`);
  }

  const remotes = await gitRemotes(syncRepo);
  if (remotes.length === 0) {
    throw new Error("No Git remote is configured for the sync repository.");
  }

  const branch = await currentBranch(syncRepo);
  const remote = remotes.includes("origin") ? "origin" : remotes[0];

  if (await hasUpstream(syncRepo)) {
    await runGit(syncRepo, ["pull", "--ff-only"]);
  } else {
    await runGit(syncRepo, ["pull", "--ff-only", remote, branch]);
  }
}

export async function gitHasUncommittedChanges(syncRepo: string): Promise<boolean> {
  return (await gitStatus(syncRepo)).trim().length > 0;
}

export async function gitRemotes(syncRepo: string): Promise<string[]> {
  const { stdout } = await runGit(syncRepo, ["remote"]);
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function currentBranch(syncRepo: string): Promise<string> {
  const { stdout } = await runGit(syncRepo, ["branch", "--show-current"]);
  const branch = stdout.trim();
  if (!branch) {
    throw new Error("Cannot push from a detached HEAD.");
  }
  return branch;
}

async function branchUpstream(syncRepo: string): Promise<string | null> {
  try {
    const { stdout } = await runGit(syncRepo, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
    const upstream = stdout.trim();
    return upstream || null;
  } catch (error) {
    if (isGitExitCode(error, 128)) {
      return null;
    }

    throw error;
  }
}

function remoteFromUpstream(upstream: string): string | null {
  const slash = upstream.indexOf("/");
  return slash > 0 ? upstream.substring(0, slash) : null;
}

export async function hasUpstream(syncRepo: string): Promise<boolean> {
  try {
    await runGit(syncRepo, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
    return true;
  } catch (error) {
    if (isGitExitCode(error, 128)) {
      return false;
    }
    throw error;
  }
}

function isNonFastForwardPushError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return message.includes("non-fast-forward") || message.includes("fetch first") || message.includes("not a fast-forward");
}

async function safeAbortRebase(syncRepo: string): Promise<void> {
  try {
    await runGit(syncRepo, ["rebase", "--abort"]);
  } catch {
    // ignore any best-effort failure from aborting a non-rebase state
  }
}

export async function runGit(syncRepo: string, args: string[]): Promise<GitCommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, { cwd: syncRepo });
    return { stdout, stderr };
  } catch (error) {
    throw normalizeGitError(error);
  }
}

function isGitExitCode(error: unknown, code: number): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}

function normalizeGitError(error: unknown): Error {
  if (error instanceof Error) {
    const stderr = (error as Error & { stderr?: unknown }).stderr;
    const stdout = (error as Error & { stdout?: unknown }).stdout;
    const details = typeof stderr === "string" && stderr.trim() ? stderr.trim() : typeof stdout === "string" ? stdout.trim() : "";
    if (details) {
      error.message = details;
    }
    return error;
  }

  return new Error(String(error));
}

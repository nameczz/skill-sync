import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { ensureGitRepository, gitAdd, gitBranchSyncStatus, gitCommit, gitPush, gitStatus } from "../src/git.js";

const execFileAsync = promisify(execFile);

describe("gitPush", () => {
  it("rebases and retries when push is rejected due non-fast-forward", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "csm-git-rebase-push-"));
    const syncRepo = path.join(root, "repo");
    const remote = path.join(root, "remote.git");
    const clone = path.join(root, "clone");
    const filePath = "SKILL.md";

    await mkdir(syncRepo, { recursive: true });
    await ensureGitRepository(syncRepo);
    await execFileAsync("git", ["-C", syncRepo, "branch", "-M", "main"]);
    await execFileAsync("git", ["init", "--bare", remote]);
    await execFileAsync("git", ["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);
    await execFileAsync("git", ["-C", syncRepo, "remote", "add", "origin", remote]);

    await writeFile(path.join(syncRepo, filePath), "base\n", "utf8");
    await gitAdd(syncRepo, [filePath]);
    await gitCommit(syncRepo, "seed");
    await gitPush(syncRepo);

    await execFileAsync("git", ["clone", remote, clone]);
    await commitFile(clone, "REMOTE.md", "remote\n", "remote commit");
    await execFileAsync("git", ["-C", clone, "push", "origin", "main"]);

    await writeFile(path.join(syncRepo, "LOCAL.md"), "local\n", "utf8");
    await gitAdd(syncRepo, ["LOCAL.md"]);
    await gitCommit(syncRepo, "local commit");

    const prePush = await gitBranchSyncStatus(syncRepo, { fetch: true });
    expect(prePush.state).toBe("diverged");
    expect(prePush.ahead).toBe(1);
    expect(prePush.behind).toBe(1);

    await gitPush(syncRepo);

    const remoteLog = await execFileAsync("git", ["--git-dir", remote, "log", "--oneline", "--max-count=3"]);
    expect(remoteLog.stdout).toContain("seed");
    expect(remoteLog.stdout).toContain("remote commit");
    expect(remoteLog.stdout).toContain("local commit");

    const postPush = await gitBranchSyncStatus(syncRepo);
    expect(postPush.state).toBe("up-to-date");

    const finalStatus = await gitStatus(syncRepo);
    expect(finalStatus).toBe("");
  }, 15_000);

  it("aborts and errors clearly when rebase is needed but conflicted", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "csm-git-rebase-conflict-"));
    const syncRepo = path.join(root, "repo");
    const remote = path.join(root, "remote.git");
    const clone = path.join(root, "clone");
    const filePath = "SKILL.md";

    await mkdir(syncRepo, { recursive: true });
    await ensureGitRepository(syncRepo);
    await execFileAsync("git", ["-C", syncRepo, "branch", "-M", "main"]);
    await execFileAsync("git", ["init", "--bare", remote]);
    await execFileAsync("git", ["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);
    await execFileAsync("git", ["-C", syncRepo, "remote", "add", "origin", remote]);

    await writeFile(path.join(syncRepo, filePath), "base\n", "utf8");
    await gitAdd(syncRepo, [filePath]);
    await gitCommit(syncRepo, "seed");
    await gitPush(syncRepo);

    await execFileAsync("git", ["clone", remote, clone]);
    await commitFile(clone, filePath, "remote-change\n", "remote conflict commit");
    await execFileAsync("git", ["-C", clone, "push", "origin", "main"]);

    await writeFile(path.join(syncRepo, filePath), "local-conflict\n", "utf8");
    await gitAdd(syncRepo, [filePath]);
    await gitCommit(syncRepo, "local conflict commit");

    await expect(gitPush(syncRepo)).rejects.toThrow(/could not be replayed cleanly/);

    const afterPush = await gitStatus(syncRepo);
    expect(afterPush).toBe("");
    expect(existsSync(path.join(syncRepo, ".git", "rebase-apply"))).toBe(false);
    expect(existsSync(path.join(syncRepo, ".git", "rebase-merge"))).toBe(false);

    const branchStatus = await gitBranchSyncStatus(syncRepo, { fetch: true });
    expect(branchStatus.state).toBe("diverged");
    expect(branchStatus.ahead).toBe(1);
    expect(branchStatus.behind).toBe(1);
  }, 15_000);
});

async function commitFile(repo: string, relativePath: string, content: string, message: string): Promise<string> {
  const file = path.join(repo, relativePath);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
  await execFileAsync("git", ["-C", repo, "add", relativePath]);
  const { stdout } = await execFileAsync("git", [
    "-C",
    repo,
    "-c",
    "user.name=Test User",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-m",
    message
  ]);
  return stdout.trim();
}

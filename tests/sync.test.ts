import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { ensureGitRepository } from "../src/git.js";
import { ensureRepoMetadata } from "../src/metadata.js";
import { importLocalSkill } from "../src/importSkill.js";
import { listRepositoryConflicts, pullRepositoryChanges, resolveRepositoryConflicts, syncSelectedSkills } from "../src/sync.js";
import type { LocalConfig, SkillRecord } from "../src/types.js";

const execFileAsync = promisify(execFile);

describe("syncSelectedSkills", () => {
  it("imports selected local skills, commits them, and pushes to the configured remote", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "csm-sync-"));
    const remote = path.join(root, "remote.git");
    const config = testConfig(root);

    await ensureRepoMetadata(config.syncRepo);
    await ensureGitRepository(config.syncRepo);
    await execFileAsync("git", ["init", "--bare", remote]);
    await execFileAsync("git", ["remote", "add", "origin", remote], { cwd: config.syncRepo });
    await writeSkill(path.join(config.codexSkillsDir, "foo"), "foo", "Local body");

    const result = await syncSelectedSkills(config, [{ skillId: "foo", source: "codex" }]);

    expect(result.skillIds).toEqual(["foo"]);
    expect(result.updatedRepoSkillIds).toEqual(["foo"]);
    expect(result.committed).toBe(true);
    expect(result.pushed).toBe(true);
    expect(result.commitHash).toMatch(/^[0-9a-f]+$/);
    expect(await readFile(path.join(config.syncRepo, "skills", "foo", "SKILL.md"), "utf8")).toContain("Local body");

    const { stdout } = await execFileAsync("git", ["--git-dir", remote, "log", "--oneline", "--all"]);
    expect(stdout).toContain("Sync skill: foo");
  });

  it("blocks conflicted skills before committing or pushing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "csm-sync-conflict-"));
    const config = testConfig(root);

    await ensureRepoMetadata(config.syncRepo);
    await ensureGitRepository(config.syncRepo);
    await writeSkill(path.join(config.codexSkillsDir, "foo"), "foo", "Original body");
    await importLocalSkill(config, "foo");

    await writeSkill(path.join(config.codexSkillsDir, "foo"), "foo", "Local change");
    await writeSkill(path.join(config.syncRepo, "skills", "foo"), "foo", "Repo change");

    await expect(syncSelectedSkills(config, [{ skillId: "foo", source: "codex" }])).rejects.toThrow("foo is conflict");
  });

  it("commits and pushes repository metadata changes when no skills are selected", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "csm-sync-repo-"));
    const remote = path.join(root, "remote.git");
    const config = testConfig(root);

    await ensureRepoMetadata(config.syncRepo);
    await ensureGitRepository(config.syncRepo);
    await execFileAsync("git", ["init", "--bare", remote]);
    await execFileAsync("git", ["remote", "add", "origin", remote], { cwd: config.syncRepo });
    await writeFile(path.join(config.syncRepo, "metadata", "usage-events.jsonl"), "{\"skillId\":\"foo\",\"invokedAt\":\"2026-01-01T00:00:00.000Z\",\"source\":\"record\"}\n", "utf8");

    const result = await syncSelectedSkills(config, []);

    expect(result.skillIds).toEqual([]);
    expect(result.committed).toBe(true);
    expect(result.pushed).toBe(true);
    expect(result.commitHash).toMatch(/^[0-9a-f]+$/);

    const { stdout } = await execFileAsync("git", ["--git-dir", remote, "log", "--oneline", "--all"]);
    expect(stdout).toContain("Sync repository changes");
  });

  it("auto-merges diverged repository metadata and removes legacy archive artifacts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "csm-sync-diverged-"));
    const remote = path.join(root, "remote.git");
    const clone = path.join(root, "clone");
    const config = testConfig(root);

    await ensureRepoMetadata(config.syncRepo);
    await ensureGitRepository(config.syncRepo);
    await execFileAsync("git", ["init", "--bare", remote]);
    await execFileAsync("git", ["remote", "add", "origin", remote], { cwd: config.syncRepo });

    await writeFile(
      path.join(config.syncRepo, "metadata", "skills.json"),
      JSON.stringify({ schemaVersion: 1, skills: [skillRecord("foo", "2026-01-01T00:00:00.000Z")] }, null, 2),
      "utf8"
    );
    await commitAll(config.syncRepo, "seed metadata");
    const branch = await currentBranch(config.syncRepo);
    await execFileAsync("git", ["-C", config.syncRepo, "push", "-u", "origin", branch]);

    await execFileAsync("git", ["clone", "-b", branch, remote, clone]);
    await mkdir(path.join(clone, "archive", "old"), { recursive: true });
    await writeFile(path.join(clone, "archive", "old", "SKILL.md"), "# old\n", "utf8");
    await writeFile(
      path.join(clone, "metadata", "skills.json"),
      JSON.stringify({ schemaVersion: 1, skills: [{ ...skillRecord("foo", "2026-01-03T00:00:00.000Z"), archivedAt: null }] }, null, 2),
      "utf8"
    );
    await commitAll(clone, "remote metadata update");
    await execFileAsync("git", ["-C", clone, "push", "origin", branch]);

    await writeFile(
      path.join(config.syncRepo, "metadata", "skills.json"),
      JSON.stringify({ schemaVersion: 1, skills: [skillRecord("foo", "2026-01-02T00:00:00.000Z")] }, null, 2),
      "utf8"
    );
    await writeFile(
      path.join(config.syncRepo, "metadata", "usage-events.jsonl"),
      "{\"skillId\":\"foo\",\"invokedAt\":\"2026-01-04T00:00:00.000Z\",\"source\":\"record\"}\n",
      "utf8"
    );
    await commitAll(config.syncRepo, "local usage update");

    const result = await pullRepositoryChanges(config);

    expect(result.gitStatus).toBe("");
    expect(result.gitBranchStatus.state).toBe("up-to-date");
    expect(existsSync(path.join(config.syncRepo, "archive"))).toBe(false);
    const metadata = JSON.parse(await readFile(path.join(config.syncRepo, "metadata", "skills.json"), "utf8")) as { skills: Array<Record<string, unknown>> };
    expect(metadata.skills[0]?.updatedAt).toBe("2026-01-03T00:00:00.000Z");
    expect(metadata.skills[0]).not.toHaveProperty("archivedAt");
    await expect(readFile(path.join(config.syncRepo, "metadata", "usage-events.jsonl"), "utf8")).resolves.toContain("2026-01-04T00:00:00.000Z");
  }, 15_000);

  it("lists and resolves diverged skill file conflicts by selected version", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "csm-sync-skill-conflict-"));
    const remote = path.join(root, "remote.git");
    const clone = path.join(root, "clone");
    const config = testConfig(root);

    await ensureRepoMetadata(config.syncRepo);
    await ensureGitRepository(config.syncRepo);
    await execFileAsync("git", ["init", "--bare", remote]);
    await execFileAsync("git", ["remote", "add", "origin", remote], { cwd: config.syncRepo });
    await writeSkill(path.join(config.codexSkillsDir, "foo"), "foo", "Base body");
    await importLocalSkill(config, "foo", { source: "codex" });
    await commitAll(config.syncRepo, "seed skill");
    const branch = await currentBranch(config.syncRepo);
    await execFileAsync("git", ["-C", config.syncRepo, "push", "-u", "origin", branch]);

    await execFileAsync("git", ["clone", "-b", branch, remote, clone]);
    await writeSkill(path.join(clone, "skills", "foo"), "foo", "Remote body");
    await commitAll(clone, "remote skill update");
    await execFileAsync("git", ["-C", clone, "push", "origin", branch]);

    await writeSkill(path.join(config.syncRepo, "skills", "foo"), "foo", "Local sync repo body");
    await commitAll(config.syncRepo, "local skill update");

    await expect(pullRepositoryChanges(config)).rejects.toThrow("Review these paths manually");

    const conflicts = await listRepositoryConflicts(config);
    expect(conflicts.gitBranchStatus.state).toBe("diverged");
    expect(conflicts.conflicts).toHaveLength(1);
    expect(conflicts.conflicts[0]?.skillId).toBe("foo");
    expect(conflicts.conflicts[0]?.versions.find((version) => version.source === "github")?.content).toContain("Remote body");
    expect(conflicts.conflicts[0]?.versions.find((version) => version.source === "syncRepo")?.content).toContain("Local sync repo body");

    const result = await resolveRepositoryConflicts(config, [{ skillId: "foo", source: "github" }]);

    expect(result.gitStatus).toBe("");
    expect(result.gitBranchStatus.state).toBe("up-to-date");
    await expect(readFile(path.join(config.syncRepo, "skills", "foo", "SKILL.md"), "utf8")).resolves.toContain("Remote body");
    await expect(readFile(path.join(config.codexSkillsDir, "foo", "SKILL.md"), "utf8")).resolves.toContain("Remote body");
  }, 15_000);
});

function testConfig(root: string): LocalConfig {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    syncRepo: path.join(root, "repo"),
    codexSkillsDir: path.join(root, "codex-skills"),
    agentsSkillsDir: path.join(root, "agents-skills"),
    cacheDir: path.join(root, "cache"),
    createdAt: now,
    updatedAt: now
  };
}

async function writeSkill(skillDir: string, name: string, body: string): Promise<void> {
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: Test skill\n---\n\n# ${name}\n\n${body}\n`,
    "utf8"
  );
  expect(existsSync(path.join(skillDir, "SKILL.md"))).toBe(true);
}

function skillRecord(id: string, updatedAt: string): SkillRecord {
  return {
    id,
    name: id,
    description: "Test skill",
    status: "managed",
    localSource: "codex",
    installed: true,
    syncState: "clean",
    lastSyncedHash: "hash",
    currentRepoHash: "hash",
    currentLocalHash: "hash",
    lastUsedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt
  };
}

async function currentBranch(repo: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repo, "branch", "--show-current"]);
  const branch = stdout.trim();
  if (!branch) {
    throw new Error(`No current branch in ${repo}`);
  }
  return branch;
}

async function commitAll(repo: string, message: string): Promise<void> {
  await execFileAsync("git", ["-C", repo, "add", "-A"]);
  await execFileAsync("git", [
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
}

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ensureRepoMetadata, readSkillsMetadata } from "../src/metadata.js";

describe("repo metadata", () => {
  it("ignores local Skill Sync cache inside the sync repo", async () => {
    const syncRepo = await mkdtemp(path.join(tmpdir(), "csm-metadata-"));

    await ensureRepoMetadata(syncRepo);

    const gitignore = await readFile(path.join(syncRepo, ".gitignore"), "utf8");
    expect(gitignore).toContain(".skill-sync/");
    expect(gitignore).toContain(".codex-skill-manager/");
    expect(existsSync(path.join(syncRepo, "archive"))).toBe(false);
  });

  it("preserves existing gitignore entries", async () => {
    const syncRepo = await mkdtemp(path.join(tmpdir(), "csm-metadata-existing-"));
    await mkdir(syncRepo, { recursive: true });
    await writeFile(path.join(syncRepo, ".gitignore"), "node_modules/\n", "utf8");

    await ensureRepoMetadata(syncRepo);

    await expect(readFile(path.join(syncRepo, ".gitignore"), "utf8")).resolves.toBe("node_modules/\n.skill-sync/\n.codex-skill-manager/\n");
  });

  it("normalizes older skill metadata records", async () => {
    const syncRepo = await mkdtemp(path.join(tmpdir(), "csm-metadata-normalize-"));
    await ensureRepoMetadata(syncRepo);
    await writeFile(
      path.join(syncRepo, "metadata", "skills.json"),
      JSON.stringify({
        schemaVersion: 1,
        skills: [
          {
            id: "legacy",
            name: "legacy",
            description: "",
            localSource: "codex",
            installed: true,
            syncState: "clean",
            lastSyncedHash: "abc",
            currentRepoHash: "abc",
            currentLocalHash: "abc",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          }
        ]
      }),
      "utf8"
    );

    const metadata = await readSkillsMetadata(syncRepo);

    expect(metadata.skills[0]?.status).toBe("managed");
    expect(metadata.skills[0]?.lastUsedAt).toBeNull();
  });
});

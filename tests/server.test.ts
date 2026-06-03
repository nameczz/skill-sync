import { execFile } from "node:child_process";
import { chmodSync, existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startServer } from "../src/server.js";
import { ensureGitRepository } from "../src/git.js";
import { ensureRepoMetadata, readSkillsMetadata, writeSkillsMetadata } from "../src/metadata.js";
import { hashDirectory } from "../src/hash.js";
import type { SkillRecord } from "../src/types.js";

const originalEnv = { ...process.env };
const execFileAsync = promisify(execFile);

beforeEach(async () => {
  const root = await mkdtemp(path.join(tmpdir(), "csm-server-codex-home-"));
  process.env.CODEX_HOME = path.join(root, "codex-home");
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("server", () => {
  it("starts without config and reports defaults", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "csm-server-"));
    process.env.CSM_CONFIG_DIR = path.join(root, "config");
    process.env.CSM_SYNC_REPO = path.join(root, "repo");
    process.env.CSM_CODEX_SKILLS_DIR = path.join(root, "skills");
    process.env.CSM_AGENTS_SKILLS_DIR = path.join(root, "agents-skills");
    process.env.CSM_CACHE_DIR = path.join(root, "cache");

    const server = await startServer({ port: 0 });
    try {
      const response = await fetch(`${server.url}/api/status`);
      const payload = (await response.json()) as {
        configured: boolean;
        defaults: { syncRepo: string; agentsSkillsDir: string; cacheDir: string };
      };
      expect(payload.configured).toBe(false);
      expect(payload.defaults.syncRepo).toBe("");
      expect(payload.defaults.agentsSkillsDir).toBe(path.join(root, "agents-skills"));
      expect(payload.defaults.cacheDir).toBe(path.join(root, "cache"));
    } finally {
      await server.close();
    }
  });

  it("serves Codex archive list, preview, delete, restore, and unarchive APIs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "csm-server-codex-archive-api-"));
    process.env.CSM_CONFIG_DIR = path.join(root, "config");
    const codexHome = process.env.CODEX_HOME;
    if (!codexHome) {
      throw new Error("CODEX_HOME missing in test setup.");
    }
    const archiveRoot = path.join(codexHome, "archived_sessions");
    await mkdir(archiveRoot, { recursive: true });
    const sessionId = "019e24bb-2ac1-7ab3-b603-b5b3a2edcee8";
    const fileName = `rollout-2026-05-14T12-25-06-${sessionId}.jsonl`;
    await writeFile(
      path.join(archiveRoot, fileName),
      [
        JSON.stringify({ timestamp: "2026-05-14T04:25:42.646Z", type: "session_meta", payload: { id: sessionId, cwd: "/tmp/project", originator: "Codex Desktop" } }),
        JSON.stringify({ timestamp: "2026-05-14T04:26:00.000Z", type: "event_msg", payload: { content: [{ text: "Preview text" }] } })
      ].join("\n"),
      "utf8"
    );
    await writeFile(path.join(codexHome, "session_index.jsonl"), `${JSON.stringify({ id: sessionId, thread_name: "API archive test" })}\n`, "utf8");

    const server = await startServer({ port: 0 });
    try {
      const redirectResponse = await fetch(`${server.url}/archive`, { redirect: "manual" });
      expect(redirectResponse.status).toBe(302);
      expect(redirectResponse.headers.get("location")).toBe("/codex-archive");

      const listResponse = await fetch(`${server.url}/api/codex-archive?state=active`);
      const listPayload = (await listResponse.json()) as { items: Array<{ fileName: string; title: string }> };
      expect(listResponse.ok).toBe(true);
      expect(listPayload.items[0]).toMatchObject({ fileName, title: "API archive test" });

      const previewResponse = await fetch(`${server.url}/api/codex-archive/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: "active", fileName })
      });
      const previewPayload = (await previewResponse.json()) as { preview: string[] };
      expect(previewResponse.ok).toBe(true);
      expect(previewPayload.preview.join("\n")).toContain("Preview text");

      const traversalResponse = await fetch(`${server.url}/api/codex-archive/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: "active", fileName: "../escape.jsonl" })
      });
      expect(traversalResponse.status).toBe(400);

      const deleteResponse = await fetch(`${server.url}/api/codex-archive/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: "active", fileName })
      });
      expect(deleteResponse.ok).toBe(true);
      expect(existsSync(path.join(archiveRoot, ".trash", fileName))).toBe(true);

      const restoreResponse = await fetch(`${server.url}/api/codex-archive/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: "trash", fileName })
      });
      expect(restoreResponse.ok).toBe(true);
      expect(existsSync(path.join(archiveRoot, fileName))).toBe(true);

      const unarchiveResponse = await fetch(`${server.url}/api/codex-archive/unarchive`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: "active", fileName })
      });
      const unarchivePayload = (await unarchiveResponse.json()) as { targetPath: string };
      expect(unarchiveResponse.ok).toBe(true);
      expect(unarchivePayload.targetPath).toBe(await realpath(path.join(codexHome, "sessions", "2026", "05", "14", fileName)));
      expect(existsSync(path.join(archiveRoot, fileName))).toBe(false);
      expect(existsSync(path.join(codexHome, "sessions", "2026", "05", "14", fileName))).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("requires the Web UI to provide a sync repository during initialization", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "csm-server-init-required-"));
    process.env.CSM_CONFIG_DIR = path.join(root, "config");

    const server = await startServer({ port: 0 });
    try {
      const response = await fetch(`${server.url}/api/init`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({})
      });
      const payload = (await response.json()) as { error: string };

      expect(response.status).toBe(400);
      expect(payload.error).toBe("Choose a sync repository before initializing.");
    } finally {
      await server.close();
    }
  });

  it("initializes with paths supplied by the Web UI", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "csm-server-init-"));
    process.env.CSM_CONFIG_DIR = path.join(root, "config");

    const server = await startServer({ port: 0 });
    try {
      const body = {
        syncRepo: path.join(root, "chosen-repo"),
        codexSkillsDir: path.join(root, "chosen-skills"),
        agentsSkillsDir: path.join(root, "chosen-agents-skills"),
        cacheDir: path.join(root, "chosen-cache")
      };
      const response = await fetch(`${server.url}/api/init`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const payload = (await response.json()) as { configured: boolean; config: typeof body };

      expect(response.ok).toBe(true);
      expect(payload.configured).toBe(true);
      expect(payload.config.syncRepo).toBe(body.syncRepo);
      expect(payload.config.codexSkillsDir).toBe(body.codexSkillsDir);
      expect(payload.config.agentsSkillsDir).toBe(body.agentsSkillsDir);
      expect(payload.config.cacheDir).toBe(body.cacheDir);
    } finally {
      await server.close();
    }
  });

  it("updates configured paths after initialization", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "csm-server-config-"));
    process.env.CSM_CONFIG_DIR = path.join(root, "config");

    const server = await startServer({ port: 0 });
    try {
      const initialBody = {
        syncRepo: path.join(root, "repo-a"),
        codexSkillsDir: path.join(root, "skills-a"),
        agentsSkillsDir: path.join(root, "agents-a"),
        cacheDir: path.join(root, "cache-a")
      };
      const updatedBody = {
        syncRepo: path.join(root, "repo-b"),
        codexSkillsDir: path.join(root, "skills-b"),
        agentsSkillsDir: path.join(root, "agents-b"),
        cacheDir: path.join(root, "cache-b")
      };

      await fetch(`${server.url}/api/init`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(initialBody)
      });

      const response = await fetch(`${server.url}/api/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updatedBody)
      });
      const payload = (await response.json()) as { configured: boolean; config: typeof updatedBody };

      expect(response.ok).toBe(true);
      expect(payload.configured).toBe(true);
      expect(payload.config.syncRepo).toBe(updatedBody.syncRepo);
      expect(payload.config.codexSkillsDir).toBe(updatedBody.codexSkillsDir);
      expect(payload.config.agentsSkillsDir).toBe(updatedBody.agentsSkillsDir);
      expect(payload.config.cacheDir).toBe(updatedBody.cacheDir);
    } finally {
      await server.close();
    }
  });

  it("reads and writes local SKILL.md files by source", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "csm-server-skill-file-"));
    process.env.CSM_CONFIG_DIR = path.join(root, "config");

    const server = await startServer({ port: 0 });
    try {
      const config = {
        syncRepo: path.join(root, "repo"),
        codexSkillsDir: path.join(root, "codex-skills"),
        agentsSkillsDir: path.join(root, "agents-skills"),
        cacheDir: path.join(root, "cache")
      };
      await fetch(`${server.url}/api/init`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config)
      });
      await addRemote(root, config.syncRepo);

      const skillDir = path.join(config.agentsSkillsDir, "klay-writer");
      const skillFile = path.join(skillDir, "SKILL.md");
      const original = "---\nname: Klay Writer\n---\nOriginal body\n";
      await mkdir(skillDir, { recursive: true });
      await writeFile(skillFile, original, "utf8");

      const readResponse = await fetch(`${server.url}/api/skill-file`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skillId: "klay-writer", source: "agents" })
      });
      const readPayload = (await readResponse.json()) as { path: string; content: string };

      expect(readResponse.ok).toBe(true);
      expect(readPayload.path).toBe(skillFile);
      expect(readPayload.content).toBe(original);

      const updated = "---\nname: Klay Writer\n---\nUpdated body\n";
      const writeResponse = await fetch(`${server.url}/api/skill-file`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skillId: "klay-writer", source: "agents", content: updated })
      });

      expect(writeResponse.ok).toBe(true);
      expect(await readFile(skillFile, "utf8")).toBe(updated);

      const codexSkillDir = path.join(config.codexSkillsDir, "klay-writer");
      const codexSkillFile = path.join(codexSkillDir, "SKILL.md");
      await mkdir(codexSkillDir, { recursive: true });
      await writeFile(codexSkillFile, original, "utf8");

      const syncedLocalCopies = "---\nname: Klay Writer\n---\nSynced local copy body\n";
      const multiWriteResponse = await fetch(`${server.url}/api/skill-file`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skillId: "klay-writer", source: "agents", sources: ["codex", "agents"], content: syncedLocalCopies })
      });
      const multiWritePayload = (await multiWriteResponse.json()) as { paths: string[] };

      expect(multiWriteResponse.ok).toBe(true);
      expect(multiWritePayload.paths.sort()).toEqual([codexSkillFile, skillFile].sort());
      expect(await readFile(skillFile, "utf8")).toBe(syncedLocalCopies);
      expect(await readFile(codexSkillFile, "utf8")).toBe(syncedLocalCopies);
    } finally {
      await server.close();
    }
  });

  it("requires a local source before reading SKILL.md", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "csm-server-skill-file-source-"));
    process.env.CSM_CONFIG_DIR = path.join(root, "config");

    const server = await startServer({ port: 0 });
    try {
      await fetch(`${server.url}/api/init`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          syncRepo: path.join(root, "repo"),
          codexSkillsDir: path.join(root, "codex-skills"),
          agentsSkillsDir: path.join(root, "agents-skills"),
          cacheDir: path.join(root, "cache")
        })
      });

      const response = await fetch(`${server.url}/api/skill-file`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skillId: "klay-writer" })
      });
      const payload = (await response.json()) as { error: string };

      expect(response.status).toBe(400);
      expect(payload.error).toBe("Request body must include source.");
    } finally {
      await server.close();
    }
  });

  it("selects directories through an injected picker", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "csm-server-picker-"));
    process.env.CSM_CONFIG_DIR = path.join(root, "config");
    const selectedPath = path.join(root, "selected");
    let receivedTitle: string | undefined;

    const server = await startServer({
      port: 0,
      directoryPicker: async (title) => {
        receivedTitle = title;
        return { canceled: false, path: selectedPath };
      }
    });
    try {
      const response = await fetch(`${server.url}/api/select-directory`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Choose sync repo" })
      });
      const payload = (await response.json()) as { canceled: boolean; path: string };

      expect(response.ok).toBe(true);
      expect(receivedTitle).toBe("Choose sync repo");
      expect(payload).toEqual({ canceled: false, path: selectedPath });
    } finally {
      await server.close();
    }
  });

  it("does not treat canceled directory selection as an error", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "csm-server-picker-cancel-"));
    process.env.CSM_CONFIG_DIR = path.join(root, "config");

    const server = await startServer({
      port: 0,
      directoryPicker: async () => ({ canceled: true })
    });
    try {
      const response = await fetch(`${server.url}/api/select-directory`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({})
      });
      const payload = (await response.json()) as { canceled: boolean };

      expect(response.ok).toBe(true);
      expect(payload).toEqual({ canceled: true });
    } finally {
      await server.close();
    }
  });

  it("blocks pull when the sync repo has uncommitted changes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "csm-server-pull-blocked-"));
    process.env.CSM_CONFIG_DIR = path.join(root, "config");

    const server = await startServer({ port: 0 });
    try {
      const config = {
        syncRepo: path.join(root, "repo"),
        codexSkillsDir: path.join(root, "codex-skills"),
        agentsSkillsDir: path.join(root, "agents-skills"),
        cacheDir: path.join(root, "cache")
      };

      await fetch(`${server.url}/api/init`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config)
      });
      await addRemote(root, config.syncRepo);

      await ensureGitRepository(config.syncRepo);
      await mkdir(path.join(config.syncRepo, "temp"), { recursive: true });
      await writeFile(path.join(config.syncRepo, "temp", "touch.txt"), "dirty", "utf8");

      const response = await fetch(`${server.url}/api/pull`, {
        method: "POST"
      });
      const payload = (await response.json()) as { error: string };

      expect(response.status).toBe(500);
      expect(payload.error).toContain("local uncommitted changes");
    } finally {
      await server.close();
    }
  });

  it("commits local usage metadata before pulling remote changes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "csm-server-pull-usage-events-"));
    process.env.CSM_CONFIG_DIR = path.join(root, "config");

    const server = await startServer({ port: 0 });
    try {
      const config = {
        syncRepo: path.join(root, "repo"),
        codexSkillsDir: path.join(root, "codex-skills"),
        agentsSkillsDir: path.join(root, "agents-skills"),
        cacheDir: path.join(root, "cache")
      };

      await fetch(`${server.url}/api/init`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config)
      });
      const remote = await addRemote(root, config.syncRepo);
      await ensureRepoMetadata(config.syncRepo);
      await commitAll(config.syncRepo, "seed metadata");
      const branch = await currentBranch(config.syncRepo);
      await execFileAsync("git", ["-C", config.syncRepo, "push", "-u", "origin", branch]);

      const clone = path.join(root, "remote-clone");
      await execFileAsync("git", ["clone", "-b", branch, remote, clone]);
      await writeFile(path.join(clone, "REMOTE.md"), "remote change\n", "utf8");
      await commitAll(clone, "remote change");
      await execFileAsync("git", ["-C", clone, "push", "origin", branch]);

      await writeFile(
        path.join(config.syncRepo, "metadata", "usage-events.jsonl"),
        "{\"skillId\":\"foo\",\"invokedAt\":\"2026-01-01T00:00:00.000Z\",\"source\":\"record\"}\n",
        "utf8"
      );

      const response = await fetch(`${server.url}/api/pull`, {
        method: "POST"
      });
      const payload = (await response.json()) as {
        preSync: { committed: boolean; commitHash: string | null } | null;
        gitStatus: string;
        gitBranchStatus: { state: string };
      };

      expect(response.ok).toBe(true);
      expect(payload.preSync?.committed).toBe(true);
      expect(payload.preSync?.commitHash).toMatch(/^[0-9a-f]+$/);
      expect(payload.gitStatus).toBe("");
      expect(payload.gitBranchStatus.state).toBe("up-to-date");
      await expect(readFile(path.join(config.syncRepo, "REMOTE.md"), "utf8")).resolves.toContain("remote change");

      const { stdout } = await execFileAsync("git", ["--git-dir", remote, "log", "--oneline", "--all"]);
      expect(stdout).toContain("Sync repository changes");
      expect(stdout).toContain("remote change");
    } finally {
      await server.close();
    }
  });

  it("stops syncing a managed skill by deleting repo metadata and keeping local copies", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "csm-server-stop-syncing-"));
    process.env.CSM_CONFIG_DIR = path.join(root, "config");

    const server = await startServer({ port: 0 });
    try {
      const config = {
        syncRepo: path.join(root, "repo"),
        codexSkillsDir: path.join(root, "codex-skills"),
        agentsSkillsDir: path.join(root, "agents-skills"),
        cacheDir: path.join(root, "cache")
      };
      await fetch(`${server.url}/api/init`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config)
      });
      await addRemote(root, config.syncRepo);

      await ensureRepoMetadata(config.syncRepo);
      await mkdir(path.join(config.syncRepo, "skills", "foo"), { recursive: true });
      await writeFile(path.join(config.syncRepo, "skills", "foo", "SKILL.md"), "id: foo", "utf8");
      await mkdir(path.join(config.codexSkillsDir, "foo"), { recursive: true });
      await writeFile(path.join(config.codexSkillsDir, "foo", "SKILL.md"), "id: foo local", "utf8");

      const hash = await hashDirectory(path.join(config.syncRepo, "skills", "foo"));
      const localHash = await hashDirectory(path.join(config.codexSkillsDir, "foo"));
      const now = new Date().toISOString();
      const record: SkillRecord = {
        id: "foo",
        name: "foo",
        description: "",
        status: "managed",
        localSource: "codex",
        installed: true,
        syncState: "clean",
        lastSyncedHash: hash,
        currentRepoHash: hash,
        currentLocalHash: localHash,
        lastUsedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      await writeSkillsMetadata(config.syncRepo, { schemaVersion: 1, skills: [record] });

      const response = await fetch(`${server.url}/api/stop-syncing`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skillId: "foo" })
      });
      const payload = (await response.json()) as { record: SkillRecord; result: { committed: boolean; pushed: boolean } };

      expect(response.ok).toBe(true);
      expect(payload.record.status).toBe("managed");
      expect(payload.result.committed).toBe(true);
      expect(payload.result.pushed).toBe(true);
      const metadata = await readSkillsMetadata(config.syncRepo);
      expect(metadata.skills).toHaveLength(0);
      await expect(readFile(path.join(config.syncRepo, "skills", "foo", "SKILL.md"), "utf8")).rejects.toThrow();
      await expect(readFile(path.join(config.codexSkillsDir, "foo", "SKILL.md"), "utf8")).resolves.toContain("id: foo local");
    } finally {
      await server.close();
    }
  });

  it("resolves conflicts through the API using a local source", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "csm-server-resolve-conflict-"));
    process.env.CSM_CONFIG_DIR = path.join(root, "config");

    const server = await startServer({ port: 0 });
    try {
      const config = {
        syncRepo: path.join(root, "repo"),
        codexSkillsDir: path.join(root, "codex-skills"),
        agentsSkillsDir: path.join(root, "agents-skills"),
        cacheDir: path.join(root, "cache")
      };
      await fetch(`${server.url}/api/init`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config)
      });
      await addRemote(root, config.syncRepo);

      await writeSkill(path.join(config.syncRepo, "skills", "writer"), "writer", "repo body");
      await writeSkill(path.join(config.codexSkillsDir, "writer"), "writer", "codex body");
      await writeSkill(path.join(config.agentsSkillsDir, "writer"), "writer", "agents body");

      const repoHash = await hashDirectory(path.join(config.syncRepo, "skills", "writer"));
      const codexHash = await hashDirectory(path.join(config.codexSkillsDir, "writer"));
      const now = new Date().toISOString();
      const record: SkillRecord = {
        id: "writer",
        name: "writer",
        description: "Managed skill",
        status: "managed",
        localSource: "agents",
        installed: true,
        syncState: "conflict",
        lastSyncedHash: "stale",
        currentRepoHash: repoHash,
        currentLocalHash: codexHash,
        lastUsedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      await writeSkillsMetadata(config.syncRepo, { schemaVersion: 1, skills: [record] });

      const response = await fetch(`${server.url}/api/resolve-conflict`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skillId: "writer", strategy: "codex" })
      });
      const payload = (await response.json()) as { record: SkillRecord; result?: { committed: boolean } };

      expect(response.ok).toBe(true);
      expect(payload.record.localSource).toBe("codex");
      expect(payload.record.syncState).toBe("clean");
      expect(payload.result?.committed).toBe(true);
      expect(await readFile(path.join(config.syncRepo, "skills", "writer", "SKILL.md"), "utf8")).toContain("codex body");
      expect(await readFile(path.join(config.agentsSkillsDir, "writer", "SKILL.md"), "utf8")).toContain("codex body");
    } finally {
      await server.close();
    }
  });

  it("rejects API conflict resolve when the selected local source is missing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "csm-server-resolve-missing-"));
    process.env.CSM_CONFIG_DIR = path.join(root, "config");

    const server = await startServer({ port: 0 });
    try {
      const config = {
        syncRepo: path.join(root, "repo"),
        codexSkillsDir: path.join(root, "codex-skills"),
        agentsSkillsDir: path.join(root, "agents-skills"),
        cacheDir: path.join(root, "cache")
      };
      await fetch(`${server.url}/api/init`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config)
      });
      await addRemote(root, config.syncRepo);

      await ensureRepoMetadata(config.syncRepo);
      await writeSkill(path.join(config.syncRepo, "skills", "writer"), "writer", "repo body");
      await writeSkill(path.join(config.agentsSkillsDir, "writer"), "writer", "agents body");
      const repoHash = await hashDirectory(path.join(config.syncRepo, "skills", "writer"));
      const agentsHash = await hashDirectory(path.join(config.agentsSkillsDir, "writer"));
      const now = new Date().toISOString();
      const record: SkillRecord = {
        id: "writer",
        name: "writer",
        description: "Managed skill",
        status: "managed",
        localSource: "agents",
        installed: true,
        syncState: "conflict",
        lastSyncedHash: "stale",
        currentRepoHash: repoHash,
        currentLocalHash: agentsHash,
        lastUsedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      await writeSkillsMetadata(config.syncRepo, { schemaVersion: 1, skills: [record] });

      const response = await fetch(`${server.url}/api/resolve-conflict`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skillId: "writer", strategy: "codex" })
      });
      const payload = (await response.json()) as { error: string };

      expect(response.status).toBe(400);
      expect(payload.error).toContain("Cannot use codex as strategy for writer");
    } finally {
      await server.close();
    }
  });

  it("returns local and repo copies in compare endpoint payload", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "csm-server-skill-versions-"));
    process.env.CSM_CONFIG_DIR = path.join(root, "config");

    const server = await startServer({ port: 0 });
    try {
      const config = {
        syncRepo: path.join(root, "repo"),
        codexSkillsDir: path.join(root, "codex-skills"),
        agentsSkillsDir: path.join(root, "agents-skills"),
        cacheDir: path.join(root, "cache")
      };
      await fetch(`${server.url}/api/init`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config)
      });
      await addRemote(root, config.syncRepo);

      await ensureRepoMetadata(config.syncRepo);
      await writeSkill(path.join(config.syncRepo, "skills", "writer"), "writer", "repo body");
      await writeSkill(path.join(config.codexSkillsDir, "writer"), "writer", "codex body");

      const response = await fetch(`${server.url}/api/skill-versions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skillId: "writer" })
      });
      const payload = (await response.json()) as {
        versions: Array<{ source: "codex" | "agents" | "repo"; path: string; exists: boolean; content: string | null }>;
      };

      expect(response.ok).toBe(true);
      expect(payload.versions).toHaveLength(3);
      expect(payload.versions.map((version) => version.source)).toEqual(["codex", "agents", "repo"]);
      expect(payload.versions.find((version) => version.source === "codex")?.exists).toBe(true);
      expect(payload.versions.find((version) => version.source === "agents")?.exists).toBe(false);
      expect(payload.versions.find((version) => version.source === "repo")?.exists).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("lists and resolves repository skill conflicts through API", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "csm-server-repo-conflicts-"));
    process.env.CSM_CONFIG_DIR = path.join(root, "config");

    const server = await startServer({ port: 0 });
    try {
      const config = {
        syncRepo: path.join(root, "repo"),
        codexSkillsDir: path.join(root, "codex-skills"),
        agentsSkillsDir: path.join(root, "agents-skills"),
        cacheDir: path.join(root, "cache")
      };
      await fetch(`${server.url}/api/init`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config)
      });
      const remote = await addRemote(root, config.syncRepo);
      await ensureRepoMetadata(config.syncRepo);
      await writeSkill(path.join(config.syncRepo, "skills", "foo"), "foo", "Base body");
      await writeSkill(path.join(config.codexSkillsDir, "foo"), "foo", "Base body");
      const hash = await hashDirectory(path.join(config.syncRepo, "skills", "foo"));
      const now = new Date().toISOString();
      await writeSkillsMetadata(config.syncRepo, {
        schemaVersion: 1,
        skills: [
          {
            id: "foo",
            name: "foo",
            description: "Test skill",
            status: "managed",
            localSource: "codex",
            installed: true,
            syncState: "clean",
            lastSyncedHash: hash,
            currentRepoHash: hash,
            currentLocalHash: hash,
            lastUsedAt: null,
            createdAt: now,
            updatedAt: now
          }
        ]
      });
      await commitAll(config.syncRepo, "seed skill");
      const branch = await currentBranch(config.syncRepo);
      await execFileAsync("git", ["-C", config.syncRepo, "push", "-u", "origin", branch]);

      const clone = path.join(root, "clone");
      await execFileAsync("git", ["clone", "-b", branch, remote, clone]);
      await writeSkill(path.join(clone, "skills", "foo"), "foo", "Remote body");
      await commitAll(clone, "remote skill update");
      await execFileAsync("git", ["-C", clone, "push", "origin", branch]);

      await writeSkill(path.join(config.syncRepo, "skills", "foo"), "foo", "Local body");
      await commitAll(config.syncRepo, "local skill update");

      const listResponse = await fetch(`${server.url}/api/repo-conflicts`);
      const listPayload = (await listResponse.json()) as { conflicts: Array<{ skillId: string; versions: Array<{ source: string; content: string | null }> }> };
      expect(listResponse.ok).toBe(true);
      expect(listPayload.conflicts[0]?.skillId).toBe("foo");
      expect(listPayload.conflicts[0]?.versions.find((version) => version.source === "github")?.content).toContain("Remote body");

      const resolveResponse = await fetch(`${server.url}/api/repo-conflicts/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resolutions: [{ skillId: "foo", source: "github" }] })
      });
      const resolvePayload = (await resolveResponse.json()) as { gitBranchStatus: { state: string } };

      expect(resolveResponse.ok).toBe(true);
      expect(resolvePayload.gitBranchStatus.state).toBe("up-to-date");
      await expect(readFile(path.join(config.syncRepo, "skills", "foo", "SKILL.md"), "utf8")).resolves.toContain("Remote body");
    } finally {
      await server.close();
    }
  });

  it("does not expose legacy skill archive endpoints", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "csm-server-legacy-archive-endpoints-"));
    process.env.CSM_CONFIG_DIR = path.join(root, "config");

    const server = await startServer({ port: 0 });
    try {
      const archiveResponse = await fetch(`${server.url}/api/archive`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skillId: "writer" })
      });
      const restoreResponse = await fetch(`${server.url}/api/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skillId: "writer" })
      });

      expect(archiveResponse.status).toBe(404);
      expect(restoreResponse.status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it("runs bulk skill actions as one pushed commit", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "csm-server-bulk-action-"));
    process.env.CSM_CONFIG_DIR = path.join(root, "config");

    const server = await startServer({ port: 0 });
    try {
      const config = {
        syncRepo: path.join(root, "repo"),
        codexSkillsDir: path.join(root, "codex-skills"),
        agentsSkillsDir: path.join(root, "agents-skills"),
        cacheDir: path.join(root, "cache")
      };
      await fetch(`${server.url}/api/init`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config)
      });
      const remote = await addRemote(root, config.syncRepo);
      await writeSkill(path.join(config.codexSkillsDir, "alpha"), "alpha", "Alpha body");
      await writeSkill(path.join(config.codexSkillsDir, "beta"), "beta", "Beta body");

      const response = await fetch(`${server.url}/api/bulk-action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          endpoint: "import",
          skills: [
            { skillId: "alpha", source: "codex" },
            { skillId: "beta", source: "codex" }
          ]
        })
      });
      const payload = (await response.json()) as { result: { skillIds: string[]; committed: boolean } };

      expect(response.ok).toBe(true);
      expect(payload.result.skillIds).toEqual(["alpha", "beta"]);
      expect(payload.result.committed).toBe(true);

      const { stdout } = await execFileAsync("git", ["--git-dir", remote, "log", "--oneline", "--all"]);
      expect(stdout.trim().split(/\r?\n/)).toHaveLength(1);
      expect(stdout).toContain("Sync 2 skills: alpha, beta");
    } finally {
      await server.close();
    }
  });

  it("records a confirmed usage event", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "csm-server-record-"));
    process.env.CSM_CONFIG_DIR = path.join(root, "config");

    const server = await startServer({ port: 0 });
    try {
      const config = {
        syncRepo: path.join(root, "repo"),
        codexSkillsDir: path.join(root, "codex-skills"),
        agentsSkillsDir: path.join(root, "agents-skills"),
        cacheDir: path.join(root, "cache")
      };
      await fetch(`${server.url}/api/init`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config)
      });

      const response = await fetch(`${server.url}/api/record`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skillId: "foo", invokedAt: "2026-01-09T00:00:00.000Z" })
      });
      const payload = (await response.json()) as { event: { skillId: string; invokedAt: string; source: string } };

      expect(response.ok).toBe(true);
      expect(payload.event.skillId).toBe("foo");
      expect(payload.event.invokedAt).toBe("2026-01-09T00:00:00.000Z");
      expect(payload.event.source).toBe("record");
    } finally {
      await server.close();
    }
  });

  it("installs a managed skill with dependencies during /api/install", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "csm-server-install-deps-"));
    process.env.CSM_CONFIG_DIR = path.join(root, "config");

    const server = await startServer({ port: 0 });
    const previousPath = process.env.PATH;
    const toolDir = path.join(root, "bin");
    const marker = path.join(root, "install-called.txt");

    try {
      const config = {
        syncRepo: path.join(root, "repo"),
        codexSkillsDir: path.join(root, "codex-skills"),
        agentsSkillsDir: path.join(root, "agents-skills"),
        cacheDir: path.join(root, "cache")
      };
      await fetch(`${server.url}/api/init`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config)
      });
      await addRemote(root, config.syncRepo);

      await ensureRepoMetadata(config.syncRepo);
      const repoSkill = path.join(config.syncRepo, "skills", "foo");
      await writeSkill(repoSkill, "foo", "repo body");
      await writeFile(path.join(repoSkill, "package.json"), "{}\n", "utf8");
      await mkdir(toolDir, { recursive: true });
      await createFakeManager(toolDir, "npm", `#!/bin/sh\nmkdir -p "$PWD/node_modules"\necho "installed" > "${marker}"\nexit 0\n`);
      await writeFile(
        path.join(repoSkill, "package-lock.json"),
        "{\"lockfileVersion\": 3}\n",
        "utf8"
      );

      const hash = await hashDirectory(repoSkill);
      const now = new Date().toISOString();
      const record = {
        id: "foo",
        name: "foo",
        description: "Test skill",
        status: "managed",
        localSource: "codex",
        installed: false,
        syncState: "missing_local",
        lastSyncedHash: hash,
        currentRepoHash: hash,
        currentLocalHash: null,
        lastUsedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      await writeSkillsMetadata(config.syncRepo, { schemaVersion: 1, skills: [record] });

      process.env.PATH = `${toolDir}:${previousPath}`;
      const response = await fetch(`${server.url}/api/install`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skillId: "foo" })
      });
      const payload = (await response.json()) as {
        dependencyInstall?: {
          status: "installed" | "skipped-no-package-json" | "skipped-existing-node-modules" | "failed";
          packageManager: string | null;
          command: string;
          message: string;
        };
      };

      expect(response.ok).toBe(true);
      expect(payload.dependencyInstall?.status).toBe("installed");
      expect(payload.dependencyInstall?.packageManager).toBe("npm");
      expect(payload.dependencyInstall?.command).toBe("npm install");
      expect(existsSync(marker)).toBe(true);
    } finally {
      process.env.PATH = previousPath;
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails /api/install when dependency install fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "csm-server-install-deps-fail-"));
    process.env.CSM_CONFIG_DIR = path.join(root, "config");
    const server = await startServer({ port: 0 });
    const previousPath = process.env.PATH;
    const toolDir = path.join(root, "bin");
    try {
      const config = {
        syncRepo: path.join(root, "repo"),
        codexSkillsDir: path.join(root, "codex-skills"),
        agentsSkillsDir: path.join(root, "agents-skills"),
        cacheDir: path.join(root, "cache")
      };
      await fetch(`${server.url}/api/init`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config)
      });
      await addRemote(root, config.syncRepo);

      await ensureRepoMetadata(config.syncRepo);
      const repoSkill = path.join(config.syncRepo, "skills", "foo");
      await writeSkill(repoSkill, "foo", "repo body");
      await writeFile(path.join(repoSkill, "package.json"), "{}\n", "utf8");
      await writeFile(path.join(repoSkill, "package-lock.json"), "{\"lockfileVersion\": 3}\n", "utf8");

      const hash = await hashDirectory(repoSkill);
      const now = new Date().toISOString();
      const record = {
        id: "foo",
        name: "foo",
        description: "Test skill",
        status: "managed",
        localSource: "codex",
        installed: false,
        syncState: "missing_local",
        lastSyncedHash: hash,
        currentRepoHash: hash,
        currentLocalHash: null,
        lastUsedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      await writeSkillsMetadata(config.syncRepo, { schemaVersion: 1, skills: [record] });

      await mkdir(toolDir, { recursive: true });
      await createFakeManager(toolDir, "npm", `#!/bin/sh\necho "install failed" 1>&2\nexit 1\n`);
      process.env.PATH = `${toolDir}:${previousPath}`;

      const response = await fetch(`${server.url}/api/install`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skillId: "foo" })
      });
      const payload = (await response.json()) as { error: string };

      expect(response.status).toBe(500);
      expect(payload.error).toContain("Failed to install dependencies");

      const metadata = await readSkillsMetadata(config.syncRepo);
      expect(metadata.skills[0]?.installed).toBe(false);
    } finally {
      process.env.PATH = previousPath;
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("updates a managed skill with dependencies during /api/update-local", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "csm-server-update-local-deps-"));
    process.env.CSM_CONFIG_DIR = path.join(root, "config");
    const server = await startServer({ port: 0 });
    const previousPath = process.env.PATH;
    const toolDir = path.join(root, "bin");
    const marker = path.join(root, "install-called.txt");

    try {
      const config = {
        syncRepo: path.join(root, "repo"),
        codexSkillsDir: path.join(root, "codex-skills"),
        agentsSkillsDir: path.join(root, "agents-skills"),
        cacheDir: path.join(root, "cache")
      };
      await fetch(`${server.url}/api/init`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config)
      });
      await addRemote(root, config.syncRepo);

      await ensureRepoMetadata(config.syncRepo);

      const repoSkill = path.join(config.syncRepo, "skills", "foo");
      await writeSkill(repoSkill, "foo", "repo body v2");
      await writeFile(path.join(repoSkill, "package.json"), "{}\n", "utf8");
      await writeFile(
        path.join(repoSkill, "package-lock.json"),
        "{\"lockfileVersion\": 3}\n",
        "utf8"
      );

      const localSkill = path.join(config.codexSkillsDir, "foo");
      await mkdir(localSkill, { recursive: true });
      await writeFile(path.join(localSkill, "SKILL.md"), "---\nname: foo\ndescription: Test skill\n---\nLocal body v1\n", "utf8");

      const repoHash = await hashDirectory(repoSkill);
      const localHash = await hashDirectory(localSkill);
      const now = new Date().toISOString();
      const record = {
        id: "foo",
        name: "foo",
        description: "Test skill",
        status: "managed",
        localSource: "codex",
        installed: true,
        syncState: "repo_modified",
        lastSyncedHash: localHash,
        currentRepoHash: localHash,
        currentLocalHash: localHash,
        lastUsedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      await writeSkillsMetadata(config.syncRepo, {
        schemaVersion: 1,
        skills: [record]
      });

      await mkdir(toolDir, { recursive: true });
      await createFakeManager(toolDir, "npm", `#!/bin/sh\nmkdir -p "$PWD/node_modules"\necho "installed" > "${marker}"\nexit 0\n`);
      process.env.PATH = `${toolDir}:${previousPath}`;

      const response = await fetch(`${server.url}/api/update-local`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skillId: "foo" })
      });
      const payload = (await response.json()) as {
        dependencyInstall?: {
          status: "installed" | "skipped-no-package-json" | "skipped-existing-node-modules" | "failed";
          packageManager: string | null;
          command: string;
          message: string;
        };
      };
      expect(response.ok).toBe(true);
      expect(payload.dependencyInstall?.status).toBe("installed");
      expect(payload.dependencyInstall?.packageManager).toBe("npm");
      expect(payload.dependencyInstall?.command).toBe("npm install");
      expect(existsSync(marker)).toBe(true);
    } finally {
      process.env.PATH = previousPath;
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails /api/update-local when dependency install fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "csm-server-update-local-deps-fail-"));
    process.env.CSM_CONFIG_DIR = path.join(root, "config");
    const server = await startServer({ port: 0 });
    const previousPath = process.env.PATH;
    const toolDir = path.join(root, "bin");

    try {
      const config = {
        syncRepo: path.join(root, "repo"),
        codexSkillsDir: path.join(root, "codex-skills"),
        agentsSkillsDir: path.join(root, "agents-skills"),
        cacheDir: path.join(root, "cache")
      };
      await fetch(`${server.url}/api/init`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config)
      });
      await addRemote(root, config.syncRepo);

      await ensureRepoMetadata(config.syncRepo);
      const repoSkill = path.join(config.syncRepo, "skills", "foo");
      await writeSkill(repoSkill, "foo", "repo body v2");
      await writeFile(path.join(repoSkill, "package.json"), "{}\n", "utf8");
      await writeFile(
        path.join(repoSkill, "package-lock.json"),
        "{\"lockfileVersion\": 3}\n",
        "utf8"
      );

      const localSkill = path.join(config.codexSkillsDir, "foo");
      await mkdir(localSkill, { recursive: true });
      await writeFile(path.join(localSkill, "SKILL.md"), "---\nname: foo\ndescription: Test skill\n---\nLocal body v1\n", "utf8");
      const repoHash = await hashDirectory(repoSkill);
      const localHash = await hashDirectory(localSkill);
      const now = new Date().toISOString();
      await writeSkillsMetadata(config.syncRepo, {
        schemaVersion: 1,
        skills: [
          {
            id: "foo",
            name: "foo",
            description: "Test skill",
            status: "managed",
            localSource: "codex",
            installed: true,
            syncState: "repo_modified",
            lastSyncedHash: localHash,
            currentRepoHash: localHash,
            currentLocalHash: localHash,
            lastUsedAt: null,
            createdAt: now,
            updatedAt: now,
          }
        ]
      });

      await mkdir(toolDir, { recursive: true });
      await createFakeManager(toolDir, "npm", `#!/bin/sh\necho "install failed" 1>&2\nexit 1\n`);
      process.env.PATH = `${toolDir}:${previousPath}`;

      const response = await fetch(`${server.url}/api/update-local`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skillId: "foo" })
      });
      const payload = (await response.json()) as { error: string };

      expect(response.status).toBe(500);
      expect(payload.error).toContain("Failed to install dependencies");
    } finally {
      process.env.PATH = previousPath;
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function createFakeManager(dir: string, name: string, body: string): Promise<void> {
  const binary = path.join(dir, name);
  await writeFile(binary, body, "utf8");
  chmodSync(binary, 0o755);
}

async function addRemote(root: string, syncRepo: string): Promise<string> {
  const remote = path.join(root, "remote.git");
  await ensureGitRepository(syncRepo);
  await execFileAsync("git", ["init", "--bare", remote]);
  await execFileAsync("git", ["remote", "add", "origin", remote], { cwd: syncRepo });
  return remote;
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

async function writeSkill(skillDir: string, name: string, body: string): Promise<void> {
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: Test skill\n---\n\n# ${name}\n\n${body}\n`,
    "utf8"
  );
}

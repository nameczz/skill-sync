import { mkdir, mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { recordUsageFromCodexSessions } from "../src/sessionUsage.js";
import { createLocalConfig } from "../src/config.js";
import { ensureRepoMetadata } from "../src/metadata.js";
import { readUsageEvents } from "../src/usage.js";

describe("session usage scanner", () => {
  it("records SKILL.md reads from Codex Desktop session tool calls", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "csm-session-usage-"));
    const configDir = path.join(root, "config");
    const threadId = "019e-test-thread";
    const config = await createLocalConfig({
      syncRepo: path.join(root, "repo"),
      codexSkillsDir: path.join(root, "codex-skills"),
      agentsSkillsDir: path.join(root, "agents-skills"),
      cacheDir: path.join(root, "cache"),
      env: { CSM_CONFIG_DIR: configDir } as NodeJS.ProcessEnv,
      force: true
    });
    await ensureRepoMetadata(config.syncRepo);
    await mkdir(path.join(config.codexSkillsDir, "baoyu-comic"), { recursive: true });
    await writeFile(path.join(config.codexSkillsDir, "baoyu-comic", "SKILL.md"), "# baoyu-comic\n", "utf8");
    await mkdir(path.join(config.codexSkillsDir, "brainstorming"), { recursive: true });
    await writeFile(path.join(config.codexSkillsDir, "brainstorming", "SKILL.md"), "# brainstorming\n", "utf8");

    const sessionsDir = path.join(root, "codex-home", "sessions", "2026", "05", "28");
    await mkdir(sessionsDir, { recursive: true });
    const sessionPath = path.join(sessionsDir, `rollout-2026-05-28T12-00-00-${threadId}.jsonl`);
    await writeFile(
      sessionPath,
      [
        JSON.stringify({
          timestamp: "2026-05-28T04:26:54.754Z",
          type: "event_msg",
          payload: {
            type: "user_message",
            message: `Use [$baoyu-comic](${config.codexSkillsDir}/baoyu-comic/SKILL.md) now.`,
            images: []
          }
        }),
        JSON.stringify({
          timestamp: "2026-05-28T04:27:54.754Z",
          type: "event_msg",
          payload: {
            type: "agent_message",
            message: "我会用 `brainstorming` 技能来陪你把想法摊开一点。"
          }
        }),
        JSON.stringify({
          timestamp: "2026-05-28T04:28:54.754Z",
          type: "event_msg",
          payload: {
            type: "agent_message",
            message: `Mentioning ${config.codexSkillsDir}/baoyu-comic/SKILL.md from assistant output should not count.`
          }
        }),
        JSON.stringify({
          timestamp: "2026-05-28T04:29:54.754Z",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "exec_command",
            arguments: JSON.stringify({
              cmd: `sed -n '1,80p' ${config.codexSkillsDir}/brainstorming/SKILL.md`,
              workdir: root
            }),
            call_id: "call_test"
          }
        })
      ].join("\n"),
      "utf8"
    );

    const result = await recordUsageFromCodexSessions(config, {
      env: { CODEX_HOME: path.join(root, "codex-home"), CODEX_THREAD_ID: threadId } as NodeJS.ProcessEnv
    });

    expect(result).toEqual({ scannedFiles: 1, recorded: 1, skillIds: ["brainstorming"] });
    await expect(readUsageEvents(config.syncRepo)).resolves.toEqual([
      { skillId: "brainstorming", invokedAt: "2026-05-28T04:29:54.754Z", source: "record" }
    ]);

    await expect(
      recordUsageFromCodexSessions(config, {
        env: { CODEX_HOME: path.join(root, "codex-home"), CODEX_THREAD_ID: threadId } as NodeJS.ProcessEnv
      })
    ).resolves.toMatchObject({ recorded: 0, skillIds: [] });
  });

  it("stores session scan state only in the local cache", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "csm-session-cache-"));
    const codexHome = path.join(root, "codex-home");
    const config = await createLocalConfig({
      syncRepo: path.join(root, "repo"),
      codexSkillsDir: path.join(root, "codex-skills"),
      agentsSkillsDir: path.join(root, "agents-skills"),
      cacheDir: path.join(root, "cache"),
      env: { CSM_CONFIG_DIR: path.join(root, "config") } as NodeJS.ProcessEnv,
      force: true
    });
    await ensureRepoMetadata(config.syncRepo);
    const sessionsDir = path.join(codexHome, "sessions", "2026", "05", "28");
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(path.join(sessionsDir, "rollout-2026-05-28T12-00-00-empty.jsonl"), "\n", "utf8");

    await recordUsageFromCodexSessions(config, { env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv });

    await expect(readFile(path.join(config.cacheDir, "usage-session-scan.json"), "utf8")).resolves.toContain("\"schemaVersion\": 2");
  });

  it("can scan all recent sessions even when the current process has a thread id", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "csm-session-all-"));
    const codexHome = path.join(root, "codex-home");
    const config = await createLocalConfig({
      syncRepo: path.join(root, "repo"),
      codexSkillsDir: path.join(root, "codex-skills"),
      agentsSkillsDir: path.join(root, "agents-skills"),
      cacheDir: path.join(root, "cache"),
      env: { CSM_CONFIG_DIR: path.join(root, "config") } as NodeJS.ProcessEnv,
      force: true
    });
    await ensureRepoMetadata(config.syncRepo);
    await mkdir(path.join(config.codexSkillsDir, "baoyu-comic"), { recursive: true });
    await writeFile(path.join(config.codexSkillsDir, "baoyu-comic", "SKILL.md"), "# baoyu-comic\n", "utf8");

    const sessionsDir = path.join(codexHome, "sessions", "2026", "05", "28");
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(
      path.join(sessionsDir, "rollout-2026-05-28T12-00-00-other-thread.jsonl"),
      `${JSON.stringify({
        timestamp: "2026-05-28T05:00:00.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          arguments: JSON.stringify({
            cmd: `sed -n '1,80p' ${config.codexSkillsDir}/baoyu-comic/SKILL.md`,
            workdir: root
          }),
          call_id: "call_test"
        }
      })}\n`,
      "utf8"
    );

    const result = await recordUsageFromCodexSessions(config, {
      threadId: null,
      env: { CODEX_HOME: codexHome, CODEX_THREAD_ID: "current-thread" } as NodeJS.ProcessEnv,
      now: () => new Date("2026-05-28T05:01:00.000Z")
    });

    expect(result).toMatchObject({ recorded: 1, skillIds: ["baoyu-comic"] });
  });

  it("scans seven days of sessions on first initialization", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "csm-session-initial-window-"));
    const codexHome = path.join(root, "codex-home");
    const config = await createLocalConfig({
      syncRepo: path.join(root, "repo"),
      codexSkillsDir: path.join(root, "codex-skills"),
      agentsSkillsDir: path.join(root, "agents-skills"),
      cacheDir: path.join(root, "cache"),
      env: { CSM_CONFIG_DIR: path.join(root, "config") } as NodeJS.ProcessEnv,
      force: true
    });
    await ensureRepoMetadata(config.syncRepo);
    await mkdir(path.join(config.codexSkillsDir, "baoyu-comic"), { recursive: true });
    await writeFile(path.join(config.codexSkillsDir, "baoyu-comic", "SKILL.md"), "# baoyu-comic\n", "utf8");

    const sessionsDir = path.join(codexHome, "sessions", "2026", "05", "22");
    await mkdir(sessionsDir, { recursive: true });
    const sixDaysOld = path.join(sessionsDir, "rollout-2026-05-22T12-00-00-six-days.jsonl");
    const eightDaysOld = path.join(sessionsDir, "rollout-2026-05-20T12-00-00-eight-days.jsonl");
    const sessionLine = (timestamp: string) =>
      `${JSON.stringify({
        timestamp,
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          arguments: JSON.stringify({
            cmd: `sed -n '1,80p' ${config.codexSkillsDir}/baoyu-comic/SKILL.md`,
            workdir: root
          }),
          call_id: "call_test"
        }
      })}\n`;

    await writeFile(sixDaysOld, sessionLine("2026-05-22T05:00:00.000Z"), "utf8");
    await writeFile(eightDaysOld, sessionLine("2026-05-20T05:00:00.000Z"), "utf8");
    await utimes(sixDaysOld, new Date("2026-05-22T05:00:00.000Z"), new Date("2026-05-22T05:00:00.000Z"));
    await utimes(eightDaysOld, new Date("2026-05-20T05:00:00.000Z"), new Date("2026-05-20T05:00:00.000Z"));

    const result = await recordUsageFromCodexSessions(config, {
      threadId: null,
      env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      now: () => new Date("2026-05-28T05:00:00.000Z")
    });

    expect(result).toMatchObject({ scannedFiles: 1, recorded: 1, skillIds: ["baoyu-comic"] });
    await expect(readUsageEvents(config.syncRepo)).resolves.toEqual([
      { skillId: "baoyu-comic", invokedAt: "2026-05-22T05:00:00.000Z", source: "record" }
    ]);
  });
});

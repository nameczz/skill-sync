import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createUsageMonitor } from "../src/usageMonitor.js";
import type { LocalConfig } from "../src/types.js";

describe("usage monitor", () => {
  it("defaults to a 30-second scan interval", () => {
    const monitor = createUsageMonitor();

    expect(monitor.getStatus().intervalMs).toBe(30_000);
  });

  it("runs an immediate scan and reports listener status", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "csm-usage-monitor-"));
    const config = configFor(root);
    const scans: string[] = [];
    const monitor = createUsageMonitor({
      intervalMs: 60_000,
      now: () => "2026-05-28T08:00:00.000Z",
      scan: async (nextConfig) => {
        scans.push(nextConfig.cacheDir);
        return { recorded: 1, skillIds: ["baoyu-comic"] };
      }
    });

    await monitor.start(config);

    expect(scans).toEqual([config.cacheDir]);
    expect(monitor.getStatus()).toMatchObject({
      enabled: true,
      running: false,
      intervalMs: 60_000,
      lastRecordedSkillIds: ["baoyu-comic"],
      lastError: null
    });

    await monitor.stop();
    expect(monitor.getStatus().enabled).toBe(false);
  });
});

function configFor(root: string): LocalConfig {
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

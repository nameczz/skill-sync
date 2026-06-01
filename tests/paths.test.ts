import { describe, expect, it } from "vitest";
import { expandHome, getDefaultAgentsSkillsDir, getDefaultCacheDir, resolveSkillPath, validateSkillId } from "../src/paths.js";

describe("skill id validation", () => {
  it("accepts nested skill ids", () => {
    expect(validateSkillId("gstack/autoplan")).toBe("gstack/autoplan");
  });

  it("rejects path traversal", () => {
    expect(() => validateSkillId("../secret")).toThrow(/invalid path segment/);
  });

  it("rejects hidden directories", () => {
    expect(() => validateSkillId(".system/openai-docs")).toThrow(/hidden/);
  });

  it("resolves only inside the root", () => {
    expect(resolveSkillPath("/tmp/skills", "foo")).toBe("/tmp/skills/foo");
    expect(() => resolveSkillPath("/tmp/skills", "../foo")).toThrow();
  });

  it("expands home paths", () => {
    expect(expandHome("~/repo", "/Users/tester")).toBe("/Users/tester/repo");
  });

  it("defaults cache under the local app cache directory", () => {
    expect(getDefaultCacheDir({ homeDir: "/Users/tester", env: {} })).toBe("/Users/tester/.skill-sync/cache");
    expect(getDefaultCacheDir({ env: { CSM_CONFIG_DIR: "/tmp/csm-config" }, homeDir: "/Users/tester" })).toBe(
      "/Users/tester/.skill-sync/cache"
    );
    expect(getDefaultCacheDir({ env: { SKILL_SYNC_CACHE_DIR: "/tmp/skill-sync-cache" } })).toBe("/tmp/skill-sync-cache");
    expect(getDefaultCacheDir({ env: { CSM_CACHE_DIR: "/tmp/csm-cache" } })).toBe("/tmp/csm-cache");
  });

  it("defaults agents skills under the agents home directory", () => {
    expect(getDefaultAgentsSkillsDir({ homeDir: "/Users/tester", env: {} })).toBe("/Users/tester/.agents/skills");
    expect(getDefaultAgentsSkillsDir({ homeDir: "/Users/tester", env: { CSM_AGENTS_SKILLS_DIR: "/tmp/agents" } })).toBe(
      "/tmp/agents"
    );
    expect(
      getDefaultAgentsSkillsDir({ homeDir: "/Users/tester", env: { SKILL_SYNC_AGENTS_SKILLS_DIR: "/tmp/skill-sync-agents" } })
    ).toBe("/tmp/skill-sync-agents");
  });
});

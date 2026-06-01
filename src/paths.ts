import path from "node:path";
import { homedir } from "node:os";

export type PathOptions = {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
};

export function expandHome(input: string, homeDir = homedir()): string {
  if (input === "~") {
    return homeDir;
  }

  if (input.startsWith("~/")) {
    return path.join(homeDir, input.slice(2));
  }

  return input;
}

export function getDefaultConfigDir(options: PathOptions = {}): string {
  const env = options.env ?? process.env;
  const home = options.homeDir ?? homedir();
  return path.resolve(expandHome(env.SKILL_SYNC_CONFIG_DIR ?? env.CSM_CONFIG_DIR ?? "~/.skill-sync", home));
}

export function getLegacyConfigDir(options: PathOptions = {}): string {
  const env = options.env ?? process.env;
  const home = options.homeDir ?? homedir();
  return path.resolve(expandHome(env.CSM_CONFIG_DIR ?? "~/.codex-skill-manager", home));
}

export function getDefaultCacheDir(options: PathOptions = {}): string {
  const env = options.env ?? process.env;
  const home = options.homeDir ?? homedir();
  return path.resolve(expandHome(env.SKILL_SYNC_CACHE_DIR ?? env.CSM_CACHE_DIR ?? "~/.skill-sync/cache", home));
}

export function getDefaultSyncRepo(options: PathOptions = {}): string {
  const env = options.env ?? process.env;
  const home = options.homeDir ?? homedir();
  return path.resolve(expandHome(env.SKILL_SYNC_REPO ?? env.CSM_SYNC_REPO ?? "~/skill-sync", home));
}

export function getDefaultCodexSkillsDir(options: PathOptions = {}): string {
  const env = options.env ?? process.env;
  const home = options.homeDir ?? homedir();
  return path.resolve(expandHome(env.SKILL_SYNC_CODEX_SKILLS_DIR ?? env.CSM_CODEX_SKILLS_DIR ?? "~/.codex/skills", home));
}

export function getDefaultAgentsSkillsDir(options: PathOptions = {}): string {
  const env = options.env ?? process.env;
  const home = options.homeDir ?? homedir();
  return path.resolve(expandHome(env.SKILL_SYNC_AGENTS_SKILLS_DIR ?? env.CSM_AGENTS_SKILLS_DIR ?? "~/.agents/skills", home));
}

export function configFilePath(configDir: string): string {
  return path.join(configDir, "config.json");
}

export function repoSkillsDir(syncRepo: string): string {
  return path.join(syncRepo, "skills");
}

export function repoMetadataDir(syncRepo: string): string {
  return path.join(syncRepo, "metadata");
}

export function getDefaultCodexArchiveSessionsDir(options: PathOptions = {}): string {
  const env = options.env ?? process.env;
  const home = options.homeDir ?? homedir();
  const codexHome = path.resolve(expandHome(env.SKILL_SYNC_CODEX_HOME ?? env.CSM_CODEX_HOME ?? env.CODEX_HOME ?? "~/.codex", home));
  return path.join(codexHome, "archived_sessions");
}

export function repoSettingsPath(syncRepo: string): string {
  return path.join(repoMetadataDir(syncRepo), "settings.json");
}

export function repoSkillsMetadataPath(syncRepo: string): string {
  return path.join(repoMetadataDir(syncRepo), "skills.json");
}

export function repoUsageEventsPath(syncRepo: string): string {
  return path.join(repoMetadataDir(syncRepo), "usage-events.jsonl");
}

export function validateSkillId(skillId: string): string {
  const normalized = skillId.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");

  if (!normalized) {
    throw new Error("Skill id cannot be empty.");
  }

  const parts = normalized.split("/");
  if (parts.some((part) => part === "." || part === ".." || part.length === 0)) {
    throw new Error(`Skill id "${skillId}" contains an invalid path segment.`);
  }

  if (normalized.startsWith(".") || normalized.includes("/.")) {
    throw new Error(`Skill id "${skillId}" cannot target hidden directories.`);
  }

  if (path.isAbsolute(skillId)) {
    throw new Error(`Skill id "${skillId}" must be relative, not absolute.`);
  }

  return normalized;
}

export function resolveSkillPath(root: string, skillId: string): string {
  const safeId = validateSkillId(skillId);
  const target = path.resolve(root, ...safeId.split("/"));
  assertInside(target, root);
  return target;
}

export function assertInside(targetPath: string, rootPath: string): void {
  const relative = path.relative(path.resolve(rootPath), path.resolve(targetPath));
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return;
  }

  throw new Error(`Path escapes allowed root: ${targetPath}`);
}

export function toSkillId(root: string, skillPath: string): string {
  const relative = path.relative(root, skillPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Cannot derive skill id outside root: ${skillPath}`);
  }

  return relative.split(path.sep).join("/");
}

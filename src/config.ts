import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { LocalConfig } from "./types.js";
import {
  configFilePath,
  expandHome,
  getDefaultCacheDir,
  getDefaultAgentsSkillsDir,
  getDefaultCodexSkillsDir,
  getDefaultConfigDir,
  getDefaultSyncRepo,
  getLegacyConfigDir,
  type PathOptions
} from "./paths.js";
import { readJsonFile, writeJsonFile } from "./json.js";

export type InitConfigOptions = PathOptions & {
  syncRepo?: string;
  codexSkillsDir?: string;
  agentsSkillsDir?: string;
  cacheDir?: string;
  force?: boolean;
};

export async function createLocalConfig(options: InitConfigOptions = {}): Promise<LocalConfig> {
  const configDir = resolveConfigDirForWrite(options);
  const now = new Date().toISOString();
  const filePath = configFilePath(configDir);
  const existing = existsSync(filePath) ? await loadLocalConfig(options) : null;

  if (existsSync(filePath) && !options.force) {
    return existing as LocalConfig;
  }

  const config: LocalConfig = {
    schemaVersion: 1,
    syncRepo: resolveUserPath(options.syncRepo ?? getDefaultSyncRepo(options), options),
    codexSkillsDir: resolveUserPath(options.codexSkillsDir ?? getDefaultCodexSkillsDir(options), options),
    agentsSkillsDir: resolveUserPath(options.agentsSkillsDir ?? existing?.agentsSkillsDir ?? getDefaultAgentsSkillsDir(options), options),
    cacheDir: resolveUserPath(options.cacheDir ?? getDefaultCacheDir(options), options),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  };

  await mkdir(config.cacheDir, { recursive: true });
  await writeJsonFile(filePath, config);
  return config;
}

export async function loadLocalConfig(options: PathOptions = {}): Promise<LocalConfig> {
  const filePath = resolveConfigFileForRead(options);

  if (!existsSync(filePath)) {
    throw new Error(`No config found at ${filePath}. Run "skill-sync init" first.`);
  }

  const config = await readJsonFile<LocalConfig>(filePath);
  if (config.schemaVersion !== 1) {
    throw new Error(`Unsupported config schema version in ${filePath}.`);
  }

  return {
    ...config,
    agentsSkillsDir: config.agentsSkillsDir ?? getDefaultAgentsSkillsDir(options)
  };
}

export async function tryLoadLocalConfig(options: PathOptions = {}): Promise<LocalConfig | null> {
  const filePath = resolveConfigFileForRead(options);
  if (!existsSync(filePath)) {
    return null;
  }

  return loadLocalConfig(options);
}

function resolveConfigDirForWrite(options: PathOptions = {}): string {
  const primary = getDefaultConfigDir(options);
  const legacy = getLegacyConfigDir(options);
  const primaryFile = configFilePath(primary);

  if (existsSync(primaryFile) || primary === legacy) {
    return primary;
  }

  const env = options.env ?? process.env;
  const hasExplicitConfigDir = Boolean(env.SKILL_SYNC_CONFIG_DIR || env.CSM_CONFIG_DIR);
  if (!hasExplicitConfigDir && existsSync(configFilePath(legacy))) {
    return legacy;
  }

  return primary;
}

function resolveConfigFileForRead(options: PathOptions = {}): string {
  const primary = configFilePath(getDefaultConfigDir(options));
  if (existsSync(primary)) {
    return primary;
  }

  const legacy = configFilePath(getLegacyConfigDir(options));
  const env = options.env ?? process.env;
  const hasExplicitConfigDir = Boolean(env.SKILL_SYNC_CONFIG_DIR || env.CSM_CONFIG_DIR);
  if (!hasExplicitConfigDir && legacy !== primary && existsSync(legacy)) {
    return legacy;
  }

  return primary;
}

function resolveUserPath(input: string, options: InitConfigOptions): string {
  return path.resolve(expandHome(input, options.homeDir));
}

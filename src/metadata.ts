import { existsSync } from "node:fs";
import type { RepoSettings, SkillRecord, SkillsMetadata } from "./types.js";
import { repoSettingsPath, repoSkillsMetadataPath, repoUsageEventsPath } from "./paths.js";
import { readJsonFile, writeJsonFile } from "./json.js";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

type PersistedSkillRecord = Omit<SkillRecord, "status"> & {
  status?: unknown;
  archivedAt?: unknown;
};

type PersistedSkillsMetadata = {
  schemaVersion: 1;
  skills: PersistedSkillRecord[];
};

export type LegacyArchiveCleanupResult = {
  removedArchiveDir: boolean;
  removedSkillIds: string[];
};

export function emptySkillsMetadata(): SkillsMetadata {
  return { schemaVersion: 1, skills: [] };
}

export async function ensureRepoMetadata(syncRepo: string): Promise<void> {
  const now = new Date().toISOString();
  await mkdir(path.join(syncRepo, "skills"), { recursive: true });
  await mkdir(path.join(syncRepo, "metadata"), { recursive: true });
  await ensureGitignore(syncRepo);

  if (!existsSync(repoSettingsPath(syncRepo))) {
    const settings: RepoSettings = {
      schemaVersion: 1,
      createdAt: now,
      updatedAt: now
    };
    await writeJsonFile(repoSettingsPath(syncRepo), settings);
  }

  if (!existsSync(repoSkillsMetadataPath(syncRepo))) {
    await writeJsonFile(repoSkillsMetadataPath(syncRepo), emptySkillsMetadata());
  }

  if (!existsSync(repoUsageEventsPath(syncRepo))) {
    await writeFile(repoUsageEventsPath(syncRepo), "", "utf8");
  }
}

async function ensureGitignore(syncRepo: string): Promise<void> {
  const gitignorePath = path.join(syncRepo, ".gitignore");
  const localCachePattern = ".skill-sync/";
  const legacyLocalCachePattern = ".codex-skill-manager/";

  if (!existsSync(gitignorePath)) {
    await writeFile(gitignorePath, `${localCachePattern}\n${legacyLocalCachePattern}\n`, "utf8");
    return;
  }

  const current = await readFile(gitignorePath, "utf8");
  const lines = current.split(/\r?\n/).map((line) => line.trim());
  const missingPatterns = [localCachePattern, legacyLocalCachePattern].filter((pattern) => !lines.includes(pattern));
  if (missingPatterns.length === 0) {
    return;
  }

  const separator = current.endsWith("\n") || current.length === 0 ? "" : "\n";
  await writeFile(gitignorePath, `${current}${separator}${missingPatterns.join("\n")}\n`, "utf8");
}

export async function readSkillsMetadata(syncRepo: string): Promise<SkillsMetadata> {
  if (!existsSync(repoSkillsMetadataPath(syncRepo))) {
    return emptySkillsMetadata();
  }

  const metadata = await readJsonFile<PersistedSkillsMetadata>(repoSkillsMetadataPath(syncRepo));
  if (metadata.schemaVersion !== 1 || !Array.isArray(metadata.skills)) {
    throw new Error(`Invalid skills metadata at ${repoSkillsMetadataPath(syncRepo)}.`);
  }

  return {
    schemaVersion: 1,
    skills: metadata.skills
      .filter((candidate) => candidate.status !== "archived")
      .map(normalizeManagedRecord)
  };
}

export async function cleanupLegacyArchiveArtifacts(syncRepo: string): Promise<LegacyArchiveCleanupResult> {
  const archiveDir = path.join(syncRepo, "archive");
  const metadataPath = repoSkillsMetadataPath(syncRepo);
  const removedArchiveDir = existsSync(archiveDir);

  await rm(archiveDir, { recursive: true, force: true });

  if (!existsSync(metadataPath)) {
    return { removedArchiveDir, removedSkillIds: [] };
  }

  const metadata = await readJsonFile<PersistedSkillsMetadata>(metadataPath);
  if (metadata.schemaVersion !== 1 || !Array.isArray(metadata.skills)) {
    return { removedArchiveDir, removedSkillIds: [] };
  }

  const removedSkillIds = metadata.skills
    .filter((record) => record.status === "archived")
    .map((record) => record.id)
    .filter((id): id is string => typeof id === "string");
  const cleaned = metadata.skills.filter((record) => record.status !== "archived").map(normalizeManagedRecord);

  const isChanged =
    cleaned.length !== metadata.skills.length ||
    cleaned.some((record, index) => {
      const original = metadata.skills[index];
      return record.id !== original?.id || record.status !== original?.status || record.lastUsedAt !== (original?.lastUsedAt ?? null) || Boolean(original && "archivedAt" in original);
    });
  if (!isChanged) {
    return { removedArchiveDir, removedSkillIds };
  }

  await writeSkillsMetadata(syncRepo, { schemaVersion: 1, skills: cleaned });
  return { removedArchiveDir, removedSkillIds };
}

export async function writeSkillsMetadata(syncRepo: string, metadata: SkillsMetadata): Promise<void> {
  const cleaned: SkillsMetadata = {
    schemaVersion: 1,
    skills: metadata.skills.map(normalizeManagedRecord).sort((a, b) => a.id.localeCompare(b.id))
  };
  await writeJsonFile(repoSkillsMetadataPath(syncRepo), cleaned);
}

export async function upsertSkillRecord(syncRepo: string, record: SkillRecord): Promise<void> {
  const metadata = await readSkillsMetadata(syncRepo);
  const index = metadata.skills.findIndex((skill) => skill.id === record.id);
  if (index === -1) {
    metadata.skills.push(record);
  } else {
    metadata.skills[index] = record;
  }
  await writeSkillsMetadata(syncRepo, metadata);
}

function normalizeManagedRecord(candidate: PersistedSkillRecord): SkillRecord {
  const { archivedAt: _archivedAt, ...record } = candidate;
  return {
    ...record,
    status: "managed",
    lastUsedAt: record.lastUsedAt ?? null
  } as SkillRecord;
}

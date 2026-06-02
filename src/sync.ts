import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { LocalConfig, LocalSkillSource, SkillRecord, SkillsMetadata } from "./types.js";
import { buildStatusReport } from "./status.js";
import { importLocalSkill } from "./importSkill.js";
import { gitAdd, gitBranchSyncStatus, gitCommit, gitHasStagedChanges, gitPull, gitPush, gitRemotes, gitStatus, runGit, type GitBranchSyncStatus } from "./git.js";
import { cleanupLegacyArchiveArtifacts, writeSkillsMetadata } from "./metadata.js";
import { readSkillFrontmatter } from "./frontmatter.js";
import { hashDirectory } from "./hash.js";
import { copySkillDirectory } from "./copy.js";
import { deriveSyncState } from "./status.js";
import { repoSettingsPath, repoSkillsDir, repoSkillsMetadataPath, repoUsageEventsPath, resolveSkillPath, validateSkillId } from "./paths.js";

export type SyncSelection = {
  skillId: string;
  source?: LocalSkillSource;
};

export type SyncResult = {
  skillIds: string[];
  updatedRepoSkillIds: string[];
  committed: boolean;
  pushed: boolean;
  commitHash: string | null;
  commitMessage: string;
  gitStatus: string;
};

export type PullRepositoryResult = {
  pulled: true;
  preSync: SyncResult | null;
  gitStatus: string;
  gitBranchStatus: GitBranchSyncStatus;
};

export type RepositoryConflictSource = "github" | "syncRepo" | LocalSkillSource;

export type RepositoryConflictVersion = {
  source: RepositoryConflictSource;
  label: string;
  path: string;
  exists: boolean;
  content: string | null;
};

export type RepositorySkillConflict = {
  skillId: string;
  files: string[];
  versions: RepositoryConflictVersion[];
};

export type RepositoryConflictsResult = {
  gitBranchStatus: GitBranchSyncStatus;
  conflicts: RepositorySkillConflict[];
};

export type RepositoryConflictResolution = {
  skillId: string;
  source: RepositoryConflictSource;
};

type PreparedSkill = {
  id: string;
  source?: LocalSkillSource;
  state: SkillRecord["syncState"] | "unmanaged";
  updateRepoFromLocal: boolean;
};

let syncGate: Promise<void> = Promise.resolve();

async function withSyncLock<T>(task: () => Promise<T>): Promise<T> {
  const next = syncGate.then(() => task());
  syncGate = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

export async function syncSelectedSkills(config: LocalConfig, selections: SyncSelection[]): Promise<SyncResult> {
  return withSyncLock(() => syncSelectedSkillsNow(config, selections));
}

export async function syncSingleSkill(config: LocalConfig, skillId: string): Promise<SyncResult> {
  return withSyncLock(() => syncSingleSkillNow(config, skillId));
}

async function syncSingleSkillNow(config: LocalConfig, skillId: string): Promise<SyncResult> {
  const id = validateSkillId(skillId);
  await requireGitRemote(config.syncRepo);

  const cleanup = await cleanupLegacyArchiveArtifacts(config.syncRepo);
  await gitAdd(config.syncRepo, stagePaths(config.syncRepo, [id], cleanup.removedArchiveDir));
  const committed = await gitHasStagedChanges(config.syncRepo);
  const commitHash = committed ? await gitCommit(config.syncRepo, buildSyncSkillCommitMessage(id)) : null;

  await gitPush(config.syncRepo);

  return {
    skillIds: [id],
    updatedRepoSkillIds: [id],
    committed,
    pushed: true,
    commitHash,
    commitMessage: buildSyncSkillCommitMessage(id),
    gitStatus: await gitStatus(config.syncRepo)
  };
}

function buildSyncSkillCommitMessage(skillId: string): string {
  return [
    `Sync skill: ${skillId}`,
    "",
    "Synced selected skill content and repository metadata.",
    `- ${skillId}`
  ].join("\n");
}

async function syncSelectedSkillsNow(config: LocalConfig, selections: SyncSelection[]): Promise<SyncResult> {
  if (selections.length === 0) {
    return syncRepositoryChangesNow(config);
  }

  const prepared = await prepareSelections(config, selections);
  await requireGitRemote(config.syncRepo);

  const updatedRepoSkillIds: string[] = [];

  for (const skill of prepared) {
    if (!skill.updateRepoFromLocal) {
      continue;
    }

    await importLocalSkill(config, skill.id, { force: true, source: skill.source });
    updatedRepoSkillIds.push(skill.id);
  }

  const skillIds = prepared.map((skill) => skill.id);
  const cleanup = await cleanupLegacyArchiveArtifacts(config.syncRepo);
  await gitAdd(config.syncRepo, stagePaths(config.syncRepo, skillIds, cleanup.removedArchiveDir));

  const commitMessage = buildCommitMessage(skillIds, updatedRepoSkillIds);
  const committed = await gitHasStagedChanges(config.syncRepo);
  const commitHash = committed ? await gitCommit(config.syncRepo, commitMessage) : null;

  await gitPush(config.syncRepo);

  return {
    skillIds,
    updatedRepoSkillIds,
    committed,
    pushed: true,
    commitHash,
    commitMessage,
    gitStatus: await gitStatus(config.syncRepo)
  };
}

export async function syncRepositoryChanges(config: LocalConfig): Promise<SyncResult> {
  return withSyncLock(() => syncRepositoryChangesNow(config));
}

export async function pullRepositoryChanges(config: LocalConfig): Promise<PullRepositoryResult> {
  return withSyncLock(() => pullRepositoryChangesNow(config));
}

export async function listRepositoryConflicts(config: LocalConfig): Promise<RepositoryConflictsResult> {
  return withSyncLock(() => listRepositoryConflictsNow(config));
}

export async function resolveRepositoryConflicts(config: LocalConfig, resolutions: RepositoryConflictResolution[]): Promise<PullRepositoryResult> {
  return withSyncLock(() => resolveRepositoryConflictsNow(config, resolutions));
}

async function pullRepositoryChangesNow(config: LocalConfig): Promise<PullRepositoryResult> {
  const statusBeforePull = await gitStatus(config.syncRepo);
  const preSync = statusBeforePull.trim() ? await syncRepositoryChangesNow(config) : null;
  const remainingStatus = await gitStatus(config.syncRepo);
  if (remainingStatus.trim()) {
    throw new Error(`Cannot pull: sync repo has local uncommitted changes.\n${remainingStatus}`);
  }

  const branchStatus = await gitBranchSyncStatus(config.syncRepo, { fetch: true });

  if (branchStatus.state === "behind") {
    await gitPull(config.syncRepo);
    await syncRepositoryChangesNow(config);
  } else if (branchStatus.state === "ahead") {
    await gitPush(config.syncRepo);
  } else if (branchStatus.state === "diverged") {
    if (!branchStatus.upstream) {
      throw new Error("Cannot resolve sync conflict because no upstream branch is configured.");
    }
    await mergeRemoteRepositoryChanges(config, branchStatus.upstream);
  } else if (branchStatus.state === "no-upstream" || branchStatus.state === "unknown") {
    await gitPull(config.syncRepo);
  }

  return {
    pulled: true,
    preSync,
    gitStatus: await gitStatus(config.syncRepo),
    gitBranchStatus: await gitBranchSyncStatus(config.syncRepo)
  };
}

async function listRepositoryConflictsNow(config: LocalConfig): Promise<RepositoryConflictsResult> {
  const gitBranchStatus = await gitBranchSyncStatus(config.syncRepo, { fetch: true });
  if (gitBranchStatus.state !== "diverged" || !gitBranchStatus.upstream) {
    return { gitBranchStatus, conflicts: [] };
  }

  const conflictPaths = await previewMergeConflictPaths(config.syncRepo, gitBranchStatus.upstream);
  const conflicts = await buildRepositorySkillConflicts(config, gitBranchStatus.upstream, conflictPaths);
  return { gitBranchStatus, conflicts };
}

async function resolveRepositoryConflictsNow(config: LocalConfig, resolutions: RepositoryConflictResolution[]): Promise<PullRepositoryResult> {
  const normalizedResolutions = normalizeRepositoryConflictResolutions(resolutions);
  const statusBeforePull = await gitStatus(config.syncRepo);
  const preSync = statusBeforePull.trim() ? await syncRepositoryChangesNow(config) : null;
  const remainingStatus = await gitStatus(config.syncRepo);
  if (remainingStatus.trim()) {
    throw new Error(`Cannot resolve repository conflicts: sync repo has local uncommitted changes.\n${remainingStatus}`);
  }

  const gitBranchStatus = await gitBranchSyncStatus(config.syncRepo, { fetch: true });
  if (gitBranchStatus.state !== "diverged" || !gitBranchStatus.upstream) {
    throw new Error("No repository conflict is waiting for resolution.");
  }

  const detected = await buildRepositorySkillConflicts(config, gitBranchStatus.upstream, await previewMergeConflictPaths(config.syncRepo, gitBranchStatus.upstream));
  const detectedSkillIds = new Set(detected.map((conflict) => conflict.skillId));
  const missingSelections = [...detectedSkillIds].filter((skillId) => !normalizedResolutions.has(skillId));
  if (missingSelections.length > 0) {
    throw new Error(`Choose a version for every conflicted skill: ${missingSelections.join(", ")}.`);
  }

  const localMetadata = await readSkillsMetadataAtRef(config.syncRepo, "HEAD");
  const remoteMetadata = await readSkillsMetadataAtRef(config.syncRepo, gitBranchStatus.upstream);
  const mergedMetadata = mergeSkillsMetadata(localMetadata, remoteMetadata);
  const usageEvents = mergeJsonl(
    await readTextAtRef(config.syncRepo, gitBranchStatus.upstream, "metadata/usage-events.jsonl"),
    await readTextAtRef(config.syncRepo, "HEAD", "metadata/usage-events.jsonl")
  );
  const materializedSources = await materializeRepositoryResolutionSources(config, gitBranchStatus.upstream, [...normalizedResolutions.values()]);

  try {
    try {
      await runGit(config.syncRepo, withSkillSyncGitIdentity(["merge", "--no-ff", "--no-commit", gitBranchStatus.upstream]));
    } catch (error) {
      if (!(await isMergeInProgress(config.syncRepo))) {
        throw error;
      }
    }

    const statusAfterMerge = await gitStatus(config.syncRepo);
    const unresolvedPaths = conflictedPaths(statusAfterMerge);
    const unhandledConflicts = unresolvedPaths.filter((filePath) => {
      if (isAutoResolvableRepositoryConflict(filePath)) {
        return false;
      }

      const skillId = skillIdFromConflictPath(filePath, detectedSkillIds);
      return !skillId || !normalizedResolutions.has(skillId);
    });
    if (unhandledConflicts.length > 0) {
      await abortMerge(config.syncRepo);
      throw new Error(`Cannot resolve repository conflict. Review these paths manually: ${unhandledConflicts.join(", ")}.`);
    }

    await writeSkillsMetadata(config.syncRepo, mergedMetadata);
    await writeFile(repoUsageEventsPath(config.syncRepo), usageEvents, "utf8");
    for (const resolution of normalizedResolutions.values()) {
      await applyRepositoryConflictResolution(config, resolution, materializedSources, mergedMetadata);
    }

    await writeSkillsMetadata(config.syncRepo, mergedMetadata);
    const cleanup = await cleanupLegacyArchiveArtifacts(config.syncRepo);
    await gitAdd(config.syncRepo, [".gitignore", "metadata", "skills", ...(cleanup.removedArchiveDir ? ["archive"] : [])]);
    const committed = await gitHasStagedChanges(config.syncRepo);
    if (committed) {
      await gitCommit(config.syncRepo, buildRepositoryConflictResolutionCommitMessage([...normalizedResolutions.values()]));
    }
    await gitPush(config.syncRepo);
  } finally {
    await cleanupMaterializedSources(config.syncRepo, materializedSources);
  }

  return {
    pulled: true,
    preSync,
    gitStatus: await gitStatus(config.syncRepo),
    gitBranchStatus: await gitBranchSyncStatus(config.syncRepo)
  };
}

async function mergeRemoteRepositoryChanges(config: LocalConfig, upstream: string): Promise<void> {
  const localMetadata = await readSkillsMetadataAtRef(config.syncRepo, "HEAD");
  const remoteMetadata = await readSkillsMetadataAtRef(config.syncRepo, upstream);
  const usageEvents = mergeJsonl(
    await readTextAtRef(config.syncRepo, upstream, "metadata/usage-events.jsonl"),
    await readTextAtRef(config.syncRepo, "HEAD", "metadata/usage-events.jsonl")
  );

  try {
    await runGit(config.syncRepo, withSkillSyncGitIdentity(["merge", "--no-ff", "--no-commit", upstream]));
  } catch (error) {
    if (!(await isMergeInProgress(config.syncRepo))) {
      throw error;
    }
  }

  const statusAfterMerge = await gitStatus(config.syncRepo);
  const unhandledConflicts = conflictedPaths(statusAfterMerge).filter((filePath) => !isAutoResolvableRepositoryConflict(filePath));
  if (unhandledConflicts.length > 0) {
    await abortMerge(config.syncRepo);
    throw new Error(`Cannot auto-resolve sync conflict. Review these paths manually: ${unhandledConflicts.join(", ")}.`);
  }

  await writeSkillsMetadata(config.syncRepo, mergeSkillsMetadata(localMetadata, remoteMetadata));
  await writeFile(repoUsageEventsPath(config.syncRepo), usageEvents, "utf8");
  const cleanup = await cleanupLegacyArchiveArtifacts(config.syncRepo);
  await gitAdd(config.syncRepo, [".gitignore", "metadata", "skills", ...(cleanup.removedArchiveDir ? ["archive"] : [])]);

  const committed = await gitHasStagedChanges(config.syncRepo);
  if (committed) {
    await gitCommit(
      config.syncRepo,
      [
        "Merge remote sync repository changes",
        "",
        "Merged remote skill updates, usage records, and repository metadata.",
        "Removed legacy skill archive artifacts."
      ].join("\n")
    );
  }

  await gitPush(config.syncRepo);
}

async function syncRepositoryChangesNow(config: LocalConfig): Promise<SyncResult> {
  await requireGitRemote(config.syncRepo);

  const cleanup = await cleanupLegacyArchiveArtifacts(config.syncRepo);
  const statusBeforeStage = await gitStatus(config.syncRepo);
  await gitAdd(config.syncRepo, [".gitignore", "metadata", "skills", ...(cleanup.removedArchiveDir ? ["archive"] : [])]);

  const commitMessage = buildRepositoryCommitMessage(statusBeforeStage);
  const committed = await gitHasStagedChanges(config.syncRepo);
  const commitHash = committed ? await gitCommit(config.syncRepo, commitMessage) : null;

  await gitPush(config.syncRepo);

  return {
    skillIds: [],
    updatedRepoSkillIds: [],
    committed,
    pushed: true,
    commitHash,
    commitMessage,
    gitStatus: await gitStatus(config.syncRepo)
  };
}

async function prepareSelections(config: LocalConfig, selections: SyncSelection[]): Promise<PreparedSkill[]> {
  if (selections.length === 0) {
    throw new Error("Select at least one skill before syncing.");
  }

  const normalized = normalizeSelections(selections);
  const report = await buildStatusReport(config);
  const managedById = new Map(report.managed.map((skill) => [skill.id, skill]));
  const unmanagedByKey = new Map(report.unmanagedLocal.map((skill) => [selectionKey(skill.id, skill.source), skill]));
  const repoOnlyIds = new Set(report.repoOnly.map((skill) => skill.id));
  const blocked: string[] = [];
  const prepared: PreparedSkill[] = [];

  for (const selection of normalized) {
    const managed = managedById.get(selection.skillId);
    if (managed) {
      const source = selection.source ?? managed.localSource ?? undefined;
      const state = managed.syncState;

      if (state === "clean") {
        prepared.push({ id: managed.id, source, state, updateRepoFromLocal: false });
      } else if (state === "local_modified" || state === "missing_repo") {
        prepared.push({ id: managed.id, source, state, updateRepoFromLocal: true });
      } else {
        blocked.push(`${managed.id} is ${state}`);
      }
      continue;
    }

    const unmanaged = selection.source ? unmanagedByKey.get(selectionKey(selection.skillId, selection.source)) : findUnmanagedById(report.unmanagedLocal, selection.skillId);
    if (unmanaged) {
      prepared.push({
        id: unmanaged.id,
        source: unmanaged.source === "codex" || unmanaged.source === "agents" ? unmanaged.source : undefined,
        state: "unmanaged",
        updateRepoFromLocal: true
      });
      continue;
    }

    if (repoOnlyIds.has(selection.skillId)) {
      blocked.push(`${selection.skillId} exists only in the sync repo`);
      continue;
    }

    blocked.push(`${selection.skillId} was not found`);
  }

  if (blocked.length > 0) {
    throw new Error(`Cannot sync selected skills: ${blocked.join("; ")}.`);
  }

  return prepared;
}

async function requireGitRemote(syncRepo: string): Promise<void> {
  const remotes = await gitRemotes(syncRepo);
  if (remotes.length === 0) {
    throw new Error("No Git remote is configured for the sync repository. Add a remote before syncing.");
  }
}

function findUnmanagedById(skills: Array<{ id: string; source: string }>, skillId: string): { id: string; source: string } | undefined {
  const matches = skills.filter((skill) => skill.id === skillId);
  if (matches.length > 1) {
    throw new Error(`Select a source for ${skillId}; it exists in multiple local skill roots.`);
  }

  return matches[0];
}

function normalizeSelections(selections: SyncSelection[]): SyncSelection[] {
  const byId = new Map<string, SyncSelection>();

  for (const selection of selections) {
    const skillId = validateSkillId(selection.skillId);
    if (selection.source && selection.source !== "codex" && selection.source !== "agents") {
      throw new Error("Skill source must be codex or agents.");
    }

    const existing = byId.get(skillId);
    if (existing && existing.source !== selection.source) {
      throw new Error(`Select only one local source for ${skillId}.`);
    }

    byId.set(skillId, { skillId, source: selection.source });
  }

  return [...byId.values()].sort((a, b) => a.skillId.localeCompare(b.skillId));
}

function stagePaths(syncRepo: string, skillIds: string[], includeLegacyArchiveDeletion = false): string[] {
  const paths = new Set<string>([
    ".gitignore",
    relativeToRepo(syncRepo, repoSettingsPath(syncRepo)),
    relativeToRepo(syncRepo, repoSkillsMetadataPath(syncRepo)),
    relativeToRepo(syncRepo, repoUsageEventsPath(syncRepo))
  ]);

  for (const skillId of skillIds) {
    paths.add(path.join("skills", ...skillId.split("/")));
  }

  if (includeLegacyArchiveDeletion) {
    paths.add("archive");
  }

  return [...paths];
}

function relativeToRepo(syncRepo: string, targetPath: string): string {
  return path.relative(syncRepo, targetPath).split(path.sep).join("/");
}

function buildCommitMessage(skillIds: string[], updatedRepoSkillIds: string[]): string {
  const subject =
    skillIds.length === 1 ? `Sync skill: ${skillIds[0]}` : `Sync ${skillIds.length} skills: ${skillIds.slice(0, 3).join(", ")}${skillIds.length > 3 ? ", ..." : ""}`;
  const lines = [
    subject,
    "",
    "Synced skills:",
    ...skillIds.map((skillId) => `- ${skillId}`),
    "",
    updatedRepoSkillIds.length > 0 ? "Updated repo copies from local skills." : "No local skill content changed; pushed existing sync repo state."
  ];

  return lines.join("\n");
}

function buildRepositoryCommitMessage(status: string): string {
  const changedLines = status
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const lines = [
    "Sync repository changes",
    "",
    "Synced repository metadata and usage records.",
    ""
  ];

  if (changedLines.length > 0) {
    lines.push("Git changes:");
    lines.push(...changedLines.slice(0, 24).map((line) => `- ${line}`));
    if (changedLines.length > 24) {
      lines.push(`- ... ${changedLines.length - 24} more`);
    }
  } else {
    lines.push("No local repository changes were detected before staging.");
  }

  return lines.join("\n");
}

function selectionKey(skillId: string, source: string): string {
  return `${source}:${skillId}`;
}

async function readSkillsMetadataAtRef(syncRepo: string, ref: string): Promise<SkillsMetadata> {
  const raw = await readTextAtRef(syncRepo, ref, "metadata/skills.json");
  if (!raw.trim()) {
    return { schemaVersion: 1, skills: [] };
  }

  const parsed = JSON.parse(raw) as { schemaVersion?: unknown; skills?: unknown };
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.skills)) {
    return { schemaVersion: 1, skills: [] };
  }

  return {
    schemaVersion: 1,
    skills: parsed.skills
      .map(toManagedSkillRecord)
      .filter((record): record is SkillRecord => record !== null)
      .sort((a, b) => a.id.localeCompare(b.id))
  };
}

async function readTextAtRef(syncRepo: string, ref: string, relativePath: string): Promise<string> {
  try {
    const { stdout } = await runGit(syncRepo, ["show", `${ref}:${relativePath}`]);
    return stdout;
  } catch {
    return "";
  }
}

function mergeSkillsMetadata(local: SkillsMetadata, remote: SkillsMetadata): SkillsMetadata {
  const merged = new Map<string, SkillRecord>();

  for (const record of local.skills) {
    merged.set(record.id, record);
  }

  for (const record of remote.skills) {
    const previous = merged.get(record.id);
    merged.set(record.id, mergeSkillRecord(previous, record));
  }

  return {
    schemaVersion: 1,
    skills: [...merged.values()].sort((a, b) => a.id.localeCompare(b.id))
  };
}

function mergeSkillRecord(local: SkillRecord | undefined, remote: SkillRecord): SkillRecord {
  if (!local) {
    return remote;
  }

  return {
    ...remote,
    lastUsedAt: maxIsoTimestamp(local.lastUsedAt, remote.lastUsedAt)
  };
}

function mergeJsonl(...contents: string[]): string {
  const lines: string[] = [];
  const seen = new Set<string>();

  for (const content of contents) {
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || seen.has(line)) {
        continue;
      }
      seen.add(line);
      lines.push(line);
    }
  }

  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

function toManagedSkillRecord(candidate: unknown): SkillRecord | null {
  if (!candidate || typeof candidate !== "object") {
    return null;
  }

  const record = candidate as Partial<Omit<SkillRecord, "status">> & { status?: unknown; archivedAt?: unknown };
  if (record.status === "archived" || typeof record.id !== "string") {
    return null;
  }

  const { archivedAt: _archivedAt, ...cleaned } = record;
  return {
    ...cleaned,
    status: "managed",
    lastUsedAt: typeof cleaned.lastUsedAt === "string" ? cleaned.lastUsedAt : null
  } as SkillRecord;
}

function maxIsoTimestamp(left: string | null | undefined, right: string | null | undefined): string | null {
  if (!left) {
    return right ?? null;
  }
  if (!right) {
    return left;
  }

  return new Date(left).getTime() >= new Date(right).getTime() ? left : right;
}

function conflictedPaths(status: string): string[] {
  return status
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => isConflictStatus(line.slice(0, 2)))
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}

function isConflictStatus(status: string): boolean {
  return status.includes("U") || status === "AA" || status === "DD";
}

function isAutoResolvableRepositoryConflict(filePath: string): boolean {
  return filePath === "metadata/skills.json" || filePath === "metadata/usage-events.jsonl" || filePath.startsWith("archive/");
}

async function isMergeInProgress(syncRepo: string): Promise<boolean> {
  try {
    await runGit(syncRepo, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
    return true;
  } catch {
    return false;
  }
}

async function abortMerge(syncRepo: string): Promise<void> {
  try {
    await runGit(syncRepo, ["merge", "--abort"]);
  } catch {
    // Best effort. The next git command will surface any remaining repository state.
  }
}

function normalizeRepositoryConflictResolutions(resolutions: RepositoryConflictResolution[]): Map<string, RepositoryConflictResolution> {
  if (resolutions.length === 0) {
    throw new Error("Choose at least one skill version before resolving repository conflicts.");
  }

  const normalized = new Map<string, RepositoryConflictResolution>();
  for (const resolution of resolutions) {
    const skillId = validateSkillId(resolution.skillId);
    if (!isRepositoryConflictSource(resolution.source)) {
      throw new Error("Repository conflict source must be github, syncRepo, codex, or agents.");
    }
    normalized.set(skillId, { skillId, source: resolution.source });
  }

  return normalized;
}

function isRepositoryConflictSource(value: unknown): value is RepositoryConflictSource {
  return value === "github" || value === "syncRepo" || value === "codex" || value === "agents";
}

async function previewMergeConflictPaths(syncRepo: string, upstream: string): Promise<string[]> {
  const tempDir = await mkdtemp(path.join(tmpdir(), "csm-merge-preview-"));

  try {
    await runGit(syncRepo, ["worktree", "add", "--detach", tempDir, "HEAD"]);
    try {
      await runGit(tempDir, withSkillSyncGitIdentity(["merge", "--no-ff", "--no-commit", upstream]));
    } catch {
      // Conflicts are expected; inspect the preview worktree status below.
    }
    return conflictedPaths(await gitStatus(tempDir));
  } finally {
    await removeWorktree(syncRepo, tempDir);
  }
}

function withSkillSyncGitIdentity(args: string[]): string[] {
  return ["-c", "user.name=Skill Sync", "-c", "user.email=skill-sync@local", ...args];
}

async function buildRepositorySkillConflicts(config: LocalConfig, upstream: string, conflictPaths: string[]): Promise<RepositorySkillConflict[]> {
  const grouped = new Map<string, string[]>();

  for (const conflictPath of conflictPaths) {
    const skillId = await detectSkillIdForConflictPath(config.syncRepo, upstream, conflictPath);
    if (!skillId) {
      continue;
    }

    grouped.set(skillId, [...(grouped.get(skillId) ?? []), conflictPath]);
  }

  const conflicts: RepositorySkillConflict[] = [];
  for (const [skillId, files] of [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    conflicts.push({
      skillId,
      files: files.sort(),
      versions: await buildRepositoryConflictVersions(config, upstream, skillId)
    });
  }

  return conflicts;
}

async function detectSkillIdForConflictPath(syncRepo: string, upstream: string, conflictPath: string): Promise<string | null> {
  const normalized = conflictPath.split(path.sep).join("/");
  if (!normalized.startsWith("skills/")) {
    return null;
  }

  const parts = normalized.slice("skills/".length).split("/").filter(Boolean);
  for (let length = parts.length; length >= 1; length -= 1) {
    const candidate = parts.slice(0, length).join("/");
    if (await skillExistsAtRef(syncRepo, "HEAD", candidate) || (await skillExistsAtRef(syncRepo, upstream, candidate))) {
      return candidate;
    }
  }

  return parts[0] ?? null;
}

function skillIdFromConflictPath(conflictPath: string, skillIds: Set<string>): string | null {
  const normalized = conflictPath.split(path.sep).join("/");
  if (!normalized.startsWith("skills/")) {
    return null;
  }

  const relative = normalized.slice("skills/".length);
  const matches = [...skillIds].filter((skillId) => relative === skillId || relative.startsWith(`${skillId}/`));
  return matches.sort((a, b) => b.length - a.length)[0] ?? null;
}

async function skillExistsAtRef(syncRepo: string, ref: string, skillId: string): Promise<boolean> {
  return (await readTextAtRef(syncRepo, ref, path.join("skills", ...skillId.split("/"), "SKILL.md").split(path.sep).join("/"))).trim().length > 0;
}

async function buildRepositoryConflictVersions(config: LocalConfig, upstream: string, skillId: string): Promise<RepositoryConflictVersion[]> {
  const syncRepoPath = path.join("skills", ...skillId.split("/"), "SKILL.md").split(path.sep).join("/");
  const codexPath = resolveSkillPath(config.codexSkillsDir, skillId);
  const agentsPath = resolveSkillPath(config.agentsSkillsDir, skillId);
  const codexSkillMdPath = path.join(codexPath, "SKILL.md");
  const agentsSkillMdPath = path.join(agentsPath, "SKILL.md");
  const githubContent = await readTextAtRef(config.syncRepo, upstream, syncRepoPath);
  const syncRepoContent = await readTextAtRef(config.syncRepo, "HEAD", syncRepoPath);

  return [
    {
      source: "github",
      label: "GitHub version",
      path: `${upstream}:${syncRepoPath}`,
      exists: githubContent.trim().length > 0,
      content: githubContent.trim().length > 0 ? githubContent : null
    },
    {
      source: "syncRepo",
      label: "Sync repo local version",
      path: `HEAD:${syncRepoPath}`,
      exists: syncRepoContent.trim().length > 0,
      content: syncRepoContent.trim().length > 0 ? syncRepoContent : null
    },
    {
      source: "codex",
      label: "Codex installed copy",
      path: codexSkillMdPath,
      exists: existsSync(codexSkillMdPath),
      content: existsSync(codexSkillMdPath) ? await readFile(codexSkillMdPath, "utf8") : null
    },
    {
      source: "agents",
      label: "Agents installed copy",
      path: agentsSkillMdPath,
      exists: existsSync(agentsSkillMdPath),
      content: existsSync(agentsSkillMdPath) ? await readFile(agentsSkillMdPath, "utf8") : null
    }
  ];
}

type MaterializedResolutionSources = {
  worktrees: string[];
  github: string | null;
  syncRepo: string | null;
};

async function materializeRepositoryResolutionSources(
  config: LocalConfig,
  upstream: string,
  resolutions: RepositoryConflictResolution[]
): Promise<MaterializedResolutionSources> {
  const materialized: MaterializedResolutionSources = { worktrees: [], github: null, syncRepo: null };
  const sources = new Set(resolutions.map((resolution) => resolution.source));

  if (sources.has("github")) {
    materialized.github = await addDetachedWorktree(config.syncRepo, upstream);
    materialized.worktrees.push(materialized.github);
  }

  if (sources.has("syncRepo")) {
    materialized.syncRepo = await addDetachedWorktree(config.syncRepo, "HEAD");
    materialized.worktrees.push(materialized.syncRepo);
  }

  return materialized;
}

async function addDetachedWorktree(syncRepo: string, ref: string): Promise<string> {
  const tempDir = await mkdtemp(path.join(tmpdir(), "csm-conflict-source-"));
  await runGit(syncRepo, ["worktree", "add", "--detach", tempDir, ref]);
  return tempDir;
}

async function cleanupMaterializedSources(syncRepo: string, materialized: MaterializedResolutionSources): Promise<void> {
  for (const worktree of materialized.worktrees) {
    await removeWorktree(syncRepo, worktree);
  }
}

async function removeWorktree(syncRepo: string, worktreePath: string): Promise<void> {
  try {
    await runGit(syncRepo, ["worktree", "remove", "--force", worktreePath]);
  } catch {
    await rm(worktreePath, { recursive: true, force: true });
  }
}

async function applyRepositoryConflictResolution(
  config: LocalConfig,
  resolution: RepositoryConflictResolution,
  materializedSources: MaterializedResolutionSources,
  metadata: SkillsMetadata
): Promise<void> {
  const sourcePath = sourcePathForRepositoryResolution(config, resolution, materializedSources);
  if (!sourcePath || !existsSync(path.join(sourcePath, "SKILL.md"))) {
    throw new Error(`Cannot use ${resolution.source} for ${resolution.skillId}: source copy is missing.`);
  }

  const repoPath = path.join(repoSkillsDir(config.syncRepo), ...resolution.skillId.split("/"));
  await replaceSkillDirectory(repoPath, sourcePath);
  const localSources = collectInstalledSources(config, resolution.skillId);
  for (const source of localSources) {
    await replaceSkillDirectory(resolveSkillPath(source === "codex" ? config.codexSkillsDir : config.agentsSkillsDir, resolution.skillId), repoPath);
  }

  const repoHash = await hashDirectory(repoPath);
  const currentLocalHash = await hashInstalledSources(config, resolution.skillId, localSources);
  const frontmatter = await readSkillFrontmatter(repoPath);
  const index = metadata.skills.findIndex((record) => record.id === resolution.skillId);
  const existing = index >= 0 ? metadata.skills[index] : null;
  const updated: SkillRecord = {
    ...(existing ?? {
      id: resolution.skillId,
      createdAt: new Date().toISOString(),
      lastUsedAt: null
    }),
    id: resolution.skillId,
    name: frontmatter.name,
    description: frontmatter.description,
    status: "managed",
    localSource: localSources.includes("codex") ? "codex" : localSources.includes("agents") ? "agents" : null,
    localSources,
    localCopiesDiffer: false,
    installed: localSources.length > 0,
    syncState: deriveSyncState(repoHash, currentLocalHash, repoHash),
    lastSyncedHash: repoHash,
    currentRepoHash: repoHash,
    currentLocalHash,
    updatedAt: new Date().toISOString()
  };

  if (index >= 0) {
    metadata.skills[index] = updated;
  } else {
    metadata.skills.push(updated);
  }
}

function sourcePathForRepositoryResolution(
  config: LocalConfig,
  resolution: RepositoryConflictResolution,
  materializedSources: MaterializedResolutionSources
): string | null {
  if (resolution.source === "github") {
    return materializedSources.github ? path.join(materializedSources.github, "skills", ...resolution.skillId.split("/")) : null;
  }

  if (resolution.source === "syncRepo") {
    return materializedSources.syncRepo ? path.join(materializedSources.syncRepo, "skills", ...resolution.skillId.split("/")) : null;
  }

  return resolveSkillPath(resolution.source === "codex" ? config.codexSkillsDir : config.agentsSkillsDir, resolution.skillId);
}

function collectInstalledSources(config: LocalConfig, skillId: string): LocalSkillSource[] {
  const sources: LocalSkillSource[] = [];
  if (existsSync(path.join(resolveSkillPath(config.codexSkillsDir, skillId), "SKILL.md"))) {
    sources.push("codex");
  }
  if (existsSync(path.join(resolveSkillPath(config.agentsSkillsDir, skillId), "SKILL.md"))) {
    sources.push("agents");
  }
  return sources;
}

async function hashInstalledSources(config: LocalConfig, skillId: string, sources: LocalSkillSource[]): Promise<string | null> {
  if (sources.length === 0) {
    return null;
  }

  const hashes = await Promise.all(sources.map((source) => hashDirectory(resolveSkillPath(source === "codex" ? config.codexSkillsDir : config.agentsSkillsDir, skillId))));
  const unique = [...new Set(hashes)];
  return unique.length === 1 ? unique[0] ?? null : null;
}

async function replaceSkillDirectory(targetPath: string, sourcePath: string): Promise<void> {
  await rm(targetPath, { recursive: true, force: true });
  await copySkillDirectory(sourcePath, targetPath);
}

function buildRepositoryConflictResolutionCommitMessage(resolutions: RepositoryConflictResolution[]): string {
  const skillIds = resolutions.map((resolution) => resolution.skillId).sort();
  return [
    skillIds.length === 1 ? `Resolve repo conflict: ${skillIds[0]}` : `Resolve ${skillIds.length} repo skill conflicts`,
    "",
    "Resolved Git repository skill conflicts by selecting canonical skill versions.",
    ...skillIds.map((skillId) => {
      const resolution = resolutions.find((candidate) => candidate.skillId === skillId);
      return `- ${skillId}: ${resolution?.source ?? "unknown"}`;
    })
  ].join("\n");
}

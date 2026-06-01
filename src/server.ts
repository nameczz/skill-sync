import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fastify from "fastify";
import fastifyStatic from "@fastify/static";
import type { LocalConfig, LocalSkillSource } from "./types.js";
import { tryLoadLocalConfig } from "./config.js";
import { initialize } from "./init.js";
import { buildStatusReport } from "./status.js";
import { selectDirectory, type DirectoryPicker } from "./directoryPicker.js";
import { gitBranchSyncStatus, gitStatus } from "./git.js";
import { importLocalSkill } from "./importSkill.js";
import { installRepoSkill } from "./installSkill.js";
import {
  listRepositoryConflicts,
  pullRepositoryChanges,
  resolveRepositoryConflicts,
  syncRepositoryChanges,
  syncSelectedSkills,
  type RepositoryConflictResolution,
  type RepositoryConflictSource,
  type SyncSelection
} from "./sync.js";
import { stopSyncingSkill } from "./stopSyncingSkill.js";
import { removeLocalSkill } from "./removeLocalSkill.js";
import { recordUsageEvent } from "./usage.js";
import { updateLocalSkill } from "./updateLocalSkill.js";
import { resolveConflict } from "./resolveConflict.js";
import {
  listCodexArchiveSessions,
  previewCodexArchiveSession,
  restoreCodexArchiveSession,
  unarchiveCodexArchiveSession,
  moveCodexArchiveSessionToTrash,
  validateCodexArchiveFileName
} from "./codexArchive.js";
import { createAutoSyncController } from "./autoSync.js";
import { createUsageMonitor } from "./usageMonitor.js";
import {
  getDefaultAgentsSkillsDir,
  getDefaultCacheDir,
  getDefaultCodexSkillsDir,
  resolveSkillPath,
  repoSkillsDir,
  validateSkillId
} from "./paths.js";

export type ServerOptions = {
  host?: string;
  port?: number;
  directoryPicker?: DirectoryPicker;
};

type SkillActionBody = {
  skillId?: string;
  source?: string;
  force?: boolean;
};

type SkillFileBody = SkillActionBody & {
  content?: unknown;
};

type InitBody = {
  syncRepo?: string;
  codexSkillsDir?: string;
  agentsSkillsDir?: string;
  cacheDir?: string;
};

type SelectDirectoryBody = {
  title?: string;
};

type SyncBody = {
  skills?: Array<{
    skillId?: string;
    source?: string;
  }>;
};

type SkillVersionsBody = {
  skillId?: string;
};

type StopSyncingBody = {
  skillId?: string;
  source?: string;
};

type CodexArchiveStateQuery = {
  state?: "active" | "trash";
};

type CodexArchiveActionBody = {
  state?: "active" | "trash";
  fileName?: string;
};

type ResolveConflictBody = {
  skillId?: string;
  strategy?: "codex" | "agents" | "repo";
};

type SkillVersionSource = "codex" | "agents" | "repo";

type SkillVersionPayload = {
  source: SkillVersionSource;
  path: string;
  exists: boolean;
  content: string | null;
};

type SkillVersionsPayload = {
  versions: SkillVersionPayload[];
};

type RepoConflictResolveBody = {
  resolutions?: Array<{
    skillId?: string;
    source?: string;
  }>;
};

type BulkActionBody = SyncBody & {
  endpoint?: string;
};

export async function startServer(options: ServerOptions = {}): Promise<{ url: string; close: () => Promise<void> }> {
  let config: LocalConfig | null = await tryLoadLocalConfig();
  const directoryPicker = options.directoryPicker ?? selectDirectory;
  const app = fastify({ logger: false });
  const autoSync = createAutoSyncController();
  const usageMonitor = createUsageMonitor();

  if (config) {
    await autoSync.start(config);
    await usageMonitor.start(config);
  }

  app.setErrorHandler((error, _request, reply) => {
    const normalized = normalizeError(error);
    reply.code(normalized.statusCode).send({
      error: normalized.message
    });
  });

  app.get("/api/health", async () => ({ ok: true }));

  app.get("/archive", async (_request, reply) => {
    reply.redirect("/codex-archive", 302);
  });

  app.get("/api/status", async () => {
    if (!config) {
      return {
        configured: false,
        defaults: {
          syncRepo: "",
          codexSkillsDir: getDefaultCodexSkillsDir(),
          agentsSkillsDir: getDefaultAgentsSkillsDir(),
          cacheDir: getDefaultCacheDir()
        }
      };
    }

    await usageMonitor.scanNow();
    const report = await buildStatusReport(config);
    return {
      configured: true,
      config,
      gitStatus: await gitStatus(config.syncRepo),
      gitBranchStatus: await gitBranchSyncStatus(config.syncRepo),
      report,
      autoSync: autoSync.getStatus(),
      usageMonitor: usageMonitor.getStatus()
    };
  });

  app.post<{ Body: InitBody }>("/api/init", async (request, reply) => {
    const syncRepo = optionalPath(request.body?.syncRepo);
    if (!syncRepo) {
      reply.code(400);
      return { error: "Choose a sync repository before initializing." };
    }

    const result = await initialize({
      syncRepo,
      codexSkillsDir: optionalPath(request.body?.codexSkillsDir),
      agentsSkillsDir: optionalPath(request.body?.agentsSkillsDir),
      cacheDir: optionalPath(request.body?.cacheDir)
    });
    config = result.config;
    await autoSync.start(config);
    await usageMonitor.start(config);
    return {
      configured: true,
      gitInitialized: result.gitInitialized,
      config: result.config,
      autoSync: autoSync.getStatus(),
      usageMonitor: usageMonitor.getStatus()
    };
  });

  app.put<{ Body: InitBody }>("/api/config", async (request) => {
    const loaded = requireConfig(config);
    const result = await initialize({
      syncRepo: optionalPath(request.body?.syncRepo) ?? loaded.syncRepo,
      codexSkillsDir: optionalPath(request.body?.codexSkillsDir) ?? loaded.codexSkillsDir,
      agentsSkillsDir: optionalPath(request.body?.agentsSkillsDir) ?? loaded.agentsSkillsDir,
      cacheDir: optionalPath(request.body?.cacheDir) ?? loaded.cacheDir,
      force: true
    });
    config = result.config;
    await autoSync.start(config);
    await usageMonitor.start(config);
    return {
      configured: true,
      gitInitialized: result.gitInitialized,
      config: result.config,
      gitStatus: await gitStatus(result.config.syncRepo),
      gitBranchStatus: await gitBranchSyncStatus(result.config.syncRepo),
      report: await buildStatusReport(result.config),
      autoSync: autoSync.getStatus(),
      usageMonitor: usageMonitor.getStatus()
    };
  });

  app.post<{ Body: SelectDirectoryBody }>("/api/select-directory", async (request) => {
    return directoryPicker(optionalTitle(request.body?.title));
  });

  app.post<{ Body: SkillActionBody }>("/api/import", async (request, reply) => {
    const loaded = requireConfig(config);
    const skillId = requireSkillId(request.body);
    const source = optionalLocalSource(request.body.source);
    const record = await importLocalSkill(loaded, skillId, { force: request.body.force, source });
    const result = await syncSelectedSkills(loaded, [{ skillId, source }]);
    reply.code(201);
    return { record, result };
  });

  app.post<{ Body: SkillActionBody }>("/api/install", async (request) => {
    const loaded = requireConfig(config);
    const skillId = requireSkillId(request.body);
    const source = optionalLocalSource(request.body.source);
    const { record, dependencyInstall } = await installRepoSkill(loaded, skillId, { force: request.body.force, source });
    const result = await syncRepositoryChanges(loaded);
    return { record, result, dependencyInstall };
  });

  app.post<{ Body: SkillActionBody }>("/api/update-local", async (request) => {
    const loaded = requireConfig(config);
    const skillId = requireSkillId(request.body);
    const source = optionalLocalSource(request.body.source);
    const { record, dependencyInstall } = await updateLocalSkill(loaded, skillId, { source });
    const result = await syncRepositoryChanges(loaded);
    return { record, result, dependencyInstall };
  });

  app.post<{ Body: SkillActionBody }>("/api/remove-local", async (request) => {
    const loaded = requireConfig(config);
    const skillId = requireSkillId(request.body);
    const source = optionalLocalSource(request.body.source);
    const record = await removeLocalSkill(loaded, skillId, { source });
    const result = await syncRepositoryChanges(loaded);
    return { record, result };
  });

  app.post<{ Body: ResolveConflictBody }>("/api/resolve-conflict", async (request) => {
    const loaded = requireConfig(config);
    const skillId = requireSkillId(request.body);
    const strategy = requireResolveStrategy(request.body?.strategy);
    const payload = await resolveConflict(loaded, skillId, { strategy });
    return payload;
  });

  app.post<{ Body: SkillVersionsBody }>("/api/skill-versions", async (request) => {
    const loaded = requireConfig(config);
    const skillId = requireSkillId(request.body);
    const versions = await buildSkillVersions(loaded, skillId);
    return { versions };
  });

  app.post<{ Body: StopSyncingBody }>("/api/stop-syncing", async (request) => {
    const loaded = requireConfig(config);
    const skillId = requireSkillId(request.body);
    optionalLocalSource(request.body?.source);
    const record = await stopSyncingSkill(loaded, skillId);
    const result = await syncRepositoryChanges(loaded);
    return { record, result };
  });

  app.get<{ Querystring: CodexArchiveStateQuery }>("/api/codex-archive", async (request) => {
    const state = request.query.state === "trash" ? "trash" : "active";
    const payload = await listCodexArchiveSessions(state);
    return payload;
  });

  app.post<{ Body: CodexArchiveActionBody }>("/api/codex-archive/preview", async (request) => {
    const state = request.body?.state === "trash" ? "trash" : "active";
    const fileName = requireArchiveFileName(request.body?.fileName);
    const payload = await previewCodexArchiveSession(state, fileName);
    return payload;
  });

  app.post<{ Body: CodexArchiveActionBody }>("/api/codex-archive/delete", async (request) => {
    const state = request.body?.state === "trash" ? "trash" : "active";
    if (state !== "active") {
      throw httpError(400, "Delete only supports state=active.");
    }
    const fileName = requireArchiveFileName(request.body?.fileName);
    const item = await moveCodexArchiveSessionToTrash(fileName);
    return { state: "trash", item };
  });

  app.post<{ Body: CodexArchiveActionBody }>("/api/codex-archive/restore", async (request) => {
    const state = request.body?.state === "active" ? "active" : "trash";
    if (state !== "trash") {
      throw httpError(400, "Restore only supports state=trash.");
    }
    const fileName = requireArchiveFileName(request.body?.fileName);
    const item = await restoreCodexArchiveSession(fileName);
    return { state: "active", item };
  });

  app.post<{ Body: CodexArchiveActionBody }>("/api/codex-archive/unarchive", async (request) => {
    const state = request.body?.state === "trash" ? "trash" : "active";
    if (state !== "active") {
      throw httpError(400, "Unarchive only supports state=active.");
    }
    const fileName = requireArchiveFileName(request.body?.fileName);
    const payload = await unarchiveCodexArchiveSession(fileName);
    return { state: "sessions", ...payload };
  });

  app.post<{ Body: { skillId?: string; invokedAt?: string } }>("/api/record", async (request) => {
    const loaded = requireConfig(config);
    const skillId = requireSkillId(request.body);
    const event = await recordUsageEvent(loaded, skillId, { invokedAt: optionalDate(request.body?.invokedAt) });
    return { event };
  });

  app.post("/api/pull", async () => {
    const loaded = requireConfig(config);
    return pullRepositoryChanges(loaded);
  });

  app.get("/api/repo-conflicts", async () => {
    const loaded = requireConfig(config);
    return listRepositoryConflicts(loaded);
  });

  app.post<{ Body: RepoConflictResolveBody }>("/api/repo-conflicts/resolve", async (request) => {
    const loaded = requireConfig(config);
    return resolveRepositoryConflicts(loaded, requireRepoConflictResolutions(request.body));
  });

  app.post<{ Body: SkillActionBody }>("/api/skill-file", async (request) => {
    const loaded = requireConfig(config);
    const filePath = localSkillMdPath(loaded, request.body);
    if (!existsSync(filePath)) {
      throw httpError(404, "Local SKILL.md not found.");
    }

    return {
      path: filePath,
      content: await readFile(filePath, "utf8")
    };
  });

  app.put<{ Body: SkillFileBody }>("/api/skill-file", async (request) => {
    const loaded = requireConfig(config);
    const filePath = localSkillMdPath(loaded, request.body);
    if (!existsSync(filePath)) {
      throw httpError(404, "Local SKILL.md not found.");
    }

    await writeFile(filePath, requireSkillFileContent(request.body), "utf8");
    autoSync.trigger();
    return { path: filePath };
  });

  app.post<{ Body: SyncBody }>("/api/sync", async (request) => {
    const loaded = requireConfig(config);
    const result = await syncSelectedSkills(loaded, requireSyncSelections(request.body));
    return { result };
  });

  app.post<{ Body: BulkActionBody }>("/api/bulk-action", async (request) => {
    const loaded = requireConfig(config);
    const endpoint = requireBulkActionEndpoint(request.body?.endpoint);
    const selections = requireSyncSelections(request.body);
    const records = [];
    const dependencyInstalls = [];

    for (const selection of selections) {
      if (endpoint === "import") {
        records.push(await importLocalSkill(loaded, selection.skillId, { force: true, source: selection.source }));
      } else if (endpoint === "install") {
        const installed = await installRepoSkill(loaded, selection.skillId, { force: true, source: selection.source });
        records.push(installed.record);
        dependencyInstalls.push({ skillId: selection.skillId, ...installed.dependencyInstall });
      } else {
        const installed = await updateLocalSkill(loaded, selection.skillId, { source: selection.source });
        records.push(installed.record);
        dependencyInstalls.push({ skillId: selection.skillId, ...installed.dependencyInstall });
      }
    }

    const result = endpoint === "import" ? await syncSelectedSkills(loaded, selections) : await syncRepositoryChanges(loaded);
    return { records, dependencyInstalls, result };
  });

  const webRoot = findWebRoot();
  if (webRoot) {
    await app.register(fastifyStatic, {
      root: webRoot,
      prefix: "/"
    });

    app.setNotFoundHandler((request, reply) => {
      if (request.raw.url?.startsWith("/api/")) {
        reply.code(404).send({ error: "Not found" });
        return;
      }

      reply.sendFile("index.html");
    });
  } else {
    app.get("/", async (_request, reply) => {
      reply.type("text/html").send(
        "<main style=\"font-family: sans-serif; padding: 32px\"><h1>Skill Sync</h1><p>Web assets are not built yet. Run <code>npm run build</code> first.</p></main>"
      );
    });
  }

  const address = await app.listen({
    host: options.host ?? "127.0.0.1",
    port: options.port ?? 3017
  });

  return {
    url: address,
    close: async () => {
      await autoSync.stop();
      await usageMonitor.stop();
      await app.close();
    }
  };
}

function requireConfig(config: LocalConfig | null): LocalConfig {
  if (!config) {
    throw httpError(409, "Skill Sync is not initialized.");
  }

  return config;
}

function requireSkillId(body: SkillActionBody | undefined): string {
  if (!body?.skillId || typeof body.skillId !== "string") {
    throw httpError(400, "Request body must include skillId.");
  }

  return body.skillId;
}

function requireSkillFileContent(body: SkillFileBody | undefined): string {
  if (!body || typeof body.content !== "string") {
    throw httpError(400, "Request body must include content.");
  }

  return body.content;
}

function requireSyncSelections(body: SyncBody | undefined): SyncSelection[] {
  if (!body || !Array.isArray(body.skills)) {
    throw httpError(400, "Request body must include skills.");
  }

  return body.skills.map((skill) => ({
    skillId: requireSkillId(skill),
    source: optionalLocalSource(skill.source)
  }));
}

function requireRepoConflictResolutions(body: RepoConflictResolveBody | undefined): RepositoryConflictResolution[] {
  if (!body || !Array.isArray(body.resolutions)) {
    throw httpError(400, "Request body must include resolutions.");
  }

  return body.resolutions.map((resolution) => ({
    skillId: requireSkillId(resolution),
    source: requireRepositoryConflictSource(resolution.source)
  }));
}

function requireRepositoryConflictSource(value: unknown): RepositoryConflictSource {
  if (value === "github" || value === "syncRepo" || value === "codex" || value === "agents") {
    return value;
  }

  throw httpError(400, "Repository conflict source must be github, syncRepo, codex, or agents.");
}

function requireBulkActionEndpoint(value: unknown): "import" | "install" | "update-local" {
  if (value === "import" || value === "install" || value === "update-local") {
    return value;
  }

  throw httpError(400, "Bulk action endpoint must be import, install, or update-local.");
}

function optionalPath(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw httpError(400, "Path values must be strings.");
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function optionalDate(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw httpError(400, "invokedAt must be an ISO timestamp.");
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  if (Number.isNaN(new Date(trimmed).getTime())) {
    throw httpError(400, "invokedAt must be an ISO timestamp.");
  }

  return trimmed;
}

function requireArchiveFileName(value: unknown): string {
  if (typeof value !== "string") {
    throw httpError(400, "Request body must include a valid fileName.");
  }

  try {
    return validateCodexArchiveFileName(value.trim());
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid file name.";
    throw httpError(400, message);
  }
}

function requireResolveStrategy(value: unknown): "codex" | "agents" | "repo" {
  if (value === "codex" || value === "agents" || value === "repo") {
    return value;
  }

  throw httpError(400, "Conflict strategy must be codex, agents, or repo.");
}

async function buildSkillVersions(config: LocalConfig, skillId: string): Promise<SkillVersionPayload[]> {
  const id = validateSkillId(skillId);
  const sources: Array<{ source: SkillVersionSource; path: string }> = [
    { source: "codex", path: resolveSkillPath(config.codexSkillsDir, id) },
    { source: "agents", path: resolveSkillPath(config.agentsSkillsDir, id) },
    { source: "repo", path: resolveSkillPath(repoSkillsDir(config.syncRepo), id) }
  ];

  const versions = await Promise.all(
    sources.map(async (entry) => {
      const skillFilePath = path.join(entry.path, "SKILL.md");
      if (!existsSync(skillFilePath)) {
        return {
          source: entry.source,
          path: skillFilePath,
          exists: false,
          content: null
        };
      }

      const content = await readFile(skillFilePath, "utf8");
      return {
        source: entry.source,
        path: skillFilePath,
        exists: true,
        content
      };
    })
  );

  return versions;
}

function optionalTitle(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw httpError(400, "Directory picker title must be a string.");
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function optionalLocalSource(value: unknown): LocalSkillSource | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (value === "codex" || value === "agents") {
    return value;
  }

  throw httpError(400, "Skill source must be codex or agents.");
}

function requireLocalSource(value: unknown): LocalSkillSource {
  const source = optionalLocalSource(value);
  if (!source) {
    throw httpError(400, "Request body must include source.");
  }

  return source;
}

function localSkillMdPath(config: LocalConfig, body: SkillActionBody | undefined): string {
  const skillId = requireSkillId(body);
  const source = requireLocalSource(body?.source);
  const localRoot = source === "agents" ? config.agentsSkillsDir : config.codexSkillsDir;

  try {
    return path.join(resolveSkillPath(localRoot, skillId), "SKILL.md");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid skillId.";
    throw httpError(400, message);
  }
}

function findWebRoot(): string | null {
  const candidates = [
    path.resolve(process.cwd(), "dist/web"),
    fileURLToPath(new URL("../web", import.meta.url)),
    fileURLToPath(new URL("../../dist/web", import.meta.url))
  ];

  return candidates.find((candidate) => existsSync(path.join(candidate, "index.html"))) ?? null;
}

function httpError(statusCode: number, message: string): Error & { apiMessage: string; statusCode: number } {
  const error = new Error(message) as Error & { apiMessage: string; statusCode: number };
  error.apiMessage = message;
  error.statusCode = statusCode;
  return error;
}

function normalizeError(error: unknown): { statusCode: number; message: string } {
  if (error instanceof Error) {
    const statusCode = (error as Error & { statusCode?: number }).statusCode;
    const apiMessage = (error as Error & { apiMessage?: string }).apiMessage;
    return {
      statusCode: statusCode && statusCode >= 400 ? statusCode : 500,
      message: apiMessage ?? error.message
    };
  }

  return {
    statusCode: 500,
    message: String(error)
  };
}

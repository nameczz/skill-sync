import { existsSync } from "node:fs";
import { mkdir, open, readFile, readdir, realpath, rename, stat } from "node:fs/promises";
import path from "node:path";
import type { PathOptions } from "./paths.js";
import { getDefaultCodexArchiveSessionsDir } from "./paths.js";

export type CodexArchiveState = "active" | "trash";

export type CodexArchiveSession = {
  fileName: string;
  sessionId: string;
  title: string;
  archivedAt: string | null;
  updatedAt: string | null;
  cwd: string | null;
  source: string | null;
  fileSize: number;
};

export type CodexArchiveListResponse = {
  state: CodexArchiveState;
  items: CodexArchiveSession[];
};

export type CodexArchivePreviewResponse = {
  state: CodexArchiveState;
  item: CodexArchiveSession;
  preview: string[];
  truncated: boolean;
};

export type CodexArchiveUnarchiveResponse = {
  item: CodexArchiveSession;
  targetPath: string;
};

type SessionIndexEntry = {
  id?: unknown;
  thread_id?: unknown;
  thread_name?: unknown;
  source?: unknown;
  originator?: unknown;
  cwd?: unknown;
  archivedAt?: unknown;
  archived_at?: unknown;
  updatedAt?: unknown;
  updated_at?: unknown;
};

type SessionIndexMap = Map<string, SessionIndexEntry>;
type SessionFileMetadata = {
  timestamp: string | null;
  cwd: string | null;
  source: string | null;
};

const PREVIEW_BYTES = 96 * 1024;
const METADATA_BYTES = 32 * 1024;
const PREVIEW_MAX_LINES = 120;
const JSONL_EXT = ".jsonl";
const MAX_SESSION_ENTRIES = 250;

export function resolveCodexArchiveRoots(options: PathOptions = {}): { active: string; trash: string; index: string; sessions: string } {
  const archiveRoot = getDefaultCodexArchiveSessionsDir(options);
  const codexHome = path.dirname(archiveRoot);
  return {
    active: archiveRoot,
    trash: path.join(archiveRoot, ".trash"),
    index: path.join(codexHome, "session_index.jsonl"),
    sessions: path.join(codexHome, "sessions")
  };
}

export async function listCodexArchiveSessions(state: CodexArchiveState, options: PathOptions = {}): Promise<CodexArchiveListResponse> {
  const roots = resolveCodexArchiveRoots(options);
  const target = state === "trash" ? roots.trash : roots.active;
  const index = await readSessionIndex(roots.index);
  const rows = await listSessionFiles(target);

  const items = (
    await Promise.all(rows.map((fileName) => buildSessionMetadata(fileName, state, index, options)))
  ).sort(compareMostRecentSessionDesc);

  return {
    state,
    items: items.slice(0, MAX_SESSION_ENTRIES)
  };
}

export async function previewCodexArchiveSession(
  state: CodexArchiveState,
  fileName: string,
  options: PathOptions = {}
): Promise<CodexArchivePreviewResponse> {
  const roots = resolveCodexArchiveRoots(options);
  const root = state === "trash" ? roots.trash : roots.active;
  const safe = validateCodexArchiveFileName(fileName);
  const target = await resolveSessionFilePath(root, safe, { mustExist: true });
  const index = await readSessionIndex(roots.index);
  const item = await buildSessionMetadata(safe, state, index, options);
  const preview = await readSessionPreview(target);
  return {
    state,
    item,
    preview: preview.lines,
    truncated: preview.truncated
  };
}

export async function moveCodexArchiveSessionToTrash(fileName: string, options: PathOptions = {}): Promise<CodexArchiveSession> {
  const roots = resolveCodexArchiveRoots(options);
  const safe = validateCodexArchiveFileName(fileName);
  const sourcePath = await resolveSessionFilePath(roots.active, safe, { mustExist: true });
  await mkdir(roots.trash, { recursive: true });

  const targetPath = await resolveSessionFilePath(roots.trash, safe);
  if (existsSync(targetPath)) {
    throw new Error(`Archive file already exists in trash: ${safe}`);
  }

  await rename(sourcePath, targetPath);
  return await buildSessionMetadata(safe, "trash", await readSessionIndex(roots.index), options);
}

export async function restoreCodexArchiveSession(fileName: string, options: PathOptions = {}): Promise<CodexArchiveSession> {
  const roots = resolveCodexArchiveRoots(options);
  const safe = validateCodexArchiveFileName(fileName);
  const sourcePath = await resolveSessionFilePath(roots.trash, safe, { mustExist: true });
  const targetPath = await resolveSessionFilePath(roots.active, safe);
  if (existsSync(targetPath)) {
    throw new Error(`Archive file already exists: ${safe}`);
  }

  await rename(sourcePath, targetPath);
  return await buildSessionMetadata(safe, "active", await readSessionIndex(roots.index), options);
}

export async function unarchiveCodexArchiveSession(fileName: string, options: PathOptions = {}): Promise<CodexArchiveUnarchiveResponse> {
  const roots = resolveCodexArchiveRoots(options);
  const safe = validateCodexArchiveFileName(fileName);
  const sourcePath = await resolveSessionFilePath(roots.active, safe, { mustExist: true });
  const item = await buildSessionMetadata(safe, "active", await readSessionIndex(roots.index), options);
  const targetPath = await resolveUnarchivedSessionPath(roots.sessions, safe, item.updatedAt ?? item.archivedAt);

  if (existsSync(targetPath)) {
    throw new Error(`Session file already exists outside archive: ${safe}`);
  }

  await rename(sourcePath, targetPath);
  return { item, targetPath };
}

export function validateCodexArchiveFileName(fileName: string): string {
  if (!fileName.endsWith(JSONL_EXT)) {
    throw new Error("Session files must use .jsonl.");
  }

  const trimmed = path.basename(fileName);
  if (trimmed !== fileName || trimmed.includes("..") || trimmed.includes("/") || trimmed.includes("\\")) {
    throw new Error("Session file name must be a safe basename.");
  }

  return fileName;
}

async function listSessionFiles(root: string): Promise<string[]> {
  const raw = await readdir(root).catch(() => []);
  return raw.filter((file) => file.endsWith(JSONL_EXT) && file === path.basename(file));
}

async function buildSessionMetadata(
  fileName: string,
  state: CodexArchiveState,
  index: SessionIndexMap,
  options: PathOptions = {}
): Promise<CodexArchiveSession> {
  const safe = validateCodexArchiveFileName(fileName);
  const roots = resolveCodexArchiveRoots(options);
  const root = state === "trash" ? roots.trash : roots.active;
  const sessionPath = await resolveSessionFilePath(root, safe, { mustExist: true });
  const stats = await stat(sessionPath);
  const sessionId = extractSessionId(safe);
  const indexMetadata = index.get(sessionId);
  const fileMetadata = await readSessionFileMetadata(sessionPath);
  const titleFromIndex = toStringOrNull(indexMetadata?.thread_name) || safe;
  const sourceFromIndex = toStringOrNull(indexMetadata?.originator) || toStringOrNull(indexMetadata?.source) || fileMetadata.source;
  const cwdFromIndex = toStringOrNull(indexMetadata?.cwd) || fileMetadata.cwd;
  const archivedAt = toIsoTimestamp(indexMetadata?.archivedAt ?? indexMetadata?.archived_at) ?? fileMetadata.timestamp ?? stats.birthtime.toISOString();
  const updatedAt = toIsoTimestamp(indexMetadata?.updatedAt ?? indexMetadata?.updated_at) ?? stats.mtime.toISOString();

  return {
    fileName: safe,
    sessionId,
    title: titleFromIndex,
    archivedAt,
    updatedAt,
    cwd: cwdFromIndex,
    source: sourceFromIndex,
    fileSize: Number.isFinite(stats.size) ? stats.size : 0
  };
}

function extractSessionId(fileName: string): string {
  const baseName = fileName.endsWith(JSONL_EXT) ? fileName.slice(0, -JSONL_EXT.length) : fileName;
  const uuidMatch = baseName.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  return uuidMatch?.[0] ?? baseName;
}

async function readSessionIndex(indexPath: string): Promise<SessionIndexMap> {
  const raw = await readFile(indexPath, "utf8").catch(() => "");
  if (!raw.trim()) {
    return new Map();
  }

  const entries: SessionIndexMap = new Map();
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (!parsed || typeof parsed !== "object") {
      continue;
    }

    const entry = parsed as SessionIndexEntry;
    const threadId = toStringOrNull(entry.id) ?? toStringOrNull(entry.thread_id);
    if (!threadId) {
      continue;
    }

    entries.set(threadId, entry);
  }

  return entries;
}

async function resolveSessionFilePath(
  root: string,
  fileName: string,
  options: { mustExist?: boolean } = {}
): Promise<string> {
  const safe = validateCodexArchiveFileName(fileName);
  const candidate = path.join(root, safe);
  const resolvedCandidate = path.resolve(candidate);
  const resolvedRoot = path.resolve(root);
  const rootRelative = path.relative(resolvedRoot, resolvedCandidate);
  if (rootRelative.startsWith("..") || path.isAbsolute(rootRelative)) {
    throw new Error(`Session file must remain in archive root: ${safe}`);
  }

  const realRoot = await realpath(resolvedRoot).catch(() => resolvedRoot);
  if (options.mustExist) {
    const realCandidate = await realpath(resolvedCandidate).catch(() => null);
    if (!realCandidate) {
      throw new Error(`Session file not found: ${safe}`);
    }

    if (!isInDirectory(realRoot, realCandidate)) {
      throw new Error(`Session file must remain in archive root: ${safe}`);
    }

    return realCandidate;
  }

  const realCandidate = path.join(realRoot, safe);
  if (!isInDirectory(realRoot, realCandidate)) {
    throw new Error(`Session file must remain in archive root: ${safe}`);
  }

  return realCandidate;
}

function isInDirectory(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function resolveUnarchivedSessionPath(sessionsRoot: string, fileName: string, fallbackTimestamp: string | null): Promise<string> {
  const safe = validateCodexArchiveFileName(fileName);
  const dateParts = sessionDateParts(safe, fallbackTimestamp);
  const resolvedRoot = path.resolve(sessionsRoot);
  const targetDir = path.join(resolvedRoot, dateParts.year, dateParts.month, dateParts.day);
  const resolvedTargetDir = path.resolve(targetDir);
  const relativeDir = path.relative(resolvedRoot, resolvedTargetDir);
  if (relativeDir.startsWith("..") || path.isAbsolute(relativeDir)) {
    throw new Error(`Unarchived session must remain in Codex sessions root: ${safe}`);
  }

  await mkdir(resolvedTargetDir, { recursive: true });

  const realRoot = await realpath(resolvedRoot).catch(() => resolvedRoot);
  const realTargetDir = await realpath(resolvedTargetDir);
  if (!isInDirectory(realRoot, realTargetDir)) {
    throw new Error(`Unarchived session must remain in Codex sessions root: ${safe}`);
  }

  const targetPath = path.join(realTargetDir, safe);
  if (!isInDirectory(realRoot, targetPath)) {
    throw new Error(`Unarchived session must remain in Codex sessions root: ${safe}`);
  }

  return targetPath;
}

function sessionDateParts(fileName: string, fallbackTimestamp: string | null): { year: string; month: string; day: string } {
  const fromFileName = fileName.match(/^rollout-(\d{4})-(\d{2})-(\d{2})T/);
  if (fromFileName) {
    return { year: fromFileName[1], month: fromFileName[2], day: fromFileName[3] };
  }

  const fallback = fallbackTimestamp ? new Date(fallbackTimestamp) : null;
  const date = fallback && !Number.isNaN(fallback.getTime()) ? fallback : new Date();
  const [year, month, day] = date.toISOString().slice(0, 10).split("-");
  return { year, month, day };
}

function compareMostRecentSessionDesc(a: CodexArchiveSession, b: CodexArchiveSession): number {
  return sessionSortTimestamp(b) - sessionSortTimestamp(a) || a.title.localeCompare(b.title) || a.sessionId.localeCompare(b.sessionId);
}

function sessionSortTimestamp(item: CodexArchiveSession): number {
  return Date.parse(item.updatedAt ?? item.archivedAt ?? "") || 0;
}

async function readSessionPreview(filePath: string): Promise<{ lines: string[]; truncated: boolean }> {
  const stats = await stat(filePath);
  if (stats.size === 0) {
    return { lines: ["<empty session file>"], truncated: false };
  }

  const handle = await open(filePath, "r");
  try {
    const byteCount = Math.min(PREVIEW_BYTES, stats.size);
    const buffer = Buffer.alloc(byteCount);
    const { bytesRead } = await handle.read(buffer, 0, byteCount, 0);
    const content = buffer.subarray(0, bytesRead).toString("utf8");
    const rawLines = content.split(/\r?\n/).filter((line) => line.trim()).slice(0, PREVIEW_MAX_LINES);
    const lines = rawLines.map(formatPreviewLine);
    return {
      lines,
      truncated: bytesRead < stats.size || lines.length === PREVIEW_MAX_LINES
    };
  } finally {
    await handle.close();
  }
}

async function readSessionFileMetadata(filePath: string): Promise<SessionFileMetadata> {
  const stats = await stat(filePath).catch(() => null);
  if (!stats || stats.size === 0) {
    return { timestamp: null, cwd: null, source: null };
  }

  const handle = await open(filePath, "r");
  let raw = "";
  try {
    const byteCount = Math.min(METADATA_BYTES, stats.size);
    const buffer = Buffer.alloc(byteCount);
    const { bytesRead } = await handle.read(buffer, 0, byteCount, 0);
    raw = buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }

  const firstLine = raw.split(/\r?\n/, 1)[0]?.trim();
  if (!firstLine) {
    return { timestamp: null, cwd: null, source: null };
  }

  try {
    const parsed = JSON.parse(firstLine) as {
      timestamp?: unknown;
      payload?: {
        timestamp?: unknown;
        cwd?: unknown;
        originator?: unknown;
        source?: unknown;
      };
    };
    return {
      timestamp: toIsoTimestamp(parsed.timestamp) ?? toIsoTimestamp(parsed.payload?.timestamp),
      cwd: toStringOrNull(parsed.payload?.cwd),
      source: toStringOrNull(parsed.payload?.originator) ?? toStringOrNull(parsed.payload?.source)
    };
  } catch {
    return { timestamp: null, cwd: null, source: null };
  }
}

function formatPreviewLine(line: string): string {
  try {
    const parsed = JSON.parse(line) as { timestamp?: unknown; type?: unknown; payload?: unknown };
    const timestamp = toIsoTimestamp(parsed.timestamp);
    const type = toStringOrNull(parsed.type) ?? "event";
    const summary = type === "session_meta" ? summarizeSessionMeta(parsed.payload) : summarizePayload(parsed.payload);
    return truncateText([timestamp, type, summary].filter(Boolean).join(" | "), 700);
  } catch {
    return truncateText(line, 700);
  }
}

function summarizeSessionMeta(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "";
  }

  const record = payload as Record<string, unknown>;
  return [toStringOrNull(record.originator), toStringOrNull(record.cwd)].filter(Boolean).join(" ");
}

function summarizePayload(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "";
  }

  const record = payload as Record<string, unknown>;
  const type = toStringOrNull(record.type);
  if (type === "session_meta") {
    return [toStringOrNull(record.originator), toStringOrNull(record.cwd)].filter(Boolean).join(" ");
  }

  const content = record.content;
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (!item || typeof item !== "object") {
          return "";
        }
        const contentItem = item as Record<string, unknown>;
        return toStringOrNull(contentItem.text) ?? toStringOrNull(contentItem.content) ?? "";
      })
      .filter(Boolean)
      .join(" ");
  }

  return toStringOrNull(record.name) ?? type ?? "";
}

function truncateText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function toIsoTimestamp(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString();
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

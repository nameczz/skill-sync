import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { LocalConfig } from "./types.js";
import { extractSkillFilePathIdsFromText } from "./skillMentions.js";
import { readUsageEvents, recordUsageEvent } from "./usage.js";
import { expandHome, type PathOptions } from "./paths.js";

const STATE_FILE = "usage-session-scan.json";
const STATE_SCHEMA_VERSION = 2;
const INITIAL_SCAN_BYTES = 5 * 1024 * 1024;
const MAX_SEEN_KEYS = 1000;
const MAX_SESSION_FILES = 20;
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;
const INITIAL_RECENT_WINDOW_MS = 7 * RECENT_WINDOW_MS;

type SessionUsageState = {
  schemaVersion: 2;
  files: Record<string, { offset: number }>;
  seen: string[];
};

type SessionRecordResult = {
  scannedFiles: number;
  recorded: number;
  skillIds: string[];
};

type SessionUsageOptions = PathOptions & {
  now?: () => Date;
  initialScanBytes?: number;
  threadId?: string | null;
};

export async function recordUsageFromCodexSessions(config: LocalConfig, options: SessionUsageOptions = {}): Promise<SessionRecordResult> {
  const { state, isInitialScan } = await readSessionState(config.cacheDir);
  const files = await findCandidateSessionFiles(options, {
    maxSessionFiles: isInitialScan ? Number.POSITIVE_INFINITY : MAX_SESSION_FILES,
    recentWindowMs: isInitialScan ? INITIAL_RECENT_WINDOW_MS : RECENT_WINDOW_MS
  });
  if (files.length === 0) {
    return { scannedFiles: 0, recorded: 0, skillIds: [] };
  }

  const seen = new Set(state.seen);
  const existingEvents = new Set((await readUsageEvents(config.syncRepo)).map((event) => `${event.skillId}:${event.invokedAt}`));
  const recordedSkillIds = new Set<string>();
  let recorded = 0;

  for (const filePath of files) {
    const stats = await stat(filePath).catch(() => null);
    if (!stats?.isFile()) {
      continue;
    }

    const previous = state.files[filePath];
    const initialScanBytes = options.initialScanBytes ?? INITIAL_SCAN_BYTES;
    const start = previous ? Math.min(previous.offset, stats.size) : Math.max(0, stats.size - initialScanBytes);
    const lines = await readJsonlTail(filePath, start, stats.size);

    for (const line of lines) {
      for (const signal of toSessionUsageSignals(line, config)) {
        for (const skillId of signal.skillIds) {
          const key = usageSeenKey(filePath, signal.timestamp, skillId, signal.message);
          if (seen.has(key)) {
            continue;
          }

          seen.add(key);
          if (existingEvents.has(`${skillId}:${signal.timestamp}`)) {
            continue;
          }

          await recordUsageEvent(config, skillId, { invokedAt: signal.timestamp });
          existingEvents.add(`${skillId}:${signal.timestamp}`);
          recorded += 1;
          recordedSkillIds.add(skillId);
        }
      }
    }

    state.files[filePath] = { offset: stats.size };
  }

  state.seen = [...seen].slice(-MAX_SEEN_KEYS);
  await writeSessionState(config.cacheDir, state);

  return {
    scannedFiles: files.length,
    recorded,
    skillIds: [...recordedSkillIds].sort((a, b) => a.localeCompare(b))
  };
}

async function findCandidateSessionFiles(
  options: SessionUsageOptions,
  scanPolicy: { maxSessionFiles: number; recentWindowMs: number }
): Promise<string[]> {
  const env = options.env ?? process.env;
  const home = options.homeDir ?? homedir();
  const codexHome = path.resolve(expandHome(env.SKILL_SYNC_CODEX_HOME ?? env.CSM_CODEX_HOME ?? env.CODEX_HOME ?? "~/.codex", home));
  const sessionsDir = path.join(codexHome, "sessions");

  if (!existsSync(sessionsDir)) {
    return [];
  }

  const allFiles = await listJsonlFiles(sessionsDir);
  const threadId = options.threadId === undefined ? env.CODEX_THREAD_ID : options.threadId ?? undefined;
  const now = options.now ?? (() => new Date());
  const cutoff = now().getTime() - scanPolicy.recentWindowMs;

  const candidates = await Promise.all(
    allFiles.map(async (filePath) => {
      const stats = await stat(filePath).catch(() => null);
      if (!stats?.isFile()) {
        return null;
      }

      return { filePath, mtimeMs: stats.mtimeMs };
    })
  );

  return candidates
    .filter((entry): entry is { filePath: string; mtimeMs: number } => entry !== null)
    .filter((entry) => (threadId ? path.basename(entry.filePath).includes(threadId) : entry.mtimeMs >= cutoff))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, scanPolicy.maxSessionFiles)
    .map((entry) => entry.filePath);
}

async function listJsonlFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listJsonlFiles(entryPath)));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(entryPath);
    }
  }

  return files;
}

async function readJsonlTail(filePath: string, start: number, end: number): Promise<string[]> {
  if (end <= start) {
    return [];
  }

  const length = end - start;
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const result = await handle.read(buffer, 0, length, start);
    const lines = buffer.subarray(0, result.bytesRead).toString("utf8").split(/\r?\n/);
    if (start > 0) {
      lines.shift();
    }

    return lines.map((line) => line.trim()).filter(Boolean);
  } finally {
    await handle.close();
  }
}

function toSessionUsageSignals(line: string, config: LocalConfig): Array<{ timestamp: string; message: string; skillIds: string[] }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [];
  }

  if (!parsed || typeof parsed !== "object") {
    return [];
  }

  const event = parsed as { timestamp?: unknown; type?: unknown; payload?: unknown };
  if (typeof event.timestamp !== "string" || Number.isNaN(new Date(event.timestamp).getTime())) {
    return [];
  }

  const payload = event.payload;
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const payloadType = (payload as { type?: unknown }).type;
  if (event.type === "response_item" && payloadType === "function_call") {
    const args = (payload as { arguments?: unknown }).arguments;
    if (typeof args !== "string" || !args.trim()) {
      return [];
    }

    return [{ timestamp: event.timestamp, message: args, skillIds: extractSkillFilePathIdsFromText(args, config) }];
  }

  return [];
}

async function readSessionState(cacheDir: string): Promise<{ state: SessionUsageState; isInitialScan: boolean }> {
  const filePath = path.join(cacheDir, STATE_FILE);
  const raw = await readFile(filePath, "utf8").catch(() => "");
  if (!raw.trim()) {
    return { state: { schemaVersion: STATE_SCHEMA_VERSION, files: {}, seen: [] }, isInitialScan: true };
  }

  try {
    const parsed = JSON.parse(raw) as SessionUsageState;
    if (parsed.schemaVersion === STATE_SCHEMA_VERSION && parsed.files && typeof parsed.files === "object" && Array.isArray(parsed.seen)) {
      return { state: parsed, isInitialScan: false };
    }
  } catch {
    // Ignore corrupt local cache and rebuild it from current session tails.
  }

  return { state: { schemaVersion: STATE_SCHEMA_VERSION, files: {}, seen: [] }, isInitialScan: true };
}

async function writeSessionState(cacheDir: string, state: SessionUsageState): Promise<void> {
  await mkdir(cacheDir, { recursive: true });
  await writeFile(path.join(cacheDir, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function usageSeenKey(filePath: string, timestamp: string, skillId: string, message: string): string {
  const messageHash = createHash("sha256").update(message).digest("hex").slice(0, 16);
  return `${filePath}:${timestamp}:${skillId}:${messageHash}`;
}

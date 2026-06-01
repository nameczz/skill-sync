import type { LocalConfig, UsageMonitorStatus } from "./types.js";
import { recordUsageFromCodexSessions } from "./sessionUsage.js";

type UsageMonitorController = {
  start: (config: LocalConfig) => Promise<void>;
  stop: () => Promise<void>;
  scanNow: () => Promise<void>;
  getStatus: () => UsageMonitorStatus;
};

type UsageMonitorOptions = {
  intervalMs?: number;
  scan?: (config: LocalConfig) => Promise<{ recorded: number; skillIds: string[] }>;
  now?: () => string;
};

export function createUsageMonitor(options: UsageMonitorOptions = {}): UsageMonitorController {
  const intervalMs = options.intervalMs ?? 30_000;
  const scan =
    options.scan ??
    ((config: LocalConfig) =>
      recordUsageFromCodexSessions(config, {
        threadId: null
      }));
  const now = options.now ?? (() => new Date().toISOString());

  let currentConfig: LocalConfig | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  let status: UsageMonitorStatus = {
    enabled: false,
    running: false,
    intervalMs,
    lastScanStartedAt: null,
    lastScanCompletedAt: null,
    lastRecordedSkillIds: [],
    lastError: null
  };

  async function start(config: LocalConfig): Promise<void> {
    currentConfig = config;
    status = {
      ...status,
      enabled: true,
      intervalMs,
      lastError: null
    };

    if (timer === null) {
      timer = setInterval(() => {
        void scanNow();
      }, intervalMs);
    }

    await scanNow();
  }

  async function stop(): Promise<void> {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }

    currentConfig = null;
    running = false;
    status = {
      ...status,
      enabled: false,
      running: false
    };
  }

  async function scanNow(): Promise<void> {
    if (!currentConfig || running) {
      return;
    }

    running = true;
    status = {
      ...status,
      running: true,
      lastScanStartedAt: now()
    };

    try {
      const result = await scan(currentConfig);
      status = {
        ...status,
        running: false,
        lastScanCompletedAt: now(),
        lastRecordedSkillIds: result.skillIds,
        lastError: null
      };
    } catch (error) {
      status = {
        ...status,
        running: false,
        lastScanCompletedAt: now(),
        lastRecordedSkillIds: [],
        lastError: normalizeError(error)
      };
    } finally {
      running = false;
    }
  }

  function getStatus(): UsageMonitorStatus {
    return { ...status };
  }

  return { start, stop, scanNow, getStatus };
}

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

#!/usr/bin/env node
import { Command } from "commander";
import { createLocalConfig, loadLocalConfig } from "./config.js";
import { initialize } from "./init.js";
import { buildStatusReport } from "./status.js";
import { formatStatus } from "./format.js";
import { importLocalSkill } from "./importSkill.js";
import { installRepoSkill } from "./installSkill.js";
import { gitBranchSyncStatus, gitStatus } from "./git.js";
import { startServer } from "./server.js";
import { pullRepositoryChanges, syncRepositoryChanges, syncSelectedSkills } from "./sync.js";
import { recordUsageEvent } from "./usage.js";
import { removeLocalSkill } from "./removeLocalSkill.js";
import { stopSyncingSkill } from "./stopSyncingSkill.js";
import { updateLocalSkill } from "./updateLocalSkill.js";

const program = new Command();

program
  .name("skill-sync")
  .description("Sync local AI agent skills with a Git-backed repository.")
  .version("0.1.1");

program
  .command("init")
  .description("Initialize local config and the Git-backed skill sync repository.")
  .option("--sync-repo <path>", "Path to the sync repository")
  .option("--skills-dir <path>", "Path to the Codex skills directory")
  .option("--agents-skills-dir <path>", "Path to the Agents skills directory")
  .option("--cache-dir <path>", "Path to local cache/config directory")
  .option("--force", "Overwrite local config")
  .action(async (options) => {
    const result = await initialize({
      syncRepo: options.syncRepo,
      codexSkillsDir: options.skillsDir,
      agentsSkillsDir: options.agentsSkillsDir,
      cacheDir: options.cacheDir,
      force: options.force
    });

    console.log(`Initialized Skill Sync`);
    console.log(`Sync repo: ${result.config.syncRepo}`);
    console.log(`Codex skills: ${result.config.codexSkillsDir}`);
    console.log(`Agents skills: ${result.config.agentsSkillsDir}`);
    console.log(`Git repository: ${result.gitInitialized ? "created" : "already present"}`);
  });

program
  .command("status")
  .description("Show managed and unmanaged skill status.")
  .option("--json", "Print JSON")
  .action(async (options) => {
    const config = await loadLocalConfig();
    const report = await buildStatusReport(config);
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    console.log(formatStatus(report));
    const status = await gitStatus(config.syncRepo);
    const branchStatus = await gitBranchSyncStatus(config.syncRepo);
    const branchSummaryText = formatBranchSummary(branchStatus);
    console.log("");
    console.log(`Git status: ${status || "clean"}`);
    console.log(`Git branch: ${branchSummaryText}`);
  });

program
  .command("import")
  .argument("<skill-id>")
  .description("Import a local Codex skill into the sync repository.")
  .option("--force", "Overwrite an existing repo copy")
  .action(async (skillId, options) => {
    const config = await loadLocalConfig();
    const record = await importLocalSkill(config, skillId, { force: options.force });
    console.log(`Imported ${record.id}`);
  });

program
  .command("sync")
  .argument("[skill-id...]")
  .description("Commit and push selected skills or repository metadata changes.")
  .action(async (skillIds: string[] = []) => {
    const config = await loadLocalConfig();
    const result = await syncSelectedSkills(
      config,
      skillIds.map((skillId) => ({ skillId }))
    );
    console.log(result.committed ? `Committed ${result.commitHash}` : "No new commit was needed.");
    if (result.skillIds.length === 0) {
      console.log("Pushed repository changes.");
      return;
    }

    console.log(`Pushed ${result.skillIds.length} skill${result.skillIds.length === 1 ? "" : "s"}: ${result.skillIds.join(", ")}`);
  });

program
  .command("serve")
  .description("Start the local Web UI.")
  .option("--host <host>", "Host to bind", "127.0.0.1")
  .option("--port <port>", "Port to bind", "3017")
  .action(async (options) => {
    const port = Number.parseInt(options.port, 10);
    if (!Number.isFinite(port)) {
      throw new Error(`Invalid port: ${options.port}`);
    }

    const server = await startServer({ host: options.host, port });
    console.log(`Skill Sync is running at ${server.url}`);
    console.log("Press Ctrl+C to stop.");
  });

program
  .command("record")
  .argument("<skill-id>")
  .description("Record a confirmed skill invocation.")
  .option("--invoked-at <iso>", "Optional invocation time in ISO format")
  .action(async (skillId, options) => {
    const config = await loadLocalConfig();
    const event = await recordUsageEvent(config, skillId, { invokedAt: options.invokedAt });
    console.log(`Recorded usage for ${event.skillId} at ${event.invokedAt}`);
  });

program
  .command("pull")
  .description("Pull latest changes from the sync repository (fast-forward only).")
  .action(async () => {
    const config = await loadLocalConfig();
    const result = await pullRepositoryChanges(config);
    if (result.preSync?.committed) {
      console.log(`Committed local repository changes as ${result.preSync.commitHash}.`);
    }
    console.log("Pulled latest changes.");
  });

program
  .command("install")
  .argument("<skill-id>")
  .description("Install a managed skill from the sync repository.")
  .option("--force", "Overwrite an existing local copy")
  .option("--source <source>", "Which local root to install into: codex or agents")
  .action(async (skillId, options) => {
    const config = await loadLocalConfig();
    const source = resolveSourceOption(options.source);
    const { record } = await installRepoSkill(config, skillId, { force: options.force, source });
    console.log(`Installed ${record.id}`);
  });

program
  .command("update-local")
  .description("Install or overwrite a managed skill from the sync repo.")
  .argument("<skill-id>")
  .option("--source <source>", "Which local root to install into: codex or agents")
  .action(async (skillId, options) => {
    const config = await loadLocalConfig();
    const source = resolveSourceOption(options.source);
    await updateLocalSkill(config, skillId, { source });
    console.log(`Updated local copy of ${skillId}`);
  });

program
  .command("remove-local")
  .argument("<skill-id>")
  .description("Remove a managed skill from this machine.")
  .option("--source <source>", "Which local source to remove from: codex or agents")
  .action(async (skillId, options) => {
    const config = await loadLocalConfig();
    const source = resolveSourceOption(options.source);
    const record = await removeLocalSkill(config, skillId, { source });
    console.log(`Removed local skill copy: ${record.id}`);
  });

program
  .command("stop-syncing")
  .argument("<skill-id>")
  .description("Stop syncing a managed skill from the sync repository.")
  .action(async (skillId) => {
    const config = await loadLocalConfig();
    const record = await stopSyncingSkill(config, skillId);
    const result = await syncRepositoryChanges(config);
    console.log(`Stopped syncing ${record.id}`);
    if (result.committed && result.commitHash) {
      console.log(`Commit ${result.commitHash} pushed to sync repository.`);
    } else {
      console.log("No repository commit required.");
    }
  });

function resolveSourceOption(value: string | undefined): "codex" | "agents" | undefined {
  if (!value) {
    return undefined;
  }

  if (value === "codex" || value === "agents") {
    return value;
  }

  throw new Error(`Invalid source: ${value}. Use "codex" or "agents".`);
}

function formatBranchSummary(status: { state: string; ahead: number; behind: number; upstream: string | null }): string {
  if (status.state === "up-to-date") {
    return "up to date";
  }

  if (status.state === "ahead") {
    return `${status.ahead} commit(s) ahead of ${status.upstream ?? "remote"}`;
  }

  if (status.state === "behind") {
    return `${status.behind} commit(s) behind ${status.upstream ?? "remote"}`;
  }

  if (status.state === "diverged") {
    return `diverged: +${status.ahead}/-${status.behind} from ${status.upstream ?? "remote"}`;
  }

  if (status.state === "no-upstream") {
    return "no remote tracking branch";
  }

  return "unknown";
}

try {
  await program.parseAsync(process.argv);
} catch (error) {
  if (error instanceof Error) {
    console.error(error.message);
  } else {
    console.error(String(error));
  }
  process.exit(1);
}

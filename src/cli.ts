#!/usr/bin/env node
import { Command } from "commander";
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CONFIG_FILENAME, loadConfig, getProjectName, buildScopedKey } from "./config.js";
import { runChecks, checkKeys } from "./doctor.js";
import { runPsst } from "./psst.js";
import { getRvConfigDir, getMasterKeyPath, approveProject, revokeProject, isApproved } from "./approval.js";

const program = new Command();

program
  .name("rv")
  .description("redpill-vault — secure credential manager for AI tools")
  .version("0.1.7");

function runInit() {
  // 1. Create master key
  const configDir = getRvConfigDir();
  const masterKeyPath = getMasterKeyPath();
  mkdirSync(configDir, { recursive: true });

  if (existsSync(masterKeyPath)) {
    console.log("Master key already exists at " + masterKeyPath);
  } else {
    const key = randomBytes(32).toString("hex");
    writeFileSync(masterKeyPath, key + "\n", { mode: 0o600 });
    chmodSync(masterKeyPath, 0o600);
    console.log("Created master key at " + masterKeyPath);
  }

  // 2. Init psst vault
  const masterKey = readFileSync(masterKeyPath, "utf-8").trim();
  {
    const result = runPsst(["init", "--global"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PSST_PASSWORD: masterKey },
    });
    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    if (result.status === 0) {
      console.log("psst vault initialized");
    } else if (stderr.includes("already exists") || stdout.includes("already exists")) {
      console.log("psst vault already initialized");
    } else {
      console.error("Failed to initialize psst vault. Is psst installed?");
      process.exit(1);
    }
  }

  // 3. Create .rv.json if missing
  const cwd = process.cwd();
  const rvPath = join(cwd, CONFIG_FILENAME);
  if (!existsSync(rvPath)) {
    writeFileSync(rvPath, JSON.stringify({ secrets: {} }, null, 2) + "\n");
    console.log(`Created ${CONFIG_FILENAME}`);
  } else {
    console.log(`${CONFIG_FILENAME} already exists`);
  }

  // 4. Wire rv-hook into .claude/settings.json
  const claudeDir = join(cwd, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  const settingsPath = join(claudeDir, "settings.json");

  const hookPath = join(dirname(fileURLToPath(import.meta.url)), "hook.js");
  const hookDef = {
    type: "command" as const,
    command: `node ${hookPath}`,
  };

  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    } catch {
      console.error("Warning: .claude/settings.json is malformed — overwriting");
    }
  }

  if (!settings.hooks) settings.hooks = {};
  const hooks = settings.hooks as Record<string, unknown>;
  if (!hooks.PreToolUse) hooks.PreToolUse = [];
  const preToolUse = hooks.PreToolUse as Array<Record<string, unknown>>;

  const alreadyInstalled = preToolUse.some(entry => {
    const inner = entry.hooks as Array<Record<string, unknown>> | undefined;
    return inner?.some(h => {
      const cmd = String(h.command ?? "");
      return cmd === "rv-hook" || cmd.includes("setup.sh");
    });
  });
  if (!alreadyInstalled) {
    preToolUse.push({ matcher: "Bash", hooks: [hookDef] });
    console.log("Added rv-hook to .claude/settings.json");
  } else {
    console.log("rv-hook already configured");
  }

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");

  // 5. Summary
  console.log("\nSetup complete. Next steps:");
  console.log("  rv add <KEY>     — register a secret in this project");
  console.log("  rv approve       — approve this project for secret injection");
}

program
  .command("setup", { hidden: true })
  .description("Alias for init")
  .action(runInit);

/** Ensure psst auth is available (keychain or master key) */
function ensurePsstAuth(): void {
  if (process.env.PSST_PASSWORD) return;
  // Try keychain first
  const probe = runPsst(["--global", "list"], { stdio: "pipe", timeout: 5000, encoding: "utf-8" });
  if (probe.status === 0) return;
  // Fall back to master key
  const mkPath = getMasterKeyPath();
  if (existsSync(mkPath)) {
    const key = readFileSync(mkPath, "utf-8").trim();
    if (key) process.env.PSST_PASSWORD = key;
  }
}

/** Get list of keys in psst vault */
function getVaultKeys(): Set<string> {
  try {
    ensurePsstAuth();
    const result = runPsst(["--global", "list"], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    if (result.status !== 0) return new Set();
    const keys = new Set<string>();
    for (const line of (result.stdout ?? "").split("\n")) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) {
        // psst list format: "● KEY" or "KEY" — strip bullet point and whitespace
        const withoutBullet = trimmed.replace(/^[●•]\s*/, "");
        const key = withoutBullet.split("=")[0].split(/\s+/)[0];
        if (key && /^[A-Z_][A-Z0-9_]*$/.test(key)) keys.add(key);
      }
    }
    return keys;
  } catch {
    return new Set();
  }
}

program
  .command("list")
  .description("Show secrets from .rv.json with descriptions and source")
  .option("-g, --global", "Show only global keys in vault")
  .action((opts: { global?: boolean }) => {
    const cwd = process.cwd();
    const config = loadConfig();

    if (opts.global) {
      // Show global keys only (exclude PROJECT__KEY scoped keys)
      const vaultKeys = getVaultKeys();
      const globalKeys = [...vaultKeys].filter(k => !k.includes("__")).sort();
      if (globalKeys.length === 0) {
        console.log("No global keys in vault.");
        return;
      }
      for (const key of globalKeys) {
        console.log(key);
      }
      return;
    }

    if (!config) {
      console.error(`No ${CONFIG_FILENAME} found. Run: rv init`);
      process.exit(1);
    }
    const entries = Object.entries(config.secrets);
    if (entries.length === 0) {
      console.log("No secrets configured. Run: rv add <KEY>");
      return;
    }

    const projectName = getProjectName(config, cwd);
    const vaultKeys = getVaultKeys();

    for (const [key, entry] of entries) {
      let line = key;
      if (entry.as) line += ` → ${entry.as}`;

      // Determine source: project-scoped key format is PROJECT__KEY
      const projectKey = projectName ? buildScopedKey(projectName, key) : null;
      const hasProjectKey = projectKey && vaultKeys.has(projectKey);
      const hasGlobalKey = vaultKeys.has(key);

      if (hasProjectKey) {
        line += " [project]";
      } else if (hasGlobalKey) {
        line += " [global]";
      } else {
        line += " [missing]";
      }

      if (entry.description) line += ` — ${entry.description}`;
      if (entry.tag) line += ` [${entry.tag}]`;
      console.log(line);
    }
  });

program
  .command("add <key>")
  .description("Add a key to .rv.json and optionally set in vault")
  .option("-d, --description <desc>", "AI-readable description")
  .option("--as <name>", "Rename env var for this project")
  .option("-t, --tag <tag>", "psst tag")
  .option("-g, --global", "Store as global key (not project-scoped)")
  .action((key: string, opts: { description?: string; as?: string; tag?: string; global?: boolean }) => {
    const cwd = process.cwd();
    const rvPath = join(cwd, CONFIG_FILENAME);

    // Check if we're in a project
    const hasConfig = existsSync(rvPath);
    if (!hasConfig && !opts.global) {
      console.error(`Not in a project (no ${CONFIG_FILENAME}). Use -g for global, or run: rv init`);
      process.exit(1);
    }

    let config: { project?: string; secrets: Record<string, Record<string, string>> } = { secrets: {} };
    if (hasConfig) {
      config = JSON.parse(readFileSync(rvPath, "utf-8"));
    }

    const entry: Record<string, string> = {};
    if (opts.description) entry.description = opts.description;
    if (opts.as) entry.as = opts.as;
    if (opts.tag) entry.tag = opts.tag;

    config.secrets[key] = entry;

    if (hasConfig) {
      writeFileSync(rvPath, JSON.stringify(config, null, 2) + "\n");
      console.log(`Added ${key} to ${CONFIG_FILENAME}`);
    }

    // Determine the vault key name (PROJECT__KEY format for project-scoped)
    const projectName = hasConfig ? getProjectName(config as any, cwd) : null;
    const vaultKey = opts.global ? key : (projectName ? buildScopedKey(projectName, key) : key);

    // Check if key exists in vault
    const result = runPsst(["--global", "list"], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    const vaultKeys = new Set((result.stdout ?? "").split("\n").map(l => l.trim().split(/\s+/)[0]));

    if (!vaultKeys.has(vaultKey)) {
      if (opts.global) {
        console.log(`Hint: ${key} not in vault — run: psst --global set ${key}`);
      } else {
        console.log(`Hint: ${vaultKey} not in vault — run: psst --global set ${vaultKey}`);
      }
    } else {
      console.log(`Using ${opts.global ? "global" : "project-scoped"} key: ${vaultKey}`);
    }
  });

program
  .command("remove <key>")
  .description("Remove a key from .rv.json (does not delete from vault)")
  .option("-g, --global", "Also remove the global key from vault")
  .option("--vault", "Also remove the key from vault")
  .action((key: string, opts: { global?: boolean; vault?: boolean }) => {
    const cwd = process.cwd();
    const rvPath = join(cwd, CONFIG_FILENAME);
    if (!existsSync(rvPath)) {
      console.error(`No ${CONFIG_FILENAME} found.`);
      process.exit(1);
    }
    const config = JSON.parse(readFileSync(rvPath, "utf-8"));
    if (!config.secrets[key]) {
      console.error(`Key "${key}" not in ${CONFIG_FILENAME}`);
      process.exit(1);
    }
    delete config.secrets[key];
    writeFileSync(rvPath, JSON.stringify(config, null, 2) + "\n");
    console.log(`Removed ${key} from ${CONFIG_FILENAME}`);

    // Optionally remove from vault
    if (opts.vault) {
      const projectName = getProjectName(config, cwd);
      const vaultKey = opts.global ? key : (projectName ? buildScopedKey(projectName, key) : key);
      const result = runPsst(["--global", "rm", vaultKey], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
      if (result.status === 0) {
        console.log(`Removed ${vaultKey} from vault`);
      } else {
        console.log(`Note: ${vaultKey} was not in vault`);
      }
    }
  });

program
  .command("check")
  .description("Verify all .rv.json keys exist in psst vault")
  .action(() => {
    const results = checkKeys();
    let allOk = true;
    for (const r of results) {
      const icon = r.ok ? "✓" : "✗";
      console.log(`${icon} ${r.name}: ${r.message}`);
      if (!r.ok) allOk = false;
    }
    if (!allOk) process.exit(1);
  });

program
  .command("doctor")
  .description("Full health check")
  .action(() => {
    const results = runChecks();
    let allOk = true;
    for (const r of results) {
      const icon = r.ok ? "✓" : "✗";
      console.log(`${icon} ${r.name}: ${r.message}`);
      if (!r.ok) allOk = false;
    }
    if (allOk) {
      console.log("\nAll checks passed.");
    } else {
      console.log("\nSome checks failed.");
      process.exit(1);
    }
  });

program
  .command("init")
  .description("Full project setup: master key, psst vault, .rv.json, and hook wiring")
  .action(runInit);

program
  .command("approve")
  .description("Approve the current project for secret injection")
  .action(() => {
    const cwd = process.cwd();
    approveProject(cwd);
    console.log(`Approved: ${cwd}`);

    const config = loadConfig(cwd);
    if (config && Object.keys(config.secrets).length > 0) {
      console.log("Secrets that will be injected:");
      for (const [key, entry] of Object.entries(config.secrets)) {
        let line = `  ${key}`;
        if (entry.as) line += ` → ${entry.as}`;
        if (entry.description) line += ` — ${entry.description}`;
        console.log(line);
      }
    }
  });

program
  .command("revoke")
  .description("Revoke approval for the current project")
  .action(() => {
    const cwd = process.cwd();
    revokeProject(cwd);
    console.log(`Revoked: ${cwd}`);
  });

program.parse();

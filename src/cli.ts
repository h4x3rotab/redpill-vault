#!/usr/bin/env node
import { Command } from "commander";
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { execSync } from "node:child_process";
import { CONFIG_FILENAME, loadConfig } from "./config.js";
import { runChecks, checkKeys } from "./doctor.js";
import { getRvConfigDir, getMasterKeyPath, approveProject, revokeProject, isApproved } from "./approval.js";

const program = new Command();

program
  .name("rv")
  .description("redpill-vault — secure credential manager for AI tools")
  .version("0.1.0");

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
  try {
    execSync("psst init --global", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PSST_PASSWORD: masterKey },
    });
    console.log("psst vault initialized");
  } catch (err: unknown) {
    const stderr = (err as { stderr?: string }).stderr ?? "";
    const stdout = (err as { stdout?: string }).stdout ?? "";
    if (stderr.includes("already exists") || stdout.includes("already exists")) {
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

  const hookDef = {
    type: "command" as const,
    command: "rv-hook",
  };

  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
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
    // Check if the plugin is installed (hooks/hooks.json handles it)
    let pluginInstalled = false;
    try {
      const out = execSync("claude plugin list 2>/dev/null", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
      pluginInstalled = out.includes("redpill-vault");
    } catch { /* claude not available or plugin not installed */ }

    if (pluginInstalled) {
      console.log("rv-hook provided by plugin (skipping settings.json wiring)");
    } else {
      preToolUse.push({ matcher: "Bash", hooks: [hookDef] });
      console.log("Added rv-hook to .claude/settings.json");
    }
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

program
  .command("list")
  .description("Show secrets from .rv.json with descriptions")
  .action(() => {
    const config = loadConfig();
    if (!config) {
      console.error(`No ${CONFIG_FILENAME} found. Run: rv init`);
      process.exit(1);
    }
    const entries = Object.entries(config.secrets);
    if (entries.length === 0) {
      console.log("No secrets configured. Run: rv add <KEY>");
      return;
    }
    for (const [key, entry] of entries) {
      let line = key;
      if (entry.as) line += ` → ${entry.as}`;
      if (entry.description) line += ` — ${entry.description}`;
      if (entry.tag) line += ` [${entry.tag}]`;
      console.log(line);
    }
  });

program
  .command("add <key>")
  .description("Add a key to .rv.json")
  .option("-d, --description <desc>", "AI-readable description")
  .option("--as <name>", "Rename env var for this project")
  .option("-t, --tag <tag>", "psst tag")
  .action((key: string, opts: { description?: string; as?: string; tag?: string }) => {
    const cwd = process.cwd();
    const rvPath = join(cwd, CONFIG_FILENAME);
    let config = { secrets: {} as Record<string, Record<string, string>> };
    if (existsSync(rvPath)) {
      config = JSON.parse(readFileSync(rvPath, "utf-8"));
    }

    const entry: Record<string, string> = {};
    if (opts.description) entry.description = opts.description;
    if (opts.as) entry.as = opts.as;
    if (opts.tag) entry.tag = opts.tag;

    config.secrets[key] = entry;
    writeFileSync(rvPath, JSON.stringify(config, null, 2) + "\n");
    console.log(`Added ${key} to ${CONFIG_FILENAME}`);

    // Prompt to set in vault if psst available
    try {
      const out = execSync("psst list", { encoding: "utf-8" });
      if (!out.includes(key)) {
        console.log(`Hint: ${key} not in vault — run: psst set ${key}`);
      }
    } catch { /* psst not available */ }
  });

program
  .command("remove <key>")
  .description("Remove a key from .rv.json")
  .action((key: string) => {
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

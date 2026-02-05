#!/usr/bin/env node
import { Command } from "commander";
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { CONFIG_FILENAME, loadConfig, getProjectName, buildScopedKey, parseEnvFile } from "./config.js";
import { runChecks, checkKeys } from "./doctor.js";
import { getRvConfigDir, getMasterKeyPath, approveProject, revokeProject, isApproved } from "./approval.js";
import { Vault, openVault, getVaultKeys, initVault, ensureAuth, VAULT_VERSION } from "./vault/index.js";

const program = new Command();

program
  .name("rv")
  .description("redpill-vault — secure credential manager for AI tools")
  .version("0.2.0");

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

  // 2. Init vault
  ensureAuth();
  const result = initVault({ global: true });
  if (!result.success) {
    console.error("Failed to initialize vault:", result.error);
    process.exit(1);
  }
  if (result.path && Vault.findVaultPath({ global: true })) {
    console.log("Vault initialized at " + result.path);
  } else {
    console.log("Vault already initialized");
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
  console.log("  rv import .env   — import secrets from a .env file");
  console.log("  Edit .rv.json    — choose which keys to inject");
  console.log("  rv approve       — approve this project for secret injection");
}

program
  .command("setup", { hidden: true })
  .description("Alias for init")
  .action(runInit);

program
  .command("list")
  .description("Show secrets from .rv.json with descriptions and source")
  .option("-g, --global", "Show only global keys in vault")
  .action((opts: { global?: boolean }) => {
    const cwd = process.cwd();
    const config = loadConfig();

    if (opts.global) {
      // Show global keys only (exclude PROJECT__KEY scoped keys)
      const vaultKeys = getVaultKeys({ global: true });
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
      console.log("No secrets configured. Edit .rv.json to add keys.");
      return;
    }

    const projectName = getProjectName(config, cwd);
    const vaultKeys = getVaultKeys({ global: true });

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
    console.log("\nTip: rv list -g — show all global keys in vault");
    console.log("     rv set KEY — set a secret | rv rm KEY — remove a secret");
  });

program
  .command("import <envfile> [keys...]")
  .description("Import all secrets from a .env file into the vault (or specify keys to import)")
  .option("-g, --global", "Import as global keys (not project-scoped)")
  .action(async (envfile: string, filterKeys: string[], opts: { global?: boolean }) => {
    const cwd = process.cwd();
    const rvPath = join(cwd, CONFIG_FILENAME);
    const envPath = join(cwd, envfile);

    if (!existsSync(envPath)) {
      console.error(`File not found: ${envfile}`);
      process.exit(1);
    }

    const hasConfig = existsSync(rvPath);
    if (!hasConfig && !opts.global) {
      console.error(`Not in a project (no ${CONFIG_FILENAME}). Use -g for global, or run: rv init`);
      process.exit(1);
    }

    let config: { project?: string; secrets: Record<string, Record<string, string>> } = { secrets: {} };
    if (hasConfig) {
      config = JSON.parse(readFileSync(rvPath, "utf-8"));
    }

    const projectName = hasConfig ? getProjectName(config as any, cwd) : null;

    ensureAuth();
    const vault = openVault({ global: true });
    if (!vault) {
      console.error("Failed to open vault. Run: rv init");
      process.exit(1);
    }

    const entries = parseEnvFile(readFileSync(envPath, "utf-8"));
    if (entries.size === 0) {
      console.error(`No entries found in ${envfile}`);
      vault.close();
      process.exit(1);
    }

    // Filter to specific keys if provided
    const keysToImport = filterKeys.length > 0
      ? [...entries.entries()].filter(([k]) => filterKeys.includes(k))
      : [...entries.entries()];

    if (keysToImport.length === 0) {
      console.error(`None of the specified keys found in ${envfile}`);
      vault.close();
      process.exit(1);
    }

    let imported = 0;
    for (const [key, value] of keysToImport) {
      const vaultKey = opts.global ? key : (projectName ? buildScopedKey(projectName, key) : key);

      try {
        await vault.setSecret(vaultKey, value);
        console.log(`Imported ${key} → ${vaultKey}`);
        imported++;
      } catch (err) {
        console.error(`Failed to import ${key}: ${err instanceof Error ? err.message : "unknown error"}`);
      }

      // Register in .rv.json if not already there
      if (hasConfig && !config.secrets[key]) {
        config.secrets[key] = {};
      }
    }

    vault.close();

    // Save updated config
    if (hasConfig) {
      writeFileSync(rvPath, JSON.stringify(config, null, 2) + "\n");
    }

    console.log(`\nImported ${imported}/${keysToImport.length} secrets.`);
  });

program
  .command("set <key>")
  .description("Set a single secret value (reads from stdin)")
  .option("-g, --global", "Store as global key (not project-scoped)")
  .action(async (key: string, opts: { global?: boolean }) => {
    const cwd = process.cwd();
    const config = loadConfig();
    const projectName = config ? getProjectName(config, cwd) : null;

    if (!opts.global && !projectName) {
      console.error(`Not in a project (no ${CONFIG_FILENAME}). Use -g for global, or run: rv init`);
      process.exit(1);
    }

    const vaultKey = opts.global ? key : (projectName ? buildScopedKey(projectName, key) : key);

    // Read value: prompt if interactive, otherwise read from stdin
    let value = "";
    const isTTY = process.stdin.isTTY;
    if (isTTY) {
      process.stderr.write(`Enter value for ${key}: `);
    }
    for await (const chunk of process.stdin) {
      value += chunk;
      // In interactive mode, stop after first line
      if (isTTY && value.includes("\n")) break;
    }
    value = value.replace(/\n$/, "");

    if (!value) {
      console.error("No value provided on stdin");
      process.exit(1);
    }

    ensureAuth();
    const vault = openVault({ global: true });
    if (!vault) {
      console.error("Failed to open vault. Run: rv init");
      process.exit(1);
    }

    try {
      await vault.setSecret(vaultKey, value);
      console.log(`Set ${vaultKey}`);
    } catch (err) {
      console.error(`Failed to set ${vaultKey}: ${err instanceof Error ? err.message : "unknown error"}`);
      process.exit(1);
    } finally {
      vault.close();
    }
  });

program
  .command("rm <keys...>")
  .description("Remove one or more secrets from the vault")
  .option("-g, --global", "Remove global keys (not project-scoped)")
  .action((keys: string[], opts: { global?: boolean }) => {
    const cwd = process.cwd();
    const config = loadConfig();
    const projectName = config ? getProjectName(config, cwd) : null;

    if (!opts.global && !projectName) {
      console.error(`Not in a project (no ${CONFIG_FILENAME}). Use -g for global, or run: rv init`);
      process.exit(1);
    }

    ensureAuth();
    const vault = openVault({ global: true });
    if (!vault) {
      console.error("Failed to open vault. Run: rv init");
      process.exit(1);
    }

    let failed = false;
    for (const key of keys) {
      const vaultKey = opts.global ? key : (projectName ? buildScopedKey(projectName, key) : key);

      const removed = vault.removeSecret(vaultKey);
      if (removed) {
        console.log(`Removed ${vaultKey}`);
      } else {
        console.error(`Key not found: ${vaultKey}`);
        failed = true;
      }
    }

    vault.close();
    if (failed) process.exit(1);
  });

program
  .command("check")
  .description("Verify all .rv.json keys exist in vault")
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
  .description("Full project setup: master key, vault, .rv.json, and hook wiring")
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

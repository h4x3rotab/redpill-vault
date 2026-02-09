#!/usr/bin/env node
import { readFileSync, existsSync, writeFileSync, unlinkSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { getMasterKeyPath, isApproved } from "./approval.js";
import { buildScopedKey, loadConfig, findConfig, getProjectName } from "./config.js";
import { Vault, ensureAuth, getVaultKeys, openVault } from "./vault/index.js";

/**
 * rv-exec [--project NAME] [--dotenv PATH] [--no-mask] [--all] [KEY1 KEY2...] -- command args...
 *
 * Resolves vault auth, then runs command with secrets injected.
 * With --project, tries PROJECT__KEY first, falls back to KEY.
 * With --dotenv, writes resolved secrets to a .env file before running
 * the command, and deletes it after.
 * With --no-mask, disables secret masking in output.
 * With --all, injects all secrets defined in .rv.json (no need to list keys).
 */

const args = process.argv.slice(2);

// Parse --project argument
let projectName: string | null = null;
let remaining = args;
const projectIndex = remaining.indexOf("--project");
if (projectIndex !== -1 && projectIndex + 1 < remaining.length) {
  projectName = remaining[projectIndex + 1];
  remaining = [...remaining.slice(0, projectIndex), ...remaining.slice(projectIndex + 2)];
}

// Parse --dotenv argument
let dotenvPath: string | null = null;
const dotenvIndex = remaining.indexOf("--dotenv");
if (dotenvIndex !== -1 && dotenvIndex + 1 < remaining.length) {
  dotenvPath = remaining[dotenvIndex + 1];
  remaining = [...remaining.slice(0, dotenvIndex), ...remaining.slice(dotenvIndex + 2)];
}

// Parse --no-mask argument
let noMask = false;
const noMaskIndex = remaining.indexOf("--no-mask");
if (noMaskIndex !== -1) {
  noMask = true;
  remaining = [...remaining.slice(0, noMaskIndex), ...remaining.slice(noMaskIndex + 1)];
}

// Parse --all argument
let injectAll = false;
const allIndex = remaining.indexOf("--all");
if (allIndex !== -1) {
  injectAll = true;
  remaining = [...remaining.slice(0, allIndex), ...remaining.slice(allIndex + 1)];
}

const sepIndex = remaining.indexOf("--");

if (sepIndex === -1 || sepIndex === remaining.length - 1) {
  process.stderr.write("Usage: rv-exec [--all] [--project NAME] [--dotenv PATH] [--no-mask] [KEY...] -- command [args...]\n");
  process.exit(1);
}

const keys = remaining.slice(0, sepIndex);
const command = remaining.slice(sepIndex + 1);

// Auto-detect project and config (findConfig walks up directories)
let configRoot: string | null = null;
let config: ReturnType<typeof loadConfig> = null;
{
  const configPath = findConfig();
  if (configPath) {
    try {
      configRoot = dirname(configPath);
      config = loadConfig();
      if (config && !projectName) {
        projectName = getProjectName(config, configRoot);
      }
    } catch {}
  }
}

// If --all, get keys from config
let effectiveKeys = keys;
if (injectAll) {
  if (!config) {
    process.stderr.write("rv-exec: --all requires .rv.json config\n");
    process.exit(1);
  }
  effectiveKeys = Object.keys(config.secrets);
  if (effectiveKeys.length === 0) {
    process.stderr.write("rv-exec: no secrets defined in .rv.json\n");
    process.exit(1);
  }
}

if (effectiveKeys.length === 0) {
  process.stderr.write("rv-exec: no keys specified (use --all or list keys)\n");
  process.exit(1);
}

// Check if project is approved
if (configRoot && !isApproved(configRoot)) {
  process.stderr.write(
    `rv-exec: project not approved for secret injection\n` +
    `  Run: rv approve\n` +
    `  (in ${configRoot})\n`
  );
  process.exit(1);
}

// Ensure auth and open vault
if (!ensureAuth()) {
  if (!existsSync(getMasterKeyPath())) {
    process.stderr.write(
      `rv-exec: no master key found at ${getMasterKeyPath()}\nRun: rv init\n`,
    );
    process.exit(1);
  }
  process.stderr.write("rv-exec: failed to authenticate with vault\nRun: rv init\n");
  process.exit(1);
}

const vault = openVault({ global: true });
if (!vault) {
  process.stderr.write("rv-exec: failed to open vault\nRun: rv init\n");
  process.exit(1);
}

// Get list of keys in vault
const vaultKeys = getVaultKeys({ global: true });

// Resolve keys: project-scoped fallback, then filter missing
interface ResolvedKey {
  vaultKey: string;  // Key name in vault
  envName: string;   // Env var name for the command
}
const resolvedKeys: ResolvedKey[] = [];
const missingKeys: string[] = [];

for (const keySpec of effectiveKeys) {
  const [key, alias] = keySpec.includes("=") ? keySpec.split("=", 2) : [keySpec, null];
  const envName = alias ?? key;

  // With --project, try project-scoped first
  if (projectName) {
    const projectKey = buildScopedKey(projectName, key);
    if (vaultKeys.has(projectKey)) {
      resolvedKeys.push({ vaultKey: projectKey, envName });
      continue;
    }
  }

  // Fallback to global key
  if (vaultKeys.has(key)) {
    resolvedKeys.push({ vaultKey: key, envName });
    continue;
  }

  // Key not found anywhere
  missingKeys.push(envName);
}

if (missingKeys.length > 0) {
  process.stderr.write(`rv-exec: missing secrets (skipped): ${missingKeys.join(", ")}\n`);
  process.stderr.write(`  Fix with: rv import .env  or  rv set KEY_NAME\n`);
}

// If no keys resolved, run command directly without secrets
if (resolvedKeys.length === 0) {
  vault.close();
  if (dotenvPath) {
    // Write empty dotenv file so the command doesn't fail on missing file
    writeFileSync(dotenvPath, "", { mode: 0o600 });
  }
  const child = spawn(command[0], command.slice(1), {
    stdio: "inherit",
    env: { ...process.env, PSST_PASSWORD: undefined },
  });
  child.on("exit", (code) => {
    if (dotenvPath) {
      try { unlinkSync(dotenvPath); } catch {}
    }
    process.exit(code ?? 1);
  });
} else {
  // Get secrets from vault
  (async () => {
    const secrets = new Map<string, string>();
    for (const { vaultKey, envName } of resolvedKeys) {
      const value = await vault.getSecret(vaultKey);
      if (value !== null) {
        secrets.set(envName, value);
      }
    }
    vault.close();

    // Write dotenv file if requested
    if (dotenvPath) {
      const lines = [...secrets.entries()].map(([k, v]) => `${k}=${v}`);
      writeFileSync(dotenvPath, lines.join("\n") + "\n", { mode: 0o600 });
    }

    // Build environment with secrets
    const env = {
      ...process.env,
      ...Object.fromEntries(secrets),
    };
    // Remove PSST_PASSWORD from child env for safety
    delete env.PSST_PASSWORD;

    // Execute command
    const [cmd, ...cmdArgs] = command;
    const shouldMask = !noMask;
    const secretValues = shouldMask
      ? Array.from(secrets.values()).filter((v) => v.length > 0)
      : [];

    const child = spawn(cmd, cmdArgs, {
      env,
      stdio: shouldMask ? ["inherit", "pipe", "pipe"] : "inherit",
    });

    if (shouldMask && child.stdout && child.stderr) {
      child.stdout.on("data", (data: Buffer) => {
        process.stdout.write(maskSecrets(data.toString(), secretValues));
      });

      child.stderr.on("data", (data: Buffer) => {
        process.stderr.write(maskSecrets(data.toString(), secretValues));
      });
    }

    child.on("error", (err) => {
      process.stderr.write("rv-exec: failed to execute: " + err.message + "\n");
      if (dotenvPath) {
        try { unlinkSync(dotenvPath); } catch {}
      }
      process.exit(2);
    });

    child.on("exit", (code) => {
      if (dotenvPath) {
        try { unlinkSync(dotenvPath); } catch {}
      }
      process.exit(code ?? 0);
    });
  })();
}

function maskSecrets(text: string, secrets: string[]): string {
  let masked = text;
  for (const secret of secrets) {
    masked = masked.split(secret).join("[REDACTED]");
  }
  return masked;
}

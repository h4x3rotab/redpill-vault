import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, CONFIG_FILENAME } from "./config.js";
import { getMasterKeyPath, isApproved } from "./approval.js";
import { Vault, openVault, getVaultKeys, VAULT_VERSION } from "./vault/index.js";

export interface Check {
  name: string;
  ok: boolean;
  message: string;
}

export function runChecks(cwd: string = process.cwd()): Check[] {
  const checks: Check[] = [];

  // 1. vault library working
  checks.push({ name: "vault", ok: true, message: `vault v${VAULT_VERSION} available` });

  // 2. master key exists
  if (existsSync(getMasterKeyPath())) {
    checks.push({ name: "master key", ok: true, message: "master key found" });
  } else {
    checks.push({ name: "master key", ok: false, message: "master key not found — run: rv init" });
  }

  // 3. project approved
  if (isApproved(cwd)) {
    checks.push({ name: "project approved", ok: true, message: "project is approved" });
  } else {
    checks.push({ name: "project approved", ok: false, message: "project not approved — run: rv approve" });
  }

  // 4. vault exists and accessible
  const vaultPath = Vault.findVaultPath({ global: true });
  if (vaultPath) {
    checks.push({ name: "vault storage", ok: true, message: "vault accessible" });
  } else {
    checks.push({ name: "vault storage", ok: false, message: "vault not accessible — run: rv init" });
  }

  // 5. .rv.json exists
  const configPath = join(cwd, CONFIG_FILENAME);
  if (existsSync(configPath)) {
    checks.push({ name: CONFIG_FILENAME, ok: true, message: "config found" });
  } else {
    checks.push({ name: CONFIG_FILENAME, ok: false, message: `${CONFIG_FILENAME} not found — run: rv init` });
  }

  // 6. hook configured
  const hookPath = join(cwd, ".claude", "settings.json");
  if (existsSync(hookPath)) {
    checks.push({ name: "hook config", ok: true, message: ".claude/settings.json exists" });
  } else {
    checks.push({ name: "hook config", ok: false, message: "hook not configured — run: rv init" });
  }

  // 7. keys present in vault
  if (vaultPath) {
    const config = loadConfig(cwd);
    if (config) {
      const vaultKeys = getVaultKeys({ global: true });
      for (const key of Object.keys(config.secrets)) {
        const found = vaultKeys.has(key);
        checks.push({
          name: `key: ${key}`,
          ok: found,
          message: found ? "in vault" : "NOT in vault — run: rv set " + key,
        });
      }
    }
  }

  return checks;
}

export function checkKeys(cwd: string = process.cwd()): Check[] {
  const config = loadConfig(cwd);
  if (!config) return [{ name: CONFIG_FILENAME, ok: false, message: "no config found" }];

  const vaultKeys = getVaultKeys({ global: true });
  if (vaultKeys.size === 0 && !Vault.findVaultPath({ global: true })) {
    return [{ name: "vault", ok: false, message: "cannot access vault" }];
  }

  const checks: Check[] = [];
  for (const key of Object.keys(config.secrets)) {
    const found = vaultKeys.has(key);
    checks.push({
      name: key,
      ok: found,
      message: found ? "present in vault" : "MISSING — run: rv set " + key,
    });
  }
  return checks;
}

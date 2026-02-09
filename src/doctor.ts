import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { loadConfig, findConfig, CONFIG_FILENAME, getProjectName, buildScopedKey } from "./config.js";
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

  // 3. vault exists and accessible
  const vaultPath = Vault.findVaultPath({ global: true });
  if (vaultPath) {
    checks.push({ name: "vault storage", ok: true, message: "vault accessible" });
  } else {
    checks.push({ name: "vault storage", ok: false, message: "vault not accessible — run: rv init" });
  }

  // 4. .rv.json exists
  const configPath = findConfig(cwd);
  const configRoot = configPath ? dirname(configPath) : cwd;
  if (configPath) {
    checks.push({ name: CONFIG_FILENAME, ok: true, message: "config found" });
  } else {
    checks.push({ name: CONFIG_FILENAME, ok: false, message: `${CONFIG_FILENAME} not found — run: rv init` });
  }

  // 5. project approved
  if (isApproved(configRoot)) {
    checks.push({ name: "project approved", ok: true, message: "project approved for secret injection" });
  } else {
    checks.push({ name: "project approved", ok: false, message: "project not approved — run: rv approve" });
  }

  // 6. keys present in vault
  if (vaultPath) {
    const config = loadConfig(cwd);
    if (config) {
      const vaultKeys = getVaultKeys({ global: true });
      const projectName = getProjectName(config, configRoot);
      for (const key of Object.keys(config.secrets)) {
        const projectKey = projectName ? buildScopedKey(projectName, key) : null;
        const hasProjectKey = projectKey && vaultKeys.has(projectKey);
        const hasGlobalKey = vaultKeys.has(key);
        const found = hasProjectKey || hasGlobalKey;
        const source = hasProjectKey ? "project" : hasGlobalKey ? "global" : null;
        checks.push({
          name: `key: ${key}`,
          ok: found,
          message: found ? `in vault [${source}]` : "NOT in vault — run: rv set " + key,
        });
      }
    }
  }

  return checks;
}

export function checkKeys(cwd: string = process.cwd()): Check[] {
  const config = loadConfig(cwd);
  if (!config) return [{ name: CONFIG_FILENAME, ok: false, message: "no config found" }];

  const configPath = findConfig(cwd);
  const configRoot = configPath ? dirname(configPath) : cwd;

  const vaultKeys = getVaultKeys({ global: true });
  if (vaultKeys.size === 0 && !Vault.findVaultPath({ global: true })) {
    return [{ name: "vault", ok: false, message: "cannot access vault" }];
  }

  const projectName = getProjectName(config, configRoot);
  const checks: Check[] = [];
  for (const key of Object.keys(config.secrets)) {
    const projectKey = projectName ? buildScopedKey(projectName, key) : null;
    const hasProjectKey = projectKey && vaultKeys.has(projectKey);
    const hasGlobalKey = vaultKeys.has(key);
    const found = hasProjectKey || hasGlobalKey;
    const source = hasProjectKey ? "project" : hasGlobalKey ? "global" : null;
    checks.push({
      name: key,
      ok: found,
      message: found ? `present in vault [${source}]` : "MISSING — run: rv set " + key,
    });
  }
  return checks;
}

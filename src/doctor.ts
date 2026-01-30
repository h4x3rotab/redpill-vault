import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, CONFIG_FILENAME } from "./config.js";
import { getMasterKeyPath, isApproved } from "./approval.js";

export interface Check {
  name: string;
  ok: boolean;
  message: string;
}

export function runChecks(cwd: string = process.cwd()): Check[] {
  const checks: Check[] = [];

  // 1. psst installed
  let psstInstalled = false;
  try {
    execSync("psst --version", { stdio: "pipe" });
    psstInstalled = true;
    checks.push({ name: "psst installed", ok: true, message: "psst is available" });
  } catch {
    checks.push({ name: "psst installed", ok: false, message: "psst not found — install from https://github.com/Michaelliv/psst" });
  }

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

  // 4. psst vault exists
  if (psstInstalled) {
    try {
      execSync("psst --global list", { stdio: "pipe" });
      checks.push({ name: "psst vault", ok: true, message: "vault accessible" });
    } catch {
      checks.push({ name: "psst vault", ok: false, message: "vault not accessible — run: rv init" });
    }
  }

  // 3. .rv.json exists
  const configPath = join(cwd, CONFIG_FILENAME);
  if (existsSync(configPath)) {
    checks.push({ name: CONFIG_FILENAME, ok: true, message: "config found" });
  } else {
    checks.push({ name: CONFIG_FILENAME, ok: false, message: `${CONFIG_FILENAME} not found — run: rv init` });
  }

  // 4. hook configured
  const hookPath = join(cwd, ".claude", "settings.json");
  if (existsSync(hookPath)) {
    checks.push({ name: "hook config", ok: true, message: ".claude/settings.json exists" });
  } else {
    checks.push({ name: "hook config", ok: false, message: "hook not configured — run: rv init" });
  }

  // 5. keys present in vault
  if (psstInstalled) {
    const config = loadConfig(cwd);
    if (config) {
      let vaultKeys: string[] = [];
      try {
        const out = execSync("psst --global list", { encoding: "utf-8" });
        vaultKeys = out.trim().split("\n").filter(Boolean);
      } catch { /* empty */ }
      for (const key of Object.keys(config.secrets)) {
        const found = vaultKeys.some(line => line.includes(key));
        checks.push({
          name: `key: ${key}`,
          ok: found,
          message: found ? "in vault" : "NOT in vault — run: psst set " + key,
        });
      }
    }
  }

  return checks;
}

export function checkKeys(cwd: string = process.cwd()): Check[] {
  const config = loadConfig(cwd);
  if (!config) return [{ name: CONFIG_FILENAME, ok: false, message: "no config found" }];

  let vaultKeys: string[] = [];
  try {
    const out = execSync("psst --global list", { encoding: "utf-8" });
    vaultKeys = out.trim().split("\n").filter(Boolean);
  } catch {
    return [{ name: "psst", ok: false, message: "cannot list vault keys" }];
  }

  const checks: Check[] = [];
  for (const key of Object.keys(config.secrets)) {
    const found = vaultKeys.some(line => line.includes(key));
    checks.push({
      name: key,
      ok: found,
      message: found ? "present in vault" : "MISSING — run: psst set " + key,
    });
  }
  return checks;
}

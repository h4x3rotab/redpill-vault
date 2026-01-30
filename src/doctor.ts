import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, CONFIG_FILENAME } from "./config.js";
import { runPsst } from "./psst.js";
import { getMasterKeyPath, isApproved } from "./approval.js";

export interface Check {
  name: string;
  ok: boolean;
  message: string;
}

function psstList(): { ok: boolean; output: string } {
  const result = runPsst(["--global", "list"], { encoding: "utf-8" });
  if (result.status === 0) {
    return { ok: true, output: result.stdout ?? "" };
  }
  return { ok: false, output: "" };
}

export function runChecks(cwd: string = process.cwd()): Check[] {
  const checks: Check[] = [];

  // 1. psst installed
  let psstInstalled = false;
  const version = runPsst(["--version"], { stdio: "pipe", encoding: "utf-8" });
  if (version.status === 0) {
    psstInstalled = true;
    checks.push({ name: "psst installed", ok: true, message: "psst is available" });
  } else {
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
    const list = psstList();
    if (list.ok) {
      checks.push({ name: "psst vault", ok: true, message: "vault accessible" });
    } else {
      checks.push({ name: "psst vault", ok: false, message: "vault not accessible — run: rv init" });
    }
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
  if (psstInstalled) {
    const config = loadConfig(cwd);
    if (config) {
      let vaultKeys: string[] = [];
      const list = psstList();
      if (list.ok) {
        vaultKeys = list.output.trim().split("\n").filter(Boolean);
      }
      for (const key of Object.keys(config.secrets)) {
        const found = vaultKeys.some(line => line.trim() === key || line.trim().startsWith(key + " "));
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

  const list = psstList();
  if (!list.ok) {
    return [{ name: "psst", ok: false, message: "cannot list vault keys" }];
  }
  const vaultKeys = list.output.trim().split("\n").filter(Boolean);

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

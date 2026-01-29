import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface SecretEntry {
  description?: string;
  as?: string;
  tag?: string;
}

export interface RvConfig {
  secrets: Record<string, SecretEntry>;
}

export const CONFIG_FILENAME = ".rv.json";

export function findConfig(cwd: string = process.cwd()): string | null {
  const p = join(cwd, CONFIG_FILENAME);
  return existsSync(p) ? p : null;
}

export function loadConfig(cwd: string = process.cwd()): RvConfig | null {
  const p = findConfig(cwd);
  if (!p) return null;
  const raw = JSON.parse(readFileSync(p, "utf-8"));
  return validateConfig(raw);
}

export function validateConfig(raw: unknown): RvConfig {
  if (typeof raw !== "object" || raw === null || !("secrets" in raw)) {
    throw new Error(".rv.json must have a \"secrets\" object");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.secrets !== "object" || obj.secrets === null) {
    throw new Error(".rv.json \"secrets\" must be an object");
  }
  const secrets = obj.secrets as Record<string, unknown>;
  for (const [key, val] of Object.entries(secrets)) {
    if (typeof val !== "object" || val === null) {
      throw new Error(`Secret "${key}" must be an object`);
    }
    const entry = val as Record<string, unknown>;
    if (entry.description !== undefined && typeof entry.description !== "string") {
      throw new Error(`Secret "${key}".description must be a string`);
    }
    if (entry.as !== undefined && typeof entry.as !== "string") {
      throw new Error(`Secret "${key}".as must be a string`);
    }
    if (entry.tag !== undefined && typeof entry.tag !== "string") {
      throw new Error(`Secret "${key}".tag must be a string`);
    }
  }
  return raw as RvConfig;
}

/** Build the psst key arguments from config. Returns keys in psst CLI format. */
export function buildPsstArgs(config: RvConfig): string[] {
  const args: string[] = [];
  for (const [key, entry] of Object.entries(config.secrets)) {
    if (entry.as) {
      // psst supports KEY=ALIAS to rename env vars
      args.push(`${key}=${entry.as}`);
    } else {
      args.push(key);
    }
  }
  return args;
}

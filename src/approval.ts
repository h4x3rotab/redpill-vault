import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export function getRvConfigDir(): string {
  return process.env.RV_CONFIG_DIR ?? join(homedir(), ".config", "rv");
}

export function getApprovedPath(): string {
  return join(getRvConfigDir(), "approved.json");
}

export function getMasterKeyPath(): string {
  return join(getRvConfigDir(), "master-key");
}

interface ApprovalEntry {
  approvedAt: string;
}

type ApprovalStore = Record<string, ApprovalEntry>;

function loadStore(): ApprovalStore {
  const p = getApprovedPath();
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return {};
  }
}

function saveStore(store: ApprovalStore): void {
  mkdirSync(getRvConfigDir(), { recursive: true });
  writeFileSync(getApprovedPath(), JSON.stringify(store, null, 2) + "\n");
}

export function isApproved(cwd: string): boolean {
  const store = loadStore();
  return cwd in store;
}

export function approveProject(cwd: string): void {
  const store = loadStore();
  store[cwd] = { approvedAt: new Date().toISOString() };
  saveStore(store);
}

export function revokeProject(cwd: string): void {
  const store = loadStore();
  delete store[cwd];
  saveStore(store);
}

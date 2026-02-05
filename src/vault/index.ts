/**
 * Vault module - secure secret storage
 *
 * Usage:
 *   import { openVault, getVaultKeys } from "./vault/index.js";
 *   const vault = openVault({ global: true });
 *   const value = await vault.getSecret("MY_KEY");
 */

export { Vault, type Secret, type SecretMeta } from "./vault.js";
export { encrypt, decrypt, keyToBuffer, generateKey } from "./crypto.js";

import { existsSync, readFileSync } from "node:fs";
import { Vault } from "./vault.js";
import { getMasterKeyPath } from "../approval.js";

export const VAULT_VERSION = "0.3.0";

/**
 * Ensure PSST_PASSWORD is set (from master key file if not already set)
 */
export function ensureAuth(): boolean {
  if (process.env.PSST_PASSWORD) return true;

  const mkPath = getMasterKeyPath();
  if (existsSync(mkPath)) {
    const key = readFileSync(mkPath, "utf-8").trim();
    if (key) {
      process.env.PSST_PASSWORD = key;
      return true;
    }
  }
  return false;
}

/**
 * Open the global vault (ensures auth and unlocks)
 * Returns null if vault doesn't exist or can't be unlocked
 */
export function openVault(options: { global?: boolean } = {}): Vault | null {
  const vaultPath = Vault.findVaultPath({ global: options.global ?? true });
  if (!vaultPath) return null;

  ensureAuth();
  const vault = new Vault(vaultPath);
  if (!vault.unlock()) {
    vault.close();
    return null;
  }
  return vault;
}

/**
 * Get set of all key names in the vault
 */
export function getVaultKeys(options: { global?: boolean } = {}): Set<string> {
  const vault = openVault(options);
  if (!vault) return new Set();

  try {
    const secrets = vault.listSecrets();
    return new Set(secrets.map(s => s.name));
  } finally {
    vault.close();
  }
}

/**
 * Initialize the vault (creates directory and database)
 */
export function initVault(options: { global?: boolean } = {}): { success: boolean; error?: string; path?: string } {
  const vaultPath = Vault.getVaultPath(options.global ?? true);

  // Check if already exists
  if (Vault.findVaultPath({ global: options.global ?? true })) {
    return { success: true, path: vaultPath };
  }

  const result = Vault.initializeVault(vaultPath);
  if (result.success) {
    return { success: true, path: vaultPath };
  }
  return result;
}

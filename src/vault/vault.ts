/**
 * Vendored from @pssst/cli - vault storage
 * Adapted for Node.js: better-sqlite3 instead of bun:sqlite, no keychain
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { encrypt, decrypt, keyToBuffer } from "./crypto.js";

const VAULT_DIR_NAME = ".psst";
const DB_NAME = "vault.db";

export interface Secret {
  name: string;
  value: string;
  tags: string[];
  created_at: string;
  updated_at: string;
}

export interface SecretMeta {
  name: string;
  tags: string[];
  created_at: string;
  updated_at: string;
}

export class Vault {
  private db: Database.Database;
  private key: Buffer | null = null;
  private vaultPath: string;

  constructor(vaultPath: string) {
    this.vaultPath = vaultPath;
    const dbPath = join(vaultPath, DB_NAME);
    this.db = new Database(dbPath);
    this.initSchema();
  }

  private initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS secrets (
        name TEXT PRIMARY KEY,
        encrypted_value BLOB NOT NULL,
        iv BLOB NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Migration: add tags column if it doesn't exist
    const columns = this.db.pragma("table_info(secrets)") as { name: string }[];
    const hasTagsColumn = columns.some((col) => col.name === "tags");
    if (!hasTagsColumn) {
      this.db.exec("ALTER TABLE secrets ADD COLUMN tags TEXT DEFAULT '[]'");
    }
  }

  /**
   * Unlock vault using PSST_PASSWORD (no keychain)
   */
  unlock(): boolean {
    if (process.env.PSST_PASSWORD) {
      this.key = keyToBuffer(process.env.PSST_PASSWORD);
      return true;
    }
    return false;
  }

  isUnlocked(): boolean {
    return this.key !== null;
  }

  async setSecret(name: string, value: string, tags?: string[]): Promise<void> {
    if (!this.key) throw new Error("Vault is locked");

    const { encrypted, iv } = await encrypt(value, this.key);
    const tagsJson = JSON.stringify(tags || []);

    const stmt = this.db.prepare(`
      INSERT INTO secrets (name, encrypted_value, iv, tags, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(name) DO UPDATE SET
        encrypted_value = excluded.encrypted_value,
        iv = excluded.iv,
        tags = excluded.tags,
        updated_at = CURRENT_TIMESTAMP
    `);
    stmt.run(name, encrypted, iv, tagsJson);
  }

  async getSecret(name: string): Promise<string | null> {
    if (!this.key) throw new Error("Vault is locked");

    const stmt = this.db.prepare("SELECT encrypted_value, iv FROM secrets WHERE name = ?");
    const row = stmt.get(name) as { encrypted_value: Buffer; iv: Buffer } | undefined;

    if (!row) return null;

    return decrypt(row.encrypted_value, row.iv, this.key);
  }

  async getSecrets(names: string[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();

    for (const name of names) {
      const value = await this.getSecret(name);
      if (value !== null) {
        result.set(name, value);
      }
    }

    return result;
  }

  listSecrets(filterTags?: string[]): SecretMeta[] {
    const stmt = this.db.prepare("SELECT name, tags, created_at, updated_at FROM secrets ORDER BY name");
    const rows = stmt.all() as { name: string; tags: string; created_at: string; updated_at: string }[];

    const secrets = rows.map((row) => ({
      name: row.name,
      tags: JSON.parse(row.tags || "[]") as string[],
      created_at: row.created_at,
      updated_at: row.updated_at,
    }));

    // Filter by tags if specified (OR logic - any matching tag)
    if (filterTags && filterTags.length > 0) {
      return secrets.filter((s) => s.tags.some((t) => filterTags.includes(t)));
    }

    return secrets;
  }

  removeSecret(name: string): boolean {
    const stmt = this.db.prepare("DELETE FROM secrets WHERE name = ?");
    const result = stmt.run(name);
    return result.changes > 0;
  }

  close() {
    this.db.close();
  }

  /**
   * Initialize a new vault (requires PSST_PASSWORD to be set)
   */
  static initializeVault(vaultPath: string): { success: boolean; error?: string } {
    if (!process.env.PSST_PASSWORD) {
      return {
        success: false,
        error: "PSST_PASSWORD must be set to initialize vault",
      };
    }

    // Create vault directory and database
    if (!existsSync(vaultPath)) {
      mkdirSync(vaultPath, { recursive: true });
    }

    // Initialize database
    const vault = new Vault(vaultPath);
    vault.close();

    return { success: true };
  }

  static findVaultPath(options: { global?: boolean; env?: string } = {}): string | null {
    const { global = false, env } = options;

    // Determine base path based on scope (no fallback between local and global)
    const basePath = global
      ? join(homedir(), VAULT_DIR_NAME)
      : join(process.cwd(), VAULT_DIR_NAME);

    // If env specified, look for env-specific vault only
    if (env) {
      const envPath = join(basePath, "envs", env);
      if (existsSync(join(envPath, DB_NAME))) {
        return envPath;
      }
      return null;
    }

    // No env specified: check legacy path first, then default env
    // Legacy: .psst/vault.db (no envs folder)
    if (existsSync(join(basePath, DB_NAME))) {
      return basePath;
    }

    // Default env: .psst/envs/default/vault.db
    const defaultEnvPath = join(basePath, "envs", "default");
    if (existsSync(join(defaultEnvPath, DB_NAME))) {
      return defaultEnvPath;
    }

    return null;
  }

  static getVaultPath(global: boolean = false, env?: string): string {
    const basePath = global
      ? join(homedir(), VAULT_DIR_NAME)
      : join(process.cwd(), VAULT_DIR_NAME);

    if (env) {
      return join(basePath, "envs", env);
    }

    return basePath;
  }
}

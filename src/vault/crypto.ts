/**
 * Vendored from @pssst/cli - crypto utilities
 * Adapted for Node.js (removed Bun dependencies)
 */

import { createHash, randomBytes } from "node:crypto";

const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 12; // 96 bits for GCM

/**
 * Convert a key string (base64 or password) to a 32-byte buffer
 */
export function keyToBuffer(key: string): Buffer {
  // If it looks like base64 and decodes to 32 bytes, use directly
  try {
    const decoded = Buffer.from(key, "base64");
    if (decoded.length === KEY_LENGTH) {
      return decoded;
    }
  } catch {}

  // Otherwise, derive key from the string using SHA-256
  return createHash("sha256").update(key).digest();
}

export async function encrypt(
  plaintext: string,
  key: Buffer
): Promise<{ encrypted: Buffer; iv: Buffer }> {
  const iv = randomBytes(IV_LENGTH);

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(key),
    { name: "AES-GCM" },
    false,
    ["encrypt"]
  );

  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: new Uint8Array(iv) },
    cryptoKey,
    new TextEncoder().encode(plaintext)
  );

  return {
    encrypted: Buffer.from(encrypted),
    iv,
  };
}

export async function decrypt(
  encrypted: Buffer,
  iv: Buffer,
  key: Buffer
): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(key),
    { name: "AES-GCM" },
    false,
    ["decrypt"]
  );

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: new Uint8Array(iv) },
    cryptoKey,
    new Uint8Array(encrypted)
  );

  return new TextDecoder().decode(decrypted);
}

/**
 * Generate a random encryption key (base64)
 */
export function generateKey(): string {
  return randomBytes(32).toString("base64");
}

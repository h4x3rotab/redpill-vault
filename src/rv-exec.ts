#!/usr/bin/env node
import { runPsst } from "./psst.js";
import { readFileSync, existsSync, writeFileSync, unlinkSync } from "node:fs";
import { getMasterKeyPath } from "./approval.js";
import { buildScopedKey } from "./config.js";

/**
 * rv-exec [--project NAME] [--dotenv PATH] KEY1 KEY2 -- command args...
 *
 * Resolves psst auth (keychain or master-key file), then execs psst.
 * With --project, tries PROJECT__KEY first, falls back to KEY.
 * With --dotenv, writes resolved secrets to a .env file before running
 * the command, and deletes it after.
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

const sepIndex = remaining.indexOf("--");

if (sepIndex === -1 || sepIndex === remaining.length - 1) {
  process.stderr.write("Usage: rv-exec [--project NAME] [--dotenv PATH] KEY1 [KEY2...] -- command [args...]\n");
  process.exit(1);
}

const keys = remaining.slice(0, sepIndex);
const command = remaining.slice(sepIndex + 1);

if (keys.length === 0) {
  process.stderr.write("rv-exec: no keys specified\n");
  process.exit(1);
}

// Check if keychain auth works by running `psst list`
let useKeychain = false;
try {
  const probe = runPsst(["--global", "list"], { stdio: "pipe", timeout: 5000, encoding: "utf-8" });
  if (probe.status === 0) {
    useKeychain = true;
  }
} catch {
  // keychain not available
}

// If no keychain, load master key
if (!useKeychain) {
  if (!existsSync(getMasterKeyPath())) {
    process.stderr.write(
      `rv-exec: no keychain and no master key found at ${getMasterKeyPath()}\nRun: rv init\n`,
    );
    process.exit(1);
  }
  const masterKey = readFileSync(getMasterKeyPath(), "utf-8").trim();
  if (!masterKey) {
    process.stderr.write("rv-exec: master key file is empty\nRun: rv init\n");
    process.exit(1);
  }
  process.env.PSST_PASSWORD = masterKey;
}

// Resolve keys with project-scoped fallback
let resolvedKeys = keys;
if (projectName) {
  // Get list of keys in vault to check which exist
  const listResult = runPsst(["--global", "list"], {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });
  const vaultKeys = new Set<string>();
  if (listResult.status === 0) {
    for (const line of (listResult.stdout ?? "").split("\n")) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) {
        // psst list format: "● KEY" — strip bullet point and whitespace
        const withoutBullet = trimmed.replace(/^[●•]\s*/, "");
        const key = withoutBullet.split("=")[0].split(/\s+/)[0];
        if (key && /^[A-Z_][A-Z0-9_]*$/.test(key)) vaultKeys.add(key);
      }
    }
  }

  // For each key, prefer project-scoped if it exists (PROJECT__KEY format)
  resolvedKeys = keys.map(keySpec => {
    // Handle KEY=ALIAS format
    const [key, alias] = keySpec.includes("=") ? keySpec.split("=", 2) : [keySpec, null];
    const projectKey = buildScopedKey(projectName, key);

    // Check project-scoped first, fallback to global
    const resolvedKey = vaultKeys.has(projectKey) ? projectKey : key;

    // Env var name: alias if set, otherwise original key name
    const envName = alias ?? key;

    // Always use alias format when vault key differs from env name
    return resolvedKey !== envName ? `${resolvedKey}=${envName}` : resolvedKey;
  });
}

// Write dotenv file if requested
if (dotenvPath) {
  // Collect env var names from resolved keys
  const envNames = resolvedKeys.map(spec => {
    const parts = spec.split("=");
    return parts.length > 1 ? parts[1] : parts[0];
  });

  // Use psst to run a shell command that outputs KEY=VALUE for each env var
  const printParts = envNames.map(n => `printf '%s=%s\\n' '${n}' "\$${n}"`).join("; ");
  const dumpResult = runPsst(
    ["--global", ...resolvedKeys, "--", "sh", "-c", printParts],
    { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], env: process.env },
  );

  if (dumpResult.status === 0 && dumpResult.stdout) {
    writeFileSync(dotenvPath, dumpResult.stdout, { mode: 0o600 });
  } else {
    const stderr = (dumpResult.stderr ?? "").trim();
    process.stderr.write(`rv-exec: failed to generate dotenv file${stderr ? ": " + stderr : ""}\n`);
    process.exit(1);
  }
}

// Exec psst with the resolved keys and command (always use global vault)
try {
  const psstArgs = ["--global", ...resolvedKeys, "--", ...command];
  const result = runPsst(psstArgs, {
    stdio: ["inherit", "inherit", "pipe"],
    env: process.env,
    encoding: "utf-8",
  });

  if (result.status !== 0) {
    // Rewrite psst error messages to avoid exposing internals
    const stderr = (result.stderr ?? "").trim();
    if (stderr) {
      const cleaned = stderr
        .replace(/psst\s+set\s+/g, "rv set ")
        .replace(/\bpsst\b/g, "rv");
      process.stderr.write(cleaned + "\n");
    }
  }

  process.exit(result.status ?? 1);
} finally {
  // Clean up dotenv file
  if (dotenvPath) {
    try { unlinkSync(dotenvPath); } catch {}
  }
}

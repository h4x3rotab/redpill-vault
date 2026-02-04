#!/usr/bin/env node
import { runPsst } from "./psst.js";
import { readFileSync, existsSync } from "node:fs";
import { getMasterKeyPath } from "./approval.js";
import { buildScopedKey } from "./config.js";

/**
 * rv-exec [--project NAME] KEY1 KEY2 -- command args...
 *
 * Resolves psst auth (keychain or master-key file), then execs psst.
 * With --project, tries {project}/KEY first, falls back to KEY.
 */

const args = process.argv.slice(2);

// Parse --project argument
let projectName: string | null = null;
let argsWithoutProject = args;
const projectIndex = args.indexOf("--project");
if (projectIndex !== -1 && projectIndex + 1 < args.length) {
  projectName = args[projectIndex + 1];
  argsWithoutProject = [...args.slice(0, projectIndex), ...args.slice(projectIndex + 2)];
}

const sepIndex = argsWithoutProject.indexOf("--");

if (sepIndex === -1 || sepIndex === argsWithoutProject.length - 1) {
  process.stderr.write("Usage: rv-exec [--project NAME] KEY1 [KEY2...] -- command [args...]\n");
  process.exit(1);
}

const keys = argsWithoutProject.slice(0, sepIndex);
const command = argsWithoutProject.slice(sepIndex + 1);

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

    // Preserve alias if present
    return alias ? `${resolvedKey}=${alias}` : resolvedKey;
  });
}

// Exec psst with the resolved keys and command (always use global vault)
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

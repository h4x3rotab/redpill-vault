#!/usr/bin/env node
import { runPsst } from "./psst.js";
import { readFileSync, existsSync } from "node:fs";
import { getMasterKeyPath } from "./approval.js";

/**
 * rv-exec KEY1 KEY2 -- command args...
 *
 * Resolves psst auth (keychain or master-key file), then execs psst.
 */

const args = process.argv.slice(2);
const sepIndex = args.indexOf("--");

if (sepIndex === -1 || sepIndex === args.length - 1) {
  process.stderr.write("Usage: rv-exec KEY1 [KEY2...] -- command [args...]\n");
  process.exit(1);
}

const keys = args.slice(0, sepIndex);
const command = args.slice(sepIndex + 1);

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

// Exec psst with the keys and command (always use global vault)
const psstArgs = ["--global", ...keys, "--", ...command];
const result = runPsst(psstArgs, {
  stdio: "inherit",
  env: process.env,
});

process.exit(result.status ?? 1);

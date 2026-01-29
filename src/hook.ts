#!/usr/bin/env node
import { loadConfig, buildPsstArgs } from "./config.js";

interface HookInput {
  tool_name: string;
  tool_input: {
    command?: string;
    [key: string]: unknown;
  };
  cwd?: string;
}

interface HookResult {
  decision?: "block" | "approve";
  reason?: string;
  updatedInput?: { command: string };
}

const BLOCKED_PATTERNS = [
  /^psst\s+get\b/,
  /^psst\s+export\b/,
  /\bcat\b.*vault\.db/,
  /^env\s*$/,
  /^env\s+-/,
  /^printenv\b/,
  /\bsqlite3?\b.*vault\.db/,
];

const SKIP_PREFIXES = ["psst ", "rv "];
const SAFE_PSST = [/^psst\s+list\b/, /^psst\s+set\b/, /^psst\s+rm\b/, /^psst\s+init\b/, /^psst\s+scan\b/, /^psst\s+install-hook\b/, /^psst\s+import\b/];

function processCommand(command: string, cwd?: string): HookResult {
  const trimmed = command.trim();

  // Block dangerous commands
  for (const pat of BLOCKED_PATTERNS) {
    if (pat.test(trimmed)) {
      return {
        decision: "block",
        reason: "redpill-vault: blocked — this command could expose secret values",
      };
    }
  }

  // Skip: already wrapped or rv command
  for (const prefix of SKIP_PREFIXES) {
    if (trimmed.startsWith(prefix)) {
      // Allow safe psst subcommands
      for (const safe of SAFE_PSST) {
        if (safe.test(trimmed)) return {};
      }
      // If it's a psst command that's not explicitly safe and not blocked, pass through
      if (trimmed.startsWith("psst ")) return {};
      // rv commands pass through
      return {};
    }
  }

  // Try to load config and wrap
  const config = loadConfig(cwd);
  if (!config || Object.keys(config.secrets).length === 0) {
    return {}; // no config or no secrets → passthrough
  }

  const psstArgs = buildPsstArgs(config);
  const wrapped = `psst ${psstArgs.join(" ")} -- ${command}`;
  return { updatedInput: { command: wrapped } };
}

async function main() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  if (!input.trim()) {
    process.exit(0);
  }

  let parsed: HookInput;
  try {
    parsed = JSON.parse(input);
  } catch {
    // Not JSON — passthrough
    return;
  }

  // Only handle Bash tool
  if (parsed.tool_name !== "Bash" || !parsed.tool_input?.command) {
    return;
  }

  const result = processCommand(parsed.tool_input.command, parsed.cwd);

  if (result.decision === "block") {
    process.stderr.write(result.reason + "\n");
    process.exit(2);
  }

  if (result.updatedInput) {
    const output = {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        updatedInput: { command: result.updatedInput.command },
      },
    };
    process.stdout.write(JSON.stringify(output));
  }

  process.exit(0);
}

main();

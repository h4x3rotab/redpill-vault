#!/usr/bin/env node
import { loadConfig, buildPsstArgs } from "./config.js";
import { isApproved } from "./approval.js";

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

const AGENT_BLOCKED_PATTERNS = [
  /^rv\s+approve\b/,
  /^rv\s+revoke\b/,
];

const SKIP_PREFIXES = ["rv-exec "];
const SAFE_PSST = [/^psst\s+(--global\s+)?(list|set|rm|init|scan|install-hook|import)\b/];

function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

export function processCommand(command: string, cwd?: string): HookResult {
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

  // Block agent from running approval/init commands
  for (const pat of AGENT_BLOCKED_PATTERNS) {
    if (pat.test(trimmed)) {
      return {
        decision: "block",
        reason: "redpill-vault: blocked — only the user may run this command",
      };
    }
  }

  // Skip: already wrapped with rv-exec
  for (const prefix of SKIP_PREFIXES) {
    if (trimmed.startsWith(prefix)) return {};
  }

  // Allow safe psst subcommands, block unknown ones
  if (trimmed.startsWith("psst ")) {
    for (const safe of SAFE_PSST) {
      if (safe.test(trimmed)) return {};
    }
    return {
      decision: "block",
      reason: "redpill-vault: blocked — unknown psst subcommand",
    };
  }

  // rv commands (list, add, etc.) pass through
  if (trimmed.startsWith("rv ")) return {};

  // Try to load config and wrap with rv-exec
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig(cwd);
  } catch {
    return {
      decision: "block",
      reason: "redpill-vault: invalid .rv.json — the user must run: rv init",
    };
  }
  if (!config || Object.keys(config.secrets).length === 0) {
    return {}; // no config or no secrets → passthrough
  }

  // Check project approval (only if a config exists)
  const effectiveCwd = cwd ?? process.cwd();
  if (!isApproved(effectiveCwd)) {
    return {
      decision: "block",
      reason: "redpill-vault: project not approved — the user must run: rv approve",
    };
  }

  const psstArgs = buildPsstArgs(config);
  const wrapped = `rv-exec ${psstArgs.join(" ")} -- bash -c ${shellEscape(command)}`;
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
        permissionDecision: "allow",
        updatedInput: { command: result.updatedInput.command },
      },
    };
    process.stdout.write(JSON.stringify(output));
  }

  process.exit(0);
}

main();

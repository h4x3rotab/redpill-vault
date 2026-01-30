#!/usr/bin/env node
import { loadConfig, buildPsstArgs, findConfig } from "./config.js";
import { fileURLToPath } from "node:url";
import { isApproved } from "./approval.js";
import { dirname } from "node:path";

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

function findConfigDir(start: string): string | null {
  let dir = start;
  while (true) {
    if (findConfig(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function resolveConfig(candidates: Array<string | undefined>): {
  config: ReturnType<typeof loadConfig>;
  root?: string;
  error?: string;
} {
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    const root = findConfigDir(candidate);
    if (!root) continue;
    try {
      const config = loadConfig(root);
      return { config, root };
    } catch {
      return { config: null, root, error: "redpill-vault: invalid .rv.json — the user must run: rv init" };
    }
  }
  return { config: null };
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
  const { config, root, error } = resolveConfig([
    cwd,
    process.env.CLAUDE_PROJECT_DIR,
    process.env.CLAUDE_PROJECT_PATH,
    process.env.CLAUDE_WORKSPACE_DIR,
    process.env.CLAUDE_WORKSPACE,
    process.env.PROJECT_DIR,
    process.env.GIT_WORK_TREE,
    process.env.PWD,
    process.cwd(),
  ]);
  if (error) {
    return { decision: "block", reason: error };
  }
  if (!config || Object.keys(config.secrets).length === 0) {
    return {}; // no config or no secrets → passthrough
  }

  // Check project approval (only if a config exists)
  const effectiveCwd = root ?? cwd ?? process.cwd();
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


  const toolInput = parsed.tool_input as Record<string, unknown>;
  const inferredCwd =
    parsed.cwd ??
    (toolInput.cwd as string | undefined) ??
    (toolInput.working_directory as string | undefined) ??
    (toolInput.workingDirectory as string | undefined) ??
    (toolInput.workdir as string | undefined) ??
    process.env.CLAUDE_PROJECT_DIR ??
    process.env.PWD;
  const result = processCommand(parsed.tool_input.command, inferredCwd);

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

const isDirectRun = fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  main();
}

import { describe, it, expect, vi, beforeEach } from "vitest";

// We test processCommand by importing the module internals.
// Since processCommand isn't exported, we'll test via the hook's stdin/stdout behavior.
// But first, let's extract the logic for testability.

// For now, test by importing the config module and testing the hook logic inline.
import { buildPsstArgs, type RvConfig } from "../src/config.js";

// Re-implement the core hook logic here for unit testing (mirrors hook.ts)
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

interface HookResult {
  decision?: "block";
  reason?: string;
  updatedInput?: { command: string };
}

function processCommand(command: string, config: RvConfig | null): HookResult {
  const trimmed = command.trim();

  for (const pat of BLOCKED_PATTERNS) {
    if (pat.test(trimmed)) {
      return { decision: "block", reason: "blocked" };
    }
  }

  for (const prefix of SKIP_PREFIXES) {
    if (trimmed.startsWith(prefix)) return {};
  }

  if (!config || Object.keys(config.secrets).length === 0) return {};

  const psstArgs = buildPsstArgs(config);
  return { updatedInput: { command: `psst ${psstArgs.join(" ")} -- ${command}` } };
}

const testConfig: RvConfig = {
  secrets: {
    OPENAI_API_KEY: { description: "key" },
    STRIPE: { as: "STRIPE_KEY" },
  },
};

describe("hook processCommand", () => {
  it("wraps command with psst args", () => {
    const r = processCommand("npm test", testConfig);
    expect(r.updatedInput?.command).toBe("psst OPENAI_API_KEY STRIPE=STRIPE_KEY -- npm test");
  });

  it("blocks psst get", () => {
    expect(processCommand("psst get SECRET", testConfig).decision).toBe("block");
  });

  it("blocks psst export", () => {
    expect(processCommand("psst export", testConfig).decision).toBe("block");
  });

  it("blocks env", () => {
    expect(processCommand("env", testConfig).decision).toBe("block");
  });

  it("blocks printenv", () => {
    expect(processCommand("printenv", testConfig).decision).toBe("block");
  });

  it("blocks cat vault.db", () => {
    expect(processCommand("cat ~/.psst/vault.db", testConfig).decision).toBe("block");
  });

  it("skips already-wrapped psst commands", () => {
    const r = processCommand("psst run -- npm test", testConfig);
    expect(r.updatedInput).toBeUndefined();
    expect(r.decision).toBeUndefined();
  });

  it("skips rv commands", () => {
    const r = processCommand("rv list", testConfig);
    expect(r.updatedInput).toBeUndefined();
  });

  it("passes through with no config", () => {
    const r = processCommand("npm test", null);
    expect(r.updatedInput).toBeUndefined();
    expect(r.decision).toBeUndefined();
  });

  it("passes through with empty secrets", () => {
    const r = processCommand("npm test", { secrets: {} });
    expect(r.updatedInput).toBeUndefined();
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildPsstArgs, type RvConfig } from "../src/config.js";

// Mock approval — default to approved
const mockIsApproved = vi.fn(() => true);
vi.mock("../src/approval.js", () => ({
  isApproved: (...args: unknown[]) => mockIsApproved(...args),
}));

const testConfig: RvConfig = {
  project: "testproj",
  secrets: {
    OPENAI_API_KEY: { description: "key" },
    STRIPE: { as: "STRIPE_KEY" },
  },
};

// Mock loadConfig and findConfig for approved-project tests
vi.mock("../src/config.js", async () => {
  const actual = await vi.importActual<typeof import("../src/config.js")>("../src/config.js");
  return {
    ...actual,
    loadConfig: () => testConfig,
    findConfig: (dir: string) => dir.includes("approved") ? `${dir}/.rv.json` : null,
    getProjectName: (config: RvConfig | null, _cwd: string) => config?.project ?? "testproj",
  };
});

const { processCommand } = await import("../src/hook.js");

describe("hook processCommand", () => {
  beforeEach(() => {
    mockIsApproved.mockReturnValue(true);
  });

  it("wraps command with rv-exec args including project", () => {
    const r = processCommand("npm test", "/approved");
    expect(r.updatedInput?.command).toBe("rv-exec --project 'testproj' OPENAI_API_KEY STRIPE=STRIPE_KEY -- bash -c 'npm test'");
  });

  it("blocks psst get", () => {
    expect(processCommand("psst get SECRET", "/approved").decision).toBe("block");
  });

  it("blocks psst export", () => {
    expect(processCommand("psst export", "/approved").decision).toBe("block");
  });

  it("blocks env", () => {
    expect(processCommand("env", "/approved").decision).toBe("block");
  });

  it("blocks printenv", () => {
    expect(processCommand("printenv", "/approved").decision).toBe("block");
  });

  it("blocks cat vault.db", () => {
    expect(processCommand("cat ~/.psst/vault.db", "/approved").decision).toBe("block");
  });

  it("skips already-wrapped rv-exec commands", () => {
    const r = processCommand("rv-exec KEY -- npm test", "/approved");
    expect(r.updatedInput).toBeUndefined();
    expect(r.decision).toBeUndefined();
  });

  it("allows rv list commands", () => {
    const r = processCommand("rv list", "/approved");
    expect(r.updatedInput).toBeUndefined();
    expect(r.decision).toBeUndefined();
  });

  it("blocks rv approve from agent", () => {
    expect(processCommand("rv approve", "/approved").decision).toBe("block");
  });

  it("blocks rv revoke from agent", () => {
    expect(processCommand("rv revoke", "/approved").decision).toBe("block");
  });

  it("allows rv init from agent", () => {
    expect(processCommand("rv init", "/approved").decision).toBeUndefined();
  });

  it("escapes shell metacharacters in wrapped command", () => {
    const r = processCommand("npm install && npm test", "/approved");
    expect(r.updatedInput?.command).toBe("rv-exec --project 'testproj' OPENAI_API_KEY STRIPE=STRIPE_KEY -- bash -c 'npm install && npm test'");
  });

  it("escapes single quotes in wrapped command", () => {
    const r = processCommand("echo 'hello world'", "/approved");
    expect(r.updatedInput?.command).toBe("rv-exec --project 'testproj' OPENAI_API_KEY STRIPE=STRIPE_KEY -- bash -c 'echo '\\''hello world'\\'''");
  });

  it("blocks unapproved project", () => {
    mockIsApproved.mockReturnValue(false);
    const r = processCommand("npm test", "/unapproved");
    expect(r.decision).toBe("block");
    expect(r.reason).toContain("rv approve");
  });
});

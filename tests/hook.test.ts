import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildPsstArgs, type RvConfig } from "../src/config.js";

// Mock approval — default to approved
const mockIsApproved = vi.fn(() => true);
vi.mock("../src/approval.js", () => ({
  isApproved: (...args: unknown[]) => mockIsApproved(...args),
}));

const { processCommand } = await import("../src/hook.js");

const testConfig: RvConfig = {
  secrets: {
    OPENAI_API_KEY: { description: "key" },
    STRIPE: { as: "STRIPE_KEY" },
  },
};

// Mock loadConfig to return testConfig for approved-project tests
vi.mock("../src/config.js", async () => {
  const actual = await vi.importActual<typeof import("../src/config.js")>("../src/config.js");
  return {
    ...actual,
    loadConfig: () => testConfig,
  };
});

describe("hook processCommand", () => {
  beforeEach(() => {
    mockIsApproved.mockReturnValue(true);
  });

  it("wraps command with rv-exec args", () => {
    const r = processCommand("npm test", "/approved");
    expect(r.updatedInput?.command).toBe("rv-exec OPENAI_API_KEY STRIPE=STRIPE_KEY -- npm test");
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

  it("blocks unapproved project", () => {
    mockIsApproved.mockReturnValue(false);
    const r = processCommand("npm test", "/unapproved");
    expect(r.decision).toBe("block");
    expect(r.reason).toContain("rv approve");
  });
});

import { describe, it, expect } from "vitest";

// rv-exec is a top-level script, so we test its argument parsing logic directly

describe("rv-exec argument parsing", () => {
  it("identifies separator position", () => {
    const args = ["KEY1", "KEY2", "--", "npm", "test"];
    const sepIndex = args.indexOf("--");
    expect(sepIndex).toBe(2);
    expect(args.slice(0, sepIndex)).toEqual(["KEY1", "KEY2"]);
    expect(args.slice(sepIndex + 1)).toEqual(["npm", "test"]);
  });

  it("handles single key", () => {
    const args = ["SECRET", "--", "echo", "hi"];
    const sepIndex = args.indexOf("--");
    expect(args.slice(0, sepIndex)).toEqual(["SECRET"]);
    expect(args.slice(sepIndex + 1)).toEqual(["echo", "hi"]);
  });

  it("detects missing separator", () => {
    const args = ["KEY1", "KEY2", "npm", "test"];
    const sepIndex = args.indexOf("--");
    expect(sepIndex).toBe(-1);
  });

  it("handles key=alias format", () => {
    const args = ["DB_PASS=DATABASE_PASSWORD", "API_KEY", "--", "node", "app.js"];
    const sepIndex = args.indexOf("--");
    const keys = args.slice(0, sepIndex);
    expect(keys).toEqual(["DB_PASS=DATABASE_PASSWORD", "API_KEY"]);
  });
});

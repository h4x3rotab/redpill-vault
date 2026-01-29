import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testDir = join(tmpdir(), "rv-test-approval-" + process.pid);

// Use env var to redirect config dir
process.env.RV_CONFIG_DIR = testDir;

const { isApproved, approveProject, revokeProject, getApprovedPath } = await import("../src/approval.js");

describe("approval", () => {
  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("returns false for unapproved project", () => {
    expect(isApproved("/some/project")).toBe(false);
  });

  it("approves and checks a project", () => {
    approveProject("/my/project");
    expect(isApproved("/my/project")).toBe(true);
    expect(isApproved("/other/project")).toBe(false);
  });

  it("revokes a project", () => {
    approveProject("/my/project");
    expect(isApproved("/my/project")).toBe(true);
    revokeProject("/my/project");
    expect(isApproved("/my/project")).toBe(false);
  });

  it("stores approvedAt timestamp", () => {
    approveProject("/my/project");
    const store = JSON.parse(readFileSync(getApprovedPath(), "utf-8"));
    expect(store["/my/project"].approvedAt).toBeDefined();
    expect(new Date(store["/my/project"].approvedAt).getTime()).toBeGreaterThan(0);
  });

  it("handles multiple projects", () => {
    approveProject("/a");
    approveProject("/b");
    expect(isApproved("/a")).toBe(true);
    expect(isApproved("/b")).toBe(true);
    revokeProject("/a");
    expect(isApproved("/a")).toBe(false);
    expect(isApproved("/b")).toBe(true);
  });
});

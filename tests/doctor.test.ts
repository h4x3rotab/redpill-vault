import { describe, it, expect } from "vitest";
// Doctor tests are integration-level (need psst + filesystem).
// We do basic import validation here; full testing requires a real environment.

describe("doctor module", () => {
  it("exports runChecks and checkKeys", async () => {
    const mod = await import("../src/doctor.js");
    expect(typeof mod.runChecks).toBe("function");
    expect(typeof mod.checkKeys).toBe("function");
  });
});

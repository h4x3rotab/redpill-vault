import { describe, it, expect } from "vitest";
import { validateConfig, buildPsstArgs } from "../src/config.js";

describe("validateConfig", () => {
  it("accepts valid config", () => {
    const config = validateConfig({
      secrets: {
        OPENAI_API_KEY: { description: "OpenAI key" },
        STRIPE: { as: "STRIPE_KEY", tag: "pay" },
      },
    });
    expect(Object.keys(config.secrets)).toHaveLength(2);
  });

  it("rejects missing secrets", () => {
    expect(() => validateConfig({})).toThrow("must have");
  });

  it("rejects non-object secret entry", () => {
    expect(() => validateConfig({ secrets: { KEY: "bad" } })).toThrow("must be an object");
  });

  it("rejects bad description type", () => {
    expect(() => validateConfig({ secrets: { K: { description: 42 } } })).toThrow("description must be a string");
  });

  it("accepts empty secrets", () => {
    const config = validateConfig({ secrets: {} });
    expect(config.secrets).toEqual({});
  });
});

describe("buildPsstArgs", () => {
  it("returns keys", () => {
    const args = buildPsstArgs({ secrets: { A: {}, B: {} } });
    expect(args).toEqual(["A", "B"]);
  });

  it("renames with as", () => {
    const args = buildPsstArgs({ secrets: { A: { as: "X" } } });
    expect(args).toEqual(["A=X"]);
  });
});

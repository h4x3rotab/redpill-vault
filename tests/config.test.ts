import { describe, it, expect } from "vitest";
import { validateConfig, buildPsstArgs, getProjectName, normalizeProjectName, buildScopedKey, parseEnvFile } from "../src/config.js";

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

  it("accepts project field", () => {
    const config = validateConfig({ project: "myapp", secrets: {} });
    expect(config.project).toBe("myapp");
  });

  it("rejects non-string project", () => {
    expect(() => validateConfig({ project: 123, secrets: {} })).toThrow("\"project\" must be a string");
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

describe("getProjectName", () => {
  it("returns null for null config", () => {
    expect(getProjectName(null, "/some/path")).toBeNull();
  });

  it("returns explicit project name", () => {
    const config = { project: "myapp", secrets: {} };
    expect(getProjectName(config, "/some/other/path")).toBe("myapp");
  });

  it("derives from directory basename when project not set", () => {
    const config = { secrets: {} };
    expect(getProjectName(config, "/home/user/myproject")).toBe("myproject");
  });

  it("explicit project overrides directory name", () => {
    const config = { project: "custom", secrets: {} };
    expect(getProjectName(config, "/home/user/myproject")).toBe("custom");
  });
});

describe("normalizeProjectName", () => {
  it("converts to uppercase", () => {
    expect(normalizeProjectName("myapp")).toBe("MYAPP");
  });

  it("converts hyphens to underscores", () => {
    expect(normalizeProjectName("my-app")).toBe("MY_APP");
  });

  it("converts dots to underscores", () => {
    expect(normalizeProjectName("my.app")).toBe("MY_APP");
  });

  it("collapses multiple underscores", () => {
    expect(normalizeProjectName("my--app")).toBe("MY_APP");
  });

  it("strips leading/trailing underscores", () => {
    expect(normalizeProjectName("-myapp-")).toBe("MYAPP");
  });

  it("handles mixed case and special chars", () => {
    expect(normalizeProjectName("My-Cool.App_v2")).toBe("MY_COOL_APP_V2");
  });
});

describe("buildScopedKey", () => {
  it("builds PROJECT__KEY format", () => {
    expect(buildScopedKey("myapp", "GITHUB_TOKEN")).toBe("MYAPP__GITHUB_TOKEN");
  });

  it("normalizes project name", () => {
    expect(buildScopedKey("my-app", "API_KEY")).toBe("MY_APP__API_KEY");
  });

  it("handles complex project names", () => {
    expect(buildScopedKey("my.cool-app", "SECRET")).toBe("MY_COOL_APP__SECRET");
  });
});

describe("parseEnvFile", () => {
  it("parses simple KEY=value pairs", () => {
    const result = parseEnvFile("FOO=bar\nBAZ=qux");
    expect(result.get("FOO")).toBe("bar");
    expect(result.get("BAZ")).toBe("qux");
  });

  it("strips double quotes", () => {
    const result = parseEnvFile('SECRET="my secret value"');
    expect(result.get("SECRET")).toBe("my secret value");
  });

  it("strips single quotes", () => {
    const result = parseEnvFile("SECRET='my secret value'");
    expect(result.get("SECRET")).toBe("my secret value");
  });

  it("handles export prefix", () => {
    const result = parseEnvFile("export API_KEY=abc123");
    expect(result.get("API_KEY")).toBe("abc123");
  });

  it("skips comments and blank lines", () => {
    const result = parseEnvFile("# comment\n\nKEY=val\n  # another comment");
    expect(result.size).toBe(1);
    expect(result.get("KEY")).toBe("val");
  });

  it("handles values with = in them", () => {
    const result = parseEnvFile("DATABASE_URL=postgres://user:pass@host/db?opt=1");
    expect(result.get("DATABASE_URL")).toBe("postgres://user:pass@host/db?opt=1");
  });

  it("skips lines without =", () => {
    const result = parseEnvFile("NOVALUE\nKEY=val");
    expect(result.size).toBe(1);
  });

  it("handles empty values", () => {
    const result = parseEnvFile("EMPTY=");
    expect(result.get("EMPTY")).toBe("");
  });
});

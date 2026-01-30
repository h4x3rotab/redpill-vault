import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from "node:child_process";
import { createRequire } from "node:module";

let cachedBin: string | null | undefined;

export function getPsstBin(): string | null {
  if (cachedBin !== undefined) return cachedBin;
  try {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve("@pssst/cli/package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { bin?: string | Record<string, string> };
    const pkgDir = dirname(pkgPath);
    const binShim = join(pkgDir, "..", ".bin", "psst");
    if (existsSync(binShim)) {
      cachedBin = binShim;
      return cachedBin;
    }
    const binRel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.psst;
    if (binRel) {
      const direct = join(pkgDir, binRel);
      if (existsSync(direct)) {
        cachedBin = direct;
        return cachedBin;
      }
    }
    cachedBin = null;
  } catch {
    cachedBin = null;
  }
  return cachedBin;
}

type PsstOptions = Omit<SpawnSyncOptionsWithStringEncoding, "encoding"> & {
  encoding?: BufferEncoding;
};

export function runPsst(
  args: string[],
  options: PsstOptions = {},
): SpawnSyncReturns<string> {
  const bin = getPsstBin();
  if (!bin) {
    return {
      pid: 0,
      output: [],
      stdout: "",
      stderr: "",
      status: null,
      signal: null,
      error: new Error("psst not found"),
    };
  }
  const merged = { encoding: "utf-8", ...options } as SpawnSyncOptionsWithStringEncoding;
  return spawnSync(bin, args, merged);
}

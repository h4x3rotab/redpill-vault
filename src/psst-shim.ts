#!/usr/bin/env node
import { runPsst } from "./psst.js";

const result = runPsst(process.argv.slice(2), { stdio: "inherit" });

if (result.error) {
  process.stderr.write("psst not available (redpill-vault dependency missing)\n");
  process.exit(1);
}

process.exit(result.status ?? 1);

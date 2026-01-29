# CLAUDE.md

## Project

redpill-vault — secure credential manager for AI tools. Transparent secret injection via psst, with an approval gate so the agent never sees secret values or the master key.

Single global vault design: one master key at `~/.config/rv/master-key`, one psst vault at `~/.psst/`, per-project `.rv.json` selects which keys get injected.

## Structure

```
src/
  cli.ts        — rv CLI (init, approve, revoke, setup, list, add, remove, check, doctor)
  hook.ts       — Claude Code PreToolUse hook (approval gate, command rewriting, blocking)
  rv-exec.ts    — wrapper binary that resolves psst auth + execs psst (agent never sees master key)
  approval.ts   — approval store CRUD (~/.config/rv/approved.json)
  config.ts     — .rv.json loader/validator
  doctor.ts     — health checks
tests/
  *.test.ts     — vitest unit tests
  integration.sh — bash integration + e2e with claude -p
```

## Development

- `npm run build` — compile TypeScript
- `npm test` — run vitest unit tests (29 tests)
- `bash tests/integration.sh` — run integration + e2e tests (19 tests, requires psst + claude)

## Architecture notes

- **psst requires `--global` for every command** when using the global vault (init, set, list, key injection). Without it, psst looks for a local `.psst/` directory and silently fails.
- **psst redacts output by default.** Secret values appear as `[REDACTED]` in stdout. Use `--no-mask` only for debugging.
- **psst init exits non-zero when vault already exists.** The "already exists" message goes to stdout, not stderr. Both streams must be checked.
- **`RV_CONFIG_DIR` env var** overrides the default `~/.config/rv/` location. Used by tests to isolate state without faking HOME.
- **Don't fake HOME in integration tests** — it breaks claude auth, git config, etc. Use targeted env vars (`RV_CONFIG_DIR`) instead. Restore real HOME for any claude invocations.

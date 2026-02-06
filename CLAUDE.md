# CLAUDE.md

## Project

redpill-vault — secure credential manager for AI tools. Secrets are stored in an encrypted vault and injected into commands via `rv-exec`. The agent never sees secret values or the master key.

Single global vault design: one master key at `~/.config/rv/master-key`, one vault at `~/.psst/`, per-project `.rv.json` selects which keys get injected. Supports project-scoped credentials with automatic fallback to global keys.

## Structure

```
src/
  cli.ts        — rv CLI (init, list, import, set, rm, check, doctor)
  rv-exec.ts    — runs commands with secrets injected from vault
  approval.ts   — config dir helpers (~/.config/rv/)
  config.ts     — .rv.json loader/validator
  doctor.ts     — health checks
  vault/
    vault.ts    — Vault class (SQLite + AES-GCM encryption)
    crypto.ts   — encryption utilities
    index.ts    — module exports
tests/
  *.test.ts     — vitest unit tests
.claude-plugin/
  marketplace.json — Claude Code marketplace manifest
skills/
  redpill-vault/
    SKILL.md    — skill instructions for Claude
    setup.sh    — one-time installer (npm i -g from plugin root)
```

## Development

- `npm run build` — compile TypeScript
- `npm test` — run vitest unit tests (40 tests)

## Architecture notes

- **`rv init`** creates master key, initializes vault, writes `.rv.json`. Idempotent.
- **`rv-exec --all -- command`** injects all secrets from `.rv.json` into the command's environment.
- **`rv-exec` auto-detects project** by walking up directories to find `.rv.json`.
- **Vault uses AES-GCM encryption** with a master key stored at `~/.config/rv/master-key`.
- **Key names must be uppercase with underscores only.** Project-scoped keys use `PROJECT__KEY` format.
- **`RV_CONFIG_DIR` env var** overrides the default `~/.config/rv/` location.

## Project-scoped credentials

Each project can have its own credentials that override global ones. Resolution order: `PROJECT__KEY` → `KEY`.

- **Project name** comes from `.rv.json` `"project"` field, or `basename(cwd)` if not set.
- **Vault key format:** `PROJECT__KEY` (double underscore, all uppercase).
- **`rv list`** shows `[project]`, `[global]`, or `[missing]` source for each key.
- **`rv import .env`** imports keys into vault (project-scoped by default, `-g` for global).
- **`rv set KEY`** sets a single secret from stdin. Does not modify `.rv.json`.
- **`rv rm KEY`** removes a secret from vault. Does not modify `.rv.json`.
- **`rv-exec --dotenv PATH`** writes secrets to a temp `.env` file before running, deletes after.
- **`rv-exec --all`** injects all secrets from `.rv.json` without listing them.

## Claude Code plugin conventions

- **`setup.sh` lives in the skill directory** (`skills/redpill-vault/setup.sh`).
- **Use `SCRIPT_DIR` to self-locate in shell scripts**, not `CLAUDE_PLUGIN_ROOT`.
- **Skills must be explicitly invoked.** SKILL.md instructions are only visible after Claude invokes the skill.

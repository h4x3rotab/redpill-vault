# CLAUDE.md

## Project

redpill-vault — secure credential manager for AI tools. Transparent secret injection via psst, with an approval gate so the agent never sees secret values or the master key.

Single global vault design: one master key at `~/.config/rv/master-key`, one psst vault at `~/.psst/`, per-project `.rv.json` selects which keys get injected.

## Structure

```
src/
  cli.ts        — rv CLI (init, approve, revoke, list, add, remove, check, doctor)
  hook.ts       — Claude Code PreToolUse hook (approval gate, command rewriting, blocking)
  rv-exec.ts    — wrapper binary that resolves psst auth + execs psst (agent never sees master key)
  approval.ts   — approval store CRUD (~/.config/rv/approved.json)
  config.ts     — .rv.json loader/validator
  doctor.ts     — health checks
tests/
  *.test.ts           — vitest unit tests
  integration.sh      — bash integration + e2e with claude -p
  plugin-e2e.sh       — plugin artifact validation + rv init tests
  plugin-onboarding.sh — full cold-start onboarding flow (requires claude CLI)
.claude-plugin/
  marketplace.json    — Claude Code marketplace manifest
hooks/
  hooks.json          — PreToolUse hook (runs rv-hook directly)
skills/
  redpill-vault/
    SKILL.md          — skill instructions for Claude
    setup.sh          — one-time installer (npm i -g from plugin root)
```

## Development

- `npm run build` — compile TypeScript
- `npm test` — run vitest unit tests (31 tests)
- `bash tests/integration.sh` — run integration + e2e tests (19 tests, requires psst + claude)
- `bash tests/plugin-e2e.sh` — plugin artifact validation + rv init (14 tests)
- `bash tests/plugin-onboarding.sh` — full plugin onboarding flow (16 tests, requires claude CLI)

## Architecture notes

- **`rv init` is the single setup command** (idempotent). Creates master key, inits psst vault, writes `.rv.json`, wires hook. `rv setup` is a hidden alias.
- **psst requires `--global` for every command** when using the global vault (init, set, list, key injection). Without it, psst looks for a local `.psst/` directory and silently fails.
- **psst redacts output by default.** Secret values appear as `[REDACTED]` in stdout. Use `--no-mask` only for debugging.
- **psst init exits non-zero when vault already exists.** The "already exists" message goes to stdout, not stderr. Both streams must be checked.
- **`RV_CONFIG_DIR` env var** overrides the default `~/.config/rv/` location. Used by tests to isolate state without faking HOME.
- **`RV_INSTALL_SOURCE` env var** overrides the npm package name in `setup.sh`. Set to a local path for testing the bootstrap flow.
- **Don't fake HOME in integration tests** — it breaks claude auth, git config, etc. Use targeted env vars (`RV_CONFIG_DIR`) instead. Restore real HOME for any claude invocations.
- **Unknown psst subcommands are blocked by default.** Only explicitly safe commands (list, set, rm, init, scan, install-hook, import) pass through the hook.
- **Plugin hook deduplication.** `rv init` skips wiring into `.claude/settings.json` if the plugin is installed (detected via `claude plugin list`). The plugin's `hooks/hooks.json` handles it instead.

## Claude Code plugin conventions

- **Hooks should be minimal.** `hooks/hooks.json` calls the binary directly (`rv-hook`). If it's not installed, the command fails silently. Installation belongs in the skill, not the hook.
- **`setup.sh` lives in the skill directory** (`skills/redpill-vault/setup.sh`). SKILL.md references it as `./skills/redpill-vault/setup.sh` — this path resolves relative to the plugin cache root.
- **Use `SCRIPT_DIR` to self-locate in shell scripts**, not `CLAUDE_PLUGIN_ROOT`. Pattern: `SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"`. Then navigate to the package root with `"$SCRIPT_DIR/../.."`.
- **Never tell Claude to run `npm i -g <package-name>`.** It doesn't work. Instead, `setup.sh` installs from the plugin's own directory (`npm i -g "$PROJECT_DIR"`).
- **Skills must be explicitly invoked.** SKILL.md instructions are only visible after Claude invokes the skill via the Skill tool. Tests must use `--allowedTools "Bash,Skill"` and prompt with "Use the redpill-vault skill to...".
- **Plugin cache uses git commit hashes.** Uncommitted changes won't appear in the cached plugin. Always commit before testing plugin behavior.

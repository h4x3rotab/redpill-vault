# Development Notes

Session-specific learnings and debugging notes that don't belong in CLAUDE.md.

## 2025-01-30: Move setup.sh from hook to skill

### Problem
`hooks/hooks.json` ran `bash ${CLAUDE_PLUGIN_ROOT}/setup.sh` on every Bash command to check if rv was installed. Wasteful.

### What didn't work
- **`CLAUDE_PLUGIN_ROOT` in SKILL.md** — this env var is expanded by the shell in hooks, but SKILL.md is just text Claude reads. Claude would type the literal `${CLAUDE_PLUGIN_ROOT}` and it's not reliably set in the agent's shell environment.
- **Telling Claude to run `npm i -g redpill-vault`** — doesn't work from within Claude Code. The agent can't install npm packages by name.
- **`./skills/redpill-vault/setup.sh` without committing first** — plugin cache keys on git commit hash. Uncommitted changes are invisible to the installed plugin.
- **`--allowedTools "Bash"` without `Skill`** — Claude never invoked the skill, so it never saw the SKILL.md setup instructions. It just said "rv not found, how do I install it?"
- **Vague prompt like "Set up redpill-vault"** — Claude recognized the tool but didn't invoke the skill. Needed explicit "Use the redpill-vault skill to..." phrasing.

### What worked
Copied the dev-browser pattern exactly:
1. `setup.sh` in `skills/redpill-vault/` with `SCRIPT_DIR` self-location
2. SKILL.md references `./skills/redpill-vault/setup.sh` (resolves from plugin cache root)
3. `hooks/hooks.json` calls `rv-hook` directly — no setup.sh wrapper
4. Tests use `--allowedTools "Bash,Skill"` and prompt "Use the redpill-vault skill to..."

### Reference
dev-browser repo: https://github.com/SawyerHood/dev-browser — the canonical example of a Claude Code plugin with skills.

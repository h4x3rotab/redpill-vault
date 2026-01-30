#!/usr/bin/env bash
# Bootstrap hook for redpill-vault Claude Code plugin.
#
# Called on every Bash command via hooks.json.
# If rv-hook is installed: delegates to it immediately.
# If not: installs redpill-vault globally, then delegates.
#
# After first install, the overhead is just `command -v rv-hook` + exec.

if command -v rv-hook &>/dev/null; then
  exec rv-hook
fi

# First run: install redpill-vault
npm i -g "${RV_INSTALL_SOURCE:-redpill-vault}" >&2 2>&1 || {
  echo "redpill-vault: install failed — run: npm i -g redpill-vault" >&2
  exit 0  # Don't block Claude if install fails
}

if command -v rv-hook &>/dev/null; then
  exec rv-hook
fi

exit 0

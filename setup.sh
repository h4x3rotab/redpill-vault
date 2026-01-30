#!/usr/bin/env bash
# Gate script for redpill-vault Claude Code plugin.
# If rv-hook is installed, delegates to it. Otherwise exits cleanly
# and lets the skill guide Claude through installation.

if command -v rv-hook &>/dev/null; then
  exec rv-hook
fi

# rv-hook not installed — pass through silently.
# The skill (SKILL.md) will guide Claude to run: npm i -g redpill-vault
exit 0

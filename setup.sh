#!/usr/bin/env bash
set -euo pipefail

# Install redpill-vault globally from npm.
# Called by the skill (SKILL.md) during first-time setup.
# The PreToolUse hook requires rv-hook on PATH, so global install is mandatory.

if command -v rv-hook &>/dev/null; then
  echo "redpill-vault is already installed ($(rv --version))"
  exit 0
fi

echo "Installing redpill-vault from npm..."
npm i -g redpill-vault

echo "Installed: $(rv --version)"
echo "Binaries: rv, rv-hook, rv-exec"

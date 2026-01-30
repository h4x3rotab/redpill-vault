#!/usr/bin/env bash
# Bootstrap script for redpill-vault Claude Code plugin.
# Ensures rv-hook is installed, then delegates to it.
#
# Set RV_INSTALL_SOURCE to a local path to install from source (for testing).
# Default: installs from npm registry.

if ! command -v rv-hook &>/dev/null; then
  if ! npm i -g "${RV_INSTALL_SOURCE:-redpill-vault}" >&2 2>&1; then
    echo "redpill-vault: failed to install — run: npm i -g redpill-vault" >&2
    # Pass through: don't block Claude if install fails
    exit 0
  fi
fi

if ! command -v rv-hook &>/dev/null; then
  # Install succeeded but rv-hook still not on PATH (npm prefix issue?)
  echo "redpill-vault: rv-hook not found after install — check npm global bin path" >&2
  exit 0
fi

exec rv-hook

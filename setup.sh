#!/usr/bin/env bash
# Bootstrap script for redpill-vault Claude Code plugin.
# Ensures rv-hook is installed, then delegates to it.
#
# Set RV_INSTALL_SOURCE to a local path to install from source (for testing).
# Default: installs from npm registry.
set -euo pipefail

if ! command -v rv-hook &>/dev/null; then
  npm i -g "${RV_INSTALL_SOURCE:-redpill-vault}" >&2
fi

exec rv-hook

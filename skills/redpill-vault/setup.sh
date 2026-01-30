#!/usr/bin/env bash
# One-time installer for redpill-vault.
#
# Called from SKILL.md when rv is not yet installed.
# RV_INSTALL_SOURCE overrides the package name (for testing with local source).

if command -v rv &>/dev/null; then
  echo "redpill-vault is already installed"
  exit 0
fi

npm i -g "${RV_INSTALL_SOURCE:-redpill-vault}" >&2 2>&1 || {
  echo "redpill-vault: install failed — run: npm i -g redpill-vault" >&2
  exit 1
}

echo "redpill-vault installed successfully"

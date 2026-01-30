#!/bin/bash

# Get the directory where this script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
INSTALL_SOURCE="${RV_INSTALL_SOURCE:-redpill-vault}"

if command -v rv &>/dev/null; then
  echo "redpill-vault is already installed"
  exit 0
fi

echo "Installing redpill-vault from: $INSTALL_SOURCE"
npm i -g "$INSTALL_SOURCE" 2>&1 || {
  echo "redpill-vault: install failed" >&2
  exit 1
}

echo "redpill-vault installed successfully"

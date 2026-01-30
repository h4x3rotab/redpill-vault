#!/bin/bash

# Get the directory where this script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_DIR="$( cd "$SCRIPT_DIR/../.." && pwd )"

if command -v rv &>/dev/null; then
  echo "redpill-vault is already installed"
  exit 0
fi

echo "Installing redpill-vault..."
npm i -g "$PROJECT_DIR" 2>&1 || {
  echo "redpill-vault: install failed" >&2
  exit 1
}

echo "redpill-vault installed successfully"

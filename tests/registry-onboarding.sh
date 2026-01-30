#!/usr/bin/env bash
set -euo pipefail

# E2E test using the PUBLISHED npm package (not local source).
#
# Simulates the real developer experience:
#   1. Uninstall rv (clean slate)
#   2. Install plugin via marketplace (from local repo — plugin files only)
#   3. Ask Claude to set up redpill-vault — it installs from npm registry
#   4. Hook blocks because project is not approved
#   5. User runs rv approve
#   6. Approved project: command passes through
#   7. Clean uninstall
#
# Requires: claude CLI authenticated, redpill-vault published to npm

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

MARKETPLACE_NAME="redpill-vault-marketplace"
PLUGIN_NAME="redpill-vault"

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

FAKE_STATE="$(mktemp -d)"
FAKE_PROJECT="$(mktemp -d)"

cleanup() {
  claude plugin uninstall "${PLUGIN_NAME}@${MARKETPLACE_NAME}" 2>/dev/null || true
  claude plugin marketplace remove "${MARKETPLACE_NAME}" 2>/dev/null || true
  rm -rf "$FAKE_STATE" "$FAKE_PROJECT"
}
trap cleanup EXIT

export RV_CONFIG_DIR="$FAKE_STATE/rv"

# ── 0. Ensure rv is NOT installed ────────────────────────────────────
echo "=== Ensure rv not installed ==="
npm rm -g redpill-vault 2>/dev/null || true

if command -v rv-hook &>/dev/null; then
  fail "rv-hook still on PATH after uninstall"
else
  pass "rv-hook not on PATH (clean slate)"
fi

# ── 1. Plugin install ────────────────────────────────────────────────
echo ""
echo "=== Plugin install ==="
claude plugin uninstall "${PLUGIN_NAME}@${MARKETPLACE_NAME}" 2>/dev/null || true
claude plugin marketplace remove "${MARKETPLACE_NAME}" 2>/dev/null || true

claude plugin marketplace add "$PROJECT_DIR" 2>&1
[ $? -eq 0 ] && pass "marketplace add" || fail "marketplace add"

claude plugin install "${PLUGIN_NAME}@${MARKETPLACE_NAME}" 2>&1
[ $? -eq 0 ] && pass "plugin install" || fail "plugin install"

skill_list=$(claude plugin list 2>&1 || true)
echo "$skill_list"
echo "$skill_list" | grep -qi "redpill-vault" \
  && pass "plugin lists redpill-vault" || fail "plugin does not list redpill-vault"

# ── 2. Ask Claude to set up rv — installs from npm registry ──────────
echo ""
echo "=== Agent-driven setup (from npm registry) ==="
cd "$FAKE_PROJECT"

# The hook (setup.sh) auto-installs rv on first Bash command.
# Claude reads SKILL.md and runs rv init.
setup_output=$(claude -p \
  "Set up redpill-vault for this project." \
  --allowedTools "Bash" \
  2>&1 || true)

echo "$setup_output"

if command -v rv &>/dev/null; then
  pass "Claude installed rv"
else
  fail "rv not on PATH after agent setup"
fi

if command -v rv-hook &>/dev/null; then
  pass "Claude installed rv-hook"
else
  fail "rv-hook not on PATH after agent setup"
fi

if [ -f .rv.json ]; then
  pass "Claude ran rv init (.rv.json exists)"
else
  fail ".rv.json missing — Claude did not run rv init"
fi

# ── 3. Hook blocks unapproved project ────────────────────────────────
echo ""
echo "=== Hook blocks unapproved project ==="
rv add TEST_KEY -d "test secret" 2>&1

hook_output=$(claude -p "Run this exact bash command: echo hello" \
  --allowedTools "Bash" \
  2>&1 || true)

echo "$hook_output"

if echo "$hook_output" | grep -qi "not approved\|rv approve\|blocked"; then
  pass "hook blocks unapproved project"
else
  fail "hook did not block unapproved project"
fi

# ── 4. User runs rv approve ──────────────────────────────────────────
echo ""
echo "=== User runs rv approve ==="
rv approve 2>&1
rv remove TEST_KEY 2>&1

approve_output=$(claude -p "Run this exact bash command: echo rv-plugin-test-ok" \
  --allowedTools "Bash" \
  2>&1 || true)

echo "$approve_output"

if echo "$approve_output" | grep -qi "rv-plugin-test-ok"; then
  pass "approved project: command passes through"
else
  fail "approved project: command did not run"
fi

# ── 5. Clean uninstall ───────────────────────────────────────────────
echo ""
echo "=== Clean uninstall ==="
claude plugin uninstall "${PLUGIN_NAME}@${MARKETPLACE_NAME}" 2>&1 \
  && pass "plugin uninstall" || fail "plugin uninstall failed"
claude plugin marketplace remove "${MARKETPLACE_NAME}" 2>&1 \
  && pass "marketplace remove" || fail "marketplace remove failed"
npm rm -g redpill-vault 2>&1 \
  && pass "npm uninstall" || fail "npm uninstall failed"

# ── Summary ──────────────────────────────────────────────────────────
echo ""
echo "$((PASS + FAIL)) tests: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi

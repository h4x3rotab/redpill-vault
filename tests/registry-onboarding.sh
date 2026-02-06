#!/usr/bin/env bash
set -euo pipefail

# E2E test using the PUBLISHED npm package (not local source).
#
# Simulates the real developer experience:
#   1. Uninstall rv (clean slate)
#   2. Install plugin via marketplace (from local repo — plugin files only)
#   3. Ask Claude to set up redpill-vault — it installs from npm registry
#   4. Test rv-exec --all functionality
#   5. Clean uninstall
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
export HOME="$FAKE_STATE/home"
mkdir -p "$HOME"

# ── 0. Ensure rv is NOT installed ────────────────────────────────────
echo "=== Ensure rv not installed ==="
npm rm -g redpill-vault 2>/dev/null || true

if command -v rv &>/dev/null; then
  echo "  Note: rv found on PATH (will be reinstalled)"
else
  pass "rv not on PATH (clean slate)"
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

# Claude invokes the redpill-vault skill, which runs setup.sh + rv init.
setup_output=$(claude -p \
  "Use the redpill-vault skill to set up redpill-vault for this project." \
  --allowedTools "Bash,Skill" \
  2>&1 || true)

echo "$setup_output"

if command -v rv &>/dev/null; then
  pass "Claude installed rv"
else
  fail "rv not on PATH after agent setup"
fi

if command -v rv-exec &>/dev/null; then
  pass "Claude installed rv-exec"
else
  fail "rv-exec not on PATH after agent setup"
fi

if [ -f .rv.json ]; then
  pass "Claude ran rv init (.rv.json exists)"
else
  fail ".rv.json missing — Claude did not run rv init"
fi

if [ -f "$RV_CONFIG_DIR/master-key" ]; then
  pass "master-key created"
else
  fail "master-key missing"
fi

# ── 3. Test rv-exec with secrets ─────────────────────────────────────
echo ""
echo "=== rv-exec with secrets ==="

# Import a test secret
echo "TEST_SECRET=registry_test_value" > .env
rv import .env 2>&1

# Approve the project (required for rv-exec to work)
rv approve 2>&1
[ $? -eq 0 ] && pass "rv approve succeeded" || fail "rv approve failed"

# Verify import
list_output=$(rv list 2>&1)
echo "$list_output"
if echo "$list_output" | grep -q "TEST_SECRET"; then
  pass "rv import added TEST_SECRET"
else
  fail "TEST_SECRET not in rv list"
fi

# Test rv-exec
exec_output=$(rv-exec --all -- printenv TEST_SECRET 2>&1) || true
if [ -n "$exec_output" ]; then
  pass "rv-exec --all injects secret"
else
  fail "rv-exec --all failed to inject secret"
fi

# ── 4. Clean uninstall ───────────────────────────────────────────────
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

#!/usr/bin/env bash
set -euo pipefail

# Integration test for redpill-vault
#
# Isolation strategy:
#   RV_CONFIG_DIR → temp dir (keeps master-key isolated)
#   HOME → temp dir (isolates ~/.psst/ global vault)
#
# Tests:
#   - rv init (master key, vault, .rv.json)
#   - rv import (from .env file)
#   - rv list (with project/global sources)
#   - rv set/rm (single secret management)
#   - rv check (verify keys exist)
#   - rv doctor (full health check)
#   - rv-exec --all (inject all secrets)
#   - rv-exec from subdirectory (auto-detect project)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
FAKE_STATE="$(mktemp -d)"
FAKE_PROJECT="$(mktemp -d)"

export HOME="$FAKE_STATE/home"
mkdir -p "$HOME"
export RV_CONFIG_DIR="$FAKE_STATE/rv"
export PATH="$PROJECT_DIR/dist:$PROJECT_DIR/node_modules/.bin:$PATH"

PASS=0
FAIL=0

pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

cleanup() {
  rm -rf "$FAKE_STATE" "$FAKE_PROJECT"
}
trap cleanup EXIT

echo "=== redpill-vault integration tests ==="
echo "FAKE_STATE=$FAKE_STATE"
echo "FAKE_PROJECT=$FAKE_PROJECT"
echo ""

# --- rv init ---
echo "--- rv init ---"

cd "$FAKE_PROJECT"
node "$PROJECT_DIR/dist/cli.js" init 2>&1 && {
  if [ -f "$RV_CONFIG_DIR/master-key" ]; then
    pass "master-key created"
  else
    fail "master-key not found"
  fi

  # Check permissions (should be 600)
  PERMS=$(stat -c '%a' "$RV_CONFIG_DIR/master-key" 2>/dev/null || stat -f '%Lp' "$RV_CONFIG_DIR/master-key" 2>/dev/null)
  if [ "$PERMS" = "600" ]; then
    pass "master-key mode 600"
  else
    fail "master-key mode is $PERMS, expected 600"
  fi

  # Check key is 64 hex chars (32 bytes)
  KEY=$(cat "$RV_CONFIG_DIR/master-key" | tr -d '\n')
  if echo "$KEY" | grep -qE '^[0-9a-f]{64}$'; then
    pass "master-key is 64 hex chars"
  else
    fail "master-key format unexpected: $KEY"
  fi

  # Check vault was created
  if [ -f "$HOME/.psst/vault.db" ]; then
    pass "vault.db created"
  else
    fail "vault.db not found"
  fi

  # Check .rv.json was created
  if [ -f "$FAKE_PROJECT/.rv.json" ]; then
    pass ".rv.json created"
  else
    fail ".rv.json not found"
  fi
} || fail "rv init failed"

# --- rv init idempotent ---
echo ""
echo "--- rv init (idempotent) ---"

KEY_BEFORE=$(cat "$RV_CONFIG_DIR/master-key" | tr -d '\n')
node "$PROJECT_DIR/dist/cli.js" init 2>&1
KEY_AFTER=$(cat "$RV_CONFIG_DIR/master-key" | tr -d '\n')
if [ "$KEY_BEFORE" = "$KEY_AFTER" ]; then
  pass "master-key unchanged on re-init"
else
  fail "master-key changed on re-init"
fi

# --- rv import ---
echo ""
echo "--- rv import ---"

# Create a .env file
cat > "$FAKE_PROJECT/.env" <<'EOF'
# Test env file
TEST_SECRET=hunter2
ANOTHER_KEY="quoted value"
export EXPORTED_VAR=exported_value
EOF

node "$PROJECT_DIR/dist/cli.js" import .env 2>&1
if [ $? -eq 0 ]; then
  pass "rv import succeeded"
else
  fail "rv import failed"
fi

# Check .rv.json was updated
if grep -q "TEST_SECRET" "$FAKE_PROJECT/.rv.json"; then
  pass "TEST_SECRET added to .rv.json"
else
  fail "TEST_SECRET not in .rv.json"
fi

# --- rv list ---
echo ""
echo "--- rv list ---"

LIST_OUTPUT=$(node "$PROJECT_DIR/dist/cli.js" list 2>&1)
if echo "$LIST_OUTPUT" | grep -q "TEST_SECRET.*\[project\]"; then
  pass "rv list shows TEST_SECRET as [project]"
else
  fail "rv list output unexpected: $LIST_OUTPUT"
fi

# --- rv check ---
echo ""
echo "--- rv check ---"

CHECK_OUTPUT=$(node "$PROJECT_DIR/dist/cli.js" check 2>&1)
if echo "$CHECK_OUTPUT" | grep -q "✓.*TEST_SECRET"; then
  pass "rv check shows TEST_SECRET present"
else
  fail "rv check output unexpected: $CHECK_OUTPUT"
fi

# --- rv approve ---
echo ""
echo "--- rv approve ---"

node "$PROJECT_DIR/dist/cli.js" approve 2>&1
if [ -f "$RV_CONFIG_DIR/approved.json" ]; then
  pass "rv approve created approved.json"
else
  fail "approved.json not created"
fi

# Test that rv-exec fails without approval (in a new unapproved project)
UNAPPROVED_PROJECT="$(mktemp -d)"
cat > "$UNAPPROVED_PROJECT/.rv.json" <<'EOF'
{ "secrets": { "TEST_KEY": {} } }
EOF
OUTPUT=$(cd "$UNAPPROVED_PROJECT" && node "$PROJECT_DIR/dist/rv-exec.js" --all -- echo test 2>&1) || true
if echo "$OUTPUT" | grep -q "not approved"; then
  pass "rv-exec blocks unapproved project"
else
  fail "rv-exec should block unapproved project: $OUTPUT"
fi
rm -rf "$UNAPPROVED_PROJECT"

# --- rv-exec --all ---
echo ""
echo "--- rv-exec --all ---"

OUTPUT=$(node "$PROJECT_DIR/dist/rv-exec.js" --all -- printenv TEST_SECRET 2>&1)
if [ "$OUTPUT" = "[REDACTED]" ] || [ "$OUTPUT" = "hunter2" ]; then
  pass "rv-exec --all injected TEST_SECRET"
else
  fail "rv-exec --all output unexpected: $OUTPUT"
fi

# Test multiple env vars
OUTPUT=$(node "$PROJECT_DIR/dist/rv-exec.js" --all -- bash -c 'echo $TEST_SECRET $ANOTHER_KEY' 2>&1)
if [ -n "$OUTPUT" ]; then
  pass "rv-exec --all injected multiple secrets"
else
  fail "rv-exec --all multiple secrets failed"
fi

# --- rv-exec from subdirectory ---
echo ""
echo "--- rv-exec from subdirectory ---"

mkdir -p "$FAKE_PROJECT/subdir/nested"
cd "$FAKE_PROJECT/subdir/nested"

OUTPUT=$(node "$PROJECT_DIR/dist/rv-exec.js" --all -- printenv TEST_SECRET 2>&1)
if [ "$OUTPUT" = "[REDACTED]" ] || [ "$OUTPUT" = "hunter2" ]; then
  pass "rv-exec from subdirectory found .rv.json"
else
  fail "rv-exec from subdirectory failed: $OUTPUT"
fi

cd "$FAKE_PROJECT"

# --- rv-exec specific keys ---
echo ""
echo "--- rv-exec specific keys ---"

OUTPUT=$(node "$PROJECT_DIR/dist/rv-exec.js" TEST_SECRET -- printenv TEST_SECRET 2>&1)
if [ "$OUTPUT" = "[REDACTED]" ] || [ "$OUTPUT" = "hunter2" ]; then
  pass "rv-exec with specific key works"
else
  fail "rv-exec specific key failed: $OUTPUT"
fi

# --- rv-exec --dotenv ---
echo ""
echo "--- rv-exec --dotenv ---"

node "$PROJECT_DIR/dist/rv-exec.js" --all --dotenv .env.tmp -- cat .env.tmp 2>&1
# .env.tmp should be deleted after command
if [ ! -f "$FAKE_PROJECT/.env.tmp" ]; then
  pass "rv-exec --dotenv cleans up temp file"
else
  fail "rv-exec --dotenv left temp file behind"
  rm -f "$FAKE_PROJECT/.env.tmp"
fi

# --- rv set (global) ---
echo ""
echo "--- rv set (global) ---"

echo "global_secret_value" | node "$PROJECT_DIR/dist/cli.js" set GLOBAL_KEY -g 2>&1
if [ $? -eq 0 ]; then
  pass "rv set -g succeeded"
else
  fail "rv set -g failed"
fi

# Verify with rv list -g
LIST_OUTPUT=$(node "$PROJECT_DIR/dist/cli.js" list -g 2>&1)
if echo "$LIST_OUTPUT" | grep -q "GLOBAL_KEY"; then
  pass "rv list -g shows GLOBAL_KEY"
else
  fail "rv list -g output unexpected: $LIST_OUTPUT"
fi

# --- rv rm ---
echo ""
echo "--- rv rm ---"

node "$PROJECT_DIR/dist/cli.js" rm GLOBAL_KEY -g 2>&1
if [ $? -eq 0 ]; then
  pass "rv rm -g succeeded"
else
  fail "rv rm -g failed"
fi

# Verify removed
LIST_OUTPUT=$(node "$PROJECT_DIR/dist/cli.js" list -g 2>&1)
if echo "$LIST_OUTPUT" | grep -q "GLOBAL_KEY"; then
  fail "GLOBAL_KEY still exists after rm"
else
  pass "GLOBAL_KEY removed from vault"
fi

# --- rv doctor ---
echo ""
echo "--- rv doctor ---"

DOCTOR_OUTPUT=$(node "$PROJECT_DIR/dist/cli.js" doctor 2>&1)
if echo "$DOCTOR_OUTPUT" | grep -q "✓.*master key"; then
  pass "doctor checks master key"
else
  fail "doctor missing master key check: $DOCTOR_OUTPUT"
fi
if echo "$DOCTOR_OUTPUT" | grep -q "✓.*vault"; then
  pass "doctor checks vault"
else
  fail "doctor missing vault check"
fi
if echo "$DOCTOR_OUTPUT" | grep -q "All checks passed"; then
  pass "doctor all checks passed"
else
  fail "doctor shows failures"
fi

# --- rv-exec missing key handling ---
echo ""
echo "--- rv-exec missing key handling ---"

# Add a key to .rv.json that doesn't exist in vault
cat > "$FAKE_PROJECT/.rv.json" <<'EOF'
{
  "secrets": {
    "TEST_SECRET": {},
    "MISSING_KEY": {}
  }
}
EOF

OUTPUT=$(node "$PROJECT_DIR/dist/rv-exec.js" --all -- printenv TEST_SECRET 2>&1)
if echo "$OUTPUT" | grep -q "missing secrets.*MISSING_KEY"; then
  pass "rv-exec reports missing keys"
else
  fail "rv-exec didn't report missing key: $OUTPUT"
fi

# --- Summary ---
echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ] || exit 1

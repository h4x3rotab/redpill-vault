#!/usr/bin/env bash
set -euo pipefail

# Real-world scenario tests for redpill-vault rv-exec behavior.
#
# All tests run locally (no claude CLI needed).
# Tests rv-exec injection and various configurations.
#
# Scenarios:
#   1. Key injection works end-to-end
#   2. --all flag injects all secrets from .rv.json
#   3. Missing vault keys are surfaced
#   4. Per-repo key scoping
#   5. Complex bash commands survive execution
#   6. Alias/rename support
#   7. Project-scoped vs global key resolution
#   8. --dotenv flag for temp .env file
#   9. Subdirectory execution finds parent config

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

cleanup() { rm -rf "$FAKE_STATE" "$FAKE_PROJECT"; }
trap cleanup EXIT

echo "=== redpill-vault scenario tests ==="

# ── Bootstrap ──────────────────────────────────────────────────────────
cd "$FAKE_PROJECT"
node "$PROJECT_DIR/dist/cli.js" init >/dev/null 2>&1
MASTER_KEY=$(cat "$RV_CONFIG_DIR/master-key" | tr -d '\n')
export PSST_PASSWORD="$MASTER_KEY"

# Import secrets via rv
cat > "$FAKE_PROJECT/.env" <<'EOF'
OPENAI_API_KEY=sk-test-openai-key-1234
STRIPE_KEY=sk_test_stripe_5678
EOF

# Import as project-scoped
node "$PROJECT_DIR/dist/cli.js" import .env >/dev/null 2>&1

# Also set a global key
echo "global-db-password" | node "$PROJECT_DIR/dist/cli.js" set DATABASE_URL -g >/dev/null 2>&1

# Configure project with only OPENAI_API_KEY
cat > "$FAKE_PROJECT/.rv.json" <<'EOF'
{
  "secrets": {
    "OPENAI_API_KEY": { "description": "OpenAI API key" }
  }
}
EOF

# Approve the project
node "$PROJECT_DIR/dist/cli.js" approve >/dev/null 2>&1

# ── 1. Key injection works ─────────────────────────────────────────────
echo ""
echo "--- 1. Key injection ---"

OUTPUT=$(node "$PROJECT_DIR/dist/rv-exec.js" OPENAI_API_KEY -- printenv OPENAI_API_KEY 2>&1)
if [ -n "$OUTPUT" ]; then
  pass "rv-exec injects OPENAI_API_KEY (got: ${OUTPUT:0:20}...)"
else
  fail "rv-exec did not inject OPENAI_API_KEY"
fi

# ── 2. --all flag injects all keys from .rv.json ───────────────────────
echo ""
echo "--- 2. --all flag ---"

# Add second key to config
cat > "$FAKE_PROJECT/.rv.json" <<'EOF'
{
  "secrets": {
    "OPENAI_API_KEY": { "description": "OpenAI key" },
    "STRIPE_KEY": { "description": "Stripe key" }
  }
}
EOF

OUTPUT=$(node "$PROJECT_DIR/dist/rv-exec.js" --all -- printenv OPENAI_API_KEY 2>&1)
if [ -n "$OUTPUT" ]; then
  pass "--all injects OPENAI_API_KEY"
else
  fail "--all failed to inject OPENAI_API_KEY"
fi

OUTPUT=$(node "$PROJECT_DIR/dist/rv-exec.js" --all -- printenv STRIPE_KEY 2>&1)
if [ -n "$OUTPUT" ]; then
  pass "--all injects STRIPE_KEY"
else
  fail "--all failed to inject STRIPE_KEY"
fi

# ── 3. Missing vault keys are surfaced ─────────────────────────────────
echo ""
echo "--- 3. Missing vault key ---"

# Add a key to .rv.json that doesn't exist in vault
cat > "$FAKE_PROJECT/.rv.json" <<'EOF'
{
  "secrets": {
    "OPENAI_API_KEY": { "description": "OpenAI API key" },
    "NONEXISTENT_KEY": { "description": "key not in vault" }
  }
}
EOF

# rv-exec with missing key should report it
EXEC_OUTPUT=$(node "$PROJECT_DIR/dist/rv-exec.js" --all -- echo ok 2>&1) || true
if echo "$EXEC_OUTPUT" | grep -qi "missing secrets\|NONEXISTENT_KEY"; then
  pass "rv-exec surfaces missing key error"
else
  fail "rv-exec didn't report missing key: $EXEC_OUTPUT"
fi

# rv check should report the missing key
CHECK_OUTPUT=$(cd "$FAKE_PROJECT" && node "$PROJECT_DIR/dist/cli.js" check 2>&1) || true
if echo "$CHECK_OUTPUT" | grep -q "NONEXISTENT_KEY" && echo "$CHECK_OUTPUT" | grep -qi "MISSING"; then
  pass "rv check reports missing key"
else
  fail "rv check didn't flag missing key: $CHECK_OUTPUT"
fi

# Restore config
cat > "$FAKE_PROJECT/.rv.json" <<'EOF'
{
  "secrets": {
    "OPENAI_API_KEY": { "description": "OpenAI API key" }
  }
}
EOF

# ── 4. Per-repo key scoping ────────────────────────────────────────────
echo ""
echo "--- 4. Per-repo key scoping ---"

# STRIPE_KEY is in vault but NOT in .rv.json — should not be injected with --all
OUTPUT=$(node "$PROJECT_DIR/dist/rv-exec.js" --all -- printenv STRIPE_KEY 2>&1) || true
if echo "$OUTPUT" | grep -q "sk_test_stripe"; then
  fail "STRIPE_KEY injected despite not being in .rv.json"
else
  pass "STRIPE_KEY not injected (not in .rv.json)"
fi

# Different project with only STRIPE_KEY
STRIPE_PROJECT="$(mktemp -d)"
cd "$STRIPE_PROJECT"
cat > "$STRIPE_PROJECT/.rv.json" <<'EOF'
{
  "secrets": {
    "STRIPE_KEY": { "description": "Stripe API key" }
  }
}
EOF

# Store project-scoped key for this project
PROJ_NAME=$(basename "$STRIPE_PROJECT" | tr '[:lower:]' '[:upper:]' | tr '-' '_')
echo "sk_test_stripe_5678" | node "$PROJECT_DIR/dist/cli.js" set STRIPE_KEY >/dev/null 2>&1

# Approve the stripe project
node "$PROJECT_DIR/dist/cli.js" approve >/dev/null 2>&1

OUTPUT=$(node "$PROJECT_DIR/dist/rv-exec.js" --all -- printenv STRIPE_KEY 2>&1) || true
if [ -n "$OUTPUT" ]; then
  pass "stripe project injects STRIPE_KEY"
else
  fail "stripe project failed to inject STRIPE_KEY"
fi
rm -rf "$STRIPE_PROJECT"
cd "$FAKE_PROJECT"

# ── 5. Complex bash commands survive execution ──────────────────────────
echo ""
echo "--- 5. Complex commands ---"

# Multi-statement with &&
EXEC_OUTPUT=$(node "$PROJECT_DIR/dist/rv-exec.js" --all -- bash -c 'echo one && echo two && echo three' 2>&1)
if echo "$EXEC_OUTPUT" | grep -q "one" && echo "$EXEC_OUTPUT" | grep -q "two" && echo "$EXEC_OUTPUT" | grep -q "three"; then
  pass "rv-exec runs multi-statement command correctly"
else
  fail "rv-exec multi-statement failed: $EXEC_OUTPUT"
fi

# Pipe chain
EXEC_OUTPUT=$(node "$PROJECT_DIR/dist/rv-exec.js" --all -- bash -c 'seq 3 | wc -l' 2>&1)
if echo "$EXEC_OUTPUT" | grep -q "3"; then
  pass "rv-exec runs piped command correctly"
else
  fail "rv-exec pipe failed: $EXEC_OUTPUT"
fi

# For loop
EXEC_OUTPUT=$(node "$PROJECT_DIR/dist/rv-exec.js" --all -- bash -c 'for i in x y z; do echo $i; done' 2>&1)
if echo "$EXEC_OUTPUT" | grep -q "x" && echo "$EXEC_OUTPUT" | grep -q "y" && echo "$EXEC_OUTPUT" | grep -q "z"; then
  pass "rv-exec runs for loop correctly"
else
  fail "rv-exec for loop failed: $EXEC_OUTPUT"
fi

# Injected key available inside complex command
EXEC_OUTPUT=$(node "$PROJECT_DIR/dist/rv-exec.js" --all -- bash -c 'if [ -n "$OPENAI_API_KEY" ]; then echo key_present; fi' 2>&1)
if echo "$EXEC_OUTPUT" | grep -q "key_present"; then
  pass "injected key available inside complex command"
else
  fail "injected key not available: $EXEC_OUTPUT"
fi

# ── 6. Alias/rename support ───────────────────────────────────────────
echo ""
echo "--- 6. Alias support ---"

# Test KEY=ALIAS syntax
EXEC_OUTPUT=$(node "$PROJECT_DIR/dist/rv-exec.js" OPENAI_API_KEY=MY_KEY -- printenv MY_KEY 2>&1) || true
if [ -n "$EXEC_OUTPUT" ]; then
  pass "rv-exec injects aliased key as MY_KEY"
else
  fail "rv-exec alias injection failed"
fi

# ── 7. Project-scoped vs global key resolution ─────────────────────────
echo ""
echo "--- 7. Project vs global resolution ---"

# DATABASE_URL was set as global; project doesn't have it scoped
cat > "$FAKE_PROJECT/.rv.json" <<'EOF'
{
  "secrets": {
    "OPENAI_API_KEY": { "description": "OpenAI key" },
    "DATABASE_URL": { "description": "Database connection" }
  }
}
EOF

# rv list should show DATABASE_URL as [global]
LIST_OUTPUT=$(node "$PROJECT_DIR/dist/cli.js" list 2>&1)
if echo "$LIST_OUTPUT" | grep -q "DATABASE_URL.*\[global\]"; then
  pass "rv list shows DATABASE_URL as [global]"
else
  fail "rv list doesn't show DATABASE_URL as global: $LIST_OUTPUT"
fi

# rv-exec should resolve the global key
OUTPUT=$(node "$PROJECT_DIR/dist/rv-exec.js" --all -- printenv DATABASE_URL 2>&1)
if [ -n "$OUTPUT" ]; then
  pass "rv-exec resolves global DATABASE_URL"
else
  fail "rv-exec failed to resolve global DATABASE_URL"
fi

# ── 8. --dotenv flag for temp .env file ────────────────────────────────
echo ""
echo "--- 8. --dotenv flag ---"

# Create a script that reads from .env file
DOTENV_OUTPUT=$(node "$PROJECT_DIR/dist/rv-exec.js" --all --dotenv .env.test -- cat .env.test 2>&1) || true
if echo "$DOTENV_OUTPUT" | grep -q "OPENAI_API_KEY="; then
  pass "--dotenv writes secrets to temp file"
else
  fail "--dotenv failed: $DOTENV_OUTPUT"
fi

# Temp file should be deleted
if [ ! -f "$FAKE_PROJECT/.env.test" ]; then
  pass "--dotenv cleans up temp file"
else
  fail "--dotenv left temp file behind"
  rm -f "$FAKE_PROJECT/.env.test"
fi

# ── 9. Subdirectory execution finds parent config ──────────────────────
echo ""
echo "--- 9. Subdirectory execution ---"

mkdir -p "$FAKE_PROJECT/subdir/nested"
cd "$FAKE_PROJECT/subdir/nested"

OUTPUT=$(node "$PROJECT_DIR/dist/rv-exec.js" --all -- printenv OPENAI_API_KEY 2>&1)
if [ -n "$OUTPUT" ]; then
  pass "rv-exec from subdirectory finds parent .rv.json"
else
  fail "rv-exec from subdirectory failed: $OUTPUT"
fi

# Project name should be auto-detected
OUTPUT=$(node "$PROJECT_DIR/dist/rv-exec.js" --all -- printenv DATABASE_URL 2>&1)
if [ -n "$OUTPUT" ]; then
  pass "rv-exec from subdirectory resolves project correctly"
else
  fail "rv-exec subdirectory project resolution failed"
fi

cd "$FAKE_PROJECT"

# ── 10. Secret masking ─────────────────────────────────────────────────
echo ""
echo "--- 10. Secret masking ---"

# By default, secrets should be masked in output
OUTPUT=$(node "$PROJECT_DIR/dist/rv-exec.js" --all -- bash -c 'echo $OPENAI_API_KEY' 2>&1)
if echo "$OUTPUT" | grep -q "\[REDACTED\]"; then
  pass "secrets are masked by default"
else
  fail "secrets not masked: $OUTPUT"
fi

# With --no-mask, secrets should appear
OUTPUT=$(node "$PROJECT_DIR/dist/rv-exec.js" --all --no-mask -- bash -c 'echo $OPENAI_API_KEY' 2>&1)
if echo "$OUTPUT" | grep -q "sk-test-openai"; then
  pass "--no-mask disables masking"
else
  fail "--no-mask didn't disable masking: $OUTPUT"
fi

# ── Summary ───────────────────────────────────────────────────────────
echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ] || exit 1

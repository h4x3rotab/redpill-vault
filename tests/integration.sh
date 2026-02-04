#!/usr/bin/env bash
set -euo pipefail

# Integration test for redpill-vault
#
# Isolation strategy:
#   RV_CONFIG_DIR → temp dir (keeps master-key + approved.json isolated)
#   HOME → temp dir (isolates psst's ~/.psst/ global vault)
#   REAL_HOME → preserved for claude -p calls (needs auth)
#
# Known psst quirks:
#   - `sh -c 'echo $VAR'` produces no output with psst injection; use `printenv` instead
#   - psst redacts secret values as [REDACTED] in output; tests can't match literal values
#   - psst init exits 2 when vault already exists; message is on stdout not stderr

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
FAKE_STATE="$(mktemp -d)"
FAKE_PROJECT="$(mktemp -d)"

REAL_HOME="$HOME"
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

# --- Setup a test project ---
echo ""
echo "--- project setup ---"

cd "$FAKE_PROJECT"
cat > .rv.json <<'EOF'
{
  "secrets": {
    "TEST_SECRET": { "description": "a test secret" }
  }
}
EOF
pass "created .rv.json"

# Store a secret in psst
MASTER_KEY=$(cat "$RV_CONFIG_DIR/master-key" | tr -d '\n')
echo "hunter2" | PSST_PASSWORD="$MASTER_KEY" psst --global set TEST_SECRET --stdin 2>&1 && pass "stored TEST_SECRET in vault" || fail "psst set failed"

# --- rv approve ---
echo ""
echo "--- rv approve ---"

node "$PROJECT_DIR/dist/cli.js" approve 2>&1
if [ -f "$RV_CONFIG_DIR/approved.json" ]; then
  if grep -q "$FAKE_PROJECT" "$RV_CONFIG_DIR/approved.json"; then
    pass "project approved in approved.json"
  else
    fail "project path not in approved.json"
  fi
else
  fail "approved.json not created"
fi

# --- hook: wraps command with rv-exec ---
echo ""
echo "--- hook: command wrapping ---"

HOOK_INPUT=$(cat <<ENDJSON
{"tool_name":"Bash","tool_input":{"command":"echo hi"},"cwd":"$FAKE_PROJECT"}
ENDJSON
)
HOOK_OUTPUT=$(echo "$HOOK_INPUT" | node "$PROJECT_DIR/dist/hook.js" 2>/dev/null || true)
# Now includes --project flag with derived project name (temp dir basename)
if echo "$HOOK_OUTPUT" | grep -q "rv-exec --project .* TEST_SECRET -- bash -c 'echo hi'"; then
  pass "hook wraps with rv-exec and project"
else
  fail "hook output unexpected: $HOOK_OUTPUT"
fi

# --- hook: blocks rv approve ---
echo ""
echo "--- hook: blocks agent commands ---"

HOOK_INPUT='{"tool_name":"Bash","tool_input":{"command":"rv approve"},"cwd":"'"$FAKE_PROJECT"'"}'
if echo "$HOOK_INPUT" | node "$PROJECT_DIR/dist/hook.js" 2>/dev/null; then
  fail "hook should have blocked rv approve"
else
  pass "hook blocked rv approve"
fi

HOOK_INPUT='{"tool_name":"Bash","tool_input":{"command":"rv init"},"cwd":"'"$FAKE_PROJECT"'"}'
if echo "$HOOK_INPUT" | node "$PROJECT_DIR/dist/hook.js" 2>/dev/null; then
  pass "hook allows rv init (agent runs it during setup)"
else
  fail "hook should allow rv init"
fi

HOOK_INPUT='{"tool_name":"Bash","tool_input":{"command":"rv revoke"},"cwd":"'"$FAKE_PROJECT"'"}'
if echo "$HOOK_INPUT" | node "$PROJECT_DIR/dist/hook.js" 2>/dev/null; then
  fail "hook should have blocked rv revoke"
else
  pass "hook blocked rv revoke"
fi

# --- rv-exec: resolves key and runs command ---
echo ""
echo "--- rv-exec: secret injection ---"

# Use printenv to check env var exists; psst redacts values so check for [REDACTED] or actual value
OUTPUT=$(node "$PROJECT_DIR/dist/rv-exec.js" TEST_SECRET -- printenv TEST_SECRET 2>&1)
if [ -n "$OUTPUT" ]; then
  pass "rv-exec injected secret (got: ${OUTPUT:0:20})"
else
  fail "rv-exec did not inject secret, output was empty"
fi

# --- rv revoke ---
echo ""
echo "--- rv revoke ---"

node "$PROJECT_DIR/dist/cli.js" revoke 2>&1

HOOK_INPUT='{"tool_name":"Bash","tool_input":{"command":"echo hi"},"cwd":"'"$FAKE_PROJECT"'"}'
if echo "$HOOK_INPUT" | node "$PROJECT_DIR/dist/hook.js" 2>/dev/null; then
  fail "hook should have blocked after revoke"
else
  pass "hook blocks after revoke"
fi

# --- hook: passthrough when no secrets ---
echo ""
echo "--- hook: passthrough with empty secrets ---"

EMPTY_PROJECT="$(mktemp -d)"
cat > "$EMPTY_PROJECT/.rv.json" <<'EOF'
{ "secrets": {} }
EOF
# Approve it first
node "$PROJECT_DIR/dist/cli.js" approve 2>&1  # approves cwd which is FAKE_PROJECT, so cd first
(cd "$EMPTY_PROJECT" && node "$PROJECT_DIR/dist/cli.js" approve 2>&1)

HOOK_INPUT='{"tool_name":"Bash","tool_input":{"command":"echo hi"},"cwd":"'"$EMPTY_PROJECT"'"}'
HOOK_OUTPUT=$(echo "$HOOK_INPUT" | node "$PROJECT_DIR/dist/hook.js" 2>/dev/null || true)
if [ -z "$HOOK_OUTPUT" ] || echo "$HOOK_OUTPUT" | grep -q '{}'; then
  pass "passthrough with empty secrets"
else
  fail "expected passthrough, got: $HOOK_OUTPUT"
fi
rm -rf "$EMPTY_PROJECT"

# --- rv doctor ---
echo ""
echo "--- rv doctor ---"

# Re-approve for doctor
(cd "$FAKE_PROJECT" && node "$PROJECT_DIR/dist/cli.js" approve 2>&1)
DOCTOR_OUTPUT=$(cd "$FAKE_PROJECT" && node "$PROJECT_DIR/dist/cli.js" doctor 2>&1) || true
if echo "$DOCTOR_OUTPUT" | grep -q "master key"; then
  pass "doctor checks master key"
else
  fail "doctor missing master key check"
fi
if echo "$DOCTOR_OUTPUT" | grep -q "project approved"; then
  pass "doctor checks project approval"
else
  fail "doctor missing approval check"
fi

# --- E2E with Claude Code ---
echo ""
echo "--- e2e: claude -p with hook ---"

# Only run if claude is available
if command -v claude &>/dev/null; then
  # Re-approve fake project
  (cd "$FAKE_PROJECT" && node "$PROJECT_DIR/dist/cli.js" approve 2>&1)

  # Set up project-level claude hook config
  mkdir -p "$FAKE_PROJECT/.claude"
  cat > "$FAKE_PROJECT/.claude/settings.json" <<ENDJSON
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node $PROJECT_DIR/dist/hook.js"
          }
        ]
      }
    ]
  }
}
ENDJSON

  # Initialize git so claude doesn't complain
  (cd "$FAKE_PROJECT" && git init -q 2>/dev/null || true)

  # Test 1: run a normal command — hook should rewrite to rv-exec and inject secret
  CLAUDE_OUTPUT=$(cd "$FAKE_PROJECT" && HOME="$REAL_HOME" claude -p \
    'Run this exact bash command verbatim and show the output: echo hello' \
    --allowedTools 'Bash' \
    --dangerously-skip-permissions \
    2>&1) || true

  echo "  claude output (first 300 chars): ${CLAUDE_OUTPUT:0:300}"

  # The secret value should not appear in plain text
  if echo "$CLAUDE_OUTPUT" | grep -q "hunter2"; then
    fail "e2e: secret value leaked in claude output"
  else
    pass "e2e: secret value not leaked"
  fi

  # The command should have run (hello in output) or show hook evidence
  if echo "$CLAUDE_OUTPUT" | grep -qi "hello\|rv-exec\|redpill-vault\|blocked"; then
    pass "e2e: hook engaged (command ran or was processed)"
  else
    fail "e2e: no evidence of hook activity in output: ${CLAUDE_OUTPUT:0:200}"
  fi

  # Test 2: agent tries to run rv approve — should be blocked
  CLAUDE_OUTPUT2=$(cd "$FAKE_PROJECT" && HOME="$REAL_HOME" claude -p \
    'Run this exact bash command verbatim: rv approve' \
    --allowedTools 'Bash' \
    --dangerously-skip-permissions \
    2>&1) || true

  echo "  claude approve output (first 300 chars): ${CLAUDE_OUTPUT2:0:300}"

  if echo "$CLAUDE_OUTPUT2" | grep -qi "blocked\|denied\|not allowed\|only the user\|redpill-vault"; then
    pass "e2e: rv approve blocked by hook"
  else
    fail "e2e: rv approve was not blocked: ${CLAUDE_OUTPUT2:0:200}"
  fi
else
  echo "  SKIP: claude not found in PATH"
fi

# --- Summary ---
echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ] || exit 1

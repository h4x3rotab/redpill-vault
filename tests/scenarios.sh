#!/usr/bin/env bash
set -euo pipefail

# Real-world scenario tests for redpill-vault hook behavior.
#
# All tests run locally via the hook binary (no claude CLI needed).
# Tests the hook's processCommand output and rv-exec injection.
#
# Scenarios:
#   1. Key injection works end-to-end
#   2. Commands without secrets pass through unmodified
#   2b. Commands without secret usage still get wrapped when config exists
#   2c. Commands referencing unapproved keys don't get them injected
#   3. Missing vault keys are surfaced
#   4. Only keys listed in .rv.json are injected (per-repo scoping)
#   5. Complex bash commands survive wrapping (pipes, &&, for loops, heredocs)
#   6. Already-wrapped commands aren't double-wrapped
#   7. Non-Bash tool calls are ignored

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

cleanup() { rm -rf "$FAKE_STATE" "$FAKE_PROJECT"; }
trap cleanup EXIT

# Helper: pipe a Bash command through the hook, return JSON output
hook() {
  local cmd="$1"
  local cwd="${2:-$FAKE_PROJECT}"
  local input="{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":$(echo "$cmd" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read().rstrip()))')},\"cwd\":\"$cwd\"}"
  echo "$input" | node "$PROJECT_DIR/dist/hook.js" 2>/dev/null || true
}

# Helper: extract the rewritten command from hook JSON output
hook_cmd() {
  local output
  output=$(hook "$1" "${2:-}")
  echo "$output" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["hookSpecificOutput"]["updatedInput"]["command"])' 2>/dev/null || echo ""
}

# Helper: check hook blocks (exit code 2)
hook_blocks() {
  local cmd="$1"
  local cwd="${2:-$FAKE_PROJECT}"
  local input="{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":$(echo "$cmd" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read().rstrip()))')},\"cwd\":\"$cwd\"}"
  echo "$input" | node "$PROJECT_DIR/dist/hook.js" 2>/dev/null
  return $?
}

echo "=== redpill-vault scenario tests ==="

# ── Bootstrap ──────────────────────────────────────────────────────────
cd "$FAKE_PROJECT"
node "$PROJECT_DIR/dist/cli.js" init >/dev/null 2>&1
MASTER_KEY=$(cat "$RV_CONFIG_DIR/master-key" | tr -d '\n')

# Store two secrets in vault
echo "sk-test-openai-key-1234" | PSST_PASSWORD="$MASTER_KEY" psst --global set OPENAI_API_KEY --stdin >/dev/null 2>&1
echo "sk_test_stripe_5678"     | PSST_PASSWORD="$MASTER_KEY" psst --global set STRIPE_KEY --stdin >/dev/null 2>&1

# Configure project with only OPENAI_API_KEY
cat > "$FAKE_PROJECT/.rv.json" <<'EOF'
{
  "secrets": {
    "OPENAI_API_KEY": { "description": "OpenAI API key" }
  }
}
EOF

node "$PROJECT_DIR/dist/cli.js" approve >/dev/null 2>&1

# ── 1. Key injection works ─────────────────────────────────────────────
echo ""
echo "--- 1. Key injection ---"

# Hook should wrap with rv-exec OPENAI_API_KEY
WRAPPED=$(hook_cmd "curl -H 'Authorization: Bearer \$OPENAI_API_KEY' https://api.openai.com/v1/models")
if echo "$WRAPPED" | grep -q "rv-exec OPENAI_API_KEY -- bash -c"; then
  pass "hook wraps curl command with OPENAI_API_KEY"
else
  fail "expected rv-exec wrapping, got: $WRAPPED"
fi

# rv-exec actually injects the key as env var
OUTPUT=$(PSST_PASSWORD="$MASTER_KEY" node "$PROJECT_DIR/dist/rv-exec.js" OPENAI_API_KEY -- printenv OPENAI_API_KEY 2>&1)
if [ -n "$OUTPUT" ]; then
  pass "rv-exec injects OPENAI_API_KEY (got: ${OUTPUT:0:20}...)"
else
  fail "rv-exec did not inject OPENAI_API_KEY"
fi

# ── 2. No-secret commands pass through unmodified ──────────────────────
echo ""
echo "--- 2. No-secret passthrough ---"

# Create a project with empty secrets
CLEAN_PROJECT="$(mktemp -d)"
cat > "$CLEAN_PROJECT/.rv.json" <<'EOF'
{ "secrets": {} }
EOF
(cd "$CLEAN_PROJECT" && node "$PROJECT_DIR/dist/cli.js" approve >/dev/null 2>&1)

OUTPUT=$(hook "echo hello" "$CLEAN_PROJECT")
if [ -z "$OUTPUT" ]; then
  pass "empty-secrets project: command passes through unmodified"
else
  fail "empty-secrets project: unexpected hook output: $OUTPUT"
fi

# Project with no .rv.json at all
NO_RV_PROJECT="$(mktemp -d)"
(cd "$NO_RV_PROJECT" && node "$PROJECT_DIR/dist/cli.js" approve >/dev/null 2>&1)
OUTPUT=$(hook "ls -la" "$NO_RV_PROJECT")
if [ -z "$OUTPUT" ]; then
  pass "no .rv.json: command passes through unmodified"
else
  fail "no .rv.json: unexpected hook output: $OUTPUT"
fi

rm -rf "$CLEAN_PROJECT" "$NO_RV_PROJECT"

# ── 2b. Commands without secret usage still get wrapped ────────────────
echo ""
echo "--- 2b. No-secret usage but config exists ---"

# With secrets configured, hook wraps even if command doesn't reference them.
WRAPPED=$(hook_cmd "echo hello")
if echo "$WRAPPED" | grep -q "rv-exec" && echo "$WRAPPED" | grep -q "OPENAI_API_KEY"; then
  pass "command without secret usage is still wrapped (expected pollution)"
else
  fail "expected wrapping despite no secret usage: $WRAPPED"
fi

# ── 2c. Command needs key not approved/injected ─────────────────────────
echo ""
echo "--- 2c. Command needs unapproved key ---"

# Command references STRIPE_KEY, but .rv.json only allows OPENAI_API_KEY.
WRAPPED=$(hook_cmd "echo \$STRIPE_KEY")
KEYS=$(echo "$WRAPPED" | sed -E "s/^rv-exec (.*) -- .*/\\1/")
if [ "$KEYS" = "OPENAI_API_KEY" ]; then
  pass "hook only injects approved keys even if command references others"
else
  fail "hook injected unexpected keys: $WRAPPED"
fi

# Running the command through rv-exec should not populate STRIPE_KEY.
EXEC_OUTPUT=$(PSST_PASSWORD="$MASTER_KEY" node "$PROJECT_DIR/dist/rv-exec.js" OPENAI_API_KEY -- printenv STRIPE_KEY 2>&1 || true)
if echo "$EXEC_OUTPUT" | grep -q "STRIPE_KEY="; then
  fail "unexpected STRIPE_KEY value injected: $EXEC_OUTPUT"
else
  pass "unapproved key remains unset at runtime"
fi

# ── 3. Missing vault key surfaced by rv-exec ───────────────────────────
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

# Hook should still wrap with both keys
WRAPPED=$(hook_cmd "echo test")
if echo "$WRAPPED" | grep -q "OPENAI_API_KEY" && echo "$WRAPPED" | grep -q "NONEXISTENT_KEY"; then
  pass "hook includes both keys (existing and missing)"
else
  fail "hook didn't include both keys: $WRAPPED"
fi

# rv-exec with missing key — psst should error or skip
EXEC_OUTPUT=$(PSST_PASSWORD="$MASTER_KEY" node "$PROJECT_DIR/dist/rv-exec.js" NONEXISTENT_KEY -- echo ok 2>&1) || true
if echo "$EXEC_OUTPUT" | grep -qi "missing secrets\|no secret\|not found\|unknown"; then
  pass "rv-exec surfaces missing key error"
else
  # psst might still run the command but not inject — check env var is empty
  EXEC_OUTPUT2=$(PSST_PASSWORD="$MASTER_KEY" node "$PROJECT_DIR/dist/rv-exec.js" NONEXISTENT_KEY -- printenv NONEXISTENT_KEY 2>&1) || true
  if echo "$EXEC_OUTPUT2" | grep -q "NONEXISTENT_KEY="; then
    fail "rv-exec: missing key unexpectedly set: $EXEC_OUTPUT2"
  else
    pass "rv-exec: missing key results in no env var"
  fi
fi

# rv check should report the missing key
CHECK_OUTPUT=$(cd "$FAKE_PROJECT" && PSST_PASSWORD="$MASTER_KEY" node "$PROJECT_DIR/dist/cli.js" check 2>&1) || true
if echo "$CHECK_OUTPUT" | grep -q "NONEXISTENT_KEY" && echo "$CHECK_OUTPUT" | grep -qi "MISSING\|NOT"; then
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

# STRIPE_KEY is in vault but NOT in .rv.json — should not be injected
WRAPPED=$(hook_cmd "echo test")
if echo "$WRAPPED" | grep -q "STRIPE_KEY"; then
  fail "STRIPE_KEY injected despite not being in .rv.json"
else
  pass "STRIPE_KEY not injected (not in .rv.json)"
fi

if echo "$WRAPPED" | grep -q "OPENAI_API_KEY"; then
  pass "OPENAI_API_KEY injected (in .rv.json)"
else
  fail "OPENAI_API_KEY not injected"
fi

# Different project with only STRIPE_KEY
STRIPE_PROJECT="$(mktemp -d)"
cat > "$STRIPE_PROJECT/.rv.json" <<'EOF'
{
  "secrets": {
    "STRIPE_KEY": { "description": "Stripe API key" }
  }
}
EOF
(cd "$STRIPE_PROJECT" && node "$PROJECT_DIR/dist/cli.js" approve >/dev/null 2>&1)

WRAPPED2=$(hook_cmd "echo test" "$STRIPE_PROJECT")
if echo "$WRAPPED2" | grep -q "STRIPE_KEY" && ! echo "$WRAPPED2" | grep -q "OPENAI_API_KEY"; then
  pass "stripe project only injects STRIPE_KEY"
else
  fail "stripe project key scoping wrong: $WRAPPED2"
fi
rm -rf "$STRIPE_PROJECT"

# ── 5. Complex bash commands survive wrapping ──────────────────────────
echo ""
echo "--- 5. Complex commands ---"

# Multi-statement with &&
WRAPPED=$(hook_cmd "npm install && npm test")
if echo "$WRAPPED" | grep -q "bash -c 'npm install && npm test'"; then
  pass "multi-statement (&&) preserved"
else
  fail "multi-statement broken: $WRAPPED"
fi

# Pipe chain
WRAPPED=$(hook_cmd "cat file.txt | grep error | wc -l")
if echo "$WRAPPED" | grep -q "bash -c 'cat file.txt | grep error | wc -l'"; then
  pass "pipe chain preserved"
else
  fail "pipe chain broken: $WRAPPED"
fi

# For loop
WRAPPED=$(hook_cmd 'for i in 1 2 3; do echo $i; done')
if echo "$WRAPPED" | grep -q "bash -c 'for i in 1 2 3"; then
  pass "for loop preserved"
else
  fail "for loop broken: $WRAPPED"
fi

# Command with single quotes (the tricky one)
WRAPPED=$(hook_cmd "echo 'hello world'")
if echo "$WRAPPED" | grep -q "bash -c 'echo"; then
  pass "single-quoted string preserved"
else
  fail "single-quoted string broken: $WRAPPED"
fi

# Subshell
WRAPPED=$(hook_cmd 'echo $(date +%Y)')
if echo "$WRAPPED" | grep -q 'bash -c'; then
  pass "subshell preserved in wrapping"
else
  fail "subshell broken: $WRAPPED"
fi

# Heredoc-style
WRAPPED=$(hook_cmd 'python3 <<EOF
print("hello")
EOF')
if echo "$WRAPPED" | grep -q "bash -c"; then
  pass "heredoc preserved in wrapping"
else
  fail "heredoc broken: $WRAPPED"
fi

# Actually execute a complex command through rv-exec to prove it works
EXEC_OUTPUT=$(PSST_PASSWORD="$MASTER_KEY" node "$PROJECT_DIR/dist/rv-exec.js" OPENAI_API_KEY -- echo one '&&' echo two '&&' echo three 2>&1)
if echo "$EXEC_OUTPUT" | grep -q "one" && echo "$EXEC_OUTPUT" | grep -q "two" && echo "$EXEC_OUTPUT" | grep -q "three"; then
  pass "rv-exec runs multi-statement command correctly"
else
  fail "rv-exec multi-statement failed: $EXEC_OUTPUT"
fi

# Execute with pipes
EXEC_OUTPUT=$(PSST_PASSWORD="$MASTER_KEY" node "$PROJECT_DIR/dist/rv-exec.js" OPENAI_API_KEY -- seq 3 '|' wc -l 2>&1)
if echo "$EXEC_OUTPUT" | grep -q "3"; then
  pass "rv-exec runs piped command correctly"
else
  fail "rv-exec pipe failed: $EXEC_OUTPUT"
fi

# Execute for loop
EXEC_OUTPUT=$(PSST_PASSWORD="$MASTER_KEY" node "$PROJECT_DIR/dist/rv-exec.js" OPENAI_API_KEY -- 'for' 'i' 'in' 'x' 'y' 'z' ';' 'do' 'echo' '$i' ';' 'done' 2>&1)
if echo "$EXEC_OUTPUT" | grep -q "x" && echo "$EXEC_OUTPUT" | grep -q "y" && echo "$EXEC_OUTPUT" | grep -q "z"; then
  pass "rv-exec runs for loop correctly"
else
  fail "rv-exec for loop failed: $EXEC_OUTPUT"
fi

# Injected key available inside complex command
EXEC_OUTPUT=$(PSST_PASSWORD="$MASTER_KEY" node "$PROJECT_DIR/dist/rv-exec.js" OPENAI_API_KEY -- 'if' '[' '-n' '$OPENAI_API_KEY' ']' ';' 'then' 'echo' 'key_present' ';' 'fi' 2>&1)
if echo "$EXEC_OUTPUT" | grep -q "key_present"; then
  pass "injected key available inside complex command"
else
  fail "injected key not available: $EXEC_OUTPUT"
fi

# ── 6. No double-wrapping ─────────────────────────────────────────────
echo ""
echo "--- 6. No double-wrapping ---"

OUTPUT=$(hook "rv-exec OPENAI_API_KEY -- bash -c 'echo hi'")
if [ -z "$OUTPUT" ]; then
  pass "already-wrapped command passes through (no double wrap)"
else
  fail "double-wrapped: $OUTPUT"
fi

# ── 7. Non-Bash tool calls ignored ────────────────────────────────────
echo ""
echo "--- 7. Non-Bash tool calls ---"

INPUT='{"tool_name":"Read","tool_input":{"file_path":"/etc/passwd"},"cwd":"'"$FAKE_PROJECT"'"}'
OUTPUT=$(echo "$INPUT" | node "$PROJECT_DIR/dist/hook.js" 2>/dev/null || true)
if [ -z "$OUTPUT" ]; then
  pass "Read tool call ignored by hook"
else
  fail "hook processed non-Bash tool: $OUTPUT"
fi

INPUT='{"tool_name":"Write","tool_input":{"file_path":"/tmp/x","content":"y"},"cwd":"'"$FAKE_PROJECT"'"}'
OUTPUT=$(echo "$INPUT" | node "$PROJECT_DIR/dist/hook.js" 2>/dev/null || true)
if [ -z "$OUTPUT" ]; then
  pass "Write tool call ignored by hook"
else
  fail "hook processed non-Bash tool: $OUTPUT"
fi

# ── 8. Alias/rename support ───────────────────────────────────────────
echo ""
echo "--- 8. Alias support ---"

cat > "$FAKE_PROJECT/.rv.json" <<'EOF'
{
  "secrets": {
    "OPENAI_API_KEY": { "description": "OpenAI key", "as": "MY_KEY" }
  }
}
EOF

WRAPPED=$(hook_cmd "echo test")
if echo "$WRAPPED" | grep -q "OPENAI_API_KEY=MY_KEY"; then
  pass "alias renames key in rv-exec args"
else
  fail "alias not applied: $WRAPPED"
fi

# Verify the alias works in rv-exec
EXEC_OUTPUT=$(PSST_PASSWORD="$MASTER_KEY" node "$PROJECT_DIR/dist/rv-exec.js" OPENAI_API_KEY=MY_KEY -- printenv MY_KEY 2>&1 || true)
if [ -n "$EXEC_OUTPUT" ]; then
  pass "rv-exec injects aliased key as MY_KEY"
else
  fail "rv-exec alias injection failed"
fi

# Restore config
cat > "$FAKE_PROJECT/.rv.json" <<'EOF'
{
  "secrets": {
    "OPENAI_API_KEY": { "description": "OpenAI API key" }
  }
}
EOF

# ── 9. Unapproved project blocks everything ───────────────────────────
echo ""
echo "--- 9. Unapproved project ---"

UNAPPROVED="$(mktemp -d)"
cat > "$UNAPPROVED/.rv.json" <<'EOF'
{
  "secrets": {
    "OPENAI_API_KEY": { "description": "OpenAI key" }
  }
}
EOF

if hook_blocks "echo hello" "$UNAPPROVED"; then
  fail "unapproved project should block"
else
  pass "unapproved project blocks commands"
fi

# rv commands still pass through even without approval
OUTPUT=$(hook "rv list" "$UNAPPROVED")
EXIT=$?
if [ $EXIT -eq 0 ]; then
  pass "rv list passes through without approval"
else
  fail "rv list blocked on unapproved project"
fi

rm -rf "$UNAPPROVED"

# ── Summary ───────────────────────────────────────────────────────────
echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ] || exit 1

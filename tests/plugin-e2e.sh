#!/usr/bin/env bash
set -euo pipefail

# E2E test for rv init (unified setup) and plugin artifacts.
#
# Validates:
#   - build + unit tests pass
#   - plugin JSON/markdown files are well-formed
#   - rv init creates all expected files in a fresh directory
#   - rv init is idempotent on re-run
#   - package.json ships plugin dirs

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

cleanup() {
  rm -rf "$FAKE_STATE" "$FAKE_PROJECT"
}
trap cleanup EXIT

FAKE_STATE="$(mktemp -d)"
FAKE_PROJECT="$(mktemp -d)"
export HOME="$FAKE_STATE/home"
mkdir -p "$HOME"
export RV_CONFIG_DIR="$FAKE_STATE/rv"
export PATH="$PROJECT_DIR/dist:$PROJECT_DIR/node_modules/.bin:$PATH"

# Use node directly to ensure we test the built version
rv() { node "$PROJECT_DIR/dist/cli.js" "$@"; }
rv-exec() { node "$PROJECT_DIR/dist/rv-exec.js" "$@"; }

# ── Build & unit tests ───────────────────────────────────────────────
echo "=== Build & unit tests ==="
npm run build --prefix "$PROJECT_DIR" >/dev/null 2>&1 && pass "build" || fail "build"
npm test --prefix "$PROJECT_DIR" >/dev/null 2>&1 && pass "unit tests" || fail "unit tests"

# ── Plugin artifact validation ───────────────────────────────────────
echo "=== Plugin artifacts ==="
python3 -m json.tool "$PROJECT_DIR/.claude-plugin/marketplace.json" >/dev/null 2>&1 \
  && pass "marketplace.json valid" || fail "marketplace.json invalid"
bash -n "$PROJECT_DIR/skills/redpill-vault/setup.sh" \
  && pass "setup.sh syntax" || fail "setup.sh syntax"
test -x "$PROJECT_DIR/skills/redpill-vault/setup.sh" \
  && pass "setup.sh executable" || fail "setup.sh not executable"
test -f "$PROJECT_DIR/skills/redpill-vault/SKILL.md" \
  && pass "SKILL.md exists" || fail "SKILL.md missing"
grep -q "claude-plugin" "$PROJECT_DIR/package.json" \
  && pass "plugin dirs in package.json files" || fail "plugin dirs missing from package.json"

# ── rv init (fresh directory) ────────────────────────────────────────
echo "=== rv init (fresh dir) ==="
cd "$FAKE_PROJECT"
rv init 2>&1

test -f "$RV_CONFIG_DIR/master-key" \
  && pass "master key created" || fail "master key missing"
test -f "$HOME/.psst/vault.db" \
  && pass "vault.db created" || fail "vault.db missing"
test -f .rv.json \
  && pass ".rv.json created" || fail ".rv.json missing"

# ── rv init (idempotent re-run) ──────────────────────────────────────
echo "=== rv init (idempotent) ==="
output=$(rv init 2>&1)
echo "$output" | grep -q "already exists" \
  && pass "idempotent: skips existing" || fail "idempotent: unexpected output"

# ── rv-exec functional test ──────────────────────────────────────────
echo "=== rv-exec functional ==="

# Import a test secret
echo "TEST_VALUE=secret123" > .env
rv import .env 2>&1

# Approve the project
rv approve 2>&1
[ $? -eq 0 ] && pass "rv approve succeeded" || fail "rv approve failed"

# Test rv-exec --all
output=$(rv-exec --all -- printenv TEST_VALUE 2>&1)
if [ -n "$output" ]; then
  pass "rv-exec --all works"
else
  fail "rv-exec --all failed: $output"
fi

# ── Summary ──────────────────────────────────────────────────────────
echo ""
echo "$((PASS + FAIL)) tests: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi

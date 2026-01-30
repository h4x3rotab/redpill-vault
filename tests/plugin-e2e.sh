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
export RV_CONFIG_DIR="$FAKE_STATE/rv"
export PATH="$PROJECT_DIR/dist:$PROJECT_DIR/node_modules/.bin:$PATH"

# ── Build & unit tests ───────────────────────────────────────────────
echo "=== Build & unit tests ==="
npm run build --prefix "$PROJECT_DIR" >/dev/null 2>&1 && pass "build" || fail "build"
npm test --prefix "$PROJECT_DIR" >/dev/null 2>&1 && pass "unit tests" || fail "unit tests"

# ── Plugin artifact validation ───────────────────────────────────────
echo "=== Plugin artifacts ==="
python3 -m json.tool "$PROJECT_DIR/.claude-plugin/marketplace.json" >/dev/null 2>&1 \
  && pass "marketplace.json valid" || fail "marketplace.json invalid"
python3 -m json.tool "$PROJECT_DIR/hooks/hooks.json" >/dev/null 2>&1 \
  && pass "hooks.json valid" || fail "hooks.json invalid"
bash -n "$PROJECT_DIR/setup.sh" \
  && pass "setup.sh syntax" || fail "setup.sh syntax"
test -x "$PROJECT_DIR/setup.sh" \
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
test -f .rv.json \
  && pass ".rv.json created" || fail ".rv.json missing"
test -f .claude/settings.json \
  && pass "settings.json created" || fail "settings.json missing"
grep -q rv-hook .claude/settings.json \
  && pass "rv-hook wired in settings" || fail "rv-hook not in settings"

# ── rv init (idempotent re-run) ──────────────────────────────────────
echo "=== rv init (idempotent) ==="
output=$(rv init 2>&1)
echo "$output" | grep -q "already exists" \
  && pass "idempotent: skips existing" || fail "idempotent: unexpected output"
echo "$output" | grep -q "already configured" \
  && pass "idempotent: hook already configured" || fail "idempotent: hook re-added"

# ── Summary ──────────────────────────────────────────────────────────
echo ""
echo "$((PASS + FAIL)) tests: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi

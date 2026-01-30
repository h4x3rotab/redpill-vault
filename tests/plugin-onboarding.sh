#!/usr/bin/env bash
set -euo pipefail

# E2E test for the Claude Code plugin onboarding flow.
#
# Simulates the exact developer experience:
#   1. Install plugin via marketplace (rv NOT installed yet)
#   2. Ask Claude to set up redpill-vault — it installs the package and runs rv init
#   3. Hook blocks because project is not approved
#   4. User runs rv approve
#   5. Approved project: command passes through
#   6. Verify skill and plugin artifacts
#   7. Clean uninstall
#
# Requires: claude CLI authenticated

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
npm run build --prefix "$PROJECT_DIR" >/dev/null 2>&1
npm unlink -g redpill-vault 2>/dev/null || true

if command -v rv-hook &>/dev/null; then
  fail "rv-hook still on PATH after unlink"
else
  pass "rv-hook not on PATH (clean slate)"
fi

# ── 1. Plugin validation + install ───────────────────────────────────
echo ""
echo "=== Plugin validation ==="
validate_output=$(claude plugin validate "$PROJECT_DIR" 2>&1)
echo "$validate_output"
echo "$validate_output" | grep -q "Validation passed" \
  && pass "marketplace validates" || fail "marketplace validation failed"

echo ""
echo "=== Plugin install ==="
claude plugin uninstall "${PLUGIN_NAME}@${MARKETPLACE_NAME}" 2>/dev/null || true
claude plugin marketplace remove "${MARKETPLACE_NAME}" 2>/dev/null || true

claude plugin marketplace add "$PROJECT_DIR" 2>&1
[ $? -eq 0 ] && pass "marketplace add" || fail "marketplace add"

claude plugin install "${PLUGIN_NAME}@${MARKETPLACE_NAME}" 2>&1
[ $? -eq 0 ] && pass "plugin install" || fail "plugin install"

# Verify plugin lists
skill_list=$(claude plugin list 2>&1 || true)
echo "$skill_list"
echo "$skill_list" | grep -qi "redpill-vault" \
  && pass "plugin lists redpill-vault" || fail "plugin does not list redpill-vault"

# ── 2. Ask Claude to set up rv — it should install + init itself ──────
echo ""
echo "=== Agent-driven setup ==="
cd "$FAKE_PROJECT"

# Claude reads SKILL.md to figure out how to install and init.
# We only hint at the local path — Claude must discover the commands from the skill.
setup_output=$(claude -p \
  "Set up redpill-vault for this project. Note: the npm package is not published yet, use this local path instead of the registry: $PROJECT_DIR" \
  --allowedTools "Bash" \
  2>&1 || true)

echo "$setup_output"

# After Claude ran, rv should be installed and rv init should have run
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

# ── 5. Skill file checks ─────────────────────────────────────────────
echo ""
echo "=== Skill file ==="
test -f "$PROJECT_DIR/skills/redpill-vault/SKILL.md" \
  && pass "SKILL.md exists" || fail "SKILL.md missing"
grep -q "^---" "$PROJECT_DIR/skills/redpill-vault/SKILL.md" \
  && pass "SKILL.md has YAML frontmatter" || fail "SKILL.md missing frontmatter"
grep -q "npm i -g" "$PROJECT_DIR/skills/redpill-vault/SKILL.md" \
  && pass "SKILL.md has install instructions" || fail "SKILL.md missing install instructions"
grep -q "user only" "$PROJECT_DIR/skills/redpill-vault/SKILL.md" \
  && pass "SKILL.md marks approve as user-only" || fail "SKILL.md missing user-only marker"

# ── 6. Clean uninstall ───────────────────────────────────────────────
echo ""
echo "=== Plugin uninstall ==="
claude plugin uninstall "${PLUGIN_NAME}@${MARKETPLACE_NAME}" 2>&1 \
  && pass "plugin uninstall" || fail "plugin uninstall failed"
claude plugin marketplace remove "${MARKETPLACE_NAME}" 2>&1 \
  && pass "marketplace remove" || fail "marketplace remove failed"

# ── Summary ──────────────────────────────────────────────────────────
echo ""
echo "$((PASS + FAIL)) tests: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi

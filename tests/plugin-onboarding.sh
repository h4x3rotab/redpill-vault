#!/usr/bin/env bash
set -euo pipefail

# E2E test for the Claude Code plugin onboarding flow.
#
# Simulates the exact first-time developer experience:
#   0. Ensure rv is NOT installed (npm unlink)
#   1. Build the project (but don't link)
#   2. Install plugin via marketplace
#   3. Claude tries a bash command → setup.sh fires → installs rv globally
#   4. Ask Claude to set up redpill-vault — it tells user to run rv init
#   5. User follows instructions: runs rv init
#   6. Hook blocks unapproved project
#   7. User follows instructions: runs rv approve
#   8. Approved project: command passes through
#   9. Skill file checks
#  10. Clean uninstall
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
# Tell setup.sh to install from local source instead of npm registry
export RV_INSTALL_SOURCE="$PROJECT_DIR"

# ── 0. Ensure rv is NOT installed ────────────────────────────────────
echo "=== Ensure rv not installed ==="
npm run build --prefix "$PROJECT_DIR" >/dev/null 2>&1
npm unlink -g redpill-vault 2>/dev/null || true

if command -v rv-hook &>/dev/null; then
  fail "rv-hook still on PATH after unlink"
else
  pass "rv-hook not on PATH (clean slate)"
fi

# ── 1. Plugin validation ─────────────────────────────────────────────
echo ""
echo "=== Plugin validation ==="
validate_output=$(claude plugin validate "$PROJECT_DIR" 2>&1)
echo "$validate_output"
echo "$validate_output" | grep -q "Validation passed" \
  && pass "marketplace validates" || fail "marketplace validation failed"

# ── 2. Install via marketplace ────────────────────────────────────────
echo ""
echo "=== Plugin install ==="
claude plugin uninstall "${PLUGIN_NAME}@${MARKETPLACE_NAME}" 2>/dev/null || true
claude plugin marketplace remove "${MARKETPLACE_NAME}" 2>/dev/null || true

claude plugin marketplace add "$PROJECT_DIR" 2>&1
[ $? -eq 0 ] && pass "marketplace add" || fail "marketplace add"

claude plugin install "${PLUGIN_NAME}@${MARKETPLACE_NAME}" 2>&1
[ $? -eq 0 ] && pass "plugin install" || fail "plugin install"

# ── 3. First bash command triggers setup.sh bootstrap ─────────────────
echo ""
echo "=== Bootstrap: setup.sh installs rv ==="
cd "$FAKE_PROJECT"

# Claude tries a command. The plugin hook (setup.sh) should detect rv-hook
# is missing, run npm i -g from $RV_INSTALL_SOURCE, then rv-hook runs and
# blocks because the project is not approved.
bootstrap_output=$(claude -p "Run this exact bash command: echo bootstrap-test" \
  --allowedTools "Bash" \
  2>&1 || true)

echo "$bootstrap_output"

# After the hook ran, rv-hook should now be on PATH
if command -v rv-hook &>/dev/null; then
  pass "setup.sh installed rv-hook"
else
  fail "setup.sh did not install rv-hook"
fi

if command -v rv &>/dev/null; then
  pass "setup.sh installed rv"
else
  fail "setup.sh did not install rv"
fi

# ── 4. Verify skill is loaded by plugin ───────────────────────────────
echo ""
echo "=== Skill loaded ==="

# Deterministic check: the plugin lists its skills
skill_list=$(claude plugin list 2>&1 || true)
echo "$skill_list"

if echo "$skill_list" | grep -qi "redpill-vault"; then
  pass "plugin lists redpill-vault skill"
else
  fail "plugin does not list redpill-vault"
fi

# ── 5. User follows instructions: runs rv init ───────────────────────
echo ""
echo "=== User runs rv init ==="
rv init 2>&1

test -f .rv.json && pass "rv init created .rv.json" || fail "rv init: no .rv.json"
test -f .claude/settings.json && pass "settings.json created" || fail "settings.json missing"

# ── 6. Hook blocks unapproved project ────────────────────────────────
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

# ── 7. User follows instructions: runs rv approve ────────────────────
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

# ── 8. Skill file checks ─────────────────────────────────────────────
echo ""
echo "=== Skill file ==="
test -f "$PROJECT_DIR/skills/redpill-vault/SKILL.md" \
  && pass "SKILL.md exists" || fail "SKILL.md missing"
grep -q "^---" "$PROJECT_DIR/skills/redpill-vault/SKILL.md" \
  && pass "SKILL.md has YAML frontmatter" || fail "SKILL.md missing frontmatter"
grep -q "rv init" "$PROJECT_DIR/skills/redpill-vault/SKILL.md" \
  && pass "SKILL.md references rv init" || fail "SKILL.md missing rv init"

# ── 9. Clean uninstall ───────────────────────────────────────────────
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

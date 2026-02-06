#!/usr/bin/env bash
set -euo pipefail

# E2E test for the Claude Code plugin onboarding flow.
#
# Simulates the exact developer experience:
#   1. Install plugin via marketplace (rv NOT installed yet)
#   2. Ask Claude to set up redpill-vault — it installs the package and runs rv init
#   3. Claude uses rv-exec --all to run commands with secrets
#   4. Verify skill and plugin artifacts
#   5. Clean uninstall
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
export HOME="$FAKE_STATE/home"
mkdir -p "$HOME"
# Tell setup.sh to install from local source instead of npm registry
export RV_INSTALL_SOURCE="$PROJECT_DIR"

# ── 0. Ensure rv is NOT installed ────────────────────────────────────
echo "=== Ensure rv not installed ==="
npm run build --prefix "$PROJECT_DIR" >/dev/null 2>&1
npm unlink -g redpill-vault 2>/dev/null || true

if command -v rv &>/dev/null; then
  echo "  Note: rv found on PATH (will be reinstalled by skill)"
else
  pass "rv not on PATH (clean slate)"
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

# Claude invokes the redpill-vault skill, which runs setup.sh + rv init.
# RV_INSTALL_SOURCE tells setup.sh to use local source instead of npm.
setup_output=$(claude -p \
  "Use the redpill-vault skill to set up redpill-vault for this project." \
  --allowedTools "Bash,Skill" \
  2>&1 || true)

echo "$setup_output"

# After Claude ran, rv should be installed and rv init should have run
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

# ── 3. Test rv-exec --all with Claude ────────────────────────────────
echo ""
echo "=== rv-exec with secrets ==="

# Add a test secret
echo "TEST_SECRET=plugin_onboarding_test" > .env
rv import .env 2>&1

# Approve the project (required for rv-exec to work)
rv approve 2>&1
[ $? -eq 0 ] && pass "rv approve succeeded" || fail "rv approve failed"

# Verify the import worked
list_output=$(rv list 2>&1)
echo "$list_output"
if echo "$list_output" | grep -q "TEST_SECRET"; then
  pass "rv import added TEST_SECRET"
else
  fail "TEST_SECRET not in rv list"
fi

# Test rv-exec directly
exec_output=$(rv-exec --all -- printenv TEST_SECRET 2>&1)
if [ -n "$exec_output" ]; then
  pass "rv-exec --all injects secret"
else
  fail "rv-exec --all failed to inject secret"
fi

# ── 4. Skill file checks ─────────────────────────────────────────────
echo ""
echo "=== Skill file ==="
test -f "$PROJECT_DIR/skills/redpill-vault/SKILL.md" \
  && pass "SKILL.md exists" || fail "SKILL.md missing"
grep -q "^---" "$PROJECT_DIR/skills/redpill-vault/SKILL.md" \
  && pass "SKILL.md has YAML frontmatter" || fail "SKILL.md missing frontmatter"
grep -q "setup.sh" "$PROJECT_DIR/skills/redpill-vault/SKILL.md" \
  && pass "SKILL.md has install instructions" || fail "SKILL.md missing install instructions"
grep -q "rv-exec --all" "$PROJECT_DIR/skills/redpill-vault/SKILL.md" \
  && pass "SKILL.md documents rv-exec --all" || fail "SKILL.md missing rv-exec --all docs"

# ── 5. Clean uninstall ───────────────────────────────────────────────
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

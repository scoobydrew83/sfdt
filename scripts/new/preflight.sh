#!/bin/bash
set -euo pipefail

# Pre-release validation checklist
# Runs a series of checks to determine release readiness

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../utils/shared.sh"
source "${SCRIPT_DIR}/../lib/git-utils.sh"
source "${SCRIPT_DIR}/../lib/changelog-utils.sh"

# Configuration
COVERAGE_THRESHOLD="${SFDT_COVERAGE_THRESHOLD:-75}"
DEFAULT_ORG="${SFDT_DEFAULT_ORG:-}"
STRICT_MODE="${SFDT_PREFLIGHT_STRICT:-}"
PROJECT_NAME="${SFDT_PROJECT_NAME:-sfdt}"

# Track results
PASS_COUNT=0
FAIL_COUNT=0
WARN_COUNT=0
declare -a RESULTS=()

record_result() {
    local status="$1"
    local check="$2"
    local detail="${3:-}"

    case "$status" in
        PASS) PASS_COUNT=$((PASS_COUNT + 1)); RESULTS+=("$(print_success "[PASS] ${check}${detail:+ - ${detail}}")") ;;
        FAIL) FAIL_COUNT=$((FAIL_COUNT + 1)); RESULTS+=("$(print_error "[FAIL] ${check}${detail:+ - ${detail}}")") ;;
        WARN) WARN_COUNT=$((WARN_COUNT + 1)); RESULTS+=("$(print_warning "[WARN] ${check}${detail:+ - ${detail}}")") ;;
    esac
}

print_header "Pre-Release Preflight Check: ${PROJECT_NAME}"

# ── Check 1: Git working directory is clean ──────────────────────────────────
print_step "Checking git working directory..."
if git diff --quiet && git diff --cached --quiet; then
    record_result "PASS" "Git working directory is clean"
else
    changed_count=$(git status --porcelain | wc -l | tr -d ' ')
    record_result "FAIL" "Git working directory has uncommitted changes" "${changed_count} file(s) modified"
fi

# ── Check 2: Current branch matches expected pattern ─────────────────────────
print_step "Checking branch naming..."
current_branch=$(git rev-parse --abbrev-ref HEAD)
if [[ "$current_branch" =~ ^(main|master|release/.*|develop/.*)$ ]]; then
    record_result "PASS" "Branch '${current_branch}' matches expected pattern"
else
    record_result "WARN" "Branch '${current_branch}' does not match main|release/*|develop/* pattern"
fi

# ── Check 3: CHANGELOG.md exists and has unreleased content ──────────────────
print_step "Checking CHANGELOG.md..."
if [[ -f "CHANGELOG.md" ]]; then
    if changelog_has_unreleased; then
        record_result "PASS" "CHANGELOG.md has unreleased content"
    else
        record_result "WARN" "CHANGELOG.md exists but has no unreleased content"
    fi
else
    record_result "WARN" "CHANGELOG.md not found"
fi

# ── Check 4: sfdx-project.json exists ───────────────────────────────────────
print_step "Checking sfdx-project.json..."
if [[ -f "sfdx-project.json" ]]; then
    record_result "PASS" "sfdx-project.json exists"
else
    record_result "FAIL" "sfdx-project.json not found"
fi

# ── Check 5: Run Apex tests ─────────────────────────────────────────────────
print_step "Running Apex tests (RunLocalTests)..."
if [[ -z "$DEFAULT_ORG" ]]; then
    record_result "WARN" "Apex tests skipped" "SFDT_DEFAULT_ORG not set"
else
    TEST_OUTPUT_FILE=$(mktemp)
    if sf apex run test --test-level RunLocalTests --target-org "$DEFAULT_ORG" --json --wait 30 > "$TEST_OUTPUT_FILE" 2>&1; then
        test_status=$(jq -r '.result.summary.outcome // "Unknown"' "$TEST_OUTPUT_FILE" 2>/dev/null || echo "Unknown")
        if [[ "$test_status" == "Passed" ]]; then
            record_result "PASS" "All Apex tests passed"
        else
            failing=$(jq -r '.result.summary.failing // "unknown"' "$TEST_OUTPUT_FILE" 2>/dev/null || echo "unknown")
            record_result "FAIL" "Apex tests failed" "${failing} test(s) failing"
        fi
    else
        error_msg=$(jq -r '.message // "Unknown error"' "$TEST_OUTPUT_FILE" 2>/dev/null || echo "Test command failed")
        record_result "FAIL" "Apex test run failed" "$error_msg"
    fi

    # ── Check 6: Coverage threshold ──────────────────────────────────────────
    print_step "Checking code coverage..."
    coverage_pct=$(jq -r '.result.summary.orgWideCoverage // "0%"' "$TEST_OUTPUT_FILE" 2>/dev/null || echo "0%")
    coverage_num="${coverage_pct//%/}"
    if [[ "$coverage_num" =~ ^[0-9]+$ ]] && (( coverage_num >= COVERAGE_THRESHOLD )); then
        record_result "PASS" "Code coverage ${coverage_pct} meets threshold (${COVERAGE_THRESHOLD}%)"
    elif [[ "$coverage_num" =~ ^[0-9]+$ ]]; then
        record_result "FAIL" "Code coverage ${coverage_pct} below threshold (${COVERAGE_THRESHOLD}%)"
    else
        record_result "WARN" "Could not parse coverage percentage" "$coverage_pct"
    fi

    rm -f "$TEST_OUTPUT_FILE"
fi

# ── Check 7: Untracked files in force-app/ ──────────────────────────────────
print_step "Checking for untracked files in force-app/..."
if [[ -d "force-app" ]]; then
    untracked=$(git ls-files --others --exclude-standard force-app/ | head -20)
    if [[ -z "$untracked" ]]; then
        record_result "PASS" "No untracked files in force-app/"
    else
        untracked_count=$(git ls-files --others --exclude-standard force-app/ | wc -l | tr -d ' ')
        record_result "WARN" "Untracked files in force-app/" "${untracked_count} file(s)"
    fi
else
    record_result "WARN" "force-app/ directory not found"
fi

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
print_header "Preflight Summary"
for result in "${RESULTS[@]}"; do
    echo "$result"
done

echo ""
echo "  Passed: ${PASS_COUNT}  |  Failed: ${FAIL_COUNT}  |  Warnings: ${WARN_COUNT}"
echo ""

if (( FAIL_COUNT > 0 )); then
    print_error "PREFLIGHT: NO-GO (${FAIL_COUNT} failure(s))"
    exit 1
elif [[ -n "$STRICT_MODE" ]] && (( WARN_COUNT > 0 )); then
    print_error "PREFLIGHT: NO-GO (strict mode, ${WARN_COUNT} warning(s))"
    exit 1
elif (( WARN_COUNT > 0 )); then
    print_warning "PREFLIGHT: GO WITH CAUTION (${WARN_COUNT} warning(s))"
    exit 0
else
    print_success "PREFLIGHT: ALL CLEAR"
    exit 0
fi

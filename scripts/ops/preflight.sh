set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../utils/shared.sh"
source "${SCRIPT_DIR}/../lib/git-utils.sh"
source "${SCRIPT_DIR}/../lib/changelog-utils.sh"
COVERAGE_THRESHOLD="${SFDT_COVERAGE_THRESHOLD:-75}"
DEFAULT_ORG="${SFDT_DEFAULT_ORG:-}"
STRICT_MODE="${SFDT_PREFLIGHT_STRICT:-}"
PROJECT_NAME="${SFDT_PROJECT_NAME:-sfdt}"
ENFORCE_TESTS="${SFDT_PREFLIGHT_ENFORCE_TESTS:-}"
ENFORCE_BRANCH="${SFDT_PREFLIGHT_ENFORCE_BRANCH:-}"
ENFORCE_CHANGELOG="${SFDT_PREFLIGHT_ENFORCE_CHANGELOG:-}"
ENFORCE_GIT_CLEAN="${SFDT_PREFLIGHT_ENFORCE_GIT_CLEAN:-true}"
ENFORCE_SFDX_PROJECT="${SFDT_PREFLIGHT_ENFORCE_SFDX_PROJECT:-true}"
ENFORCE_UNTRACKED="${SFDT_PREFLIGHT_ENFORCE_UNTRACKED:-}"
PASS_COUNT=0
FAIL_COUNT=0
WARN_COUNT=0
declare -a RESULTS=()
record_result() {
    local status="$1"
    local check="$2"
    local detail="${3:-}"
    echo "SFDT_LOG:check:${check}:${status}:${detail}"
    case "$status" in
        PASS) PASS_COUNT=$((PASS_COUNT + 1)); RESULTS+=("$(print_success "[PASS] ${check}${detail:+ - ${detail}}")") ;;
        FAIL) FAIL_COUNT=$((FAIL_COUNT + 1)); RESULTS+=("$(print_error "[FAIL] ${check}${detail:+ - ${detail}}")") ;;
        WARN) WARN_COUNT=$((WARN_COUNT + 1)); RESULTS+=("$(print_warning "[WARN] ${check}${detail:+ - ${detail}}")") ;;
    esac
}
print_header "Pre-Release Preflight Check: ${PROJECT_NAME}"
if [[ "$ENFORCE_GIT_CLEAN" != "false" ]]; then
    print_step "Checking git working directory..."
    if git diff --quiet && git diff --cached --quiet; then
        record_result "PASS" "Git working directory is clean"
    else
        changed_count=$(git status --porcelain | wc -l | tr -d ' ')
        record_result "FAIL" "Git working directory has uncommitted changes" "${changed_count} file(s) modified"
    fi
else
    record_result "WARN" "Git working directory check skipped" "Set deployment.preflight.enforceGitClean: true to enable"
fi
print_step "Checking branch naming..."
current_branch=$(git rev-parse --abbrev-ref HEAD)
if [[ "$current_branch" =~ ^(main|master|release/.*|develop/.*)$ ]]; then
    record_result "PASS" "Branch '${current_branch}' matches expected pattern"
elif [[ -n "$ENFORCE_BRANCH" ]]; then
    record_result "FAIL" "Branch '${current_branch}' does not match main|release/*|develop/* pattern"
else
    record_result "WARN" "Branch '${current_branch}' does not match main|release/*|develop/* pattern"
fi
print_step "Checking CHANGELOG.md..."
if [[ -f "CHANGELOG.md" ]]; then
    if has_unreleased_content; then
        record_result "PASS" "CHANGELOG.md has unreleased content"
    elif [[ -n "$ENFORCE_CHANGELOG" ]]; then
        record_result "FAIL" "CHANGELOG.md exists but has no unreleased content"
    else
        record_result "WARN" "CHANGELOG.md exists but has no unreleased content"
    fi
elif [[ -n "$ENFORCE_CHANGELOG" ]]; then
    record_result "FAIL" "CHANGELOG.md not found"
else
    record_result "WARN" "CHANGELOG.md not found"
fi
if [[ "$ENFORCE_SFDX_PROJECT" != "false" ]]; then
    print_step "Checking sfdx-project.json..."
    if [[ -f "sfdx-project.json" ]]; then
        record_result "PASS" "sfdx-project.json exists"
    else
        record_result "FAIL" "sfdx-project.json not found"
    fi
else
    record_result "WARN" "sfdx-project.json check skipped" "Set deployment.preflight.enforceSfdxProject: true to enable"
fi
print_step "Checking Apex tests..."
if [[ -z "$ENFORCE_TESTS" ]]; then
    record_result "WARN" "Apex tests skipped" "Set deployment.preflight.enforceTests in config to require"
else
    require_jq || exit 1
    if [[ -z "$DEFAULT_ORG" ]]; then
        record_result "WARN" "Apex tests skipped — no default org configured" "Set defaultOrg in .sfdt/config.json"
    else
        TEST_OUTPUT_FILE=$(mktemp)
        TEST_RUN_OK=false
        sf apex run test --test-level RunLocalTests --target-org "$DEFAULT_ORG" --json --wait 30 \
            > "$TEST_OUTPUT_FILE" 2>&1 || true
        test_status=$(jq -r '.result.summary.outcome // ""' "$TEST_OUTPUT_FILE" 2>/dev/null)
        if [[ -n "$test_status" ]]; then
            TEST_RUN_OK=true
            if [[ "$test_status" == "Passed" ]]; then
                record_result "PASS" "All Apex tests passed"
            else
                failing=$(jq -r '.result.summary.failing // "unknown"' "$TEST_OUTPUT_FILE" 2>/dev/null || echo "unknown")
                record_result "FAIL" "Apex tests failed" "${failing} test(s) failing"
                echo ""
                jq -r '.result.tests[]? | select(.Outcome == "Fail") |
                    "  ❌ \(.ApexClass.Name // "?").\(.MethodName // "?"): \(.Message // "(no message)")"' \
                    "$TEST_OUTPUT_FILE" 2>/dev/null | head -10 || true
                echo ""
            fi
        else
            error_msg=$(jq -r '.message // .name // ""' "$TEST_OUTPUT_FILE" 2>/dev/null)
            if [[ -z "$error_msg" ]]; then
                error_msg=$(head -5 "$TEST_OUTPUT_FILE" 2>/dev/null | tr '\n' ' ')
            fi
            [[ -z "$error_msg" ]] && error_msg="Test command failed"
            if echo "$error_msg" | grep -qi \
                "cannot be found\|not found\|not authenticated\|no default\|ECONNREFUSED\|connect ETIMEDOUT\|DomainNotFoundError"; then
                record_result "WARN" "Apex tests skipped — org unreachable" "$error_msg"
            else
                record_result "FAIL" "Apex test run failed" "$error_msg"
                TEST_RUN_OK=true
            fi
        fi
        if [[ "$TEST_RUN_OK" == "true" ]]; then
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
        fi
        rm -f "$TEST_OUTPUT_FILE"
    fi
fi
if [[ -n "$ENFORCE_UNTRACKED" ]]; then
    local_source_path="${SFDT_SOURCE_PATH:-force-app/main/default}"
    source_root="${local_source_path%%/*}"
    print_step "Checking for untracked files in ${source_root}/..."
    if [[ -d "$source_root" ]]; then
        untracked=$(git ls-files --others --exclude-standard "${source_root}/" | head -20)
        if [[ -z "$untracked" ]]; then
            record_result "PASS" "No untracked files in ${source_root}/"
        else
            untracked_count=$(git ls-files --others --exclude-standard "${source_root}/" | wc -l | tr -d ' ')
            record_result "WARN" "Untracked files in ${source_root}/" "${untracked_count} file(s)"
        fi
    else
        record_result "WARN" "${source_root}/ directory not found"
    fi
fi
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

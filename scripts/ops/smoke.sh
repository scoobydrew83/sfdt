#!/bin/bash
set -euo pipefail

# Post-deployment smoke test verification
# Runs configured test classes and health checks against a target org

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../utils/shared.sh"
source "${SCRIPT_DIR}/../lib/git-utils.sh"

# Configuration
SMOKE_TESTS="${SFDT_SMOKE_TESTS:-}"
TARGET_ORG="${SFDT_TARGET_ORG:-}"
PROJECT_NAME="${SFDT_PROJECT_NAME:-sfdt}"
CONFIG_DIR="${SFDT_CONFIG_DIR:-.sfdt}"

PASS_COUNT=0
FAIL_COUNT=0
declare -a RESULTS=()

record_result() {
    local status="$1"
    local check="$2"
    local detail="${3:-}"

    case "$status" in
        PASS) PASS_COUNT=$((PASS_COUNT + 1)); RESULTS+=("$(print_success "[PASS] ${check}${detail:+ - ${detail}}")") ;;
        FAIL) FAIL_COUNT=$((FAIL_COUNT + 1)); RESULTS+=("$(print_error "[FAIL] ${check}${detail:+ - ${detail}}")") ;;
    esac
}

print_header "Post-Deployment Smoke Tests: ${PROJECT_NAME}"

# ── Resolve target org ───────────────────────────────────────────────────────
if [[ -z "$TARGET_ORG" ]]; then
    echo ""
    print_info "No SFDT_TARGET_ORG set. Available orgs:"
    sf org list --json 2>/dev/null | jq -r '.result.nonScratchOrgs[]?.alias // empty' 2>/dev/null || true
    sf org list --json 2>/dev/null | jq -r '.result.scratchOrgs[]?.alias // empty' 2>/dev/null || true
    echo ""
    read -rp "Enter target org alias: " TARGET_ORG
    if [[ -z "$TARGET_ORG" ]]; then
        print_error "No target org specified. Aborting."
        exit 1
    fi
fi

print_info "Target org: ${TARGET_ORG}"

# ── Resolve smoke test classes ───────────────────────────────────────────────
SMOKE_TEST_CLASSES=()

if [[ -n "$SMOKE_TESTS" ]]; then
    # From environment variable (comma-separated)
    IFS=',' read -ra SMOKE_TEST_CLASSES <<< "$SMOKE_TESTS"
elif [[ -f "${CONFIG_DIR}/sfdt.config.json" ]]; then
    # From config file
    mapfile -t SMOKE_TEST_CLASSES < <(
        jq -r '.smokeTests.testClasses[]? // empty' "${CONFIG_DIR}/sfdt.config.json" 2>/dev/null
    )
fi

# Trim whitespace from class names
SMOKE_TEST_CLASSES=("${SMOKE_TEST_CLASSES[@]/#/}")
SMOKE_TEST_CLASSES=("${SMOKE_TEST_CLASSES[@]/%/}")
# Remove empty entries
SMOKE_TEST_CLASSES=("${SMOKE_TEST_CLASSES[@]}")

if [[ ${#SMOKE_TEST_CLASSES[@]} -eq 0 ]] || [[ -z "${SMOKE_TEST_CLASSES[0]}" ]]; then
    print_warning "No smoke test classes configured."
    print_info "Set SFDT_SMOKE_TESTS env var or add testClasses to smokeTests in config."
    echo ""
    read -rp "Run RunLocalTests as fallback? (y/N): " run_fallback
    if [[ "$run_fallback" =~ ^[Yy]$ ]]; then
        print_step "Running RunLocalTests on ${TARGET_ORG}..."
        TEST_OUTPUT=$(mktemp)
        if sf apex run test --test-level RunLocalTests --target-org "$TARGET_ORG" --json --wait 30 > "$TEST_OUTPUT" 2>&1; then
            outcome=$(jq -r '.result.summary.outcome // "Unknown"' "$TEST_OUTPUT" 2>/dev/null || echo "Unknown")
            passing=$(jq -r '.result.summary.passing // "0"' "$TEST_OUTPUT" 2>/dev/null || echo "0")
            failing=$(jq -r '.result.summary.failing // "0"' "$TEST_OUTPUT" 2>/dev/null || echo "0")
            record_result "PASS" "RunLocalTests" "${passing} passed, ${failing} failed"
            if [[ "$outcome" != "Passed" ]]; then
                RESULTS=()
                PASS_COUNT=0
                FAIL_COUNT=0
                record_result "FAIL" "RunLocalTests" "outcome: ${outcome}"
            fi
        else
            record_result "FAIL" "RunLocalTests" "Test run command failed"
        fi
        rm -f "$TEST_OUTPUT"
    else
        print_info "Smoke tests skipped."
        exit 0
    fi
else
    # ── Run configured smoke test classes ────────────────────────────────────
    CLASS_LIST=$(IFS=','; echo "${SMOKE_TEST_CLASSES[*]}")
    print_step "Running smoke tests: ${CLASS_LIST}"
    echo ""

    TEST_OUTPUT=$(mktemp)
    if sf apex run test \
        --class-names "$CLASS_LIST" \
        --target-org "$TARGET_ORG" \
        --json \
        --wait 30 > "$TEST_OUTPUT" 2>&1; then

        # Parse individual test results
        test_count=$(jq -r '.result.tests | length' "$TEST_OUTPUT" 2>/dev/null || echo "0")
        for (( i=0; i<test_count; i++ )); do
            test_name=$(jq -r ".result.tests[$i].fullName // \"Test ${i}\"" "$TEST_OUTPUT" 2>/dev/null)
            test_outcome=$(jq -r ".result.tests[$i].outcome // \"Unknown\"" "$TEST_OUTPUT" 2>/dev/null)
            test_message=$(jq -r ".result.tests[$i].message // \"\"" "$TEST_OUTPUT" 2>/dev/null)

            if [[ "$test_outcome" == "Pass" ]]; then
                record_result "PASS" "$test_name"
            else
                record_result "FAIL" "$test_name" "$test_message"
            fi
        done
    else
        record_result "FAIL" "Smoke test execution" "sf apex run test command failed"
    fi
    rm -f "$TEST_OUTPUT"
fi

# ── Optional: Verify key classes exist in org ────────────────────────────────
KEY_CLASSES=()
if [[ -f "${CONFIG_DIR}/sfdt.config.json" ]]; then
    mapfile -t KEY_CLASSES < <(
        jq -r '.deployment.keyClasses[]? // empty' "${CONFIG_DIR}/sfdt.config.json" 2>/dev/null
    )
fi

if [[ ${#KEY_CLASSES[@]} -gt 0 ]] && [[ -n "${KEY_CLASSES[0]}" ]]; then
    print_step "Verifying key classes exist in org..."
    ORG_CLASSES=$(sf apex list --target-org "$TARGET_ORG" --json 2>/dev/null || echo '{"result":[]}')

    for key_class in "${KEY_CLASSES[@]}"; do
        [[ -z "$key_class" ]] && continue
        if echo "$ORG_CLASSES" | jq -r '.result[]?' 2>/dev/null | grep -q "^${key_class}$"; then
            record_result "PASS" "Key class exists: ${key_class}"
        else
            record_result "FAIL" "Key class missing: ${key_class}"
        fi
    done
fi

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
print_header "Smoke Test Summary"
for result in "${RESULTS[@]}"; do
    echo "$result"
done

echo ""
echo "  Passed: ${PASS_COUNT}  |  Failed: ${FAIL_COUNT}"
echo ""

if (( FAIL_COUNT > 0 )); then
    print_error "SMOKE TESTS: FAILED (${FAIL_COUNT} failure(s))"
    exit 1
else
    print_success "SMOKE TESTS: ALL PASSED"
    exit 0
fi

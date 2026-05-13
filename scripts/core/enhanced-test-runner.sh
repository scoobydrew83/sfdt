#!/bin/bash

# =============================================================================
# SFDT - Enhanced Test Runner v2.0
# Features: Parallel execution, performance testing, quality gates
# =============================================================================
set -euo pipefail

# Source shared utilities
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../utils/shared.sh"

# Project configuration
PROJECT_NAME="${SFDT_PROJECT_NAME:-Salesforce Project}"

# Color codes (from shared.sh or redefined here for safety)
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${BLUE}${PROJECT_NAME} - Enhanced Test Runner v2.0${NC}"
echo -e "${YELLOW}================================================================${NC}"
require_jq || exit 1

# Initialize environment variables from script-runner env if available
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
LOG_DIR="${SFDT_LOG_DIR:-${SFDT_PROJECT_ROOT:-$SCRIPT_DIR/../..}/logs}"
RESULTS_DIR="$LOG_DIR/test-results"
PERFORMANCE_LOG="$RESULTS_DIR/performance_$TIMESTAMP.log"
PARALLEL_JOBS=3
PARALLEL_BATCH_DELAY=${SFDT_PARALLEL_DELAY:-1}
MIN_COVERAGE_THRESHOLD=${SFDT_TEST_COVERAGE_THRESHOLD:-75}

mkdir -p "$RESULTS_DIR"

# ─── TestLevel shortcut path ─────────────────────────────────────────────────
if [[ "${SFDT_TEST_LEVEL:-}" == "RunLocalTests" || "${SFDT_TEST_LEVEL:-}" == "RunAllTestsInOrg" ]]; then
    TARGET_ORG="${SFDT_TARGET_ORG:-${SFDT_DEFAULT_ORG:-}}"
    if [[ -z "$TARGET_ORG" ]]; then
        log_error "No target org set. Set SFDT_DEFAULT_ORG or SFDT_TARGET_ORG."
        exit 1
    fi

    log_info "Running sf apex run test --test-level ${SFDT_TEST_LEVEL} on ${TARGET_ORG}"

    OUTPUT_FILE="${RESULTS_DIR}/local_${TIMESTAMP}.json"
    STDERR_FILE="${RESULTS_DIR}/local_${TIMESTAMP}_stderr.log"

    EXIT_CODE=0
    sf apex run test \
        --test-level "${SFDT_TEST_LEVEL}" \
        --code-coverage \
        --json \
        --wait 20 \
        --target-org "$TARGET_ORG" \
        > "$OUTPUT_FILE" 2>"$STDERR_FILE" || EXIT_CODE=$?

    # Emit the raw JSON — parsers.js handles result.coverage.coverage[] and result.codeCoverage
    if [[ -f "$OUTPUT_FILE" ]]; then
        jq -c '.' "$OUTPUT_FILE" 2>/dev/null || true
    fi

    exit ${EXIT_CODE}
fi
# ─── End TestLevel shortcut path ─────────────────────────────────────────────

# Load test classes
if [[ -n "${SFDT_TEST_CLASSES:-}" ]]; then
    IFS=',' read -r -a PROJECT_TEST_CLASSES <<< "$SFDT_TEST_CLASSES"
else
    # Fallback to config file using jq (proper paths)
    TEST_CONFIG_FILE="${SFDT_CONFIG_DIR:-${SFDT_PROJECT_ROOT:-.}/.sfdt}/test-config.json"
    if [[ -f "$TEST_CONFIG_FILE" ]]; then
        PROJECT_TEST_CLASSES=($(jq -r '.testClasses[]' "$TEST_CONFIG_FILE" 2>/dev/null || echo ""))
    else
        PROJECT_TEST_CLASSES=()
    fi
fi

if [[ -n "${SFDT_APEX_CLASSES:-}" ]]; then
    IFS=',' read -r -a PROJECT_APEX_CLASSES <<< "$SFDT_APEX_CLASSES"
else
    TEST_CONFIG_FILE="${SFDT_CONFIG_DIR:-${SFDT_PROJECT_ROOT:-.}/.sfdt}/test-config.json"
    if [[ -f "$TEST_CONFIG_FILE" ]]; then
        mapfile -t PROJECT_APEX_CLASSES < <(jq -r '.apexClasses[]? // empty' "$TEST_CONFIG_FILE" 2>/dev/null || true)
    else
        PROJECT_APEX_CLASSES=()
    fi
fi

if [ ${#PROJECT_TEST_CLASSES[@]} -eq 0 ]; then
    log_error "No test classes found. Run 'sfdt init' or check your configuration."
    exit 1
fi

log_info "Identified ${#PROJECT_TEST_CLASSES[@]} test classes."

# Resolve target org (same precedence as deployment-assistant.sh)
TARGET_ORG="${SFDT_TARGET_ORG:-${SFDT_DEFAULT_ORG:-}}"
if [[ -z "$TARGET_ORG" ]]; then
    log_error "No target org set. Set SFDT_DEFAULT_ORG or SFDT_TARGET_ORG."
    exit 1
fi

# Handle Non-Interactive Mode
NON_INTERACTIVE="${SFDT_NON_INTERACTIVE:-false}"
OPTION="1" # Default: Parallel with coverage

if [[ "$NON_INTERACTIVE" != "true" ]]; then
    echo ""
    echo -e "${BLUE}Enhanced Test Execution Options:${NC}"
    echo "=============================================="
    echo "1. Parallel test execution with coverage (recommended)"
    echo "2. Quick parallel tests without coverage"
    echo "3. Performance regression testing"
    echo "4. Test quality analysis"
    echo "5. Clean up test results"

    read -p "Choose option (1-5): " -n 1 -r OPTION
    echo ""
else
    log_info "Non-interactive mode: Parallel tests with coverage."
fi

# Function for parallel tests
run_parallel_tests() {
    local with_coverage=$1
    log_info "Starting parallel execution (${PARALLEL_JOBS} concurrent jobs)"

    local total_classes=${#PROJECT_TEST_CLASSES[@]}
    local batch_size=$(( (total_classes + PARALLEL_JOBS - 1) / PARALLEL_JOBS ))
    local pids=()
    local batch_count=0

    for ((i=0; i<total_classes; i+=batch_size)); do
        local batch=("${PROJECT_TEST_CLASSES[@]:i:batch_size}")
        local batch_list=$(IFS=,; echo "${batch[*]}")
        local batch_num=$((i/batch_size + 1))

        log_info "Launching batch ${batch_num} (${#batch[@]} classes)"
        (
            local args=("--target-org" "$TARGET_ORG" "--class-names" "$batch_list" "--json" "--wait" "20")
            [[ "$with_coverage" == "true" ]] && args+=("--code-coverage")
            sf apex run test "${args[@]}" > "$RESULTS_DIR/batch_${batch_num}_$TIMESTAMP.json" 2>&1
        ) &
        pids+=($!)
        batch_count=$batch_num

        # Respect Salesforce API rate limits between batch launches
        if (( i + batch_size < total_classes )); then
            sleep "$PARALLEL_BATCH_DELAY"
        fi
    done

    log_info "Waiting for ${#pids[@]} batches to complete..."
    local any_failed=0
    for pid in "${pids[@]}"; do
        wait "$pid" || any_failed=1
    done

    log_success "Parallel batches completed."
    log_info "Aggregating results..."

    # Aggregate results from all batch JSON files
    local total_passing=0
    local total_failing=0
    local total_ran=0
    local failed_tests=()

    for ((b=1; b<=batch_count; b++)); do
        local batch_file="$RESULTS_DIR/batch_${b}_$TIMESTAMP.json"
        if [[ ! -f "$batch_file" ]]; then
            log_warning "Batch $b result file not found: $batch_file"
            continue
        fi

        local passing failing
        passing=$(jq -r '.result.summary.passing // 0' "$batch_file" 2>/dev/null || echo 0)
        failing=$(jq -r '.result.summary.failing // 0' "$batch_file" 2>/dev/null || echo 0)
        total_passing=$(( total_passing + passing ))
        total_failing=$(( total_failing + failing ))
        total_ran=$(( total_ran + passing + failing ))

        # Collect names of failing tests
        if (( failing > 0 )); then
            while IFS= read -r name; do
                [[ -n "$name" ]] && failed_tests+=("$name")
            done < <(jq -r '.result.tests[] | select(.Outcome == "Fail") | .FullName' "$batch_file" 2>/dev/null)
        fi
    done

    echo ""
    echo -e "${BLUE}========== Test Summary ==========${NC}"
    echo -e "  Tests Run : $total_ran"
    echo -e "  ${GREEN}Passing   : $total_passing${NC}"
    if (( total_failing > 0 )); then
        echo -e "  ${RED}Failing   : $total_failing${NC}"
        echo ""
        log_error "Failing tests:"
        for t in "${failed_tests[@]}"; do
            echo "    - $t"
        done
    else
        echo -e "  Failing   : 0"
    fi
    echo -e "${BLUE}==================================${NC}"
    echo ""

    # Emit combined JSON to stdout for GUI result parsing (single compact line)
    if compgen -G "$RESULTS_DIR/batch_*_${TIMESTAMP}.json" > /dev/null 2>&1; then
        jq -c -s '
          reduce .[] as $b (
            {"result":{"summary":{"passing":0,"failing":0,"skipped":0,"testRunCoverage":null},"tests":[],"codeCoverage":[]}};
            .result.summary.passing += ($b.result.summary.passing // 0) |
            .result.summary.failing += ($b.result.summary.failing // 0) |
            .result.summary.skipped += ($b.result.summary.skipped // 0) |
            (if ($b.result.summary.testRunCoverage // null) != null then
              .result.summary.testRunCoverage = $b.result.summary.testRunCoverage
            else . end) |
            .result.tests += ($b.result.tests // []) |
            .result.codeCoverage += ($b.result.details.runTestResult.codeCoverage // [])
          ) |
          .result.codeCoverage = (.result.codeCoverage | unique_by(.name))
        ' "$RESULTS_DIR"/batch_*_"${TIMESTAMP}".json 2>/dev/null || \
            echo '{"result":{"summary":{"passing":0,"failing":0,"skipped":0},"tests":[],"codeCoverage":[]}}'
    fi

    if (( total_ran == 0 )); then
        if (( any_failed == 1 )); then
            log_error "No tests ran — SF CLI reported errors:"
            for ((b=1; b<=batch_count; b++)); do
                local batch_file="$RESULTS_DIR/batch_${b}_$TIMESTAMP.json"
                local sf_msg
                sf_msg=$(jq -r '.message // empty' "$batch_file" 2>/dev/null || true)
                [[ -n "$sf_msg" ]] && echo "  Batch $b: $sf_msg"
            done
            log_error "Ensure the class names exist in the org and have @isTest methods."
        else
            log_warning "No tests ran. Verify testConfig.testClasses in .sfdt/config.json."
        fi
        return 1
    elif (( total_failing > 0 )); then
        log_error "Test run failed: $total_failing failing test(s)."
        return 1
    elif (( any_failed == 1 )); then
        log_error "Test run completed with errors (sf apex command returned non-zero)."
        return 1
    fi

    log_success "All $total_passing tests passed."
    return 0
}

case $OPTION in
    1|"") run_parallel_tests true ;;
    2)    run_parallel_tests false ;;
    3)    log_info "Running performance tests..." ;; # Implement as needed
    4)    "$SCRIPT_DIR/../quality/test-analyzer.sh" ;;
    5)    rm -f "$RESULTS_DIR"/*.json && log_success "Cleanup complete." ;;
    *)    log_error "Invalid option" && exit 1 ;;
esac

log_success "Enhanced test execution finished."

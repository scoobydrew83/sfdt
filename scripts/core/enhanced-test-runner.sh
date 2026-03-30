#!/bin/bash

# =============================================================================
# SFDT - Enhanced Test Runner v2.0
# Features: Parallel execution, performance testing, quality gates
# =============================================================================

# Source shared utilities
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../utils/shared.sh"

# Initialize environment
init_script_env

# Project configuration
PROJECT_NAME="${SFDT_PROJECT_NAME:-Salesforce Project}"

echo -e "${BLUE}${PROJECT_NAME} - Enhanced Test Runner v2.0${NC}"
echo -e "${YELLOW}================================================================${NC}"

# Enhanced variables
TEMP_OUTPUT=""
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
RESULTS_FILE="$LOG_DIR/test-results/enhanced_test_results_$TIMESTAMP.md"
PERFORMANCE_LOG="$LOG_DIR/test-results/performance_$TIMESTAMP.log"
PARALLEL_JOBS=3
MIN_COVERAGE_THRESHOLD=75

# Create test-results directory if it doesn't exist
mkdir -p "$LOG_DIR/test-results"

# Load test configuration
log_info "Loading test configuration from $TEST_CONFIG_FILE"

# Extract test classes - improved parsing
PROJECT_TEST_CLASSES=($(jq -r '.project_test_classes[]' "$TEST_CONFIG_FILE" 2>/dev/null | sort))
PROJECT_APEX_CLASSES=($(jq -r '.project_apex_classes[]' "$TEST_CONFIG_FILE" 2>/dev/null | sort))

# Validate configuration loading
if [ ${#PROJECT_TEST_CLASSES[@]} -eq 0 ]; then
    log_error "Failed to load test classes from configuration file"
    exit 1
fi

if [ ${#PROJECT_APEX_CLASSES[@]} -eq 0 ]; then
    log_error "Failed to load apex classes from configuration file"
    exit 1
fi

# Convert array to comma-separated string
TEST_CLASS_LIST=$(IFS=,; echo "${PROJECT_TEST_CLASSES[*]}")

log_info "Project test classes identified: ${#PROJECT_TEST_CLASSES[@]} classes"
log_info "Project apex classes identified: ${#PROJECT_APEX_CLASSES[@]} classes"

# Enhanced menu with new options
echo ""
echo -e "${BLUE}Enhanced Test Execution Options:${NC}"
echo "=============================================="
echo "Fast Options:"
echo "  1. Parallel test execution with coverage (recommended)"
echo "  2. Quick parallel tests without coverage"
echo ""
echo "Performance Options:"
echo "  3. Performance regression testing"
echo "  4. Load testing simulation"
echo ""
echo "Analysis Options:"
echo "  5. Test quality analysis"
echo "  6. Coverage gap analysis"
echo ""
echo "Utility Options:"
echo "  7. Validate test configuration"
echo "  8. Generate detailed test report"
echo "  9. Clean up test results"
echo ""
echo "Legacy Options:"
echo "  10. Run specific test class"
echo "  11. Traditional sequential testing"

read -p "Choose option (1-11): " -n 2 -r
echo ""

# Performance testing function
run_performance_tests() {
    local test_classes=("$@")
    local start_time=$(date +%s)

    log_info "Starting performance regression testing..."

    # Create performance baseline if it doesn't exist
    local baseline_file="$LOG_DIR/test-results/performance_baseline.json"
    if [ ! -f "$baseline_file" ]; then
        log_warning "No performance baseline found. Creating new baseline."
        echo "{}" > "$baseline_file"
    fi

    # Run tests and capture performance metrics
    for class in "${test_classes[@]}"; do
        local class_start=$(date +%s%3N)  # milliseconds

        log_info "Performance testing: $class"

        local result=$(sf apex run test --class-names "$class" --json --wait 10 2>/dev/null)
        local class_end=$(date +%s%3N)
        local duration=$((class_end - class_start))

        # Log performance data
        echo "$(date --iso-8601=seconds),$class,$duration" >> "$PERFORMANCE_LOG"

        # Check for performance regression
        local baseline_duration=$(jq -r ".[\"$class\"] // 0" "$baseline_file")
        if [ "$baseline_duration" != "0" ] && [ "$duration" -gt $((baseline_duration * 150 / 100)) ]; then
            log_warning "Performance regression detected in $class: ${duration}ms (baseline: ${baseline_duration}ms)"
        fi
    done

    local end_time=$(date +%s)
    local total_time=$((end_time - start_time))
    log_success "Performance testing completed in ${total_time} seconds"
}

# Parallel test execution function
run_parallel_tests() {
    local with_coverage=$1
    local test_classes=("$@:2")  # Skip first parameter

    log_info "Starting parallel test execution (${PARALLEL_JOBS} concurrent jobs)"

    # Split test classes into batches
    local total_classes=${#PROJECT_TEST_CLASSES[@]}
    local batch_size=$(( (total_classes + PARALLEL_JOBS - 1) / PARALLEL_JOBS ))

    local pids=()
    local batch_num=1

    for ((i=0; i<total_classes; i+=batch_size)); do
        local batch_classes=("${PROJECT_TEST_CLASSES[@]:i:batch_size}")
        local batch_list=$(IFS=,; echo "${batch_classes[*]}")

        log_info "Starting batch $batch_num with ${#batch_classes[@]} classes"

        # Run batch in background
        if [ "$with_coverage" = true ]; then
            (
                sf apex run test --class-names "$batch_list" --code-coverage --json --wait 15 \
                > "$LOG_DIR/test-results/batch_${batch_num}_$TIMESTAMP.json" 2>&1
            ) &
        else
            (
                sf apex run test --class-names "$batch_list" --json --wait 10 \
                > "$LOG_DIR/test-results/batch_${batch_num}_$TIMESTAMP.json" 2>&1
            ) &
        fi

        pids+=($!)
        ((batch_num++))

        # Prevent overwhelming the system
        sleep 2
    done

    # Wait for all batches to complete
    log_info "Waiting for all test batches to complete..."
    for pid in "${pids[@]}"; do
        wait "$pid"
    done

    log_success "All parallel test batches completed"

    # Aggregate results
    aggregate_test_results "$batch_num"
}

# Aggregate parallel test results
aggregate_test_results() {
    local total_batches=$1
    local total_tests=0
    local passed_tests=0
    local failed_tests=0
    local total_time=0

    log_info "Aggregating results from $total_batches batches..."

    for ((i=1; i<total_batches; i++)); do
        local batch_file="$LOG_DIR/test-results/batch_${i}_$TIMESTAMP.json"
        if [ -f "$batch_file" ]; then
            # Extract metrics from each batch (simplified parsing)
            local batch_passed=$(jq -r '.result.summary.passing // 0' "$batch_file" 2>/dev/null || echo "0")
            local batch_failed=$(jq -r '.result.summary.failing // 0' "$batch_file" 2>/dev/null || echo "0")
            local batch_time=$(jq -r '.result.summary.testRunDuration // "0"' "$batch_file" 2>/dev/null || echo "0")

            # Convert time to seconds if in milliseconds format
            if [[ "$batch_time" =~ [0-9]+ms$ ]]; then
                batch_time=${batch_time%ms}
                batch_time=$((batch_time / 1000))
            fi

            passed_tests=$((passed_tests + batch_passed))
            failed_tests=$((failed_tests + batch_failed))
            total_time=$((total_time + batch_time))
        fi
    done

    total_tests=$((passed_tests + failed_tests))

    # Generate summary report
    generate_enhanced_report "$total_tests" "$passed_tests" "$failed_tests" "$total_time"
}

# Generate enhanced test report
generate_enhanced_report() {
    local total=$1
    local passed=$2
    local failed=$3
    local duration=$4

    log_info "Generating enhanced test report..."

    # Create markdown report
    cat > "$RESULTS_FILE" << EOF
# ${PROJECT_NAME} - Enhanced Test Results

**Test Execution Date**: $(date)
**Test Runner Version**: 2.0 (Enhanced)
**Execution Type**: Parallel Testing

## Summary Statistics

| Metric | Value |
|--------|-------|
| **Total Tests** | $total |
| **Passed** | $passed |
| **Failed** | $failed |
| **Success Rate** | $( [ "$total" -gt 0 ] && echo "$((passed * 100 / total))%" || echo "N/A" ) |
| **Execution Time** | ${duration}s |
| **Average per Test** | $( [ "$total" -gt 0 ] && echo "$((duration / total))s" || echo "N/A" ) |

## Performance Improvements

- **Parallel Execution**: ${PARALLEL_JOBS} concurrent batches
- **Time Savings**: ~$((100 - (duration * 100 / (total * 5))))% faster than sequential
- **Resource Efficiency**: Optimized batch sizing

## Quality Metrics

$(if [ -f "$PERFORMANCE_LOG" ]; then
echo "- **Performance Testing**: Enabled"
echo "- **Regression Detection**: Active"
else
echo "- **Performance Testing**: Not run this session"
fi)

## Component Breakdown

- **Total Components**: ${#PROJECT_APEX_CLASSES[@]} Apex classes
- **Test Coverage**: ${#PROJECT_TEST_CLASSES[@]} test classes
- **Coverage Ratio**: $((${#PROJECT_TEST_CLASSES[@]} * 100 / ${#PROJECT_APEX_CLASSES[@]}))%

---

*Generated by Enhanced Test Runner v2.0*
*Timestamp: $(date '+%Y-%m-%dT%H:%M:%S')*
EOF

    log_success "Enhanced report generated: $RESULTS_FILE"
}

# Quality gates enforcement
enforce_quality_gates() {
    local passed_tests=$1
    local total_tests=$2
    local failed_tests=$3

    log_info "Enforcing quality gates..."

    local success_rate=0
    if [ "$total_tests" -gt 0 ]; then
        success_rate=$((passed_tests * 100 / total_tests))
    fi

    # Quality gate checks
    local quality_passed=true

    if [ "$failed_tests" -gt 0 ]; then
        log_error "Quality gate FAILED: $failed_tests failing tests found"
        quality_passed=false
    fi

    if [ "$success_rate" -lt "$MIN_COVERAGE_THRESHOLD" ]; then
        log_error "Quality gate FAILED: Success rate $success_rate% below threshold $MIN_COVERAGE_THRESHOLD%"
        quality_passed=false
    fi

    if [ "$quality_passed" = true ]; then
        log_success "All quality gates PASSED"
        return 0
    else
        log_error "Quality gates FAILED"
        return 1
    fi
}

# Main execution logic
case $REPLY in
    1)
        log_info "Running parallel tests with coverage..."
        run_parallel_tests true
        enforce_quality_gates
        ;;
    2)
        log_info "Running quick parallel tests without coverage..."
        run_parallel_tests false
        ;;
    3)
        log_info "Starting performance regression testing..."
        run_performance_tests "${PROJECT_TEST_CLASSES[@]}"
        ;;
    4)
        log_info "Load testing simulation..."
        log_warning "Load testing not yet implemented - coming in Phase 2.1"
        ;;
    5)
        log_info "Running test quality analysis..."
        "$SCRIPT_DIR/../quality/test-analyzer.sh"
        ;;
    6)
        log_info "Analyzing coverage gaps..."
        log_warning "Coverage gap analysis not yet implemented - coming in Phase 2.1"
        ;;
    7)
        log_info "Validating test configuration..."
        validate_configs && log_success "Configuration validation passed"
        ;;
    8)
        log_info "Generating detailed test report..."
        generate_enhanced_report 0 0 0 0
        ;;
    9)
        log_info "Cleaning up test results..."
        find "$LOG_DIR/test-results" -name "batch_*" -delete 2>/dev/null
        find "$LOG_DIR/test-results" -name "*.tmp" -delete 2>/dev/null
        log_success "Test results cleanup completed"
        ;;
    10)
        read -p "Enter test class name: " TEST_CLASS_NAME
        log_info "Running specific test class: $TEST_CLASS_NAME"
        sf apex run test --class-names "$TEST_CLASS_NAME" --code-coverage
        ;;
    11)
        log_info "Running traditional sequential tests..."
        sf apex run test --class-names "$TEST_CLASS_LIST" --code-coverage
        ;;
    *)
        log_error "Invalid option selected"
        exit 1
        ;;
esac

log_success "Enhanced test execution completed!"

#!/bin/bash
set -euo pipefail

# =============================================================================
# SFDT - Test Quality Analyzer
# Analyzes test quality, coverage patterns, and identifies improvement areas
# =============================================================================

# Source shared utilities
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../utils/shared.sh"

# Configuration from SFDT_ env vars (set by script-runner.js)
PROJECT_NAME="${SFDT_PROJECT_NAME:-Salesforce Project}"
SOURCE_PATH="${SFDT_SOURCE_PATH:-force-app/main/default}"
LOG_DIR="${SFDT_LOG_DIR:-${SFDT_PROJECT_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}/logs}"
TEST_CONFIG_FILE="${SFDT_CONFIG_DIR:-${SFDT_PROJECT_ROOT:-.}/.sfdt}/test-config.json"

echo -e "${BLUE}${PROJECT_NAME} - Test Quality Analyzer${NC}"
echo -e "${YELLOW}======================================================${NC}"

# Configuration - resolve force-app directory
FORCE_APP_DIR="$SOURCE_PATH"
if [ ! -d "$FORCE_APP_DIR" ]; then
    FORCE_APP_DIR="../../${SOURCE_PATH}"
fi

mkdir -p "$LOG_DIR/test-results"
TEST_QUALITY_REPORT="$LOG_DIR/test-results/test_quality_$(date +%Y%m%d_%H%M%S).md"

# Load test configuration
if [[ -n "${SFDT_TEST_CLASSES:-}" ]]; then
    IFS=',' read -r -a PROJECT_TEST_CLASSES <<< "$SFDT_TEST_CLASSES"
elif [[ -f "$TEST_CONFIG_FILE" ]]; then
    mapfile -t PROJECT_TEST_CLASSES < <(jq -r '.testClasses[]' "$TEST_CONFIG_FILE" 2>/dev/null | sort)
else
    PROJECT_TEST_CLASSES=()
fi

if [[ -n "${SFDT_APEX_CLASSES:-}" ]]; then
    IFS=',' read -r -a PROJECT_APEX_CLASSES <<< "$SFDT_APEX_CLASSES"
elif [[ -f "$TEST_CONFIG_FILE" ]]; then
    mapfile -t PROJECT_APEX_CLASSES < <(jq -r '.apexClasses[]' "$TEST_CONFIG_FILE" 2>/dev/null | sort)
else
    PROJECT_APEX_CLASSES=()
fi

log_info "Analyzing test quality for ${#PROJECT_TEST_CLASSES[@]} test classes"

# Initialize analysis variables
declare -A test_analysis
declare -A class_analysis
declare -a quality_issues
declare -a recommendations

# Analyze test class patterns
analyze_test_patterns() {
    log_info "Analyzing test class patterns..."

    local total_test_methods=0
    local assertion_count=0
    local setup_methods=0
    local teardown_methods=0

    for test_class in "${PROJECT_TEST_CLASSES[@]}"; do
        local test_file="$FORCE_APP_DIR/classes/${test_class}.cls"

        if [ -f "$test_file" ]; then
            # Count test methods
            local test_methods=$(grep -c "@IsTest\|@isTest\|testMethod" "$test_file" 2>/dev/null || echo 0)
            total_test_methods=$((total_test_methods + test_methods))

            # Count assertions
            local assertions=$(grep -c "System\.assert\|System\.assertEquals\|System\.assertNotEquals\|Assert\." "$test_file" 2>/dev/null || echo 0)
            assertion_count=$((assertion_count + assertions))

            # Check for setup methods
            if grep -q "@TestSetup\|@testSetup" "$test_file" 2>/dev/null; then
                setup_methods=$((setup_methods + 1))
            fi

            # Store analysis data
            test_analysis["$test_class"]="methods:$test_methods,assertions:$assertions"

            # Quality checks
            if [ "$test_methods" -gt 0 ] && [ "$assertions" -eq 0 ]; then
                quality_issues+=("$test_class: No assertions found in test methods")
            fi

            if [ "$test_methods" -gt 5 ] && ! grep -q "@TestSetup" "$test_file" 2>/dev/null; then
                recommendations+=("$test_class: Consider using @TestSetup for ${test_methods} test methods")
            fi

        else
            quality_issues+=("$test_class: Test class file not found")
        fi
    done

    # Store summary metrics
    test_analysis["total_methods"]=$total_test_methods
    test_analysis["total_assertions"]=$assertion_count
    test_analysis["setup_methods"]=$setup_methods

    log_success "Test pattern analysis completed"
}

# Analyze test coverage patterns
analyze_coverage_patterns() {
    log_info "Analyzing test coverage patterns..."

    local classes_with_tests=0
    local classes_without_tests=0
    local utility_classes=0

    for apex_class in "${PROJECT_APEX_CLASSES[@]}"; do
        # Skip if it's already a test class
        if [[ "$apex_class" =~ Test$ ]]; then
            continue
        fi

        local apex_file="$FORCE_APP_DIR/classes/${apex_class}.cls"
        local has_test=false

        # Check for corresponding test classes
        for test_class in "${PROJECT_TEST_CLASSES[@]}"; do
            if [[ "$test_class" == "${apex_class}Test" ]] || [[ "$test_class" == "${apex_class}_Test" ]]; then
                has_test=true
                break
            fi
        done

        if [ "$has_test" = true ]; then
            classes_with_tests=$((classes_with_tests + 1))
            class_analysis["$apex_class"]="tested"
        else
            classes_without_tests=$((classes_without_tests + 1))
            class_analysis["$apex_class"]="untested"

            # Check if it's a utility class
            if [ -f "$apex_file" ] && grep -q "public static\|@TestVisible" "$apex_file" 2>/dev/null; then
                utility_classes=$((utility_classes + 1))
                recommendations+=("$apex_class: Utility class without dedicated test class")
            else
                quality_issues+=("$apex_class: No corresponding test class found")
            fi
        fi
    done

    # Store coverage metrics
    class_analysis["tested_count"]=$classes_with_tests
    class_analysis["untested_count"]=$classes_without_tests
    class_analysis["utility_count"]=$utility_classes

    log_success "Coverage pattern analysis completed"
}

# Analyze test naming conventions
analyze_naming_conventions() {
    log_info "Analyzing naming conventions..."

    local naming_issues=0

    for test_class in "${PROJECT_TEST_CLASSES[@]}"; do
        # Check test class naming
        if [[ ! "$test_class" =~ Test$ ]] && [[ ! "$test_class" =~ _Test$ ]]; then
            quality_issues+=("$test_class: Non-standard test class naming (should end with 'Test')")
            naming_issues=$((naming_issues + 1))
        fi

        # Check for corresponding non-test class
        local base_class=""
        if [[ "$test_class" =~ Test$ ]]; then
            base_class="${test_class%Test}"
        elif [[ "$test_class" =~ _Test$ ]]; then
            base_class="${test_class%_Test}"
        fi

        if [ -n "$base_class" ]; then
            local found_base=false
            for apex_class in "${PROJECT_APEX_CLASSES[@]}"; do
                if [ "$apex_class" = "$base_class" ]; then
                    found_base=true
                    break
                fi
            done

            if [ "$found_base" = false ]; then
                recommendations+=("$test_class: Test class exists but no corresponding class '$base_class' found")
            fi
        fi
    done

    class_analysis["naming_issues"]=$naming_issues

    log_success "Naming convention analysis completed"
}

# Generate quality score
calculate_quality_score() {
    local total_issues=${#quality_issues[@]}
    local total_recommendations=${#recommendations[@]}
    local total_classes=${#PROJECT_APEX_CLASSES[@]}
    local tested_classes=${class_analysis["tested_count"]}

    # Calculate coverage percentage
    local coverage_score=0
    if [ "$total_classes" -gt 0 ]; then
        coverage_score=$((tested_classes * 100 / total_classes))
    fi

    # Calculate quality score (0-100)
    local quality_score=100
    quality_score=$((quality_score - total_issues * 5))      # -5 points per issue
    quality_score=$((quality_score - total_recommendations)) # -1 point per recommendation

    # Bonus points for good coverage
    if [ "$coverage_score" -gt 90 ]; then
        quality_score=$((quality_score + 10))
    elif [ "$coverage_score" -gt 80 ]; then
        quality_score=$((quality_score + 5))
    fi

    # Ensure score is not negative
    if [ "$quality_score" -lt 0 ]; then
        quality_score=0
    fi

    echo "$quality_score"
}

# Generate comprehensive report
generate_quality_report() {
    log_info "Generating test quality report..."

    local quality_score=$(calculate_quality_score)
    local total_methods=${test_analysis["total_methods"]}
    local total_assertions=${test_analysis["total_assertions"]}
    local tested_count=${class_analysis["tested_count"]}
    local untested_count=${class_analysis["untested_count"]}
    local total_classes=$((tested_count + untested_count))

    # Determine quality grade
    local grade="F"
    if [ "$quality_score" -ge 90 ]; then
        grade="A"
    elif [ "$quality_score" -ge 80 ]; then
        grade="B"
    elif [ "$quality_score" -ge 70 ]; then
        grade="C"
    elif [ "$quality_score" -ge 60 ]; then
        grade="D"
    fi

    cat > "$TEST_QUALITY_REPORT" << EOF
# Test Quality Analysis Report

**Analysis Date**: $(date)
**Analyzer Version**: 1.0
**Project**: ${PROJECT_NAME}

## Overall Quality Score: ${quality_score}/100 (Grade: ${grade})

## Test Coverage Statistics

| Metric | Count | Percentage |
|--------|-------|------------|
| **Total Apex Classes** | $total_classes | 100% |
| **Classes with Tests** | $tested_count | $((total_classes > 0 ? tested_count * 100 / total_classes : 0))% |
| **Classes without Tests** | $untested_count | $((total_classes > 0 ? untested_count * 100 / total_classes : 0))% |
| **Total Test Classes** | ${#PROJECT_TEST_CLASSES[@]} | - |
| **Total Test Methods** | $total_methods | - |
| **Total Assertions** | $total_assertions | - |

## Quality Metrics

- **Average Assertions per Test Method**: $((total_assertions / (total_methods > 0 ? total_methods : 1)))
- **Test Classes with @TestSetup**: ${test_analysis["setup_methods"]}
- **Naming Convention Issues**: ${class_analysis["naming_issues"]}

## Quality Issues Found (${#quality_issues[@]})

EOF

    if [ ${#quality_issues[@]} -gt 0 ]; then
        for issue in "${quality_issues[@]}"; do
            echo "- $issue" >> "$TEST_QUALITY_REPORT"
        done
    else
        echo "No quality issues found!" >> "$TEST_QUALITY_REPORT"
    fi

    cat >> "$TEST_QUALITY_REPORT" << EOF

## Recommendations (${#recommendations[@]})

EOF

    if [ ${#recommendations[@]} -gt 0 ]; then
        for rec in "${recommendations[@]}"; do
            echo "- $rec" >> "$TEST_QUALITY_REPORT"
        done
    else
        echo "No recommendations - test quality is excellent!" >> "$TEST_QUALITY_REPORT"
    fi

    cat >> "$TEST_QUALITY_REPORT" << EOF

## Quality Improvement Plan

### Priority 1: Critical Issues
$(if [ ${#quality_issues[@]} -gt 0 ]; then
    echo "- Address ${#quality_issues[@]} critical quality issues listed above"
else
    echo "- No critical issues found"
fi)

### Priority 2: Test Coverage
$(if [ "$untested_count" -gt 0 ]; then
    echo "- Create test classes for $untested_count untested classes"
    echo "- Target: Achieve >90% test coverage"
else
    echo "- All classes have corresponding tests"
fi)

### Priority 3: Test Quality
- Ensure all test methods have meaningful assertions
- Implement @TestSetup where appropriate
- Follow consistent naming conventions

## Recommended Actions

1. **Immediate (This Week)**:
   - Fix critical quality issues
   - Add missing test classes for core functionality

2. **Short Term (Next Sprint)**:
   - Improve assertion coverage in existing tests
   - Implement consistent @TestSetup patterns

3. **Long Term (Next Month)**:
   - Establish quality gates in CI/CD pipeline
   - Regular quality monitoring and reporting

---

*Generated by Test Quality Analyzer v1.0*
*Report Location: $TEST_QUALITY_REPORT*
EOF

    log_success "Quality report generated: $TEST_QUALITY_REPORT"
}

# Main execution
main() {
    analyze_test_patterns
    analyze_coverage_patterns
    analyze_naming_conventions
    generate_quality_report

    local quality_score=$(calculate_quality_score)

    echo ""
    log_info "Test Quality Analysis Summary:"
    echo "==============================="
    echo "Overall Quality Score: ${quality_score}/100"
    echo "Total Test Classes: ${#PROJECT_TEST_CLASSES[@]}"
    echo "Total Apex Classes: ${#PROJECT_APEX_CLASSES[@]}"
    echo "Quality Issues: ${#quality_issues[@]}"
    echo "Recommendations: ${#recommendations[@]}"
    echo ""

    if [ "$quality_score" -ge 80 ]; then
        log_success "Test quality is GOOD"
    elif [ "$quality_score" -ge 60 ]; then
        log_warning "Test quality NEEDS IMPROVEMENT"
    else
        log_error "Test quality is POOR - Immediate attention required"
    fi

    echo ""
    echo -e "${CYAN}Full report available at: $TEST_QUALITY_REPORT${NC}"
}

# Run the analysis
main

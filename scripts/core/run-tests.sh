#!/bin/bash

# =============================================================================
# SFDT - Comprehensive Test Runner
# =============================================================================

# Project configuration
PROJECT_NAME="${SFDT_PROJECT_NAME:-Salesforce Project}"

echo "${PROJECT_NAME} - Test Suite"
echo "========================================="

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to log info
log_info() {
    echo -e "${BLUE}ℹ️  INFO${NC} - $1"
}

# Function to log success
log_success() {
    echo -e "${GREEN}✅ SUCCESS${NC} - $1"
}

# Function to log warning
log_warning() {
    echo -e "${YELLOW}⚠️  WARN${NC} - $1"
}

# Function to log error
log_error() {
    echo -e "${RED}❌ ERROR${NC} - $1"
}

# Initialize variables
TEMP_OUTPUT=""
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_RESULTS_DIR="${SCRIPT_DIR}/../logs/test-results"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
RESULTS_FILE="$TEST_RESULTS_DIR/test_results_$TIMESTAMP.md"

# Create test-results directory if it doesn't exist
mkdir -p "$TEST_RESULTS_DIR"

# Configuration file path - check SFDT_CONFIG_DIR first
CONFIG_DIR="${SFDT_CONFIG_DIR:-${SCRIPT_DIR}/../config}"
CONFIG_FILE="${CONFIG_DIR}/test-config.json"

# Check if configuration file exists
if [ ! -f "$CONFIG_FILE" ]; then
    log_error "Configuration file '$CONFIG_FILE' not found!"
    echo "Please ensure the test-config.json file exists in your config directory."
    exit 1
fi

# Load test classes from configuration file - use sed parsing consistently
# Extract test classes - improved parsing and sort alphabetically
PROJECT_TEST_CLASSES=($(sed -n '/"project_test_classes": \[/,/\]/p' "$CONFIG_FILE" | grep '"[^"]*"' | sed 's/.*"\([^"]*\)".*/\1/' | grep -v "^[[:space:]]*$" | grep -v "project_test_classes" | grep -v "project_apex_classes" | sort))

# Extract apex classes - improved parsing and sort alphabetically
PROJECT_APEX_CLASSES=($(sed -n '/"project_apex_classes": \[/,/\]/p' "$CONFIG_FILE" | grep '"[^"]*"' | sed 's/.*"\([^"]*\)".*/\1/' | grep -v "^[[:space:]]*$" | grep -v "project_test_classes" | grep -v "project_apex_classes" | sort))



# Validate that we loaded the classes
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

echo
log_info "Project test classes identified: ${#PROJECT_TEST_CLASSES[@]} classes"
echo "Test classes: $TEST_CLASS_LIST"
echo
log_info "Project apex classes identified: ${#PROJECT_APEX_CLASSES[@]} classes"
echo "Apex classes: ${PROJECT_APEX_CLASSES[*]}"

echo
echo "Test execution options:"
echo "1. Run all project tests with code coverage (recommended)"
echo "2. Run all project tests without code coverage (faster)"
echo "3. Run specific test class"
echo "4. Validate tests only (check compilation)"
echo "5. Run tests and generate detailed report"
echo "6. Clean up test-results directory"

read -p "Choose option (1-6): " -n 1 -r
echo

case $REPLY in
    1)
        log_info "Running all project tests with code coverage..."
        # Capture output to a temporary file for coverage parsing
        TEMP_OUTPUT="/tmp/test_output_$(date +%s).txt"
        sf apex run test --class-names "$TEST_CLASS_LIST" --code-coverage --result-format human --wait 15 | tee "$TEMP_OUTPUT"
        ;;
    2)
        log_info "Running all project tests without code coverage..."
        TEMP_OUTPUT="/tmp/test_output_$(date +%s).txt"
        sf apex run test --class-names "$TEST_CLASS_LIST" --result-format human --wait 10 | tee "$TEMP_OUTPUT"
        ;;
    3)
        echo "Available test classes:"
        for i in "${!PROJECT_TEST_CLASSES[@]}"; do
            echo "$((i+1)). ${PROJECT_TEST_CLASSES[$i]}"
        done
        read -p "Enter class number (1-${#PROJECT_TEST_CLASSES[@]}): " class_num

        if [[ $class_num -ge 1 && $class_num -le ${#PROJECT_TEST_CLASSES[@]} ]]; then
            selected_class="${PROJECT_TEST_CLASSES[$((class_num-1))]}"
            log_info "Running test class: $selected_class"
            TEMP_OUTPUT="/tmp/test_output_$(date +%s).txt"
            sf apex run test --class-names "$selected_class" --code-coverage --result-format human --wait 10 | tee "$TEMP_OUTPUT"
        else
            log_error "Invalid class number"
            exit 1
        fi
        ;;
    4)
        log_info "Validating test compilation..."
        # This checks if tests compile without running them
        for test_class in "${PROJECT_TEST_CLASSES[@]}"; do
            log_info "Checking $test_class..."
            sf data query --query "SELECT Id FROM ApexClass WHERE Name='$test_class'" > /dev/null 2>&1
            if [ $? -eq 0 ]; then
                log_success "$test_class - Compiled successfully"
            else
                log_error "$test_class - Compilation failed"
            fi
        done
        ;;
    5)
        log_info "Running comprehensive test suite with detailed reporting..."
        TEMP_OUTPUT="/tmp/test_output_$(date +%s).txt"
        sf apex run test --class-names "$TEST_CLASS_LIST" --code-coverage --result-format human --wait 15 | tee "$TEMP_OUTPUT"

        if [ $? -eq 0 ]; then
            log_success "Tests completed! Results captured for analysis."

            # Also generate JSON format for detailed analysis
            sf apex run test --class-names "$TEST_CLASS_LIST" --code-coverage --result-format json --wait 5 > test_results.json

            if command -v jq &> /dev/null; then
                TESTS_RUN=$(jq '.summary.testsRan' test_results.json 2>/dev/null)
                PASSING=$(jq '.summary.passing' test_results.json 2>/dev/null)
                FAILING=$(jq '.summary.failing' test_results.json 2>/dev/null)
                COVERAGE=$(jq '.summary.testRunCoverage' test_results.json 2>/dev/null)

                echo
                echo "Test Summary:"
                echo "  Tests Run: $TESTS_RAN"
                echo "  Passing: $PASSING"
                echo "  Failing: $FAILING"
                echo "  Code Coverage: $COVERAGE%"
            else
                log_warning "Install 'jq' for detailed JSON parsing"
                echo "Results saved to test_results.json"
            fi
        else
            log_error "Test execution failed"
            exit 1
        fi
        ;;
    6)
        log_info "Cleaning up test-results directory..."
        if [ -d "$TEST_RESULTS_DIR" ]; then
            file_count=$(find "$TEST_RESULTS_DIR" -type f -name "*.md" | wc -l)
            if [ $file_count -gt 0 ]; then
                echo "Found $file_count test result files in $TEST_RESULTS_DIR"
                read -p "Are you sure you want to delete all test result files? (y/N): " -n 1 -r
                echo
                if [[ $REPLY =~ ^[Yy]$ ]]; then
                    rm -f "$TEST_RESULTS_DIR"/*.md
                    log_success "Cleaned up $file_count test result files from $TEST_RESULTS_DIR"
                else
                    log_info "Cleanup cancelled"
                fi
            else
                log_info "No test result files found in $TEST_RESULTS_DIR"
            fi
        else
            log_info "Test results directory does not exist"
        fi
        exit 0
        ;;
    *)
        log_error "Invalid option"
        exit 1
        ;;
esac

TEST_RESULT=$?

# Function to generate markdown report
generate_markdown_report() {
    local outcome=$1
    local temp_output=$2

    # Start markdown file
    cat > "$RESULTS_FILE" << EOF
# ${PROJECT_NAME} - Test Results

**Generated:** $(date)
**Test Run ID:** $(grep "Test Run Id" "$temp_output" 2>/dev/null | awk '{print $3}' | head -1 || echo "N/A")

## Test Summary

EOF

    # Add test summary section
    if [ -f "$temp_output" ]; then
        OUTCOME=$(grep -A 20 "=== Test Summary" "$temp_output" 2>/dev/null | grep "Outcome" | awk '{print $2}' | head -1)
        TESTS_RAN=$(grep -A 20 "=== Test Summary" "$temp_output" 2>/dev/null | grep "Tests Ran" | awk '{print $3}' | head -1)
        PASS_RATE=$(grep -A 20 "=== Test Summary" "$temp_output" 2>/dev/null | grep "Pass Rate" | awk '{print $3}' | head -1)
        FAIL_RATE=$(grep -A 20 "=== Test Summary" "$temp_output" 2>/dev/null | grep "Fail Rate" | awk '{print $3}' | head -1)
        SKIP_RATE=$(grep -A 20 "=== Test Summary" "$temp_output" 2>/dev/null | grep "Skip Rate" | awk '{print $3}' | head -1)

        cat >> "$RESULTS_FILE" << EOF
| Metric | Value |
|--------|-------|
| **Outcome** | ${OUTCOME:-N/A} |
| **Tests Ran** | ${TESTS_RAN:-N/A} |
| **Pass Rate** | ${PASS_RATE:-N/A} |
| **Fail Rate** | ${FAIL_RATE:-N/A} |
| **Skip Rate** | ${SKIP_RATE:-N/A} |

EOF
    fi

    # Add test classes section
    cat >> "$RESULTS_FILE" << EOF

## Test Classes Executed

EOF

    for test_class in "${PROJECT_TEST_CLASSES[@]}"; do
        cat >> "$RESULTS_FILE" << EOF
- $test_class

EOF
    done

    # Add coverage summary section
    cat >> "$RESULTS_FILE" << EOF

## Code Coverage Summary

| Class Name | Coverage | Status |
|------------|----------|--------|
EOF

    TOTAL_COVERAGE=0
    CLASS_COUNT=0
    CLASSES_ABOVE_75=0
    CLASSES_BELOW_75=0

    for apex_class in "${PROJECT_APEX_CLASSES[@]}"; do
        if [ -f "$temp_output" ]; then
            coverage_line=$(grep -A 50 "=== Apex Code Coverage by Class" "$temp_output" 2>/dev/null | grep "^$apex_class" | head -1)
            if [ ! -z "$coverage_line" ]; then
                coverage_percent=$(echo "$coverage_line" | awk '{print $2}' | sed 's/%//')

                if [ -z "$coverage_percent" ] || [ "$coverage_percent" = "$apex_class" ]; then
                    coverage_percent=$(echo "$coverage_line" | awk '{print $NF}' | sed 's/%//')
                fi

                if [ "$coverage_percent" -gt 100 ] 2>/dev/null; then
                    coverage_percent=100
                fi

                if [ "$coverage_percent" -ge 85 ] 2>/dev/null; then
                    status="Excellent"
                    CLASSES_ABOVE_75=$((CLASSES_ABOVE_75 + 1))
                elif [ "$coverage_percent" -ge 75 ] 2>/dev/null; then
                    status="Good"
                    CLASSES_ABOVE_75=$((CLASSES_ABOVE_75 + 1))
                elif [ "$coverage_percent" -ge 50 ] 2>/dev/null; then
                    status="Needs Work"
                    CLASSES_BELOW_75=$((CLASSES_BELOW_75 + 1))
                else
                    status="Poor"
                    CLASSES_BELOW_75=$((CLASSES_BELOW_75 + 1))
                fi

                echo "| $apex_class | ${coverage_percent}% | $status |" >> "$RESULTS_FILE"
                TOTAL_COVERAGE=$((TOTAL_COVERAGE + coverage_percent))
                CLASS_COUNT=$((CLASS_COUNT + 1))
            else
                echo "| $apex_class | N/A | Not found |" >> "$RESULTS_FILE"
            fi
        else
            echo "| $apex_class | N/A | No output captured |" >> "$RESULTS_FILE"
        fi
    done

    # Add coverage summary
    if [ $CLASS_COUNT -gt 0 ]; then
        AVERAGE_COVERAGE=$((TOTAL_COVERAGE / CLASS_COUNT))
        cat >> "$RESULTS_FILE" << EOF

**Coverage Summary:**
- Total Project Classes: $CLASS_COUNT/${#PROJECT_APEX_CLASSES[@]}
- Average Coverage: ${AVERAGE_COVERAGE}%
- Classes with 75%+ coverage: $CLASSES_ABOVE_75
- Classes below 75% coverage: $CLASSES_BELOW_75

EOF
    fi

    # Add failed tests section if there are failures
    if [ "$OUTCOME" = "Failed" ]; then
        cat >> "$RESULTS_FILE" << EOF

## Failed Tests

EOF

        # Improved failed test detection
        if [ -f "$temp_output" ]; then
            # Look for actual test failures in the output
            # Pattern: TestName.testMethodName Fail ErrorMessage
            failed_tests=$(grep -E "^[A-Za-z_]+Test\.[a-zA-Z_]+.*Fail" "$temp_output" 2>/dev/null | awk '{print $1}' | sort | uniq)

            if [ ! -z "$failed_tests" ]; then
                echo "$failed_tests" | while read -r failed_test; do
                    if [ ! -z "$failed_test" ]; then
                        test_class=$(echo "$failed_test" | cut -d'.' -f1)
                        test_method=$(echo "$failed_test" | cut -d'.' -f2)
                        echo "- **$test_class.$test_method**" >> "$RESULTS_FILE"

                        # Get the error message for this test
                        error_msg=$(grep -A 5 "^$failed_test.*Fail" "$temp_output" 2>/dev/null | grep -v "^$failed_test" | head -3 | sed 's/^/  /')
                        if [ ! -z "$error_msg" ]; then
                            echo "  \`\`\`" >> "$RESULTS_FILE"
                            echo "$error_msg" >> "$RESULTS_FILE"
                            echo "  \`\`\`" >> "$RESULTS_FILE"
                        fi
                    fi
                done
            else
                echo "No specific test failures could be parsed from the output." >> "$RESULTS_FILE"
                echo "Check the detailed test output for failure details." >> "$RESULTS_FILE"
            fi
        fi
    fi

    # Add recommendations section
    cat >> "$RESULTS_FILE" << EOF

## Recommendations

- Aim for 85%+ coverage on all classes for production deployment
- Focus on edge cases and error handling in lower-coverage classes
- Consider adding negative test scenarios for better coverage
- Review any failing tests and fix issues before deployment

## Raw Test Output

\`\`\`
$(cat "$temp_output" 2>/dev/null || echo "No test output captured")
\`\`\`
EOF

    log_success "Detailed test results saved to: $RESULTS_FILE"
}

echo
if [ $TEST_RESULT -eq 0 ]; then
    log_success "Test execution completed successfully!"
    echo
    echo "What was tested:"
    for test_class in "${PROJECT_TEST_CLASSES[@]}"; do
        echo "  $test_class"
    done

    # Add comprehensive coverage summary
    echo
    echo "Test Coverage Summary for Project Classes:"
    echo "==========================================="

    # Get coverage data for each project class
    echo "Class Name                          | Coverage | Status"
    echo "----------------------------------- | -------- | --------------"

    TOTAL_COVERAGE=0
    CLASS_COUNT=0
    CLASSES_ABOVE_75=0
    CLASSES_BELOW_75=0

    for apex_class in "${PROJECT_APEX_CLASSES[@]}"; do
        # Parse coverage from the captured output
        if [ -f "$TEMP_OUTPUT" ]; then
            # Extract coverage percentage for the specific class from the test output
            coverage_line=$(grep -A 50 "=== Apex Code Coverage by Class" "$TEMP_OUTPUT" 2>/dev/null | grep "^$apex_class" | head -1)
            if [ ! -z "$coverage_line" ]; then
                # Parse the coverage percentage - try different column positions
                coverage_percent=$(echo "$coverage_line" | awk '{print $2}' | sed 's/%//')

                # If that doesn't work, try the last column (sometimes coverage is at the end)
                if [ -z "$coverage_percent" ] || [ "$coverage_percent" = "$apex_class" ]; then
                    coverage_percent=$(echo "$coverage_line" | awk '{print $NF}' | sed 's/%//')
                fi

                # Cap coverage at 100% (sometimes Salesforce reports >100% due to test-only lines)
                if [ "$coverage_percent" -gt 100 ] 2>/dev/null; then
                    coverage_percent=100
                fi

                # Determine status based on coverage
                if [ "$coverage_percent" -ge 85 ] 2>/dev/null; then
                    status="Excellent"
                    CLASSES_ABOVE_75=$((CLASSES_ABOVE_75 + 1))
                elif [ "$coverage_percent" -ge 75 ] 2>/dev/null; then
                    status="Good"
                    CLASSES_ABOVE_75=$((CLASSES_ABOVE_75 + 1))
                elif [ "$coverage_percent" -ge 50 ] 2>/dev/null; then
                    status="Needs Work"
                    CLASSES_BELOW_75=$((CLASSES_BELOW_75 + 1))
                else
                    status="Poor"
                    CLASSES_BELOW_75=$((CLASSES_BELOW_75 + 1))
                fi

                printf "%-35s | %7s%% | %s\n" "$apex_class" "$coverage_percent" "$status"
                TOTAL_COVERAGE=$((TOTAL_COVERAGE + coverage_percent))
                CLASS_COUNT=$((CLASS_COUNT + 1))
            else
                printf "%-35s | %8s | %s\n" "$apex_class" "N/A" "Not found in output"
            fi
        else
            printf "%-35s | %8s | %s\n" "$apex_class" "N/A" "No output captured"
        fi
    done

    echo "----------------------------------- | -------- | --------------"

    # Calculate average coverage
    if [ $CLASS_COUNT -gt 0 ]; then
        AVERAGE_COVERAGE=$((TOTAL_COVERAGE / CLASS_COUNT))
        echo "Total Project Classes: $CLASS_COUNT/${#PROJECT_APEX_CLASSES[@]} | Avg: ${AVERAGE_COVERAGE}% | Good: $CLASSES_ABOVE_75 | Need Work: $CLASSES_BELOW_75"
    else
        echo "Total Project Classes: $CLASS_COUNT/${#PROJECT_APEX_CLASSES[@]} | No coverage data available"
    fi

    # Add Test Summary section
    echo
    echo "Test Execution Summary:"
    echo "==========================================="

    if [ -f "$TEMP_OUTPUT" ]; then
        # Parse test summary information from the output
        OUTCOME=$(grep -A 20 "=== Test Summary" "$TEMP_OUTPUT" 2>/dev/null | grep "Outcome" | awk '{print $2}' | head -1)
        TESTS_RAN=$(grep -A 20 "=== Test Summary" "$TEMP_OUTPUT" 2>/dev/null | grep "Tests Ran" | awk '{print $3}' | head -1)
        PASS_RATE=$(grep -A 20 "=== Test Summary" "$TEMP_OUTPUT" 2>/dev/null | grep "Pass Rate" | awk '{print $3}' | head -1)
        FAIL_RATE=$(grep -A 20 "=== Test Summary" "$TEMP_OUTPUT" 2>/dev/null | grep "Fail Rate" | awk '{print $3}' | head -1)
        SKIP_RATE=$(grep -A 20 "=== Test Summary" "$TEMP_OUTPUT" 2>/dev/null | grep "Skip Rate" | awk '{print $3}' | head -1)

        # Display summary table
        echo "NAME                 | VALUE"
        echo "-------------------- | ----------------------"

        # Show outcome
        if [ "$OUTCOME" = "Passed" ]; then
            printf "%-20s | %s\n" "Outcome" "PASSED $OUTCOME"
        elif [ "$OUTCOME" = "Failed" ]; then
            printf "%-20s | %s\n" "Outcome" "FAILED $OUTCOME"
        else
            printf "%-20s | %s\n" "Outcome" "${OUTCOME:-N/A}"
        fi

        printf "%-20s | %s\n" "Tests Ran" "${TESTS_RAN:-N/A}"
        printf "%-20s | %s\n" "Pass Rate" "${PASS_RATE:-N/A}"
        printf "%-20s | %s\n" "Fail Rate" "${FAIL_RATE:-N/A}"
        printf "%-20s | %s\n" "Skip Rate" "${SKIP_RATE:-N/A}"

        echo "-------------------- | ----------------------"

        # Add interpretation
        if [ "$OUTCOME" = "Passed" ]; then
            echo "All tests completed successfully!"
        elif [ "$OUTCOME" = "Failed" ]; then
            echo "Some tests failed - review details above"


            # Extract and display failing test classes - IMPROVED LOGIC
            echo
            echo "Failed Test Classes:"
            echo "====================="

            # Look for actual test failures in the output
            # Pattern: TestName.testMethodName Fail ErrorMessage
            # Look for lines that end with "Fail" followed by an error message (not just "Fail" in the test name)
            failed_tests=$(grep -E "[A-Za-z_]+Test\.[a-zA-Z_]+[[:space:]]+Fail[[:space:]]+" "$TEMP_OUTPUT" 2>/dev/null | awk '{print $1}' | sort | uniq)



            if [ ! -z "$failed_tests" ]; then
                # Group failures by test class and only show classes that actually have failures
                failed_classes=$(echo "$failed_tests" | cut -d'.' -f1 | sort | uniq)
                if [ ! -z "$failed_classes" ]; then
                    # Use a different approach to avoid subshell issues with while read
                    for test_class in $failed_classes; do
                        if [ ! -z "$test_class" ]; then
                            echo "  FAILED: $test_class"
                        fi
                    done
                else
                    echo "  No specific test classes with failures found"
                fi
            else
                # Try alternative pattern matching for failures
                echo "  Analyzing test output for failures..."

                # Look for lines that contain "Fail" and extract the test class name
                failed_tests_alt=$(grep -B 1 "Fail" "$TEMP_OUTPUT" 2>/dev/null | grep -E "[A-Za-z_]+Test\." | awk '{print $1}' | sort | uniq)

                if [ ! -z "$failed_tests_alt" ]; then
                    failed_classes_alt=$(echo "$failed_tests_alt" | cut -d'.' -f1 | sort | uniq)
                    for test_class in $failed_classes_alt; do
                        if [ ! -z "$test_class" ]; then
                            echo "  FAILED: $test_class"
                        fi
                    done
                else
                            # Final fallback - look for any line containing "Fail" and try to extract test class
            echo "  Final fallback analysis..."
            failed_lines=$(grep "Fail" "$TEMP_OUTPUT" 2>/dev/null | head -20)
            if [ ! -z "$failed_lines" ]; then
                echo "  Found failure lines, but couldn't parse specific classes:"
                echo "$failed_lines" | head -5 | sed 's/^/    /'
                echo "  Debug: Looking for test class patterns..."
                echo "$failed_lines" | grep -E "[A-Za-z_]+Test" | head -3 | sed 's/^/    /'
            else
                echo "  Could not parse specific test failures from output"
                echo "  Check the detailed test output above for failure details"
            fi
                fi
            fi
        fi
    else
        echo "NAME                 | VALUE"
        echo "-------------------- | ----------------------"
        echo "Outcome              | No data captured"
        echo "Tests Ran            | N/A"
        echo "Pass Rate            | N/A"
        echo "Fail Rate            | N/A"
        echo "Skip Rate            | N/A"
        echo "-------------------- | ----------------------"
        echo "Test summary not available - check test execution"
    fi

    echo
    echo "Test Coverage Analysis:"
    echo "  All ${#PROJECT_TEST_CLASSES[@]} test classes executed successfully"
    echo "  Tests cover ${CLASS_COUNT}/${#PROJECT_APEX_CLASSES[@]} main Apex classes in the project"
    if [ $CLASS_COUNT -gt 0 ]; then
        echo "  Average coverage across project classes: ${AVERAGE_COVERAGE}%"
        echo "  Classes with 75%+ coverage: $CLASSES_ABOVE_75 out of $CLASS_COUNT"
        if [ $CLASSES_BELOW_75 -gt 0 ]; then
            echo "  WARNING: Classes needing attention: $CLASSES_BELOW_75 below 75% coverage"
        else
            echo "  All tested classes meet minimum coverage requirements!"
        fi
    fi

    echo
    echo "Coverage Recommendations:"
    echo "  Aim for 85%+ coverage on all classes for production deployment"
    echo "  Focus on edge cases and error handling in lower-coverage classes"
    echo "  Consider adding negative test scenarios for better coverage"

    echo
    echo "Next steps:"
    echo "  Review any failing tests and fix issues"
    echo "  Ensure code coverage meets your org requirements (usually 75%+)"
    echo "  Run deployment if all tests pass"

    # Generate markdown report
    generate_markdown_report "success" "$TEMP_OUTPUT"

else
    log_error "Some tests failed!"
    echo
    echo "Troubleshooting:"
    echo "  Check test failure details above"
    echo "  Verify all required API configurations are set up"
    echo "  Ensure proper test data setup"
    echo "  Check for any deployment issues"

    # Generate markdown report even for failures
    generate_markdown_report "failure" "$TEMP_OUTPUT"

    exit 1
fi

echo
echo "Pro Tips:"
echo "  Run tests before every deployment"
echo "  Aim for 85%+ code coverage for production"
echo "  Fix failing tests before proceeding with deployment"
echo "  Use option 3 to debug specific failing tests"
echo "  Detailed results saved to: $RESULTS_FILE"

# Cleanup temporary file
if [ -f "$TEMP_OUTPUT" ]; then
    rm -f "$TEMP_OUTPUT"
fi

#!/bin/bash

# =============================================================================
# SFDT - Comprehensive Test Runner
# =============================================================================
set -euo pipefail

# Project configuration
PROJECT_NAME="${SFDT_PROJECT_NAME:-Salesforce Project}"

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to log info
log_info() { echo -e "${BLUE}ℹ️  INFO${NC} - $1"; }
log_success() { echo -e "${GREEN}✅ SUCCESS${NC} - $1"; }
log_warning() { echo -e "${YELLOW}⚠️  WARN${NC} - $1"; }
log_error() { echo -e "${RED}❌ ERROR${NC} - $1"; }

echo -e "${BLUE}${PROJECT_NAME} - Test Suite${NC}"
echo "========================================="

# Initialize variables
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
# Fallback for LOG_DIR if not provided by script-runner
LOG_DIR="${SFDT_LOG_DIR:-${SFDT_PROJECT_ROOT:-$SCRIPT_DIR/../..}/logs}"
TEST_RESULTS_DIR="$LOG_DIR/test-results"
RESULTS_FILE="$TEST_RESULTS_DIR/test_results_$TIMESTAMP.md"

mkdir -p "$TEST_RESULTS_DIR"

# Load classes from env vars or config file
if [[ -n "${SFDT_TEST_CLASSES:-}" ]]; then
    IFS=',' read -r -a PROJECT_TEST_CLASSES <<< "$SFDT_TEST_CLASSES"
else
    # Fallback to config file using jq
    CONFIG_FILE="${SFDT_CONFIG_DIR:-${SFDT_PROJECT_ROOT:-.}/.sfdt}/test-config.json"
    if [[ -f "$CONFIG_FILE" ]]; then
        PROJECT_TEST_CLASSES=($(jq -r '.testClasses[]' "$CONFIG_FILE" 2>/dev/null || echo ""))
    else
        PROJECT_TEST_CLASSES=()
    fi
fi

if [[ -n "${SFDT_APEX_CLASSES:-}" ]]; then
    IFS=',' read -r -a PROJECT_APEX_CLASSES <<< "$SFDT_APEX_CLASSES"
else
    # Fallback to config file using jq
    CONFIG_FILE="${SFDT_CONFIG_DIR:-${SFDT_PROJECT_ROOT:-.}/.sfdt}/test-config.json"
    if [[ -f "$CONFIG_FILE" ]]; then
        PROJECT_APEX_CLASSES=($(jq -r '.apexClasses[]' "$CONFIG_FILE" 2>/dev/null || echo ""))
    else
        PROJECT_APEX_CLASSES=()
    fi
fi

# Validate that we loaded the classes
if [ ${#PROJECT_TEST_CLASSES[@]} -eq 0 ]; then
    log_error "No test classes identified. Run 'sfdt init' or check your configuration."
    exit 1
fi

TEST_CLASS_LIST=$(IFS=,; echo "${PROJECT_TEST_CLASSES[*]}")

log_info "Classes identified: ${#PROJECT_TEST_CLASSES[@]} tests, ${#PROJECT_APEX_CLASSES[@]} apex."

# Handle Non-Interactive Mode
NON_INTERACTIVE="${SFDT_NON_INTERACTIVE:-false}"
OPTION="1" # Default to all tests with coverage

if [[ "$NON_INTERACTIVE" != "true" ]]; then
    echo
    echo "Test execution options:"
    echo "1. Run all project tests with code coverage (recommended)"
    echo "2. Run all project tests without code coverage (faster)"
    echo "3. Run specific test class"
    echo "4. Validate tests only (check compilation)"
    echo "5. Run tests and generate detailed report"
    echo "6. Clean up test-results directory"

    read -p "Choose option (1-6): " -n 1 -r OPTION
    echo
else
    log_info "Non-interactive mode: running all tests with coverage."
fi

TEMP_OUTPUT=$(mktemp)
TEST_EXIT_CODE=0

case $OPTION in
    1|5|"")
        log_info "Running all tests with code coverage..."
        sf apex run test --class-names "$TEST_CLASS_LIST" --code-coverage --result-format human --wait 20 | tee "$TEMP_OUTPUT"
        TEST_EXIT_CODE=${PIPESTATUS[0]}
        ;;
    2)
        log_info "Running all tests without coverage..."
        sf apex run test --class-names "$TEST_CLASS_LIST" --result-format human --wait 15 | tee "$TEMP_OUTPUT"
        TEST_EXIT_CODE=${PIPESTATUS[0]}
        ;;
    3)
        if [[ "$NON_INTERACTIVE" == "true" ]]; then
            log_error "Option 3 (specific class) is not supported in non-interactive mode."
            exit 1
        fi
        echo "Available test classes:"
        for i in "${!PROJECT_TEST_CLASSES[@]}"; do
            echo "$((i+1)). ${PROJECT_TEST_CLASSES[$i]}"
        done
        read -p "Enter class number (1-${#PROJECT_TEST_CLASSES[@]}): " class_num
        if [[ $class_num -ge 1 && $class_num -le ${#PROJECT_TEST_CLASSES[@]} ]]; then
            selected_class="${PROJECT_TEST_CLASSES[$((class_num-1))]}"
            log_info "Running test class: $selected_class"
            sf apex run test --class-names "$selected_class" --code-coverage --result-format human --wait 15 | tee "$TEMP_OUTPUT"
            TEST_EXIT_CODE=${PIPESTATUS[0]}
        else
            log_error "Invalid class number"
            exit 1
        fi
        ;;
    4)
        log_info "Validating test compilation..."
        for test_class in "${PROJECT_TEST_CLASSES[@]}"; do
            if sf data query --query "SELECT Id FROM ApexClass WHERE Name='$test_class'" --json &>/dev/null; then
                log_success "$test_class - Compiled successfully"
            else
                log_error "$test_class - Compilation failed or not found"
            fi
        done
        exit 0
        ;;
    6)
        log_info "Cleaning up $TEST_RESULTS_DIR..."
        rm -f "$TEST_RESULTS_DIR"/*.md
        log_success "Cleanup complete."
        exit 0
        ;;
    *)
        log_error "Invalid option: $OPTION"
        exit 1
        ;;
esac

# Generate markdown report from captured output
echo -e "\n${BLUE}Generating Report...${NC}"

cat > "$RESULTS_FILE" << EOF
# ${PROJECT_NAME} - Test Results
**Generated:** $(date)

## Summary
$(grep -A 10 "Test Summary" "$TEMP_OUTPUT" 2>/dev/null || echo "No summary found in output.")

## Coverage per Class
| Class | Coverage |
|-------|----------|
$(for cls in "${PROJECT_APEX_CLASSES[@]}"; do
    cov=$(grep "$cls" "$TEMP_OUTPUT" 2>/dev/null | grep -oP '\d+%' | head -1 || echo "N/A")
    echo "| $cls | $cov |"
done)
EOF

log_success "Detailed results saved to: $RESULTS_FILE"

# Cleanup temp file
rm -f "$TEMP_OUTPUT"

# Exit with the actual test command's exit code
exit $TEST_EXIT_CODE
 test command's exit code
exit $TEST_EXIT_CODE

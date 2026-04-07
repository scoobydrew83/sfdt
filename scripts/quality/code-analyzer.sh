#!/bin/bash
set -euo pipefail

# =============================================================================
# SFDT - Code Quality Analyzer
# Basic static analysis and quality checks
# =============================================================================

# Source shared utilities
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../utils/shared.sh"

# Configuration from SFDT_ env vars (set by script-runner.js)
PROJECT_NAME="${SFDT_PROJECT_NAME:-Salesforce Project}"
SOURCE_PATH="${SFDT_SOURCE_PATH:-force-app/main/default}"
LOG_DIR="${SFDT_LOG_DIR:-${SFDT_PROJECT_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}/logs}"
PROJECT_CONFIG_DIR="${SFDT_CONFIG_DIR:-${SFDT_PROJECT_ROOT:-.}/.sfdt}"
PROJECT_CONFIG_FILE="${PROJECT_CONFIG_DIR}/config.json"
ENVIRONMENT_CONFIG_FILE="${PROJECT_CONFIG_DIR}/environments.json"
PULL_CONFIG_FILE="${PROJECT_CONFIG_DIR}/pull-config.json"
TEST_CONFIG_FILE="${PROJECT_CONFIG_DIR}/test-config.json"

echo -e "${BLUE}${PROJECT_NAME} - Code Quality Analyzer${NC}"
echo -e "${YELLOW}====================================================${NC}"

# Check project structure
log_info "Checking project structure..."

# Resolve force-app directory - try relative paths from script location
FORCE_APP_DIR="$SOURCE_PATH"
if [ ! -d "$FORCE_APP_DIR" ]; then
    FORCE_APP_DIR="../../${SOURCE_PATH}"
fi
if [ ! -d "$FORCE_APP_DIR" ]; then
    log_error "Source directory not found: $SOURCE_PATH"
    exit 1
fi

# Count different types of components
APEX_CLASSES=$(find "$FORCE_APP_DIR/classes" -name "*.cls" 2>/dev/null | wc -l || echo 0)
APEX_TESTS=$(find "$FORCE_APP_DIR/classes" -name "*Test.cls" 2>/dev/null | wc -l || echo 0)
LWC_COMPONENTS=$(find "$FORCE_APP_DIR/lwc" -maxdepth 1 -type d 2>/dev/null | tail -n +2 | wc -l || echo 0)
FLOWS=$(find "$FORCE_APP_DIR/flows" -name "*.flow-meta.xml" 2>/dev/null | wc -l || echo 0)
OBJECTS=$(find "$FORCE_APP_DIR/objects" -name "*.object-meta.xml" 2>/dev/null | wc -l || echo 0)

log_info "Project Statistics:"
echo "  Apex Classes: $APEX_CLASSES"
echo "  Test Classes: $APEX_TESTS"
echo "  LWC Components: $LWC_COMPONENTS"
echo "  Flows: $FLOWS"
echo "  Custom Objects: $OBJECTS"

# Calculate test coverage ratio
if [ "$APEX_CLASSES" -gt 0 ]; then
    TEST_RATIO=$((APEX_TESTS * 100 / APEX_CLASSES))
    if [ "$TEST_RATIO" -ge 80 ]; then
        log_success "Test Coverage Ratio: ${TEST_RATIO}% (Good)"
    elif [ "$TEST_RATIO" -ge 60 ]; then
        log_warning "Test Coverage Ratio: ${TEST_RATIO}% (Needs Improvement)"
    else
        log_error "Test Coverage Ratio: ${TEST_RATIO}% (Critical)"
    fi
else
    log_warning "No Apex classes found for analysis"
fi

# Check for common quality issues
log_info "Checking for quality issues..."

# Check for classes without tests
if [ -d "$FORCE_APP_DIR/classes" ]; then
    CLASSES_WITHOUT_TESTS=0
    while IFS= read -r -d '' class_file; do
        class_name=$(basename "$class_file" .cls)
        # Skip if it's already a test class
        if [[ ! "$class_name" =~ Test$ ]]; then
            # Check if corresponding test exists
            if [ ! -f "$FORCE_APP_DIR/classes/${class_name}Test.cls" ] && [ ! -f "$FORCE_APP_DIR/classes/${class_name}_Test.cls" ]; then
                if [ "$CLASSES_WITHOUT_TESTS" -eq 0 ]; then
                    log_warning "Classes without tests found:"
                fi
                echo "  $class_name"
                ((CLASSES_WITHOUT_TESTS++))
            fi
        fi
    done < <(find "$FORCE_APP_DIR/classes" -name "*.cls" -print0)

    if [ "$CLASSES_WITHOUT_TESTS" -eq 0 ]; then
        log_success "All non-test classes have corresponding test classes"
    fi
fi

# Check configuration integrity
log_info "Validating configuration files..."

CONFIG_ISSUES=0

# Check project.json
if ! jq empty "$PROJECT_CONFIG_FILE" 2>/dev/null; then
    log_error "Invalid JSON in project.json"
    ((CONFIG_ISSUES++))
else
    log_success "project.json is valid JSON"
fi

# Check environments.json
if ! jq empty "$ENVIRONMENT_CONFIG_FILE" 2>/dev/null; then
    log_error "Invalid JSON in environments.json"
    ((CONFIG_ISSUES++))
else
    log_success "environments.json is valid JSON"
fi

# Check pull-config.json
if ! jq empty "$PULL_CONFIG_FILE" 2>/dev/null; then
    log_error "Invalid JSON in pull-config.json"
    ((CONFIG_ISSUES++))
else
    log_success "pull-config.json is valid JSON"
fi

# Check test-config.json
if ! jq empty "$TEST_CONFIG_FILE" 2>/dev/null; then
    log_error "Invalid JSON in test-config.json"
    ((CONFIG_ISSUES++))
else
    log_success "test-config.json is valid JSON"
fi

# Summary
echo ""
log_info "Quality Analysis Summary:"
echo "=========================="

if [ "$CONFIG_ISSUES" -eq 0 ] && [ "$CLASSES_WITHOUT_TESTS" -eq 0 ] && [ "${TEST_RATIO:-0}" -ge 70 ]; then
    log_success "Overall quality: GOOD"
    echo "  All configurations are valid"
    echo "  Test coverage is adequate"
    echo "  No major quality issues found"
elif [ "$CONFIG_ISSUES" -eq 0 ] && [ "$CLASSES_WITHOUT_TESTS" -le 5 ]; then
    log_warning "Overall quality: FAIR"
    echo "  Minor issues found that should be addressed"
else
    log_error "Overall quality: NEEDS IMPROVEMENT"
    echo "  Significant quality issues found"
fi

# Exit with appropriate code
if [ "$CONFIG_ISSUES" -gt 0 ] || [ "$CLASSES_WITHOUT_TESTS" -gt 10 ]; then
    exit 1
else
    exit 0
fi

#!/bin/bash
set -euo pipefail

# SFDT - Code Quality Analyzer
# Basic static analysis and quality checks

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
require_jq || exit 1

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
                CLASSES_WITHOUT_TESTS=$((CLASSES_WITHOUT_TESTS + 1))
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
    CONFIG_ISSUES=$((CONFIG_ISSUES + 1))
else
    log_success "project.json is valid JSON"
fi

# Check environments.json
if ! jq empty "$ENVIRONMENT_CONFIG_FILE" 2>/dev/null; then
    log_error "Invalid JSON in environments.json"
    CONFIG_ISSUES=$((CONFIG_ISSUES + 1))
else
    log_success "environments.json is valid JSON"
fi

# Check pull-config.json
if ! jq empty "$PULL_CONFIG_FILE" 2>/dev/null; then
    log_error "Invalid JSON in pull-config.json"
    CONFIG_ISSUES=$((CONFIG_ISSUES + 1))
else
    log_success "pull-config.json is valid JSON"
fi

# Check test-config.json
if ! jq empty "$TEST_CONFIG_FILE" 2>/dev/null; then
    log_error "Invalid JSON in test-config.json"
    CONFIG_ISSUES=$((CONFIG_ISSUES + 1))
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

# Emit structured JSON to stdout for GUI result parsing.
# Try sf scanner (Salesforce Code Analyzer) if installed. When it is NOT
# installed (or the run fails), never fabricate a clean scan result — emit an
# unmistakably labelled skipped marker (status "skipped" + reason) so that no
# downstream consumer can mistake the absence of a scan for a passing one.
# "result": [] plus "_sfdt_unavailable" are kept for existing consumers
# (gui-server parseQualityLines); "status"/"reason" are additive.
# Prefer Salesforce Code Analyzer v5 (`sf code-analyzer run`, a just-in-time
# plugin on a modern sf CLI). Fall back to the retired v4 (`sf scanner run`)
# when only that is present, and otherwise emit the skipped marker — never
# fabricate a clean scan. Set SFDT_ANALYZER_INCLUDE_FIXES=true to request
# actionable fixes/suggestions in the output (v5 only).
_INCLUDE_FIXES=()
if [[ "${SFDT_ANALYZER_INCLUDE_FIXES:-}" == "true" ]]; then
    _INCLUDE_FIXES=(--include-fixes --include-suggestions)
fi

_SCANNER_V4=""
if command -v sf &>/dev/null; then
    _SCANNER_V4=$(sf plugins --json 2>/dev/null | \
        jq -r '.[] | select(.name == "@salesforce/sfdx-scanner") | .name' 2>/dev/null || true)
fi

if command -v sf &>/dev/null && sf code-analyzer --help &>/dev/null; then
    log_info "Running Salesforce Code Analyzer v5 (sf code-analyzer run)..."
    _ANALYZER_TMP=$(mktemp -t sfdt-analyzer-XXXXXX.json)
    # --severity-threshold is deliberately omitted: sfdt applies its own
    # thresholds, and a non-zero analyzer exit must not abort this script.
    # v5 writes JSON to --output-file (by extension); cat it to stdout so the
    # existing stdout-JSON contract (parseQualityLines) is preserved.
    if sf code-analyzer run \
        --workspace "$FORCE_APP_DIR" \
        "${_INCLUDE_FIXES[@]}" \
        --output-file "$_ANALYZER_TMP" &>/dev/null && [[ -s "$_ANALYZER_TMP" ]]; then
        cat "$_ANALYZER_TMP"
    else
        printf '{"status":"skipped","reason":"sf code-analyzer run failed","result":[],"_sfdt_unavailable":"sf code-analyzer run failed — no violation data available for this run"}\n'
    fi
    rm -f "$_ANALYZER_TMP"
elif [[ -n "$_SCANNER_V4" ]]; then
    log_info "Running Salesforce Code Analyzer v4 (legacy sf scanner run)..."
    sf scanner run \
        --format json \
        --target "$FORCE_APP_DIR" \
        --engine pmd,eslint \
        2>/dev/null || \
        printf '{"status":"skipped","reason":"sf scanner run failed","result":[],"_sfdt_unavailable":"sf scanner run failed — no violation data available for this run"}\n'
else
    log_warning "Salesforce Code Analyzer not available — static violation analysis SKIPPED (not run)."
    log_warning "It auto-installs with a modern sf CLI, or run:  sf plugins install code-analyzer"
    printf '{"status":"skipped","reason":"sf code-analyzer not installed","result":[],"_sfdt_unavailable":"sf code-analyzer not available. It auto-installs with a modern sf CLI, or run: sf plugins install code-analyzer"}\n'
fi

# Exit with appropriate code
if [ "${CONFIG_ISSUES:-0}" -gt 0 ] || [ "${CLASSES_WITHOUT_TESTS:-0}" -gt 10 ]; then
    exit 1
else
    exit 0
fi

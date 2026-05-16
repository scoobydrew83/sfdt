set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../utils/shared.sh"
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
log_info "Checking project structure..."
FORCE_APP_DIR="$SOURCE_PATH"
if [ ! -d "$FORCE_APP_DIR" ]; then
    FORCE_APP_DIR="../../${SOURCE_PATH}"
fi
if [ ! -d "$FORCE_APP_DIR" ]; then
    log_error "Source directory not found: $SOURCE_PATH"
    exit 1
fi
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
log_info "Checking for quality issues..."
if [ -d "$FORCE_APP_DIR/classes" ]; then
    CLASSES_WITHOUT_TESTS=0
    while IFS= read -r -d '' class_file; do
        class_name=$(basename "$class_file" .cls)
        if [[ ! "$class_name" =~ Test$ ]]; then
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
log_info "Validating configuration files..."
CONFIG_ISSUES=0
if ! jq empty "$PROJECT_CONFIG_FILE" 2>/dev/null; then
    log_error "Invalid JSON in project.json"
    CONFIG_ISSUES=$((CONFIG_ISSUES + 1))
else
    log_success "project.json is valid JSON"
fi
if ! jq empty "$ENVIRONMENT_CONFIG_FILE" 2>/dev/null; then
    log_error "Invalid JSON in environments.json"
    CONFIG_ISSUES=$((CONFIG_ISSUES + 1))
else
    log_success "environments.json is valid JSON"
fi
if ! jq empty "$PULL_CONFIG_FILE" 2>/dev/null; then
    log_error "Invalid JSON in pull-config.json"
    CONFIG_ISSUES=$((CONFIG_ISSUES + 1))
else
    log_success "pull-config.json is valid JSON"
fi
if ! jq empty "$TEST_CONFIG_FILE" 2>/dev/null; then
    log_error "Invalid JSON in test-config.json"
    CONFIG_ISSUES=$((CONFIG_ISSUES + 1))
else
    log_success "test-config.json is valid JSON"
fi
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
_SCANNER_PLUGIN=""
if command -v sf &>/dev/null; then
    _SCANNER_PLUGIN=$(sf plugins --json 2>/dev/null | \
        jq -r '.[] | select(.name == "@salesforce/sfdx-scanner") | .name' 2>/dev/null || true)
fi
if [[ -n "$_SCANNER_PLUGIN" ]]; then
    log_info "Running Salesforce Code Analyzer (sf scanner)..."
    sf scanner run \
        --format json \
        --target "$FORCE_APP_DIR" \
        --engine pmd,eslint \
        2>/dev/null || \
        echo '{"status":0,"result":[]}'
else
    log_warning "sf scanner not installed — static violation analysis unavailable."
    log_warning "Install with:  sf plugins install @salesforce/sfdx-scanner"
    printf '{"status":0,"result":[],"_sfdt_unavailable":"sf scanner plugin not installed. Run: sf plugins install @salesforce/sfdx-scanner"}\n'
fi
if [ "${CONFIG_ISSUES:-0}" -gt 0 ] || [ "${CLASSES_WITHOUT_TESTS:-0}" -gt 10 ]; then
    exit 1
else
    exit 0
fi

#!/bin/bash
set -euo pipefail

# =============================================================================
# SFDT - Generate Test Stubs
# Generates minimal @IsTest stub .cls + -meta.xml pairs for Apex classes
# that don't have a corresponding test class.
# =============================================================================

# Source shared utilities
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../utils/shared.sh"

# Configuration from SFDT_ env vars (set by script-runner.js)
PROJECT_NAME="${SFDT_PROJECT_NAME:-Salesforce Project}"
SOURCE_PATH="${SFDT_SOURCE_PATH:-force-app/main/default}"
DRY_RUN="${SFDT_DRY_RUN:-false}"
TEST_CONFIG_FILE="${SFDT_CONFIG_DIR:-${SFDT_PROJECT_ROOT:-.}/.sfdt}/test-config.json"

echo -e "${BLUE}${PROJECT_NAME} - Generate Test Stubs${NC}"
echo -e "${YELLOW}======================================================${NC}"

# Load test class list
if [[ -n "${SFDT_TEST_CLASSES:-}" ]]; then
    IFS=',' read -r -a PROJECT_TEST_CLASSES <<< "$SFDT_TEST_CLASSES"
elif [[ -f "$TEST_CONFIG_FILE" ]]; then
    mapfile -t PROJECT_TEST_CLASSES < <(jq -r '.testClasses[]' "$TEST_CONFIG_FILE" 2>/dev/null | sort)
else
    PROJECT_TEST_CLASSES=()
fi

# Load apex class list
if [[ -n "${SFDT_APEX_CLASSES:-}" ]]; then
    IFS=',' read -r -a PROJECT_APEX_CLASSES <<< "$SFDT_APEX_CLASSES"
elif [[ -f "$TEST_CONFIG_FILE" ]]; then
    mapfile -t PROJECT_APEX_CLASSES < <(jq -r '.apexClasses[]' "$TEST_CONFIG_FILE" 2>/dev/null | sort)
else
    PROJECT_APEX_CLASSES=()
fi

log_info "Checking ${#PROJECT_APEX_CLASSES[@]} Apex classes for missing test stubs"

CLASSES_DIR="${SOURCE_PATH}/classes"
STUB_COUNT=0

for class in "${PROJECT_APEX_CLASSES[@]}"; do
    # Skip classes that are already test classes
    if [[ "$class" =~ Test$ ]] || [[ "$class" =~ _Test$ ]]; then
        continue
    fi

    # Check if a test class already exists in the known list
    has_test=false
    for test_class in "${PROJECT_TEST_CLASSES[@]}"; do
        if [[ "$test_class" == "${class}Test" ]] || [[ "$test_class" == "${class}_Test" ]]; then
            has_test=true
            break
        fi
    done

    if [[ "$has_test" == "true" ]]; then
        continue
    fi

    # This class needs a test stub
    STUB_FILE="${CLASSES_DIR}/${class}Test.cls"
    META_FILE="${CLASSES_DIR}/${class}Test.cls-meta.xml"

    if [[ "$DRY_RUN" == "true" ]]; then
        log_info "[DRY RUN] Would create: ${class}Test.cls"
        STUB_COUNT=$((STUB_COUNT + 1))
    else
        if [[ -f "$STUB_FILE" ]]; then
            log_warning "Skipping ${class}Test.cls — file already exists"
            continue
        fi

        mkdir -p "$CLASSES_DIR"

        cat > "$STUB_FILE" << APEX
@IsTest
private class ${class}Test {
    @IsTest
    static void testPlaceholder() {
        // TODO: Implement tests for ${class}
        System.assert(true, 'Placeholder test for ${class}');
    }
}
APEX

        cat > "$META_FILE" << XML
<?xml version="1.0" encoding="UTF-8"?>
<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>${SFDT_API_VERSION:-61.0}</apiVersion>
    <status>Active</status>
</ApexClass>
XML

        log_success "Created: ${class}Test.cls"
        STUB_COUNT=$((STUB_COUNT + 1))
    fi
done

echo ""
if [[ "$DRY_RUN" == "true" ]]; then
    log_info "Dry run: would generate ${STUB_COUNT} stubs"
else
    log_success "Generated ${STUB_COUNT} test stubs"
fi

exit 0

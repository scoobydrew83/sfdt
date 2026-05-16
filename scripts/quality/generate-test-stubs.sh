set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../utils/shared.sh"
PROJECT_NAME="${SFDT_PROJECT_NAME:-Salesforce Project}"
SOURCE_PATH="${SFDT_SOURCE_PATH:-force-app/main/default}"
DRY_RUN="${SFDT_DRY_RUN:-false}"
TEST_CONFIG_FILE="${SFDT_CONFIG_DIR:-${SFDT_PROJECT_ROOT:-.}/.sfdt}/test-config.json"
echo -e "${BLUE}${PROJECT_NAME} - Generate Test Stubs${NC}"
echo -e "${YELLOW}======================================================${NC}"
require_jq || exit 1
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
log_info "Checking ${
CLASSES_DIR="${SOURCE_PATH}/classes"
STUB_COUNT=0
for class in "${PROJECT_APEX_CLASSES[@]}"; do
    if [[ ! "$class" =~ ^[a-zA-Z0-9_]+$ ]]; then
        log_warning "Skipping invalid class name: ${class}"
        continue
    fi
    if [[ "$class" =~ Test$ ]] || [[ "$class" =~ _Test$ ]]; then
        continue
    fi
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
    <apiVersion>${SFDT_API_VERSION:-65.0}</apiVersion>
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

#!/bin/bash
set -euo pipefail

# Org drift detection
# Compares org metadata against local repo to identify configuration drift

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../utils/shared.sh"
source "${SCRIPT_DIR}/../lib/git-utils.sh"

# Configuration
TARGET_ORG="${SFDT_TARGET_ORG:-}"
PROJECT_NAME="${SFDT_PROJECT_NAME:-sfdt}"

print_header "Org Drift Detection: ${PROJECT_NAME}"

# ── Resolve target org ───────────────────────────────────────────────────────
if [[ -z "$TARGET_ORG" ]]; then
    echo ""
    print_info "No SFDT_TARGET_ORG set. Available orgs:"
    sf org list --json 2>/dev/null | jq -r '.result.nonScratchOrgs[]?.alias // empty' 2>/dev/null || true
    sf org list --json 2>/dev/null | jq -r '.result.scratchOrgs[]?.alias // empty' 2>/dev/null || true
    echo ""
    read -rp "Enter target org alias: " TARGET_ORG
    if [[ -z "$TARGET_ORG" ]]; then
        print_error "No target org specified. Aborting."
        exit 1
    fi
fi

print_info "Target org: ${TARGET_ORG}"
echo ""

# ── Run retrieve preview ─────────────────────────────────────────────────────
print_step "Comparing org metadata against local source..."
echo ""

PREVIEW_OUTPUT=$(mktemp)
if ! sf project retrieve preview --target-org "$TARGET_ORG" --json > "$PREVIEW_OUTPUT" 2>&1; then
    # Check if it failed entirely or just had non-zero exit
    if ! jq -e '.result' "$PREVIEW_OUTPUT" &>/dev/null; then
        print_error "Failed to run retrieve preview."
        jq -r '.message // "Unknown error"' "$PREVIEW_OUTPUT" 2>/dev/null || cat "$PREVIEW_OUTPUT"
        rm -f "$PREVIEW_OUTPUT"
        exit 1
    fi
fi

# ── Parse and categorize results ─────────────────────────────────────────────
ADD_COUNT=0
MODIFY_COUNT=0
DELETE_COUNT=0

declare -a ADDED=()
declare -a MODIFIED=()
declare -a DELETED=()

# Parse the JSON output - structure varies by sf CLI version
# Try .result.files[] first, then .result[] as fallback
FILE_ENTRIES=$(jq -r '
    (.result.files // .result // [])[] |
    "\(.state // .type // "Unknown")|\(.fullName // .path // "unknown")"
' "$PREVIEW_OUTPUT" 2>/dev/null || true)

if [[ -z "$FILE_ENTRIES" ]]; then
    # Try alternate JSON structure
    FILE_ENTRIES=$(jq -r '
        .result[] |
        "\(.state // "Unknown")|\(.fullName // .path // "unknown")"
    ' "$PREVIEW_OUTPUT" 2>/dev/null || true)
fi

while IFS='|' read -r state name; do
    [[ -z "$state" ]] && continue
    case "$state" in
        Add|Created|add)
            ADDED+=("$name")
            ADD_COUNT=$((ADD_COUNT + 1))
            ;;
        Changed|Modified|modify|Modify)
            MODIFIED+=("$name")
            MODIFY_COUNT=$((MODIFY_COUNT + 1))
            ;;
        Delete|Deleted|delete)
            DELETED+=("$name")
            DELETE_COUNT=$((DELETE_COUNT + 1))
            ;;
        *)
            MODIFIED+=("${state}: ${name}")
            MODIFY_COUNT=$((MODIFY_COUNT + 1))
            ;;
    esac
done <<< "$FILE_ENTRIES"

rm -f "$PREVIEW_OUTPUT"

# ── Display categorized results ──────────────────────────────────────────────
TOTAL=$((ADD_COUNT + MODIFY_COUNT + DELETE_COUNT))

if (( TOTAL == 0 )); then
    print_success "No drift detected. Org and local source are in sync."
    exit 0
fi

print_warning "Drift detected: ${TOTAL} difference(s) found"
echo ""

if (( ADD_COUNT > 0 )); then
    print_info "Added (in org only, not in local source): ${ADD_COUNT}"
    for item in "${ADDED[@]}"; do
        echo "  + ${item}"
    done
    echo ""
fi

if (( MODIFY_COUNT > 0 )); then
    print_info "Modified (different between org and local): ${MODIFY_COUNT}"
    for item in "${MODIFIED[@]}"; do
        echo "  ~ ${item}"
    done
    echo ""
fi

if (( DELETE_COUNT > 0 )); then
    print_info "Deleted (in local source, not in org): ${DELETE_COUNT}"
    for item in "${DELETED[@]}"; do
        echo "  - ${item}"
    done
    echo ""
fi

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
print_header "Drift Summary"
echo "  Added:    ${ADD_COUNT}"
echo "  Modified: ${MODIFY_COUNT}"
echo "  Deleted:  ${DELETE_COUNT}"
echo "  Total:    ${TOTAL}"
echo ""

# ── Offer to pull changes ────────────────────────────────────────────────────
read -rp "Pull changes from org to resolve drift? (y/N): " pull_changes
if [[ "$pull_changes" =~ ^[Yy]$ ]]; then
    print_step "Retrieving metadata from ${TARGET_ORG}..."
    if sf project retrieve start --target-org "$TARGET_ORG"; then
        echo ""
        print_success "Metadata retrieved successfully."
        print_info "Review the changes with 'git diff' before committing."
    else
        echo ""
        print_error "Metadata retrieval failed."
        exit 1
    fi
else
    print_info "No changes pulled. Review the drift report and address manually."
fi

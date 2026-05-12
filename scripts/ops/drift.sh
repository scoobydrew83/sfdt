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
require_jq || exit 1

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
            echo "SFDT_LOG:component:${name}:Unknown:Added"
            ;;
        Changed|Modified|modify|Modify)
            MODIFIED+=("$name")
            MODIFY_COUNT=$((MODIFY_COUNT + 1))
            echo "SFDT_LOG:component:${name}:Unknown:Modified"
            ;;
        Delete|Deleted|delete)
            DELETED+=("$name")
            DELETE_COUNT=$((DELETE_COUNT + 1))
            echo "SFDT_LOG:component:${name}:Unknown:Deleted"
            ;;
        *)
            MODIFIED+=("${state}: ${name}")
            MODIFY_COUNT=$((MODIFY_COUNT + 1))
            echo "SFDT_LOG:component:${name}:Unknown:Modified"
            ;;
    esac
done <<< "$FILE_ENTRIES"

rm -f "$PREVIEW_OUTPUT"

# ── Display categorized results ──────────────────────────────────────────────
TOTAL=$((ADD_COUNT + MODIFY_COUNT + DELETE_COUNT))

# ── Persist structured log ───────────────────────────────────────────────────
_SFDT_LOG_DIR="${SFDT_LOG_DIR:-${SFDT_PROJECT_ROOT}/logs}"
mkdir -p "$_SFDT_LOG_DIR"
_COMPONENTS_JSON=$(
  {
    for item in ${ADDED[@]+"${ADDED[@]}"}; do printf '%s\tAdded\n' "$item"; done
    for item in ${MODIFIED[@]+"${MODIFIED[@]}"}; do printf '%s\tModified\n' "$item"; done
    for item in ${DELETED[@]+"${DELETED[@]}"}; do printf '%s\tDeleted\n' "$item"; done
  } | jq -Rn '[inputs | split("\t") | {name: .[0], type: "Unknown", drift: .[1]}]'
) || _COMPONENTS_JSON="[]"
_DRIFT_STATUS=$( [[ "$TOTAL" -gt 0 ]] && echo "drift" || echo "clean" )
jq -n \
  --arg schemaVersion "1" \
  --arg type "drift" \
  --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg org "${TARGET_ORG}" \
  --arg projectName "${PROJECT_NAME}" \
  --arg status "$_DRIFT_STATUS" \
  --argjson components "$_COMPONENTS_JSON" \
  '{schemaVersion:$schemaVersion,type:$type,timestamp:$timestamp,durationMs:0,exitCode:0,org:$org,projectName:$projectName,data:{status:$status,components:$components}}' \
  > "${_SFDT_LOG_DIR}/drift-latest.json" || true

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
if [[ "${SFDT_NON_INTERACTIVE:-}" == "true" ]]; then
    print_info "Non-interactive mode: skipping pull prompt. Use 'sfdt pull' to retrieve changes."
else
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
fi

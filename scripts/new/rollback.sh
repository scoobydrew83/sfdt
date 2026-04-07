#!/bin/bash
set -euo pipefail

# Rollback to a previous release manifest
# Redeploys a previously archived package.xml to a target org

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../utils/shared.sh"
source "${SCRIPT_DIR}/../lib/git-utils.sh"

# Configuration
MANIFEST_DIR="${SFDT_MANIFEST_DIR:-manifest/release}"
TARGET_ORG="${SFDT_TARGET_ORG:-}"
PROJECT_NAME="${SFDT_PROJECT_NAME:-sfdt}"
DEPLOYED_DIR="${MANIFEST_DIR}/deployed"
BACKUP_BEFORE_ROLLBACK="${SFDT_BACKUP_BEFORE_ROLLBACK:-true}"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
BACKUP_DIR="${SFDT_LOG_DIR:-${SFDT_PROJECT_ROOT:-.}/logs}/rollback-backups"

print_header "Rollback Deployment: ${PROJECT_NAME}"

# ── Step 1: Validate manifest directory ──────────────────────────────────────
if [[ ! -d "$DEPLOYED_DIR" ]]; then
    print_error "No deployed manifests found at: ${DEPLOYED_DIR}"
    print_info "Ensure previous releases have been archived to ${DEPLOYED_DIR}/"
    exit 1
fi

# ── Step 2: List last 5 deployed manifests (sorted by version) ───────────────
print_step "Scanning deployed manifests..."

mapfile -t MANIFESTS < <(
    find "$DEPLOYED_DIR" -name "package*.xml" -type f | sort -V | tail -5
)

if [[ ${#MANIFESTS[@]} -eq 0 ]]; then
    print_error "No package.xml files found in ${DEPLOYED_DIR}/"
    exit 1
fi

echo ""
print_info "Available manifests for rollback (last ${#MANIFESTS[@]}):"
echo ""

PS3=$'\nSelect manifest to rollback to (number): '
select SELECTED_MANIFEST in "${MANIFESTS[@]}"; do
    if [[ -n "$SELECTED_MANIFEST" ]]; then
        break
    fi
    print_warning "Invalid selection. Please choose a number from the list."
done

print_info "Selected: ${SELECTED_MANIFEST}"

# ── Step 3: Confirm target org ───────────────────────────────────────────────
if [[ -z "$TARGET_ORG" ]]; then
    echo ""
    print_info "Available orgs:"
    sf org list --json 2>/dev/null | jq -r '.result.nonScratchOrgs[]?.alias // empty' 2>/dev/null || true
    sf org list --json 2>/dev/null | jq -r '.result.scratchOrgs[]?.alias // empty' 2>/dev/null || true
    echo ""
    read -rp "Enter target org alias: " TARGET_ORG
    if [[ -z "$TARGET_ORG" ]]; then
        print_error "No target org specified. Aborting."
        exit 1
    fi
fi

# ── Step 4: Show what will be deployed ───────────────────────────────────────
echo ""
print_step "Manifest contents (${SELECTED_MANIFEST}):"
echo ""

# Parse package.xml to show types and member counts
if command -v xmllint &>/dev/null; then
    xmllint --xpath '//*[local-name()="types"]' "$SELECTED_MANIFEST" 2>/dev/null | \
        sed 's/<\/types>/\n/g' | while IFS= read -r type_block; do
            type_name=$(echo "$type_block" | sed -n 's/.*<name>\(.*\)<\/name>.*/\1/p')
            if [[ -n "$type_name" ]]; then
                member_count=$(echo "$type_block" | grep -c '<members>' || true)
                echo "  ${type_name}: ${member_count} member(s)"
            fi
        done
else
    # Fallback: simple grep-based parsing
    echo "  Types in manifest:"
    grep '<name>' "$SELECTED_MANIFEST" | sed 's/.*<name>\(.*\)<\/name>/    - \1/' | sort -u
    echo ""
    member_count=$(grep -c '<members>' "$SELECTED_MANIFEST" || true)
    echo "  Total members: ${member_count}"
fi

# ── Step 5: Confirm before proceeding ────────────────────────────────────────
echo ""
print_warning "This will deploy ${SELECTED_MANIFEST} to org: ${TARGET_ORG}"
read -rp "Proceed with rollback? (y/N): " confirm
if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
    print_info "Rollback cancelled."
    exit 0
fi

# ── Step 5b: Backup current org state ────────────────────────────────────────
if [[ "$BACKUP_BEFORE_ROLLBACK" == "true" ]]; then
    print_step "Creating pre-rollback backup of current org state..."
    BACKUP_PATH="${BACKUP_DIR}/pre_rollback_${TIMESTAMP}"
    mkdir -p "$BACKUP_PATH"
    if sf project retrieve start \
        --manifest "$SELECTED_MANIFEST" \
        --target-org "$TARGET_ORG" \
        --output-dir "$BACKUP_PATH" 2>/dev/null; then
        print_success "Pre-rollback backup saved to: ${BACKUP_PATH}"
    else
        print_warning "Pre-rollback backup failed — continuing with rollback"
    fi
fi

# ── Step 6: Execute deployment ───────────────────────────────────────────────
echo ""
print_step "Deploying manifest to ${TARGET_ORG}..."

if sf project deploy start \
    --manifest "$SELECTED_MANIFEST" \
    --target-org "$TARGET_ORG" \
    --wait 30; then
    echo ""
    print_success "Rollback deployment succeeded."
    print_info "Manifest: ${SELECTED_MANIFEST}"
    print_info "Target org: ${TARGET_ORG}"
else
    echo ""
    print_error "Rollback deployment failed."
    print_info "Check deployment errors above and retry if needed."
    exit 1
fi

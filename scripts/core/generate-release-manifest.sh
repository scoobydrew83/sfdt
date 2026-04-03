#!/usr/bin/env bash

# Release Manifest Generation Script
# Generates versioned package.xml and destructiveChanges.xml from git diffs

set -euo pipefail

# Check bash version (requires 4.0+ for associative arrays)
if [ "${BASH_VERSINFO:-0}" -lt 4 ]; then
    echo "Error: This script requires bash 4.0 or higher (current: $BASH_VERSION)"
    echo "On macOS, install via Homebrew: brew install bash"
    echo "Then run with: /opt/homebrew/bin/bash $0 $@"
    exit 1
fi

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# Source libraries
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/metadata-parser.sh"
source "${SCRIPT_DIR}/../lib/git-utils.sh"
source "${SCRIPT_DIR}/../lib/changelog-utils.sh"

# Project configuration
SOURCE_PATH="${SFDT_SOURCE_PATH:-force-app}"
MANIFEST_DIR="${SFDT_MANIFEST_DIR:-manifest/release}"

# Global variables
RELEASE_VERSION=""
PREVIOUS_TAG=""

# Declare global associative arrays for metadata parsing
declare -A ADDITIVE_METADATA  # metadata_type -> "member1,member2,..."
declare -A DESTRUCTIVE_METADATA

print_header() {
    echo -e "\n${BOLD}${BLUE}═══════════════════════════════════════════════════${NC}" >&2
    echo -e "${BOLD}${BLUE}  $1${NC}" >&2
    echo -e "${BOLD}${BLUE}═══════════════════════════════════════════════════${NC}\n" >&2
}

print_step() {
    echo -e "${CYAN}▶ $1${NC}" >&2
}

print_success() {
    echo -e "${GREEN}✅ $1${NC}" >&2
}

print_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}" >&2
}

print_error() {
    echo -e "${RED}❌ $1${NC}" >&2
}

error_handler() {
    local exit_code=$1
    local line_number=$2
    print_error "Error occurred at line ${line_number} (exit code: ${exit_code})"
    exit $exit_code
}

trap 'error_handler $? $LINENO' ERR

# Get release version from argument or prompt
# Detect the next release version by inspecting existing manifests and git tags
detect_next_version() {
    local latest_version=""

    # Check manifest/release files for latest version
    if [ -d "$MANIFEST_DIR" ]; then
        latest_version=$(ls "$MANIFEST_DIR"/rl-*-package.xml 2>/dev/null \
            | sed -E 's|.*/rl-([0-9]+\.[0-9]+\.[0-9]+)-package\.xml|\1|' \
            | sort -t. -k1,1n -k2,2n -k3,3n \
            | tail -1)
    fi

    # Fall back to git tags if no manifests found
    if [ -z "$latest_version" ]; then
        local latest_tag=$(get_latest_release_tag)
        if [ -n "$latest_tag" ]; then
            latest_version="${latest_tag#v}"
        fi
    fi

    if [ -z "$latest_version" ]; then
        echo ""
        return
    fi

    # Increment patch version
    local major minor patch
    IFS='.' read -r major minor patch <<< "$latest_version"
    echo "${major}.${minor}.$((patch + 1))"
}

get_release_version() {
    if [ $# -gt 0 ]; then
        RELEASE_VERSION="$1"
    else
        local suggested_version=$(detect_next_version)
        if [ -n "$suggested_version" ]; then
            read -p "$(echo -e ${GREEN}Release version [${suggested_version}]:${NC} )" RELEASE_VERSION
            # Use suggested version if user just hits Enter
            if [ -z "$RELEASE_VERSION" ]; then
                RELEASE_VERSION="$suggested_version"
            fi
        else
            read -p "$(echo -e ${GREEN}Enter release version \(e.g., 0.1.0\):${NC} )" RELEASE_VERSION
        fi
    fi

    if [ -z "$RELEASE_VERSION" ]; then
        print_error "Release version cannot be empty"
        exit 1
    fi

    # Validate version format (X.Y.Z)
    if ! [[ "$RELEASE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        print_error "Invalid version format. Expected: X.Y.Z (e.g., 0.1.7)"
        exit 1
    fi

    print_success "Release version: $RELEASE_VERSION"
}

# Check if version already exists
check_version_exists() {
    local tag="v${RELEASE_VERSION}"

    if tag_exists "$tag"; then
        print_error "Tag $tag already exists!"
        exit 1
    fi

    local manifest="${MANIFEST_DIR}/rl-${RELEASE_VERSION}-package.xml"
    if [ -f "$manifest" ]; then
        print_error "Manifest $manifest already exists (pending deployment)!"
        exit 1
    fi

    # Also check if already deployed (in deployed/ folder)
    local deployed_manifest="${MANIFEST_DIR}/deployed/rl-${RELEASE_VERSION}-package.xml"
    if [ -f "$deployed_manifest" ]; then
        print_error "Version $RELEASE_VERSION already deployed!"
        print_warning "Deployed manifest found at: $deployed_manifest"
        exit 1
    fi

    print_success "Version $RELEASE_VERSION is available"
}

# Check git prerequisites
check_git_prerequisites() {
    print_step "Checking git prerequisites..."

    # Check if in git repo
    if ! git rev-parse --git-dir > /dev/null 2>&1; then
        print_error "Not a git repository"
        exit 1
    fi

    # Check if working directory is clean
    if ! is_git_clean; then
        print_warning "Working directory has uncommitted changes"
        git status --short
        echo ""
        read -p "Continue anyway? (y/n) " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            exit 1
        fi
    else
        print_success "Working directory is clean"
    fi
}

# Find the previous release tag
find_previous_tag() {
    print_step "Finding previous release tag..."

    PREVIOUS_TAG=$(get_latest_release_tag)
    local current_branch=$(get_current_branch)

    # Check if on a feature/bugfix branch
    if [[ "$current_branch" =~ ^(feature|bugfix|hotfix)/ ]] && [ -n "$PREVIOUS_TAG" ]; then
        print_warning "On branch: $current_branch (latest tag: $PREVIOUS_TAG)"
        echo -e "${GREEN}Compare against:${NC}" >&2
        options=("Branch divergence from main (recommended)" "Previous release tag ($PREVIOUS_TAG)" "Specific commit")
        select opt in "${options[@]}"; do
            case $opt in
                "Branch divergence from main (recommended)")
                    PREVIOUS_TAG=$(get_branch_divergence_point "main")
                    print_success "Using divergence point: ${PREVIOUS_TAG:0:7}"
                    echo -e "${CYAN}Will include ${BOLD}ALL changes${NC}${CYAN} on branch ${BOLD}${current_branch}${NC}" >&2
                    break
                    ;;
                "Previous release tag ($PREVIOUS_TAG)")
                    print_success "Using previous release: $PREVIOUS_TAG"
                    break
                    ;;
                "Specific commit")
                    read -p "Enter commit SHA: " PREVIOUS_TAG
                    break
                    ;;
                *)
                    print_warning "Invalid selection"
                    ;;
            esac
        done
    elif [ -z "$PREVIOUS_TAG" ]; then
        print_warning "No previous release tag found (first release)"
        echo -e "${GREEN}Compare against:${NC}" >&2
        options=("Branch divergence from main" "main branch" "Specific commit" "Include all ${SOURCE_PATH}/")
        select opt in "${options[@]}"; do
            case $opt in
                "Branch divergence from main")
                    PREVIOUS_TAG=$(get_branch_divergence_point "main")
                    print_success "Using divergence point: ${PREVIOUS_TAG:0:7}"
                    echo -e "${CYAN}Branch: ${BOLD}${current_branch}${NC}${CYAN} diverged from ${BOLD}main${NC}${CYAN} at commit ${BOLD}${PREVIOUS_TAG:0:7}${NC}" >&2
                    break
                    ;;
                "main branch")
                    PREVIOUS_TAG="main"
                    break
                    ;;
                "Specific commit")
                    read -p "Enter commit SHA: " PREVIOUS_TAG
                    break
                    ;;
                "Include all ${SOURCE_PATH}/")
                    PREVIOUS_TAG=""
                    break
                    ;;
                *)
                    print_warning "Invalid selection"
                    ;;
            esac
        done
    else
        print_success "Previous release: $PREVIOUS_TAG"
        echo -e "${CYAN}Will compare ${BOLD}${PREVIOUS_TAG}${NC}${CYAN} → ${BOLD}v${RELEASE_VERSION}${NC}" >&2
    fi
}

# Detect changed files
detect_changed_files() {
    print_step "Detecting changed files..."

    # Create temporary file to store changes
    local temp_file=$(mktemp)

    if [ -z "$PREVIOUS_TAG" ]; then
        # First release - include all files
        cd "${SOURCE_PATH}/main/default"
        find . -type f \( -name "*.cls" -o -name "*.trigger" -o -name "*-meta.xml" \) | sed 's|^\./||' | awk '{print "A\t" $0}' > "$temp_file"
        cd - > /dev/null
    else
        # Get changes from git
        get_changed_files "$PREVIOUS_TAG" "HEAD" "${SOURCE_PATH}/" > "$temp_file"
    fi

    # Count changes
    local added=$(grep "^A" "$temp_file" | wc -l | tr -d ' ')
    local modified=$(grep "^M" "$temp_file" | wc -l | tr -d ' ')
    local deleted=$(grep "^D" "$temp_file" | wc -l | tr -d ' ')

    if [ "$added" -eq 0 ] && [ "$modified" -eq 0 ] && [ "$deleted" -eq 0 ]; then
        print_warning "No changes detected since $PREVIOUS_TAG"
        read -p "Continue anyway? (y/n) " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            rm "$temp_file"
            exit 0
        fi
    else
        print_success "Changes detected:"
        echo -e "  ${GREEN}Added:${NC} $added" >&2
        echo -e "  ${BLUE}Modified:${NC} $modified" >&2
        echo -e "  ${RED}Deleted:${NC} $deleted" >&2
    fi

    echo "$temp_file"
}

# Parse changed files and group by metadata type
# Args: $1 = changes file path
# Outputs: Creates associative arrays for added/modified and deleted components
parse_changes_to_metadata() {
    local changes_file=$1

    print_step "Parsing changes to metadata components..."

    local unknown_files=""
    local unknown_count=0
    local processed_count=0
    local total_count=$(wc -l < "$changes_file" | tr -d ' ')

    while IFS=$'\t' read -r status file_path; do
        processed_count=$((processed_count + 1))

        # Show progress every 50 files
        if (( processed_count % 50 == 0 )); then
            echo -ne "\r${GREEN}▶${NC} Processed $processed_count/$total_count files..."
        fi
        # Skip non-metadata files
        if [[ ! "$file_path" =~ ${SOURCE_PATH}/ ]] && [[ ! "$file_path" =~ force-app/ ]]; then
            continue
        fi

        # Get metadata type
        local metadata_type=$(get_metadata_type "$file_path")

        if [ "$metadata_type" == "SKIP" ]; then
            continue
        fi

        if [ "$metadata_type" == "UNKNOWN" ]; then
            unknown_files="${unknown_files}\n  - $file_path"
            unknown_count=$((unknown_count + 1))
            continue
        fi

        # Get member name
        local member_name=$(get_member_name "$file_path" "$metadata_type")

        # Add to appropriate array based on status
        if [ "$status" == "D" ]; then
            # Deleted - add to destructive
            if [ -z "${DESTRUCTIVE_METADATA[$metadata_type]:-}" ]; then
                DESTRUCTIVE_METADATA[$metadata_type]="$member_name"
            else
                DESTRUCTIVE_METADATA[$metadata_type]="${DESTRUCTIVE_METADATA[$metadata_type]},${member_name}"
            fi
        else
            # Added or Modified - add to additive
            if [ -z "${ADDITIVE_METADATA[$metadata_type]:-}" ]; then
                ADDITIVE_METADATA[$metadata_type]="$member_name"
            else
                ADDITIVE_METADATA[$metadata_type]="${ADDITIVE_METADATA[$metadata_type]},${member_name}"
            fi
        fi
    done < "$changes_file"

    # Clear progress line and show completion
    echo -ne "\r\033[K"  # Clear the line
    print_success "Processed $processed_count files"

    # Handle unknown files
    if [ $unknown_count -gt 0 ]; then
        print_warning "$unknown_count unknown file types detected:${unknown_files}"
        read -p "Continue? (y/n) " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            exit 1
        fi
    fi

    # Deduplicate members (for bundled components)
    for metadata_type in "${!ADDITIVE_METADATA[@]}"; do
        local members="${ADDITIVE_METADATA[$metadata_type]}"
        local unique_members=$(echo "$members" | tr ',' '\n' | sort -u | tr '\n' ',' | sed 's/,$//')
        ADDITIVE_METADATA[$metadata_type]="$unique_members"
    done

    for metadata_type in "${!DESTRUCTIVE_METADATA[@]}"; do
        local members="${DESTRUCTIVE_METADATA[$metadata_type]}"
        local unique_members=$(echo "$members" | tr ',' '\n' | sort -u | tr '\n' ',' | sed 's/,$//')
        DESTRUCTIVE_METADATA[$metadata_type]="$unique_members"
    done

    print_success "Metadata components parsed"
}

# Display parsed components for review
display_parsed_components() {
    print_header "PARSED COMPONENTS"

    # Check if there are additive components
    local has_additive=false
    for key in "${!ADDITIVE_METADATA[@]}"; do
        has_additive=true
        break
    done

    if [ "$has_additive" = true ]; then
        echo -e "${GREEN}${BOLD}Additive Components (new/modified):${NC}" >&2
        for metadata_type in "${!ADDITIVE_METADATA[@]}"; do
            local members="${ADDITIVE_METADATA[$metadata_type]}"
            local member_array=(${members//,/ })
            echo -e "  ${CYAN}${metadata_type}:${NC} ${#member_array[@]} components" >&2
            for member in "${member_array[@]}"; do
                echo -e "    - $member" >&2
            done
        done
        echo "" >&2
    fi

    # Check if there are destructive components
    local has_destructive=false
    for key in "${!DESTRUCTIVE_METADATA[@]}"; do
        has_destructive=true
        break
    done

    if [ "$has_destructive" = true ]; then
        echo -e "${RED}${BOLD}Destructive Components (deleted):${NC}" >&2
        for metadata_type in "${!DESTRUCTIVE_METADATA[@]}"; do
            local members="${DESTRUCTIVE_METADATA[$metadata_type]}"
            local member_array=(${members//,/ })
            echo -e "  ${CYAN}${metadata_type}:${NC} ${#member_array[@]} components" >&2
            for member in "${member_array[@]}"; do
                echo -e "    - $member" >&2
            done
        done
        echo "" >&2
    fi
}

# Generate package.xml from metadata map
# Args: $1 = output file path, $2 = associative array name
generate_package_xml() {
    local output_file=$1
    local -n metadata_map=$2

    # Load API version from config
    local api_version="63.0"
    if [ -f "sfdx-project.json" ] && command -v jq &> /dev/null; then
        api_version=$(jq -r '.sourceApiVersion // "63.0"' sfdx-project.json)
    elif [ -f "${SFDT_CONFIG_DIR:-tools/config}/deployment-config.yml" ]; then
        api_version=$(grep "apiVersion:" "${SFDT_CONFIG_DIR:-tools/config}/deployment-config.yml" | awk '{print $2}' | tr -d '"')
    fi

    # Start XML
    cat > "$output_file" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<Package xmlns="http://soap.sforce.com/2006/04/metadata">
EOF

    # Add types in alphabetical order
    for metadata_type in $(echo "${!metadata_map[@]}" | tr ' ' '\n' | sort); do
        echo "    <types>" >> "$output_file"

        # Add members in alphabetical order
        local members="${metadata_map[$metadata_type]}"
        for member in $(echo "$members" | tr ',' '\n' | sort); do
            echo "        <members>$member</members>" >> "$output_file"
        done

        echo "        <name>$metadata_type</name>" >> "$output_file"
        echo "    </types>" >> "$output_file"
    done

    # Close XML
    cat >> "$output_file" <<EOF
    <version>$api_version</version>
</Package>
EOF

    print_success "Generated: $output_file"
}

# Generate README documentation
generate_readme() {
    local readme_file="${MANIFEST_DIR}/rl-${RELEASE_VERSION}-README.md"

    print_step "Generating README..."

    # Count total components
    local additive_count=0
    for metadata_type in "${!ADDITIVE_METADATA[@]}"; do
        local members="${ADDITIVE_METADATA[$metadata_type]}"
        local member_array=(${members//,/ })
        additive_count=$((additive_count + ${#member_array[@]}))
    done

    local destructive_count=0
    for metadata_type in "${!DESTRUCTIVE_METADATA[@]}"; do
        local members="${DESTRUCTIVE_METADATA[$metadata_type]}"
        local member_array=(${members//,/ })
        destructive_count=$((destructive_count + ${#member_array[@]}))
    done

    local total_count=$((additive_count + destructive_count))

    # Load API version
    local api_version="63.0"
    if [ -f "sfdx-project.json" ] && command -v jq &> /dev/null; then
        api_version=$(jq -r '.sourceApiVersion // "63.0"' sfdx-project.json)
    elif [ -f "${SFDT_CONFIG_DIR:-tools/config}/deployment-config.yml" ]; then
        api_version=$(grep "apiVersion:" "${SFDT_CONFIG_DIR:-tools/config}/deployment-config.yml" | awk '{print $2}' | tr -d '"')
    fi

    # Generate README
    cat > "$readme_file" <<EOF
# Release ${RELEASE_VERSION} Deployment Package

**Generated:** $(date +%Y-%m-%d)
**Baseline:** ${PREVIOUS_TAG}
**Target API Version:** ${api_version}

## Components (${total_count} total)

EOF

    # New/Modified components
    # Check if array has elements (safe for set -u)
    local has_additive=false
    for key in "${!ADDITIVE_METADATA[@]}"; do
        has_additive=true
        break
    done

    if [ "$has_additive" = true ]; then
        echo "### New/Modified Components (${additive_count})" >> "$readme_file"
        echo "" >> "$readme_file"

        for metadata_type in $(echo "${!ADDITIVE_METADATA[@]}" | tr ' ' '\n' | sort); do
            local members="${ADDITIVE_METADATA[$metadata_type]}"
            echo "- **${metadata_type}**: $(echo "$members" | tr ',' ', ')" >> "$readme_file"
        done
        echo "" >> "$readme_file"
    fi

    # Deleted components
    # Check if array has elements (safe for set -u)
    local has_destructive=false
    for key in "${!DESTRUCTIVE_METADATA[@]}"; do
        has_destructive=true
        break
    done

    if [ "$has_destructive" = true ]; then
        echo "### Deleted Components (${destructive_count})" >> "$readme_file"
        echo "" >> "$readme_file"

        for metadata_type in $(echo "${!DESTRUCTIVE_METADATA[@]}" | tr ' ' '\n' | sort); do
            local members="${DESTRUCTIVE_METADATA[$metadata_type]}"
            echo "- **${metadata_type}**: $(echo "$members" | tr ',' ', ')" >> "$readme_file"
        done
        echo "" >> "$readme_file"
    fi

    # Deployment instructions
    cat >> "$readme_file" <<EOF
## Deployment Instructions

### Validate Deployment

\`\`\`bash
sf project deploy validate \\
  --manifest ${MANIFEST_DIR}/rl-${RELEASE_VERSION}-package.xml \\
  --target-org TARGET_ORG \\
  --test-level RunLocalTests
\`\`\`

### Quick Deploy (after validation)

\`\`\`bash
sf project deploy quick \\
  --job-id VALIDATION_JOB_ID \\
  --target-org TARGET_ORG
\`\`\`

### Full Deployment

\`\`\`bash
sf project deploy start \\
  --manifest ${MANIFEST_DIR}/rl-${RELEASE_VERSION}-package.xml \\
  --target-org TARGET_ORG \\
  --test-level RunLocalTests
\`\`\`

### With Destructive Changes

\`\`\`bash
sf project deploy start \\
  --manifest ${MANIFEST_DIR}/rl-${RELEASE_VERSION}-package.xml \\
  --post-destructive-changes ${MANIFEST_DIR}/rl-${RELEASE_VERSION}-destructiveChanges.xml \\
  --target-org TARGET_ORG \\
  --test-level RunLocalTests
\`\`\`

## Prerequisites

Before deploying, ensure the target org meets all prerequisites documented in the project README.

## Post-Deployment Steps

1. Verify all components deployed successfully
2. Run smoke tests on critical functionality
3. Monitor error logs for any issues
4. Update documentation if needed

EOF

    print_success "Generated: $readme_file"
}

# Generate manifest files
generate_manifests() {
    print_step "Generating manifest files..."

    # Ensure directory exists
    mkdir -p "$MANIFEST_DIR"

    # Generate package.xml (additive)
    # Check if array has elements (safe for set -u)
    local has_additive=false
    for key in "${!ADDITIVE_METADATA[@]}"; do
        has_additive=true
        break
    done

    if [ "$has_additive" = true ]; then
        local package_file="${MANIFEST_DIR}/rl-${RELEASE_VERSION}-package.xml"
        generate_package_xml "$package_file" ADDITIVE_METADATA
    else
        print_warning "No additive components - skipping package.xml"
    fi

    # Generate destructiveChanges.xml
    # Check if array has elements (safe for set -u)
    local has_destructive=false
    for key in "${!DESTRUCTIVE_METADATA[@]}"; do
        has_destructive=true
        break
    done

    if [ "$has_destructive" = true ]; then
        local destructive_file="${MANIFEST_DIR}/rl-${RELEASE_VERSION}-destructiveChanges.xml"
        generate_package_xml "$destructive_file" DESTRUCTIVE_METADATA
    else
        print_success "No destructive components"
    fi

    # Generate README
    generate_readme
}

# Run Claude CLI to update CHANGELOG.md
# Falls back to manual instructions if claude is not available
run_claude_changelog_update() {
    local prompt="Document and update CHANGELOG.md for release ${RELEASE_VERSION}. Review git log for changes since ${PREVIOUS_TAG:-initial commit}."

    if command -v claude &> /dev/null; then
        print_step "Running Claude to update CHANGELOG..."
        claude -p "$prompt" --allowedTools Read,Write,Edit,Bash 2>&1
    else
        print_warning "Claude CLI not found - manual update required"
        echo -e "${CYAN}Run this command to update CHANGELOG with Claude:${NC}" >&2
        echo -e "${BOLD}claude '${prompt}'${NC}" >&2
        echo "" >&2
        read -p "Press Enter when CHANGELOG has been updated, or Ctrl+C to abort..." >&2
    fi
}

# Check if CHANGELOG.md has entry for this version
check_changelog() {
    local changelog="CHANGELOG.md"

    print_step "Checking CHANGELOG.md..."

    if [ ! -f "$changelog" ]; then
        print_warning "CHANGELOG.md not found"
        return 1
    fi

    if grep -q "## \[${RELEASE_VERSION}\]" "$changelog"; then
        print_success "CHANGELOG.md contains entry for ${RELEASE_VERSION}"
        return 0
    else
        print_warning "CHANGELOG.md missing entry for ${RELEASE_VERSION}"
        return 1
    fi
}

# Display and compare CHANGELOG [Unreleased] section
display_and_compare_changelog() {
    print_header "CHANGELOG REVIEW"

    if [ ! -f "CHANGELOG.md" ]; then
        print_warning "CHANGELOG.md not found"
        return 1
    fi

    # Check if [Unreleased] has content
    if has_unreleased_content "CHANGELOG.md"; then
        echo -e "${CYAN}${BOLD}[Unreleased] Section Content:${NC}" >&2
        echo "" >&2
        display_unreleased_changes "CHANGELOG.md" >&2
        echo "" >&2

        # Compare with git changes
        if [ -n "${CHANGES_FILE:-}" ]; then
            compare_changelog_vs_git "CHANGELOG.md" "$CHANGES_FILE" || true
        fi

        echo "" >&2
        return 0
    else
        print_warning "[Unreleased] section is empty"
        return 1
    fi
}

# Prompt to move [Unreleased] to versioned release
prompt_move_unreleased_to_version() {
    print_step "Processing CHANGELOG..."

    # Check if version already exists in CHANGELOG
    if validate_version_entry "$RELEASE_VERSION" "CHANGELOG.md"; then
        print_success "CHANGELOG already contains [$RELEASE_VERSION]"
        return 0
    fi

    # Check if [Unreleased] has content
    if ! has_unreleased_content "CHANGELOG.md"; then
        print_warning "[Unreleased] section is empty"

        read -p "$(echo -e ${YELLOW}Would you like to update CHANGELOG.md now? \(y/n\)${NC} )" -n 1 -r
        echo

        if [[ $REPLY =~ ^[Yy]$ ]]; then
            run_claude_changelog_update

            if has_unreleased_content "CHANGELOG.md"; then
                print_success "CHANGELOG updated with content"
            else
                print_warning "CHANGELOG still empty"
                return 1
            fi
        else
            print_warning "CHANGELOG not updated - remember to do this manually"
            return 1
        fi
    fi

    # Offer to move [Unreleased] to version
    echo -e "${GREEN}Move [Unreleased] -> [${RELEASE_VERSION}]?${NC}" >&2
    options=("Yes - auto-generate version section" "No - I'll update manually" "Preview changes first")
    select opt in "${options[@]}"; do
        case $opt in
            "Yes - auto-generate version section")
                move_unreleased_to_version "$RELEASE_VERSION" "CHANGELOG.md"
                print_success "CHANGELOG updated: [Unreleased] -> [$RELEASE_VERSION]"
                return 0
                ;;
            "No - I'll update manually")
                print_warning "CHANGELOG not auto-updated"
                return 1
                ;;
            "Preview changes first")
                echo -e "${CYAN}Preview of changes:${NC}" >&2
                echo -e "${BOLD}Before:${NC} ## [Unreleased]" >&2
                echo -e "${BOLD}After:${NC}  ## [Unreleased] (empty)" >&2
                echo -e "        ## [${RELEASE_VERSION}] - $(date +%Y-%m-%d)" >&2
                echo "" >&2
                ;;
            *)
                print_warning "Invalid selection"
                ;;
        esac
    done
}

# Prompt user to update CHANGELOG (legacy fallback)
prompt_changelog_update() {
    if check_changelog; then
        return 0
    fi

    read -p "$(echo -e ${YELLOW}Would you like to update CHANGELOG.md now? \(y/n\)${NC} )" -n 1 -r
    echo

    if [[ $REPLY =~ ^[Yy]$ ]]; then
        run_claude_changelog_update

        if check_changelog; then
            print_success "CHANGELOG updated"
        else
            print_warning "CHANGELOG still missing version ${RELEASE_VERSION}"
        fi
    else
        print_warning "CHANGELOG not updated - remember to do this manually"
    fi
}

# Commit manifests and create tag
commit_and_tag() {
    print_step "Git workflow..."

    # Stage manifest files and CHANGELOG if modified
    git add -f "${MANIFEST_DIR}/rl-${RELEASE_VERSION}-"*
    if git diff --cached --quiet --exit-code CHANGELOG.md 2>/dev/null; then
        : # CHANGELOG not staged or no changes
    else
        git add CHANGELOG.md
    fi

    # Show what's staged
    echo -e "${CYAN}Staged files:${NC}" >&2
    local staged_files=$(git status --short | grep "^[AM]" || echo "")
    if [ -z "$staged_files" ]; then
        print_warning "No files to commit (manifests may already be committed)"
        return 0
    fi
    echo "$staged_files" >&2
    echo "" >&2

    # Prompt to commit
    read -p "Commit these changes? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        print_warning "Changes not committed"
        return 0
    fi

    # Commit
    git commit -m "release: Generate manifests for ${RELEASE_VERSION}"
    print_success "Changes committed"

    # Prompt to create tag
    local tag="v${RELEASE_VERSION}"
    read -p "Create git tag ${tag}? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        print_warning "Tag not created"
        return 0
    fi

    # Create tag
    git tag -a "$tag" -m "Release ${RELEASE_VERSION}"
    print_success "Tag ${tag} created"

    # Prompt to push
    read -p "Push tag to remote? (y/n) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        git push origin "$tag"
        print_success "Tag pushed to remote"
    fi
}

cleanup_on_exit() {
    # Always cleanup temp files and backups on exit
    rm -f "${CHANGES_FILE:-}" 2>/dev/null || true
    cleanup_changelog_backup 2>/dev/null || true
}

main() {
    print_header "RELEASE MANIFEST GENERATOR"

    # Setup cleanup trap
    trap cleanup_on_exit EXIT

    # Get and validate version
    get_release_version "$@"
    check_version_exists
    check_git_prerequisites
    find_previous_tag

    # Detect changes
    CHANGES_FILE=$(detect_changed_files)

    # Parse to metadata components
    parse_changes_to_metadata "$CHANGES_FILE"
    display_parsed_components

    # Display and compare CHANGELOG
    if [ -f "CHANGELOG.md" ]; then
        display_and_compare_changelog || true
    fi

    # Generate manifests
    generate_manifests

    # CHANGELOG workflow - try new workflow, fall back to legacy
    if [ -f "CHANGELOG.md" ]; then
        prompt_move_unreleased_to_version || prompt_changelog_update
    fi

    # Git workflow
    commit_and_tag

    # Summary
    print_header "RELEASE ${RELEASE_VERSION} COMPLETE"
    echo -e "${GREEN}Manifests generated:${NC}" >&2
    echo -e "  - ${MANIFEST_DIR}/rl-${RELEASE_VERSION}-package.xml" >&2

    # Check if array has elements for summary (safe for set -u)
    local has_destructive=false
    for key in "${!DESTRUCTIVE_METADATA[@]}"; do
        has_destructive=true
        break
    done

    if [ "$has_destructive" = true ]; then
        echo -e "  - ${MANIFEST_DIR}/rl-${RELEASE_VERSION}-destructiveChanges.xml" >&2
    fi
    echo -e "  - ${MANIFEST_DIR}/rl-${RELEASE_VERSION}-README.md" >&2
    echo "" >&2
    echo -e "${CYAN}Next steps:${NC}" >&2
    echo -e "  1. Review generated manifests" >&2
    echo -e "  2. Deploy using the deployment assistant script" >&2
    echo "" >&2
}

# Run main
main "$@"

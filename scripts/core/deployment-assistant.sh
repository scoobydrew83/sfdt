#!/bin/bash

# Enhanced Salesforce Deployment Assistant
# Includes pre-deployment validation, CHANGELOG checks, git workflow, and coverage enforcement

set -euo pipefail  # Exit on error, undefined vars, pipe failures

# Color codes for better readability
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# Project configuration
PROJECT_NAME="${SFDT_PROJECT_NAME:-Salesforce Project}"
MANIFEST_BASE_DIR="${SFDT_MANIFEST_DIR:-manifest/release}"
COVERAGE_THRESHOLD="${SFDT_COVERAGE_THRESHOLD:-75}"

# Global variables
MANIFEST_PATH=""
RELEASE_VERSION=""
TARGET_ORG=""
TEST_LEVEL=""
SPECIFIED_TESTS=""
IS_PRODUCTION=false
TAG_TIMING=""  # "now", "after", or "skip"
VALIDATION_JOB_ID=""
DESTRUCTIVE_PATH=""
DESTRUCTIVE_TIMING="post"  # "pre" or "post" - when to execute destructive changes

# --- Error Handling ---

error_handler() {
    local exit_code=$1
    local line_number=$2
    echo -e "\n${RED}❌ Error occurred in deployment script at line ${line_number} (exit code: ${exit_code})${NC}"
    echo -e "${YELLOW}Deployment aborted. Please review the error above.${NC}"
    exit $exit_code
}

trap 'error_handler $? $LINENO' ERR

# --- Helper Functions ---

print_header() {
    echo -e "\n${BOLD}${BLUE}═══════════════════════════════════════════════════${NC}"
    echo -e "${BOLD}${BLUE}  $1${NC}"
    echo -e "${BOLD}${BLUE}═══════════════════════════════════════════════════${NC}\n"
}

print_step() {
    echo -e "${CYAN}▶ $1${NC}"
}

print_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

print_error() {
    echo -e "${RED}❌ $1${NC}"
}

# Extract version from manifest filename (e.g., rl-0.1.6-package.xml -> 0.1.6)
extract_version() {
    local manifest=$1
    # Extract version using regex: rl-X.Y.Z-package.xml or rl-X.Y.Z-suffix-package.xml
    if [[ $manifest =~ rl-([0-9]+\.[0-9]+\.[0-9]+)(-[a-zA-Z0-9-]+)?-package\.xml ]]; then
        echo "${BASH_REMATCH[1]}"
    else
        echo ""
    fi
}

# Check if version exists in CHANGELOG.md
check_changelog() {
    local version=$1
    local changelog="CHANGELOG.md"

    if [ ! -f "$changelog" ]; then
        print_warning "CHANGELOG.md not found!"
        return 1
    fi

    # Look for version in format: ## [0.1.6] or ## [X.Y.Z]
    if grep -q "## \[$version\]" "$changelog"; then
        return 0
    else
        return 1
    fi
}

# Check git status for uncommitted changes
check_git_status() {
    if ! git diff-index --quiet HEAD --; then
        return 1  # Has uncommitted changes
    fi
    return 0  # Clean
}

# Get current git branch
get_current_branch() {
    git branch --show-current
}

# Detect if target org is production (sandbox = false)
detect_production() {
    local org=$1

    # Check if jq is installed
    if ! command -v jq &> /dev/null; then
        print_warning "jq not installed - cannot detect production org. Assuming production for safety."
        return 0
    fi

    local is_sandbox=$(sf org display --target-org "$org" --json 2>/dev/null | jq -r '.result.isSandbox // true')

    if [ "$is_sandbox" == "false" ]; then
        return 0  # Is production
    else
        return 1  # Is sandbox
    fi
}

# Parse code coverage from SF CLI output
parse_coverage() {
    local output=$1

    # Try multiple patterns used by SF CLI
    # Pattern 1: "Code Coverage: XX%" or "Apex Code Coverage: XX%"
    if [[ $output =~ [Cc]ode\ [Cc]overage:?\ ([0-9]+)% ]]; then
        echo "${BASH_REMATCH[1]}"
        return
    fi

    # Pattern 2: "Test Run Coverage XX%" (from deploy report)
    if [[ $output =~ [Tt]est\ [Rr]un\ [Cc]overage\ ([0-9]+)% ]]; then
        echo "${BASH_REMATCH[1]}"
        return
    fi

    # Pattern 3: Just "Coverage: XX%"
    if [[ $output =~ [Cc]overage:\ ([0-9]+)% ]]; then
        echo "${BASH_REMATCH[1]}"
        return
    fi

    # Pattern 4: "XX%" on a line with "coverage" (case insensitive)
    if [[ $output =~ coverage.*([0-9]+)% ]] || [[ $output =~ ([0-9]+)%.*coverage ]]; then
        echo "${BASH_REMATCH[1]}"
        return
    fi

    echo "0"
}

# Extract job ID from validation output
extract_job_id() {
    local output=$1

    # Salesforce Job IDs start with 0Af and are 15 or 18 characters
    # Format: 0Af[alphanumeric]{12,15}
    if [[ $output =~ (0Af[a-zA-Z0-9]{12,15}) ]]; then
        echo "${BASH_REMATCH[1]}"
    else
        echo ""
    fi
}

# --- Pre-Deployment Functions ---

select_manifest() {
    local include_deployed=${1:-false}
    print_step "Finding release manifests in ${MANIFEST_BASE_DIR}/..."

    # Find manifests in main release folder
    local manifests=( $(find "${MANIFEST_BASE_DIR}/" -maxdepth 1 -name "rl-*-package.xml" 2>/dev/null | sort -V) )

    # Also include deployed manifests when called from post-deployment flow (last 3 only)
    if [ "$include_deployed" == "true" ] && [ ${#manifests[@]} -eq 0 ]; then
        print_warning "No undeployed manifests found. Showing recent deployed manifests..."
        manifests=( $(find "${MANIFEST_BASE_DIR}/deployed/" -maxdepth 1 -name "rl-*-package.xml" 2>/dev/null | sort -V | tail -3) )
    fi

    if [ ${#manifests[@]} -eq 0 ]; then
        print_error "No release manifests found in ${MANIFEST_BASE_DIR}/"
        print_warning "Already deployed manifests are in ${MANIFEST_BASE_DIR}/deployed/"
        exit 1
    fi

    echo -e "${GREEN}Available manifests:${NC}"
    COLUMNS=1
    PS3="$(echo -e ${GREEN}Choice:${NC} )"
    select manifest_path in "${manifests[@]}"; do
        if [[ -n "$manifest_path" ]]; then
            MANIFEST_PATH="$manifest_path"
            RELEASE_VERSION=$(extract_version "$(basename "$manifest_path")")

            if [ -z "$RELEASE_VERSION" ]; then
                print_error "Could not extract version from manifest filename: $manifest_path"
                exit 1
            fi

            print_success "Selected: $manifest_path (Version: $RELEASE_VERSION)"
            check_destructive_changes
            break
        else
            print_warning "Invalid selection. Please try again."
        fi
    done
}

# Check for destructive changes file
check_destructive_changes() {
    local manifest_base=$(basename "$MANIFEST_PATH" "-package.xml")
    local destructive_path="${MANIFEST_BASE_DIR}/${manifest_base}-destructiveChanges.xml"

    DESTRUCTIVE_PATH=""

    if [ -f "$destructive_path" ]; then
        print_warning "Destructive changes detected for this release"
        echo ""
        echo -e "${RED}${BOLD}Components to be deleted:${NC}"

        # Parse and display components
        grep "<members>" "$destructive_path" | sed 's/.*<members>\(.*\)<\/members>/\1/' | while read -r member; do
            echo -e "  ${RED}✗${NC} $member"
        done

        echo ""
        read -p "$(echo -e ${YELLOW}Include destructive changes in deployment? \(y/n\)${NC} )" -n 1 -r
        echo

        if [[ $REPLY =~ ^[Yy]$ ]]; then
            DESTRUCTIVE_PATH="$destructive_path"

            # Ask about timing - CRITICAL decision
            echo ""
            echo -e "${CYAN}${BOLD}When should deletions occur?${NC}"
            echo ""
            echo -e "${GREEN}Pre-Destructive${NC} (Delete FIRST, then deploy new):"
            echo -e "  ${CYAN}Use when:${NC} Old components conflict with new ones"
            echo -e "  ${CYAN}Examples:${NC} Changing field types, renaming objects/fields"
            echo ""
            echo -e "${GREEN}Post-Destructive${NC} (Deploy FIRST, then delete old):"
            echo -e "  ${CYAN}Use when:${NC} Replacing old components with new ones"
            echo -e "  ${CYAN}Examples:${NC} Refactoring classes, replacing triggers"
            echo ""
            echo -e "${YELLOW}Note:${NC} Post-destructive is safer for most refactoring scenarios"
            echo ""

            local timing_options=("Post-Destructive (Deploy first, safer)" "Pre-Destructive (Delete first)")
            COLUMNS=1
            PS3="$(echo -e ${GREEN}Choice:${NC} )"
            select timing_choice in "${timing_options[@]}"; do
                case $timing_choice in
                    "Post-Destructive (Deploy first, safer)")
                        DESTRUCTIVE_TIMING="post"
                        print_success "Using POST-destructive (deploy new components first)"
                        break
                        ;;
                    "Pre-Destructive (Delete first)")
                        DESTRUCTIVE_TIMING="pre"
                        print_warning "Using PRE-destructive (delete old components first)"
                        break
                        ;;
                    *)
                        print_warning "Invalid selection. Please try again."
                        ;;
                esac
            done

            print_success "Destructive changes will be included (${DESTRUCTIVE_TIMING}-destructive)"
        else
            print_warning "Destructive changes will NOT be deployed"
        fi
    fi
}

check_changelog_updated() {
    print_step "Checking if CHANGELOG.md has been updated for version $RELEASE_VERSION..."

    if check_changelog "$RELEASE_VERSION"; then
        print_success "CHANGELOG.md contains entry for version $RELEASE_VERSION"
        return 0
    else
        print_warning "CHANGELOG.md does not contain entry for version $RELEASE_VERSION"

        read -p "$(echo -e ${YELLOW}Would you like to update CHANGELOG.md now? \(y/n\)${NC} )" -n 1 -r
        echo

        if [[ $REPLY =~ ^[Yy]$ ]]; then
            echo -e "${CYAN}Run this command to update CHANGELOG with Claude:${NC}"
            echo -e "${BOLD}claude 'Document and update CHANGELOG.md for release ${RELEASE_VERSION}'${NC}"
            echo ""
            read -p "Press Enter when CHANGELOG has been updated, or Ctrl+C to abort..."

            # Re-check after user confirms
            if check_changelog "$RELEASE_VERSION"; then
                print_success "CHANGELOG.md now contains version $RELEASE_VERSION"
            else
                print_error "Version $RELEASE_VERSION still not found in CHANGELOG.md"
                read -p "Continue anyway? (y/n) " -n 1 -r
                echo
                if [[ ! $REPLY =~ ^[Yy]$ ]]; then
                    exit 1
                fi
            fi
        fi
    fi
}

check_git_commit() {
    print_step "Checking git status..."

    if check_git_status; then
        print_success "No uncommitted changes"
        return 0
    else
        print_warning "You have uncommitted changes"
        git status --short
        echo ""

        read -p "$(echo -e ${YELLOW}Would you like to commit now? \(y/n\)${NC} )" -n 1 -r
        echo

        if [[ $REPLY =~ ^[Yy]$ ]]; then
            read -p "Enter commit message: " commit_message

            if [ -z "$commit_message" ]; then
                print_error "Commit message cannot be empty"
                exit 1
            fi

            git add -A
            git commit -m "$commit_message"
            print_success "Changes committed"
        else
            read -p "Continue with uncommitted changes? (y/n) " -n 1 -r
            echo
            if [[ ! $REPLY =~ ^[Yy]$ ]]; then
                exit 1
            fi
        fi
    fi
}

handle_release_tagging() {
    print_step "Release tagging for v${RELEASE_VERSION}..."

    # Check if tag already exists
    if git tag | grep -q "^v${RELEASE_VERSION}$"; then
        print_warning "Tag v${RELEASE_VERSION} already exists"
        TAG_TIMING="skip"
        return 0
    fi

    echo -e "${GREEN}When should the release be tagged?${NC}"
    options=("Tag now (before deployment)" "Tag after successful deployment" "Skip tagging")
    COLUMNS=1
    PS3="$(echo -e ${GREEN}Choice:${NC} )"
    select opt in "${options[@]}"; do
        case $opt in
            "Tag now (before deployment)")
                TAG_TIMING="now"
                create_git_tag
                break
                ;;
            "Tag after successful deployment")
                TAG_TIMING="after"
                print_success "Will tag after deployment completes"
                break
                ;;
            "Skip tagging")
                TAG_TIMING="skip"
                print_warning "Skipping release tagging"
                break
                ;;
            *)
                print_warning "Invalid selection. Please try again."
                ;;
        esac
    done
}

create_git_tag() {
    local tag_name="v${RELEASE_VERSION}"
    local force=${1:-false}

    read -p "Enter tag message (or press Enter for default): " tag_message

    if [ -z "$tag_message" ]; then
        tag_message="Release ${RELEASE_VERSION}"
    fi

    if [ "$force" == "true" ]; then
        git tag -d "$tag_name" 2>/dev/null
        git push origin --delete "$tag_name" 2>/dev/null || true
        print_warning "Removed old tag: $tag_name"
    fi

    git tag -a "$tag_name" -m "$tag_message"
    print_success "Created tag: $tag_name"

    read -p "Push tag to remote? (y/n) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        git push origin "$tag_name"
        print_success "Tag pushed to remote"
    fi
}

check_pr_status() {
    print_step "Checking branch and PR status..."

    local current_branch=$(get_current_branch)
    print_success "Current branch: $current_branch"

    if [ "$current_branch" == "main" ] || [ "$current_branch" == "master" ]; then
        print_success "Already on main branch"
        return 0
    fi

    echo -e "${YELLOW}You are not on the main branch.${NC}"
    echo -e "${GREEN}What would you like to do?${NC}"

    options=("PR already merged - continue" "Will merge PR later" "Skip (deploy from branch)")
    COLUMNS=1
    PS3="$(echo -e ${GREEN}Choice:${NC} )"
    select opt in "${options[@]}"; do
        case $opt in
            "PR already merged - continue")
                print_success "Proceeding with deployment"
                break
                ;;
            "Will merge PR later")
                print_warning "Remember to merge PR after deployment"
                break
                ;;
            "Skip (deploy from branch)")
                print_warning "Deploying from branch: $current_branch"
                break
                ;;
            *)
                print_warning "Invalid selection. Please try again."
                ;;
        esac
    done
}

# Helper to select base branch and create or suggest PR
create_new_pr() {
    local current_branch=$1
    local selected_base=""

    # Fetch latest remote branches
    git fetch --prune --quiet 2>/dev/null || true

    # Build branch list: main first, then release/*, develop/*, others — exclude current branch
    local remote_branches=()
    while IFS= read -r branch; do
        # Strip "origin/" prefix
        branch="${branch#origin/}"
        # Skip HEAD pointer and current branch
        [[ "$branch" == "HEAD" ]] && continue
        [[ "$branch" == *"HEAD"* ]] && continue
        [[ "$branch" == "$current_branch" ]] && continue
        remote_branches+=("$branch")
    done < <(git branch -r --format='%(refname:short)' 2>/dev/null | sort)

    if [ ${#remote_branches[@]} -eq 0 ]; then
        print_warning "No remote branches found"
        read -p "$(echo -e ${GREEN}Enter base branch manually:${NC} )" selected_base
        if [ -z "$selected_base" ]; then
            return 0
        fi
    else
        # Sort: main/master first, then release/*, then rest
        local sorted_branches=()
        for b in "${remote_branches[@]}"; do
            [[ "$b" == "main" || "$b" == "master" ]] && sorted_branches+=("$b")
        done
        for b in "${remote_branches[@]}"; do
            [[ "$b" == release/* ]] && sorted_branches+=("$b")
        done
        for b in "${remote_branches[@]}"; do
            [[ "$b" != "main" && "$b" != "master" && "$b" != release/* ]] && sorted_branches+=("$b")
        done

        echo -e "${CYAN}Select target branch for PR:${NC}"
        sorted_branches+=("Cancel")
        COLUMNS=1
        PS3="$(echo -e ${GREEN}Choice:${NC} )"
        select branch_opt in "${sorted_branches[@]}"; do
            if [ "$branch_opt" == "Cancel" ]; then
                return 0
            elif [ -n "$branch_opt" ]; then
                selected_base="$branch_opt"
                break
            else
                print_warning "Invalid selection. Please try again."
            fi
        done
    fi

    echo ""
    echo -e "${CYAN}How would you like to create the PR?${NC}"
    options=("Create PR now (gh cli)" "Create PR with Claude (AI-generated summary)" "Show gh command to run manually" "Cancel")
    COLUMNS=1
    PS3="$(echo -e ${GREEN}Choice:${NC} )"
    select opt in "${options[@]}"; do
        case $opt in
            "Create PR now (gh cli)")
                local pr_title="release: ${RELEASE_VERSION} — merge ${current_branch} → ${selected_base}"
                read -p "$(echo -e ${GREEN}PR title [${pr_title}]:${NC} )" custom_title
                if [ -n "$custom_title" ]; then
                    pr_title="$custom_title"
                fi
                gh pr create --base "$selected_base" --head "$current_branch" \
                    --title "$pr_title" \
                    --body "$(cat <<EOF
## Summary
- Release ${RELEASE_VERSION} post-deployment merge
- Merging \`${current_branch}\` → \`${selected_base}\`
EOF
)"
                print_success "PR created"
                break
                ;;
            "Create PR with Claude (AI-generated summary)")
                echo ""
                print_step "Invoking Claude Code to create PR..."
                claude -p "$(cat <<PROMPT
Create a PR merging '${current_branch}' into '${selected_base}' for release ${RELEASE_VERSION}.

Steps:
1. Run: git log v${RELEASE_VERSION}~..HEAD --oneline  (to get changes since last release)
2. Push the branch if needed: git push origin ${current_branch}
3. Create the PR using gh pr create with a HEREDOC for the body to preserve newlines. Example format:

gh pr create --base "${selected_base}" --head "${current_branch}" --title "release: ${RELEASE_VERSION} — merge ${current_branch} → ${selected_base}" --body "\$(cat <<'EOF'
## Summary
- Release ${RELEASE_VERSION}
- Merging \`${current_branch}\` → \`${selected_base}\`

### Changes
(categorized list of changes from git log)

## Test plan
- [ ] Verify all Apex tests pass
- [ ] Validate key features
EOF
)"

IMPORTANT: You MUST use a HEREDOC (cat <<'EOF' ... EOF) to pass the --body content to gh pr create. Do NOT pass the body as a single-line string — that causes encoding issues.
PROMPT
)" \
                    --allowedTools "Bash(git*),Bash(gh*)"
                break
                ;;
            "Show gh command to run manually")
                echo ""
                echo -e "${CYAN}${BOLD}Run this command:${NC}"
                echo ""
                echo -e "${GREEN}gh pr create --base \"${selected_base}\" --head \"${current_branch}\" --title \"release: ${RELEASE_VERSION} — merge ${current_branch} → ${selected_base}\" --body \"Release ${RELEASE_VERSION} post-deployment merge\"${NC}"
                echo ""
                break
                ;;
            "Cancel")
                break
                ;;
            *)
                print_warning "Invalid selection. Please try again."
                ;;
        esac
    done
}

# Offer to create a PR for post-deployment flow
offer_pr_creation() {
    local current_branch=$1

    print_warning "You are on branch '$current_branch'"

    # Check if an open PR already exists for this branch
    local existing_pr=""
    if command -v gh &> /dev/null; then
        existing_pr=$(gh pr view "$current_branch" --json url,state 2>/dev/null || echo "")
    fi

    if [ -n "$existing_pr" ]; then
        local pr_url=$(echo "$existing_pr" | jq -r '.url' 2>/dev/null)
        local pr_state=$(echo "$existing_pr" | jq -r '.state' 2>/dev/null)
        print_success "Existing PR found: $pr_url (${pr_state})"

        if [ "$pr_state" == "OPEN" ]; then
            echo -e "${GREEN}What would you like to do?${NC}"
            options=("Merge existing PR now" "Will merge PR later" "Create new PR to different branch" "Skip")
            COLUMNS=1
            PS3="$(echo -e ${GREEN}Choice:${NC} )"
            select opt in "${options[@]}"; do
                case $opt in
                    "Merge existing PR now")
                        gh pr merge "$current_branch" --merge
                        print_success "PR merged"
                        break
                        ;;
                    "Will merge PR later")
                        print_warning "Remember to merge PR: $pr_url"
                        break
                        ;;
                    "Create new PR to different branch")
                        create_new_pr "$current_branch"
                        break
                        ;;
                    "Skip")
                        break
                        ;;
                    *)
                        print_warning "Invalid selection. Please try again."
                        ;;
                esac
            done
        else
            # PR is MERGED or CLOSED — offer to create a new one
            echo -e "${GREEN}What would you like to do?${NC}"
            options=("Create new PR to another branch" "Will handle PR later" "Skip")
            COLUMNS=1
            PS3="$(echo -e ${GREEN}Choice:${NC} )"
            select opt in "${options[@]}"; do
                case $opt in
                    "Create new PR to another branch")
                        create_new_pr "$current_branch"
                        break
                        ;;
                    "Will handle PR later")
                        print_warning "Remember to create PR for branch '$current_branch'"
                        break
                        ;;
                    "Skip")
                        break
                        ;;
                    *)
                        print_warning "Invalid selection. Please try again."
                        ;;
                esac
            done
        fi
    else
        echo -e "${GREEN}What would you like to do?${NC}"
        options=("Create PR now" "Will create PR later" "Skip")
        COLUMNS=1
        PS3="$(echo -e ${GREEN}Choice:${NC} )"
        select opt in "${options[@]}"; do
            case $opt in
                "Create PR now")
                    create_new_pr "$current_branch"
                    break
                    ;;
                "Will create PR later")
                    print_warning "Remember to create and merge PR for branch '$current_branch'"
                    break
                    ;;
                "Skip")
                    break
                    ;;
                *)
                    print_warning "Invalid selection. Please try again."
                    ;;
            esac
        done
    fi
}

# --- Deployment Functions ---

select_target_org() {
    print_step "Retrieving authorized orgs..."

    # Check if jq is installed
    if ! command -v jq &> /dev/null; then
        print_warning "jq not installed - falling back to manual entry"
        read -p "$(echo -e ${GREEN}Enter target org alias:${NC} )" TARGET_ORG
    else
        # Get list of authorized orgs
        local orgs_json=$(sf org list --json 2>/dev/null)

        if [ $? -ne 0 ]; then
            print_warning "Could not retrieve org list - falling back to manual entry"
            read -p "$(echo -e ${GREEN}Enter target org alias:${NC} )" TARGET_ORG
        else
            # Extract non-scratch orgs (more stable for deployments)
            local org_aliases=$(echo "$orgs_json" | jq -r '.result.nonScratchOrgs[]? | select(.alias != null) | .alias' 2>/dev/null | sort)

            # Add scratch orgs as well
            local scratch_aliases=$(echo "$orgs_json" | jq -r '.result.scratchOrgs[]? | select(.alias != null) | .alias' 2>/dev/null | sort)

            # Combine both lists
            local all_orgs=$(echo -e "${org_aliases}\n${scratch_aliases}" | grep -v "^$" | sort -u)

            if [ -z "$all_orgs" ]; then
                print_warning "No authorized orgs found"
                read -p "$(echo -e ${GREEN}Enter target org alias:${NC} )" TARGET_ORG
            else
                # Convert to array for select menu
                local org_array=()
                while IFS= read -r org; do
                    org_array+=("$org")
                done <<< "$all_orgs"

                # Add manual entry option
                org_array+=("Enter manually")

                echo -e "${GREEN}Select target org:${NC}"
                COLUMNS=1
                PS3="$(echo -e ${GREEN}Choice:${NC} )"
                select TARGET_ORG in "${org_array[@]}"
                do
                    if [ "$TARGET_ORG" == "Enter manually" ]; then
                        read -p "$(echo -e ${GREEN}Enter target org alias:${NC} )" TARGET_ORG
                        break
                    elif [ -n "$TARGET_ORG" ]; then
                        break
                    else
                        print_warning "Invalid selection"
                    fi
                done
            fi
        fi
    fi

    if [ -z "$TARGET_ORG" ]; then
        print_error "Target org cannot be empty"
        exit 1
    fi

    # Verify org exists and is authenticated
    if ! sf org display --target-org "$TARGET_ORG" &> /dev/null; then
        print_error "Cannot connect to org: $TARGET_ORG"
        print_warning "Please authenticate with: sf org login web --alias $TARGET_ORG"
        exit 1
    fi

    print_success "Connected to org: $TARGET_ORG"

    # Detect if production
    if detect_production "$TARGET_ORG"; then
        IS_PRODUCTION=true
        echo -e "${RED}${BOLD}⚠️  WARNING: This is a PRODUCTION org!${NC}"
    else
        IS_PRODUCTION=false
        print_success "This is a sandbox org"
    fi
}

# Extract ApexClass test classes from manifest
extract_test_classes_from_manifest() {
    local manifest=$1

    if [ ! -f "$manifest" ]; then
        echo ""
        return 1
    fi

    # Extract ApexClass members that likely are test classes
    # Pattern: ends with "Test", "_Test", "Tests", or contains "Test" in name
    # Note: In package.xml, <members> come BEFORE <name>ApexClass</name>
    # Strategy: Extract the <types> section containing <name>ApexClass</name>
    local test_classes=$(awk '
        BEGIN { in_apex_types=0 }
        /<types>/ { buffer=""; in_types=1 }
        in_types { buffer = buffer $0 "\n" }
        in_types && /<name>ApexClass<\/name>/ { in_apex_types=1 }
        /<\/types>/ {
            if (in_apex_types) {
                print buffer
                in_apex_types=0
            }
            in_types=0
        }
    ' "$manifest" 2>/dev/null | \
    grep "<members>" | \
    sed 's/.*<members>\(.*\)<\/members>/\1/' | \
    grep -iE "(Test$|_Test$|Tests$|Test[A-Z])" || echo "")

    if [ -z "$test_classes" ]; then
        return 1
    fi

    # Convert to space-separated list
    echo "$test_classes" | tr '\n' ' ' | sed 's/ $//'
}

select_test_level() {
    print_step "Selecting test level..."

    local options=("RunSpecifiedTests" "RunLocalTests" "RunAllTestsInOrg")

    # Add "Skip Tests" option only for sandboxes (omits --test-level flag)
    if [ "$IS_PRODUCTION" == false ]; then
        options+=("Skip Tests (No Apex deployments)")
    else
        print_warning "Production deployments require test execution"
        echo -e "${CYAN}For metadata-only deployments, use RunLocalTests${NC}"
    fi

    echo -e "${GREEN}Please select a test level:${NC}"
    COLUMNS=1  # Force vertical list display
    PS3="$(echo -e ${GREEN}Choice:${NC} )"
    select TEST_LEVEL in "${options[@]}"; do
        if [[ -n "$TEST_LEVEL" ]]; then
            print_success "Selected test level: $TEST_LEVEL"

            if [ "$TEST_LEVEL" == "RunSpecifiedTests" ]; then
                # Try to auto-detect test classes from manifest
                local auto_detected=$(extract_test_classes_from_manifest "$MANIFEST_PATH")

                if [ -n "$auto_detected" ]; then
                    echo ""
                    echo -e "${CYAN}Detected test classes in manifest:${NC}"
                    echo "$auto_detected" | tr ' ' '\n' | sed 's/^/  - /'
                    echo ""

                    echo -e "${GREEN}How would you like to specify test classes?${NC}"
                    local test_options=("Use detected classes" "Enter manually" "Combine both")
                    COLUMNS=1  # Force vertical list for submenu too
                    PS3="$(echo -e ${GREEN}Choice:${NC} )"
                    select test_choice in "${test_options[@]}"; do
                        case $test_choice in
                            "Use detected classes")
                                SPECIFIED_TESTS="$auto_detected"
                                print_success "Using $(echo $auto_detected | wc -w | tr -d ' ') detected test classes"
                                break
                                ;;
                            "Enter manually")
                                read -p "Enter test classes (space-separated): " SPECIFIED_TESTS
                                break
                                ;;
                            "Combine both")
                                read -p "Enter additional test classes (space-separated): " additional_tests
                                SPECIFIED_TESTS="$auto_detected $additional_tests"
                                print_success "Using detected + additional test classes"
                                break
                                ;;
                            *)
                                print_warning "Invalid selection"
                                ;;
                        esac
                    done
                else
                    print_warning "No ApexClass test classes detected in manifest"
                    echo -e "${CYAN}Note: Manifest must contain <name>ApexClass</name> section with test classes${NC}"
                    echo ""
                    read -p "Enter test classes (space-separated): " SPECIFIED_TESTS
                fi

                if [ -z "$SPECIFIED_TESTS" ]; then
                    print_error "Test classes cannot be empty for RunSpecifiedTests"
                    exit 1
                fi

                # Show final list
                echo -e "${BLUE}Test classes to run:${NC}"
                echo "$SPECIFIED_TESTS" | tr ' ' '\n' | sed 's/^/  - /'
            fi
            break
        else
            print_warning "Invalid selection. Please try again."
        fi
    done
}

run_validation() {
    print_header "RUNNING DEPLOYMENT VALIDATION"

    local cmd=(sf project deploy validate --manifest "$MANIFEST_PATH" --target-org "$TARGET_ORG")

    # Only add --test-level if not skipping tests
    if [ "$TEST_LEVEL" != "Skip Tests (No Apex deployments)" ]; then
        cmd+=(--test-level "$TEST_LEVEL")

        if [ "$TEST_LEVEL" == "RunSpecifiedTests" ] && [ -n "$SPECIFIED_TESTS" ]; then
            cmd+=(--tests "$SPECIFIED_TESTS")
        fi
    else
        print_warning "Skipping test execution (metadata-only deployment)"
    fi

    if [ -n "$DESTRUCTIVE_PATH" ]; then
        if [ "$DESTRUCTIVE_TIMING" == "pre" ]; then
            cmd+=(--pre-destructive-changes "$DESTRUCTIVE_PATH")
            print_warning "Validation includes PRE-destructive changes (delete first)"
        else
            cmd+=(--post-destructive-changes "$DESTRUCTIVE_PATH")
            print_warning "Validation includes POST-destructive changes (deploy first)"
        fi
    fi

    echo -e "${BLUE}Command:${NC} ${cmd[*]}"
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"

    # Run validation and capture output while streaming to terminal
    local validation_output
    validation_output=$("${cmd[@]}" 2>&1 | tee /dev/tty)
    local exit_code=${PIPESTATUS[0]}

    echo -e "\n${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"

    if [ $exit_code -ne 0 ]; then
        print_error "Validation failed"
        exit $exit_code
    fi

    print_success "Validation succeeded"

    # Extract job ID
    VALIDATION_JOB_ID=$(extract_job_id "$validation_output")

    if [ -n "$VALIDATION_JOB_ID" ]; then
        print_success "Validation Job ID: $VALIDATION_JOB_ID"
    else
        print_warning "Could not extract job ID from validation output"
    fi

    # Check code coverage using job ID (only if tests were run)
    if [ "$TEST_LEVEL" != "Skip Tests (No Apex deployments)" ]; then
        check_code_coverage "$VALIDATION_JOB_ID"
    else
        print_warning "Skipping code coverage check (no tests were run)"
    fi
}

check_code_coverage() {
    local job_id=$1

    print_step "Checking code coverage..."

    if [ -z "$job_id" ]; then
        print_warning "No job ID available - cannot check coverage"
        read -p "Continue anyway? (y/n) " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            exit 1
        fi
        return 0
    fi

    # Fetch detailed deployment report to get coverage
    print_step "Fetching deployment report for coverage details..."

    # Try JSON output first (most reliable)
    local coverage=0
    if command -v jq &> /dev/null; then
        local json_output
        json_output=$(sf project deploy report --job-id "$job_id" --target-org "$TARGET_ORG" --json 2>&1)

        # Calculate coverage from codeCoverage array
        # Sum: (totalLocations - notCoveredLocations) / totalLocations * 100
        coverage=$(echo "$json_output" | jq -r '
            .result.details.runTestResult.codeCoverage // [] |
            if length > 0 then
                (map(.numLocations) | add) as $total |
                (map(.numLocationsNotCovered) | add) as $notCovered |
                if $total > 0 then
                    (($total - $notCovered) * 100 / $total | floor)
                else 0 end
            else 0 end
        ' 2>/dev/null || echo "0")
    fi

    # Fallback to text parsing if JSON didn't work
    if [ "$coverage" -eq 0 ]; then
        local report_output
        report_output=$(sf project deploy report --job-id "$job_id" --target-org "$TARGET_ORG" 2>&1)
        coverage=$(parse_coverage "$report_output")
    fi

    if [ "$coverage" -eq 0 ]; then
        print_warning "Could not parse code coverage from deployment report"
        echo -e "${YELLOW}Validation succeeded, but coverage percentage not found.${NC}"
        echo -e "${YELLOW}For production, coverage must be >=${COVERAGE_THRESHOLD}%. Please verify manually:${NC}"
        echo -e "${CYAN}sf project deploy report --job-id $job_id --target-org $TARGET_ORG${NC}"
        echo ""
        read -p "Continue anyway? (y/n) " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            exit 1
        fi
        return 0
    fi

    echo -e "${CYAN}Code Coverage: ${BOLD}${coverage}%${NC}"

    if [ "$coverage" -lt "$COVERAGE_THRESHOLD" ]; then
        print_error "Code coverage ${coverage}% is below required ${COVERAGE_THRESHOLD}%"
        echo -e "${RED}${BOLD}Deployment will fail in production!${NC}"
        echo -e "${YELLOW}Please increase test coverage before deploying.${NC}"
        exit 1
    else
        print_success "Code coverage ${coverage}% meets requirement (>=${COVERAGE_THRESHOLD}%)"
    fi
}

run_quick_deploy() {
    if [ -z "$VALIDATION_JOB_ID" ]; then
        print_warning "No validation job ID available"
        read -p "Enter job ID manually for quick deploy: " manual_job_id

        if [ -z "$manual_job_id" ]; then
            print_warning "Skipping quick deploy"
            return 0
        fi

        VALIDATION_JOB_ID="$manual_job_id"
    fi

    print_header "RUNNING QUICK DEPLOY"

    echo -e "${RED}${BOLD}⚠️  You are about to deploy to: ${TARGET_ORG}${NC}"

    if [ "$IS_PRODUCTION" == true ]; then
        echo -e "${RED}${BOLD}⚠️  THIS IS A PRODUCTION ORG!${NC}"
    fi

    read -p "$(echo -e ${YELLOW}Are you sure? \(y/n\)${NC} )" -n 1 -r
    echo

    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        print_warning "Quick deploy cancelled"
        return 0
    fi

    local cmd=(sf project deploy quick --job-id "$VALIDATION_JOB_ID" --target-org "$TARGET_ORG")

    echo -e "${BLUE}Command:${NC} ${cmd[*]}"
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"

    "${cmd[@]}"
    local exit_code=$?

    echo -e "\n${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"

    if [ $exit_code -eq 0 ]; then
        print_success "Deployment succeeded!"
        return 0
    else
        print_error "Deployment failed"
        exit $exit_code
    fi
}

run_full_deployment() {
    print_header "RUNNING FULL DEPLOYMENT"

    echo -e "${RED}${BOLD}⚠️  You are about to deploy to: ${TARGET_ORG}${NC}"

    if [ "$IS_PRODUCTION" == true ]; then
        echo -e "${RED}${BOLD}⚠️  THIS IS A PRODUCTION ORG!${NC}"
    fi

    read -p "$(echo -e ${YELLOW}Are you sure? \(y/n\)${NC} )" -n 1 -r
    echo

    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        print_warning "Deployment cancelled"
        exit 1
    fi

    local cmd=(sf project deploy start --manifest "$MANIFEST_PATH" --target-org "$TARGET_ORG")

    # Only add --test-level if not skipping tests
    if [ "$TEST_LEVEL" != "Skip Tests (No Apex deployments)" ]; then
        cmd+=(--test-level "$TEST_LEVEL")

        if [ "$TEST_LEVEL" == "RunSpecifiedTests" ] && [ -n "$SPECIFIED_TESTS" ]; then
            cmd+=(--tests "$SPECIFIED_TESTS")
        fi
    else
        print_warning "Skipping test execution (metadata-only deployment)"
    fi

    if [ -n "$DESTRUCTIVE_PATH" ]; then
        if [ "$DESTRUCTIVE_TIMING" == "pre" ]; then
            cmd+=(--pre-destructive-changes "$DESTRUCTIVE_PATH")
            print_warning "Deployment includes PRE-destructive changes (delete first)"
        else
            cmd+=(--post-destructive-changes "$DESTRUCTIVE_PATH")
            print_warning "Deployment includes POST-destructive changes (deploy first)"
        fi
    fi

    echo -e "${BLUE}Command:${NC} ${cmd[*]}"
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"

    "${cmd[@]}"
    local exit_code=$?

    echo -e "\n${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"

    if [ $exit_code -eq 0 ]; then
        print_success "Deployment succeeded!"
        return 0
    else
        print_error "Deployment failed"
        exit $exit_code
    fi
}

# --- Post-Deployment Functions ---

# Archive deployed manifest files
archive_deployed_manifest() {
    # Skip if manifest path not set (e.g., quick deploy only workflow)
    if [ -z "$MANIFEST_PATH" ]; then
        print_warning "Skipping manifest archiving (manifest path not set)"
        return 0
    fi

    print_step "Archiving deployed manifest files..."

    # Create deployed directory if it doesn't exist
    local deployed_dir="${MANIFEST_BASE_DIR}/deployed"
    mkdir -p "$deployed_dir"

    # Get base name of manifest (e.g., rl-0.1.2)
    local manifest_base=$(basename "$MANIFEST_PATH" "-package.xml")

    # Find all files for this release
    local files_to_move=(
        "${MANIFEST_BASE_DIR}/${manifest_base}-package.xml"
        "${MANIFEST_BASE_DIR}/${manifest_base}-README.md"
        "${MANIFEST_BASE_DIR}/${manifest_base}-destructiveChanges.xml"
    )

    local moved_count=0
    for file in "${files_to_move[@]}"; do
        if [ -f "$file" ]; then
            mv "$file" "$deployed_dir/"
            moved_count=$((moved_count + 1))
            print_success "Moved: $(basename "$file")"
        fi
    done

    if [ $moved_count -gt 0 ]; then
        print_success "Archived $moved_count file(s) to $deployed_dir/"

        # Commit the move
        git add "$deployed_dir" "${MANIFEST_BASE_DIR}/"
        git commit -m "chore: Archive deployed release ${RELEASE_VERSION} manifests

Moved to $deployed_dir/ after successful deployment to ${TARGET_ORG}"
        print_success "Committed manifest archiving"
    else
        print_warning "No files to archive"
    fi
}

post_deployment_tasks() {
    print_header "POST-DEPLOYMENT TASKS"

    # Archive manifest files
    archive_deployed_manifest

    # Tag after deploy if requested (skip if release version not set)
    if [ "$TAG_TIMING" == "after" ] && [ -n "$RELEASE_VERSION" ]; then
        print_step "Creating release tag..."
        create_git_tag
    elif [ "$TAG_TIMING" == "after" ] && [ -z "$RELEASE_VERSION" ]; then
        print_warning "Skipping git tagging (release version not set)"
    fi

    # Remind about PR if not on main
    local current_branch=$(get_current_branch)
    if [ "$current_branch" != "main" ] && [ "$current_branch" != "master" ]; then
        print_warning "Remember: You are still on branch '$current_branch'"
        print_warning "Don't forget to merge your PR if not already done"
    fi

    # Summary
    echo ""
    print_success "═══════════════════════════════════════════════════"
    if [ -n "$RELEASE_VERSION" ]; then
        print_success "  DEPLOYMENT COMPLETE - Release ${RELEASE_VERSION}"
    else
        print_success "  DEPLOYMENT COMPLETE"
    fi
    print_success "  Target Org: ${TARGET_ORG}"
    if [ -n "$MANIFEST_PATH" ]; then
        print_success "  Manifest archived to: ${MANIFEST_BASE_DIR}/deployed/"
    fi
    print_success "═══════════════════════════════════════════════════"
    echo ""
}

# --- Main Workflow ---

main_validate_and_deploy() {
    print_header "SALESFORCE DEPLOYMENT ASSISTANT"
    echo -e "${CYAN}Release Validation & Deployment Workflow${NC}\n"

    # Pre-deployment checks
    select_manifest
    check_changelog_updated
    check_git_commit
    handle_release_tagging
    check_pr_status

    # Deployment configuration
    select_target_org
    select_test_level

    # Run validation
    run_validation

    # Quick deploy requires a job ID and tests to have been run during validation.
    # When unavailable (no job ID, or metadata-only like Flows), offer full deploy instead.
    echo ""
    local can_quick_deploy=true
    if [ -z "$VALIDATION_JOB_ID" ]; then
        can_quick_deploy=false
        print_warning "Quick deploy is not available (no validation job ID)"
    elif [ "$TEST_LEVEL" == "Skip Tests (No Apex deployments)" ]; then
        can_quick_deploy=false
        print_warning "Quick deploy is not available (validation ran without tests)"
    fi

    if [ "$can_quick_deploy" == true ]; then
        read -p "$(echo -e ${GREEN}Validation successful. Run quick deploy now? \(y/n\)${NC} )" -n 1 -r
        echo

        if [[ $REPLY =~ ^[Yy]$ ]]; then
            run_quick_deploy
            post_deployment_tasks
        else
            print_warning "Quick deploy skipped"
            echo -e "${CYAN}You can run quick deploy later with:${NC}"
            echo -e "${BOLD}sf project deploy quick --job-id $VALIDATION_JOB_ID --target-org $TARGET_ORG${NC}"
        fi
    else
        read -p "$(echo -e ${GREEN}Validation successful. Run full deployment now? \(y/n\)${NC} )" -n 1 -r
        echo

        if [[ $REPLY =~ ^[Yy]$ ]]; then
            run_full_deployment
            post_deployment_tasks
        else
            print_warning "Deployment skipped"
        fi
    fi
}

main_full_deploy() {
    print_header "SALESFORCE DEPLOYMENT ASSISTANT"
    echo -e "${CYAN}Full Deployment Workflow (No Validation)${NC}\n"

    # Pre-deployment checks
    select_manifest
    check_changelog_updated
    check_git_commit
    handle_release_tagging
    check_pr_status

    # Deployment configuration
    select_target_org
    select_test_level

    # Run deployment
    run_full_deployment
    post_deployment_tasks
}

main_quick_deploy_only() {
    print_header "QUICK DEPLOY FROM VALIDATION"

    read -p "Enter validation job ID: " VALIDATION_JOB_ID

    if [ -z "$VALIDATION_JOB_ID" ]; then
        print_error "Validation job ID is required"
        exit 1
    fi

    # Reuse the select_target_org function for consistency
    select_target_org

    # Detect production (already done in select_target_org, but keeping for clarity)
    if detect_production "$TARGET_ORG"; then
        IS_PRODUCTION=true
    fi

    run_quick_deploy
    post_deployment_tasks
}

main_post_deployment_only() {
    print_header "POST-DEPLOYMENT TASKS"
    echo -e "${CYAN}For deployments already completed outside this script${NC}\n"

    # Select manifest - include deployed manifests since deployment already happened
    select_manifest true

    # Check if already tagged
    local current_branch=$(get_current_branch)
    local existing_tag=$(git tag -l "v${RELEASE_VERSION}" 2>/dev/null)

    if [ -n "$existing_tag" ]; then
        print_warning "Tag 'v${RELEASE_VERSION}' already exists"
        echo ""
        options=("Skip - tag is correct" "Retag - delete old and create new" "Skip all tagging")
        COLUMNS=1
        PS3="$(echo -e ${GREEN}Choice:${NC} )"
        select opt in "${options[@]}"; do
            case $opt in
                "Skip - tag is correct")
                    print_success "Keeping existing tag v${RELEASE_VERSION}"
                    break
                    ;;
                "Retag - delete old and create new")
                    create_git_tag true
                    break
                    ;;
                "Skip all tagging")
                    print_success "Skipping tag creation"
                    break
                    ;;
                *)
                    print_warning "Invalid selection. Please try again."
                    ;;
            esac
        done
    else
        echo ""
        read -p "$(echo -e ${GREEN}Create git tag 'v${RELEASE_VERSION}'? \(y/n\)${NC} )" -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            create_git_tag
        else
            print_success "Skipping tag creation"
        fi
    fi

    # Archive manifest files (skip if already in deployed/)
    echo ""
    if [[ "$MANIFEST_PATH" != *"/deployed/"* ]]; then
        archive_deployed_manifest
    else
        print_success "Manifest already archived in deployed/"
    fi

    # Offer to create PR if not on main
    if [ "$current_branch" != "main" ] && [ "$current_branch" != "master" ]; then
        echo ""
        offer_pr_creation "$current_branch"
    fi

    # Summary
    echo ""
    print_success "═══════════════════════════════════════════════════"
    print_success "  POST-DEPLOYMENT TASKS COMPLETE"
    print_success "  Release: ${RELEASE_VERSION}"
    if [ -n "$MANIFEST_PATH" ]; then
        print_success "  Manifest: $(basename "$MANIFEST_PATH")"
    fi
    print_success "═══════════════════════════════════════════════════"
    echo ""
}

# --- Main Menu ---

echo -e "${GREEN}${BOLD}"
echo "╔═══════════════════════════════════════════════════════════╗"
echo "║                                                           ║"
echo "║         SALESFORCE DEPLOYMENT ASSISTANT                   ║"
echo "║         ${PROJECT_NAME}$(printf '%*s' $((34 - ${#PROJECT_NAME})) '')║"
echo "║                                                           ║"
echo "╚═══════════════════════════════════════════════════════════╝"
echo -e "${NC}"

COLUMNS=1
PS3="$(echo -e ${GREEN}Select deployment action:${NC} )"
options=(
    "Validate & Quick Deploy (Recommended)"
    "Full Deployment (No Validation)"
    "Quick Deploy Only (Manual Job ID)"
    "Post-Deployment Tasks Only (Already Deployed)"
    "Exit"
)

select opt in "${options[@]}"
do
    case $opt in
        "Validate & Quick Deploy (Recommended)")
            main_validate_and_deploy
            break
            ;;
        "Full Deployment (No Validation)")
            main_full_deploy
            break
            ;;
        "Quick Deploy Only (Manual Job ID)")
            main_quick_deploy_only
            break
            ;;
        "Post-Deployment Tasks Only (Already Deployed)")
            main_post_deployment_only
            break
            ;;
        "Exit")
            echo -e "${YELLOW}Exiting deployment assistant${NC}"
            exit 0
            ;;
        *)
            print_error "Invalid option $REPLY"
            ;;
    esac
done

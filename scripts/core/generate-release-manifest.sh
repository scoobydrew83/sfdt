set -euo pipefail
if [ "${BASH_VERSINFO:-0}" -lt 4 ]; then
    echo "Error: This script requires bash 4.0 or higher (current: $BASH_VERSION)"
    echo "On macOS, install via Homebrew: brew install bash"
    echo "Then run with: /opt/homebrew/bin/bash $0 $@"
    exit 1
fi
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/metadata-parser.sh"
source "${SCRIPT_DIR}/../lib/git-utils.sh"
source "${SCRIPT_DIR}/../lib/changelog-utils.sh"
SOURCE_PATH="${SFDT_SOURCE_PATH:-force-app}"
MANIFEST_DIR="${SFDT_MANIFEST_DIR:-manifest/release}"
declare -a SOURCE_PATHS
if [ "${SFDT_PACKAGE_TARGET:-all}" != "all" ] && [ -n "${SFDT_PACKAGE_DIRS:-}" ] && command -v jq &>/dev/null; then
    matched=$(echo "${SFDT_PACKAGE_DIRS}" | jq -r --arg t "${SFDT_PACKAGE_TARGET}" '.[] | select(endswith("/" + $t) or . == $t)' | head -1)
    if [ -z "$matched" ]; then
        echo "Error: Package '${SFDT_PACKAGE_TARGET}' not found in SFDT_PACKAGE_DIRS" >&2
        exit 1
    fi
    SOURCE_PATHS=("$matched")
elif [ -n "${SFDT_PACKAGE_DIRS:-}" ] && command -v jq &>/dev/null; then
    readarray -t SOURCE_PATHS < <(echo "${SFDT_PACKAGE_DIRS}" | jq -r '.[]')
else
    SOURCE_PATHS=("${SOURCE_PATH}")
fi
MANIFEST_LAYOUT="${SFDT_MANIFEST_LAYOUT:-flat}"
CHANGELOG_FILE="${SFDT_CHANGELOG_FILE:-CHANGELOG.md}"
PKG_SUBDIR=""
PKG_SUFFIX=""
if [ "$MANIFEST_LAYOUT" = "subpath" ]; then
    PKG_SUBDIR="${SFDT_PACKAGE_TARGET:-all}"
    MANIFEST_OUTPUT_DIR="${MANIFEST_DIR}/${PKG_SUBDIR}"
else
    if [ "${SFDT_PACKAGE_TARGET:-all}" != "all" ] && [ -n "${SFDT_PACKAGE_TARGET:-}" ]; then
        PKG_SUFFIX="-${SFDT_PACKAGE_TARGET}"
    fi
    MANIFEST_OUTPUT_DIR="${MANIFEST_DIR}"
fi
RELEASE_VERSION=""
PREVIOUS_TAG=""
declare -A ADDITIVE_METADATA
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
detect_next_version() {
    local latest_version=""
    if [ -d "$MANIFEST_DIR" ]; then
        latest_version=$(ls "$MANIFEST_DIR"/rl-*-package.xml 2>/dev/null \
            | sed -E 's|.*/rl-([0-9]+\.[0-9]+\.[0-9]+)-package\.xml|\1|' \
            | sort -t. -k1,1n -k2,2n -k3,3n \
            | tail -1)
    fi
    if [ -z "$latest_version" ]; then
        local latest_tag=$(get_latest_release_tag)
        if [ -n "$latest_tag" ]; then
            latest_version="${latest_tag
        fi
    fi
    if [ -z "$latest_version" ]; then
        echo ""
        return
    fi
    local major minor patch
    IFS='.' read -r major minor patch <<< "$latest_version"
    echo "${major}.${minor}.$((patch + 1))"
}
get_release_version() {
    if [ -n "${SFDT_RELEASE_NAME:-}" ]; then
        RELEASE_VERSION="${SFDT_RELEASE_NAME}"
    elif [ $
        RELEASE_VERSION="$1"
    else
        local suggested_version=$(detect_next_version)
        if [ -n "$suggested_version" ]; then
            read -p "$(echo -e ${GREEN}Release version [${suggested_version}]:${NC} )" RELEASE_VERSION
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
    if ! [[ "$RELEASE_VERSION" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]*$ ]]; then
        print_error "Invalid release label. Must start with alphanumeric and contain only letters, digits, dots, dashes, underscores."
        exit 1
    fi
    print_success "Release version: $RELEASE_VERSION"
}
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
    local deployed_manifest="${MANIFEST_DIR}/deployed/rl-${RELEASE_VERSION}-package.xml"
    if [ -f "$deployed_manifest" ]; then
        print_error "Version $RELEASE_VERSION already deployed!"
        print_warning "Deployed manifest found at: $deployed_manifest"
        exit 1
    fi
    print_success "Version $RELEASE_VERSION is available"
}
check_git_prerequisites() {
    print_step "Checking git prerequisites..."
    if ! git rev-parse --git-dir > /dev/null 2>&1; then
        print_error "Not a git repository"
        exit 1
    fi
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
find_previous_tag() {
    print_step "Finding previous release tag..."
    PREVIOUS_TAG=$(get_latest_release_tag)
    local current_branch=$(get_current_branch)
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
detect_changed_files() {
    print_step "Detecting changed files..."
    local temp_file=$(mktemp)
    if [ -z "$PREVIOUS_TAG" ]; then
        for src_path in "${SOURCE_PATHS[@]}"; do
            local scan_dir
            if [[ "$src_path" == */main/default ]]; then
                scan_dir="$src_path"
            else
                scan_dir="${src_path}/main/default"
            fi
            if [ -d "$scan_dir" ]; then
                find "$scan_dir" -type f \( -name "*.cls" -o -name "*.trigger" -o -name "*-meta.xml" \) \
                    | sed 's|^\./||' | awk '{print "A\t" $0}' >> "$temp_file"
            fi
        done
    else
        for src_path in "${SOURCE_PATHS[@]}"; do
            get_changed_files "$PREVIOUS_TAG" "HEAD" "${src_path}/" >> "$temp_file"
        done
    fi
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
parse_changes_to_metadata() {
    local changes_file=$1
    print_step "Parsing changes to metadata components..."
    local unknown_files=""
    local unknown_count=0
    local processed_count=0
    local total_count=$(wc -l < "$changes_file" | tr -d ' ')
    while IFS=$'\t' read -r status file_path; do
        processed_count=$((processed_count + 1))
        if (( processed_count % 50 == 0 )); then
            echo -ne "\r${GREEN}▶${NC} Processed $processed_count/$total_count files..."
        fi
        if [[ ! "$file_path" =~ ${SOURCE_PATH}/ ]] && [[ ! "$file_path" =~ force-app/ ]]; then
            continue
        fi
        local metadata_type=$(get_metadata_type "$file_path")
        if [ "$metadata_type" == "SKIP" ]; then
            continue
        fi
        if [ "$metadata_type" == "UNKNOWN" ]; then
            unknown_files="${unknown_files}\n  - $file_path"
            unknown_count=$((unknown_count + 1))
            continue
        fi
        local member_name=$(get_member_name "$file_path" "$metadata_type")
        if [ "$status" == "D" ]; then
            if [ -z "${DESTRUCTIVE_METADATA[$metadata_type]:-}" ]; then
                DESTRUCTIVE_METADATA[$metadata_type]="$member_name"
            else
                DESTRUCTIVE_METADATA[$metadata_type]="${DESTRUCTIVE_METADATA[$metadata_type]},${member_name}"
            fi
        else
            if [ -z "${ADDITIVE_METADATA[$metadata_type]:-}" ]; then
                ADDITIVE_METADATA[$metadata_type]="$member_name"
            else
                ADDITIVE_METADATA[$metadata_type]="${ADDITIVE_METADATA[$metadata_type]},${member_name}"
            fi
        fi
    done < "$changes_file"
    echo -ne "\r\033[K"
    print_success "Processed $processed_count files"
    if [ $unknown_count -gt 0 ]; then
        print_warning "$unknown_count unknown file types detected:${unknown_files}"
        read -p "Continue? (y/n) " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            exit 1
        fi
    fi
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
display_parsed_components() {
    print_header "PARSED COMPONENTS"
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
            echo -e "  ${CYAN}${metadata_type}:${NC} ${
            for member in "${member_array[@]}"; do
                echo -e "    - $member" >&2
            done
        done
        echo "" >&2
    fi
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
            echo -e "  ${CYAN}${metadata_type}:${NC} ${
            for member in "${member_array[@]}"; do
                echo -e "    - $member" >&2
            done
        done
        echo "" >&2
    fi
}
generate_package_xml() {
    local output_file=$1
    local -n metadata_map=$2
    local api_version="63.0"
    if [ -f "sfdx-project.json" ] && command -v jq &> /dev/null; then
        api_version=$(jq -r '.sourceApiVersion // "63.0"' sfdx-project.json)
    elif [ -f "${SFDT_CONFIG_DIR:-tools/config}/deployment-config.yml" ]; then
        api_version=$(grep "apiVersion:" "${SFDT_CONFIG_DIR:-tools/config}/deployment-config.yml" | awk '{print $2}' | tr -d '"')
    fi
    cat > "$output_file" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<Package xmlns="http://soap.sforce.com/2006/04/metadata">
EOF
    for metadata_type in $(echo "${!metadata_map[@]}" | tr ' ' '\n' | sort); do
        echo "    <types>" >> "$output_file"
        local members="${metadata_map[$metadata_type]}"
        for member in $(echo "$members" | tr ',' '\n' | sort); do
            echo "        <members>$member</members>" >> "$output_file"
        done
        echo "        <name>$metadata_type</name>" >> "$output_file"
        echo "    </types>" >> "$output_file"
    done
    cat >> "$output_file" <<EOF
    <version>$api_version</version>
</Package>
EOF
    print_success "Generated: $output_file"
}
generate_readme() {
    local readme_file="${MANIFEST_OUTPUT_DIR}/rl-${RELEASE_VERSION}-README.md"
    print_step "Generating README..."
    local additive_count=0
    for metadata_type in "${!ADDITIVE_METADATA[@]}"; do
        local members="${ADDITIVE_METADATA[$metadata_type]}"
        local member_array=(${members//,/ })
        additive_count=$((additive_count + ${
    done
    local destructive_count=0
    for metadata_type in "${!DESTRUCTIVE_METADATA[@]}"; do
        local members="${DESTRUCTIVE_METADATA[$metadata_type]}"
        local member_array=(${members//,/ })
        destructive_count=$((destructive_count + ${
    done
    local total_count=$((additive_count + destructive_count))
    local api_version="63.0"
    if [ -f "sfdx-project.json" ] && command -v jq &> /dev/null; then
        api_version=$(jq -r '.sourceApiVersion // "63.0"' sfdx-project.json)
    elif [ -f "${SFDT_CONFIG_DIR:-tools/config}/deployment-config.yml" ]; then
        api_version=$(grep "apiVersion:" "${SFDT_CONFIG_DIR:-tools/config}/deployment-config.yml" | awk '{print $2}' | tr -d '"')
    fi
    cat > "$readme_file" <<EOF
**Generated:** $(date +%Y-%m-%d)
**Baseline:** ${PREVIOUS_TAG}
**Target API Version:** ${api_version}
EOF
    local has_additive=false
    for key in "${!ADDITIVE_METADATA[@]}"; do
        has_additive=true
        break
    done
    if [ "$has_additive" = true ]; then
        echo "
        echo "" >> "$readme_file"
        for metadata_type in $(echo "${!ADDITIVE_METADATA[@]}" | tr ' ' '\n' | sort); do
            local members="${ADDITIVE_METADATA[$metadata_type]}"
            echo "- **${metadata_type}**: $(echo "$members" | tr ',' ', ')" >> "$readme_file"
        done
        echo "" >> "$readme_file"
    fi
    local has_destructive=false
    for key in "${!DESTRUCTIVE_METADATA[@]}"; do
        has_destructive=true
        break
    done
    if [ "$has_destructive" = true ]; then
        echo "
        echo "" >> "$readme_file"
        for metadata_type in $(echo "${!DESTRUCTIVE_METADATA[@]}" | tr ' ' '\n' | sort); do
            local members="${DESTRUCTIVE_METADATA[$metadata_type]}"
            echo "- **${metadata_type}**: $(echo "$members" | tr ',' ', ')" >> "$readme_file"
        done
        echo "" >> "$readme_file"
    fi
    cat >> "$readme_file" <<EOF
\`\`\`bash
sf project deploy validate \\
  --manifest ${MANIFEST_DIR}/rl-${RELEASE_VERSION}-package.xml \\
  --target-org TARGET_ORG \\
  --test-level RunLocalTests
\`\`\`
\`\`\`bash
sf project deploy quick \\
  --job-id VALIDATION_JOB_ID \\
  --target-org TARGET_ORG
\`\`\`
\`\`\`bash
sf project deploy start \\
  --manifest ${MANIFEST_DIR}/rl-${RELEASE_VERSION}-package.xml \\
  --target-org TARGET_ORG \\
  --test-level RunLocalTests
\`\`\`
\`\`\`bash
sf project deploy start \\
  --manifest ${MANIFEST_DIR}/rl-${RELEASE_VERSION}-package.xml \\
  --post-destructive-changes ${MANIFEST_DIR}/rl-${RELEASE_VERSION}-destructiveChanges.xml \\
  --target-org TARGET_ORG \\
  --test-level RunLocalTests
\`\`\`
Before deploying, ensure the target org meets all prerequisites documented in the project README.
1. Verify all components deployed successfully
2. Run smoke tests on critical functionality
3. Monitor error logs for any issues
4. Update documentation if needed
EOF
    print_success "Generated: $readme_file"
}
generate_manifests() {
    print_step "Generating manifest files..."
    mkdir -p "${MANIFEST_OUTPUT_DIR}"
    local has_additive=false
    for key in "${!ADDITIVE_METADATA[@]}"; do
        has_additive=true
        break
    done
    if [ "$has_additive" = true ]; then
        local package_file="${MANIFEST_OUTPUT_DIR}/rl-${RELEASE_VERSION}${PKG_SUFFIX}-package.xml"
        generate_package_xml "$package_file" ADDITIVE_METADATA
    else
        print_warning "No additive components - skipping package.xml"
    fi
    local has_destructive=false
    for key in "${!DESTRUCTIVE_METADATA[@]}"; do
        has_destructive=true
        break
    done
    if [ "$has_destructive" = true ]; then
        local destructive_file="${MANIFEST_OUTPUT_DIR}/rl-${RELEASE_VERSION}${PKG_SUFFIX}-destructiveChanges.xml"
        generate_package_xml "$destructive_file" DESTRUCTIVE_METADATA
    else
        print_success "No destructive components"
    fi
    generate_readme
}
run_claude_changelog_update() {
    local prompt="Document and update ${CHANGELOG_FILE} for release ${RELEASE_VERSION}. Review git log for changes since ${PREVIOUS_TAG:-initial commit}."
    print_step "Running AI to update changelog..."
    sfdt ai prompt "$prompt"
}
check_changelog() {
    local changelog="$CHANGELOG_FILE"
    print_step "Checking ${changelog}..."
    if [ ! -f "$changelog" ]; then
        print_warning "${changelog} not found"
        return 1
    fi
    if grep -q "
        print_success "${changelog} contains entry for ${RELEASE_VERSION}"
        return 0
    else
        print_warning "${changelog} missing entry for ${RELEASE_VERSION}"
        return 1
    fi
}
display_and_compare_changelog() {
    print_header "CHANGELOG REVIEW"
    if [ ! -f "$CHANGELOG_FILE" ]; then
        print_warning "${CHANGELOG_FILE} not found"
        return 1
    fi
    if has_unreleased_content "$CHANGELOG_FILE"; then
        echo -e "${CYAN}${BOLD}[Unreleased] Section Content:${NC}" >&2
        echo "" >&2
        display_unreleased_changes "$CHANGELOG_FILE" >&2
        echo "" >&2
        if [ -n "${CHANGES_FILE:-}" ]; then
            compare_changelog_vs_git "$CHANGELOG_FILE" "$CHANGES_FILE" || true
        fi
        echo "" >&2
        return 0
    else
        print_warning "[Unreleased] section is empty"
        return 1
    fi
}
prompt_move_unreleased_to_version() {
    print_step "Processing CHANGELOG..."
    if validate_version_entry "$RELEASE_VERSION" "$CHANGELOG_FILE"; then
        print_success "${CHANGELOG_FILE} already contains [$RELEASE_VERSION]"
        return 0
    fi
    if ! has_unreleased_content "$CHANGELOG_FILE"; then
        print_warning "[Unreleased] section is empty"
        read -p "$(echo -e ${YELLOW}Would you like to update ${CHANGELOG_FILE} now? \(y/n\)${NC} )" -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            run_claude_changelog_update
            if has_unreleased_content "$CHANGELOG_FILE"; then
                print_success "Changelog updated with content"
            else
                print_warning "Changelog still empty"
                return 1
            fi
        else
            print_warning "Changelog not updated - remember to do this manually"
            return 1
        fi
    fi
    echo -e "${GREEN}Move [Unreleased] -> [${RELEASE_VERSION}]?${NC}" >&2
    options=("Yes - auto-generate version section" "No - I'll update manually" "Preview changes first")
    select opt in "${options[@]}"; do
        case $opt in
            "Yes - auto-generate version section")
                move_unreleased_to_version "$RELEASE_VERSION" "$CHANGELOG_FILE"
                print_success "${CHANGELOG_FILE} updated: [Unreleased] -> [$RELEASE_VERSION]"
                return 0
                ;;
            "No - I'll update manually")
                print_warning "CHANGELOG not auto-updated"
                return 1
                ;;
            "Preview changes first")
                echo -e "${CYAN}Preview of changes:${NC}" >&2
                echo -e "${BOLD}Before:${NC}
                echo -e "${BOLD}After:${NC}
                echo -e "
                echo "" >&2
                ;;
            *)
                print_warning "Invalid selection"
                ;;
        esac
    done
}
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
commit_and_tag() {
    print_step "Git workflow..."
    git add -f "${MANIFEST_OUTPUT_DIR}/rl-${RELEASE_VERSION}"*
    if ! git diff --quiet "$CHANGELOG_FILE" 2>/dev/null; then
        git add "$CHANGELOG_FILE"
    fi
    echo -e "${CYAN}Staged files:${NC}" >&2
    local staged_files=$(git status --short | grep "^[AM]" || echo "")
    if [ -z "$staged_files" ]; then
        print_warning "No files to commit (manifests may already be committed)"
        return 0
    fi
    echo "$staged_files" >&2
    echo "" >&2
    read -p "Commit these changes? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        print_warning "Changes not committed"
        return 0
    fi
    git commit -m "release: Generate manifests for ${RELEASE_VERSION}"
    print_success "Changes committed"
    local tag="v${RELEASE_VERSION}"
    read -p "Create git tag ${tag}? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        print_warning "Tag not created"
        return 0
    fi
    git tag -a "$tag" -m "Release ${RELEASE_VERSION}"
    print_success "Tag ${tag} created"
    read -p "Push tag to remote? (y/n) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        git push origin "$tag"
        print_success "Tag pushed to remote"
    fi
}
cleanup_on_exit() {
    rm -f "${CHANGES_FILE:-}" 2>/dev/null || true
    cleanup_changelog_backup 2>/dev/null || true
}
main() {
    print_header "RELEASE MANIFEST GENERATOR"
    trap cleanup_on_exit EXIT
    get_release_version "$@"
    check_version_exists
    check_git_prerequisites
    find_previous_tag
    CHANGES_FILE=$(detect_changed_files)
    parse_changes_to_metadata "$CHANGES_FILE"
    display_parsed_components
    if [ -f "$CHANGELOG_FILE" ]; then
        display_and_compare_changelog || true
    fi
    generate_manifests
    if [ -f "$CHANGELOG_FILE" ]; then
        prompt_move_unreleased_to_version || prompt_changelog_update
    fi
    print_header "RELEASE ${RELEASE_VERSION} MANIFESTS GENERATED"
    echo -e "${GREEN}Manifests generated:${NC}" >&2
    echo -e "  - ${MANIFEST_OUTPUT_DIR}/rl-${RELEASE_VERSION}${PKG_SUFFIX}-package.xml" >&2
    local has_destructive=false
    for key in "${!DESTRUCTIVE_METADATA[@]}"; do
        has_destructive=true
        break
    done
    if [ "$has_destructive" = true ]; then
        echo -e "  - ${MANIFEST_OUTPUT_DIR}/rl-${RELEASE_VERSION}${PKG_SUFFIX}-destructiveChanges.xml" >&2
    fi
    echo -e "  - ${MANIFEST_OUTPUT_DIR}/rl-${RELEASE_VERSION}-README.md" >&2
    echo "" >&2
    echo "$RELEASE_VERSION"
}
main "$@"

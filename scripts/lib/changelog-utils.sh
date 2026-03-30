#!/bin/bash

# CHANGELOG Utilities Library
# Helper functions for parsing and manipulating CHANGELOG.md

set -euo pipefail

# Extract the [Unreleased] section from CHANGELOG.md
# Args: $1 = path to CHANGELOG.md
# Output: Content of [Unreleased] section (without header)
extract_unreleased_section() {
    local changelog_file=${1:-CHANGELOG.md}

    if [ ! -f "$changelog_file" ]; then
        return 1
    fi

    # Extract everything between ## [Unreleased] and the next ## [version]
    awk '/^## \[Unreleased\]$/,/^## \[[0-9]/ {
        if (/^## \[Unreleased\]$/) next;
        if (/^## \[[0-9]/) exit;
        print
    }' "$changelog_file"
}

# Check if [Unreleased] section has content (not just empty/whitespace)
# Args: $1 = path to CHANGELOG.md
# Returns: 0 if has content, 1 if empty
has_unreleased_content() {
    local changelog_file=${1:-CHANGELOG.md}
    local content=$(extract_unreleased_section "$changelog_file")

    # Remove whitespace and check if anything remains
    if echo "$content" | grep -q '[^[:space:]]'; then
        return 0
    else
        return 1
    fi
}

# Parse CHANGELOG sections (Added, Changed, Fixed, Deprecated, Removed, Security)
# Args: $1 = section content, $2 = section name (Added, Changed, etc.)
# Output: Bullet points from that section
parse_changelog_section() {
    local content=$1
    local section_name=$2

    echo "$content" | awk -v section="$section_name" '
        /^### / {
            in_section = 0
            if ($0 ~ "^### " section "$") {
                in_section = 1
            }
            next
        }
        in_section && /^[[:space:]]*-/ {
            print
        }
    '
}

# Get all section names from CHANGELOG content
# Args: $1 = changelog content
# Output: Section names (Added, Changed, etc.)
get_changelog_sections() {
    local content=$1
    echo "$content" | grep "^### " | sed 's/^### //' | sort -u
}

# Display formatted unreleased changes
# Args: $1 = path to CHANGELOG.md
display_unreleased_changes() {
    local changelog_file=${1:-CHANGELOG.md}

    if ! has_unreleased_content "$changelog_file"; then
        return 1
    fi

    local content=$(extract_unreleased_section "$changelog_file")
    local sections=$(get_changelog_sections "$content")

    echo "$content"
}

# Move [Unreleased] section to versioned release
# Args: $1 = release version (e.g., 0.1.2), $2 = path to CHANGELOG.md
# Creates: Backup file and updates CHANGELOG.md
move_unreleased_to_version() {
    local version=$1
    local changelog_file=${2:-CHANGELOG.md}
    local release_date=$(date +%Y-%m-%d)

    if [ ! -f "$changelog_file" ]; then
        echo "Error: $changelog_file not found" >&2
        return 1
    fi

    # Create backup
    cp "$changelog_file" "${changelog_file}.backup"

    # Get unreleased content
    local unreleased_content=$(extract_unreleased_section "$changelog_file")

    if [ -z "$(echo "$unreleased_content" | grep '[^[:space:]]')" ]; then
        echo "Warning: [Unreleased] section is empty" >&2
        rm "${changelog_file}.backup"
        return 1
    fi

    # Create new CHANGELOG with version section
    # Process file to move [Unreleased] content to new version section
    awk -v version="$version" -v date="$release_date" '
        BEGIN {
            in_unreleased = 0
            printed_version = 0
        }

        # Hit [Unreleased] header - print empty section and new version header
        /^## \[Unreleased\]$/ {
            print "## [Unreleased]"
            print ""
            print "## [" version "] - " date
            in_unreleased = 1
            printed_version = 1
            next
        }

        # Hit next version section - stop capturing unreleased content
        in_unreleased && /^## \[[0-9]/ {
            in_unreleased = 0
        }

        # Print everything (unreleased content goes under new version, rest stays same)
        { print }
    ' "$changelog_file" > "${changelog_file}.tmp"

    # Validate the temp file is not empty and has content
    if [ ! -s "${changelog_file}.tmp" ]; then
        echo "Error: Generated CHANGELOG is empty! Restoring backup..." >&2
        mv "${changelog_file}.backup" "$changelog_file"
        rm -f "${changelog_file}.tmp"
        return 1
    fi

    # Validate temp file has expected structure
    if ! grep -q "^## \[Unreleased\]" "${changelog_file}.tmp"; then
        echo "Error: Generated CHANGELOG is malformed! Restoring backup..." >&2
        mv "${changelog_file}.backup" "$changelog_file"
        rm -f "${changelog_file}.tmp"
        return 1
    fi

    # Safe to replace original
    mv "${changelog_file}.tmp" "$changelog_file"
    echo "Updated CHANGELOG.md: [Unreleased] -> [$version]" >&2
}

# Extract metadata components mentioned in CHANGELOG
# Args: $1 = path to CHANGELOG.md
# Output: List of component types/names mentioned
extract_changelog_components() {
    local changelog_file=${1:-CHANGELOG.md}
    local content=$(extract_unreleased_section "$changelog_file")

    # Look for common Salesforce metadata patterns
    echo "$content" | grep -E "(Flow|Apex|Trigger|Custom Metadata|Platform Event|Field|Object|External Service)" || true
}

# Compare CHANGELOG documented changes vs git changed files
# Args: $1 = path to CHANGELOG.md, $2 = git changes file (from detect_changed_files)
# Output: Comparison report
compare_changelog_vs_git() {
    local changelog_file=${1:-CHANGELOG.md}
    local git_changes_file=$2

    if [ ! -f "$changelog_file" ]; then
        echo "CHANGELOG.md not found - skipping comparison" >&2
        return 1
    fi

    if [ ! -f "$git_changes_file" ]; then
        echo "Git changes file not found - skipping comparison" >&2
        return 1
    fi

    local has_content=0
    if has_unreleased_content "$changelog_file"; then
        has_content=1
    fi

    local git_change_count=$(grep -c "^[AMD]" "$git_changes_file" || echo "0")

    echo "CHANGELOG vs Git Comparison:" >&2
    echo "  - CHANGELOG [Unreleased]: $([ $has_content -eq 1 ] && echo "Has content" || echo "Empty")" >&2
    echo "  - Git changes: $git_change_count files" >&2

    if [ $has_content -eq 1 ] && [ "$git_change_count" -gt 0 ]; then
        echo "  - Status: Both have changes" >&2
        return 0
    elif [ $has_content -eq 0 ] && [ "$git_change_count" -gt 0 ]; then
        echo "  - Status: Git has changes but CHANGELOG [Unreleased] is empty" >&2
        return 1
    elif [ $has_content -eq 1 ] && [ "$git_change_count" -eq 0 ]; then
        echo "  - Status: CHANGELOG has content but no git changes" >&2
        return 1
    else
        echo "  - Status: Both empty" >&2
        return 1
    fi
}

# Validate CHANGELOG entry exists for a specific version
# Args: $1 = version (e.g., 0.1.2), $2 = path to CHANGELOG.md
# Returns: 0 if exists, 1 if not
validate_version_entry() {
    local version=$1
    local changelog_file=${2:-CHANGELOG.md}

    if [ ! -f "$changelog_file" ]; then
        return 1
    fi

    grep -q "^## \[${version}\]" "$changelog_file"
}

# Get the last released version from CHANGELOG
# Args: $1 = path to CHANGELOG.md
# Output: Version number (e.g., 0.1.6)
get_last_changelog_version() {
    local changelog_file=${1:-CHANGELOG.md}

    if [ ! -f "$changelog_file" ]; then
        return 1
    fi

    grep "^## \[[0-9]" "$changelog_file" | head -1 | sed -E 's/^## \[([0-9.]+)\].*/\1/'
}

# Restore CHANGELOG from backup
# Args: $1 = path to CHANGELOG.md
restore_changelog_backup() {
    local changelog_file=${1:-CHANGELOG.md}

    if [ -f "${changelog_file}.backup" ]; then
        mv "${changelog_file}.backup" "$changelog_file"
        echo "Restored CHANGELOG.md from backup" >&2
        return 0
    else
        echo "No backup file found" >&2
        return 1
    fi
}

# Remove CHANGELOG backup file
# Args: $1 = path to CHANGELOG.md
cleanup_changelog_backup() {
    local changelog_file=${1:-CHANGELOG.md}

    if [ -f "${changelog_file}.backup" ]; then
        rm "${changelog_file}.backup"
    fi
}

set -euo pipefail
extract_unreleased_section() {
    local changelog_file=${1:-CHANGELOG.md}
    if [ ! -f "$changelog_file" ]; then
        return 1
    fi
    awk '/^
        if (/^
        if (/^
        print
    }' "$changelog_file"
}
has_unreleased_content() {
    local changelog_file=${1:-CHANGELOG.md}
    local content=$(extract_unreleased_section "$changelog_file")
    if echo "$content" | grep -q '[^[:space:]]'; then
        return 0
    else
        return 1
    fi
}
parse_changelog_section() {
    local content=$1
    local section_name=$2
    echo "$content" | awk -v section="$section_name" '
        /^
            in_section = 0
            if ($0 ~ "^
                in_section = 1
            }
            next
        }
        in_section && /^[[:space:]]*-/ {
            print
        }
    '
}
get_changelog_sections() {
    local content=$1
    echo "$content" | grep "^
}
display_unreleased_changes() {
    local changelog_file=${1:-CHANGELOG.md}
    if ! has_unreleased_content "$changelog_file"; then
        return 1
    fi
    local content=$(extract_unreleased_section "$changelog_file")
    local sections=$(get_changelog_sections "$content")
    echo "$content"
}
move_unreleased_to_version() {
    local version=$1
    local changelog_file=${2:-CHANGELOG.md}
    local release_date=$(date +%Y-%m-%d)
    if [ ! -f "$changelog_file" ]; then
        echo "Error: $changelog_file not found" >&2
        return 1
    fi
    cp "$changelog_file" "${changelog_file}.backup"
    local unreleased_content=$(extract_unreleased_section "$changelog_file")
    if [ -z "$(echo "$unreleased_content" | grep '[^[:space:]]')" ]; then
        echo "Warning: [Unreleased] section is empty" >&2
        rm "${changelog_file}.backup"
        return 1
    fi
    awk -v version="$version" -v date="$release_date" '
        BEGIN {
            in_unreleased = 0
            printed_version = 0
        }
        /^
            print "
            print ""
            print "
            in_unreleased = 1
            printed_version = 1
            next
        }
        in_unreleased && /^
            in_unreleased = 0
        }
        { print }
    ' "$changelog_file" > "${changelog_file}.tmp"
    if [ ! -s "${changelog_file}.tmp" ]; then
        echo "Error: Generated CHANGELOG is empty! Restoring backup..." >&2
        mv "${changelog_file}.backup" "$changelog_file"
        rm -f "${changelog_file}.tmp"
        return 1
    fi
    if ! grep -q "^
        echo "Error: Generated CHANGELOG is malformed! Restoring backup..." >&2
        mv "${changelog_file}.backup" "$changelog_file"
        rm -f "${changelog_file}.tmp"
        return 1
    fi
    mv "${changelog_file}.tmp" "$changelog_file"
    echo "Updated CHANGELOG.md: [Unreleased] -> [$version]" >&2
}
extract_changelog_components() {
    local changelog_file=${1:-CHANGELOG.md}
    local content=$(extract_unreleased_section "$changelog_file")
    echo "$content" | grep -E "(Flow|Apex|Trigger|Custom Metadata|Platform Event|Field|Object|External Service)" || true
}
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
validate_version_entry() {
    local version=$1
    local changelog_file=${2:-CHANGELOG.md}
    if [ ! -f "$changelog_file" ]; then
        return 1
    fi
    local safe_version normalized_pattern
    safe_version=$(printf '%s\n' "$version" | sed 's/[][\\.^$*]/\\&/g')
    normalized_pattern=$(printf '%s\n' "$safe_version" | sed 's/\\-/[- ]/g')
    grep -qi "^
}
get_last_changelog_version() {
    local changelog_file=${1:-CHANGELOG.md}
    if [ ! -f "$changelog_file" ]; then
        return 1
    fi
    grep "^
}
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
cleanup_changelog_backup() {
    local changelog_file=${1:-CHANGELOG.md}
    if [ -f "${changelog_file}.backup" ]; then
        rm "${changelog_file}.backup"
    fi
}

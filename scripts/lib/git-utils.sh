#!/bin/bash

# Git Utilities Library
# Helper functions for git operations

set -euo pipefail

# Get the latest release tag (v*.*)
get_latest_release_tag() {
    git tag --list 'v*' --sort=-version:refname | head -1
}

# Check if a specific tag exists
tag_exists() {
    local tag=$1
    git tag --list | grep -q "^${tag}$"
}

# Get changed files between two refs
# Usage: get_changed_files <from_ref> <to_ref> <path>
# Output: Lines with format "STATUS\tFILENAME"
get_changed_files() {
    local from_ref=$1
    local to_ref=${2:-HEAD}
    local path=${3:-${SFDT_SOURCE_PATH:-force-app}/}

    git diff --name-status "$from_ref" "$to_ref" -- "$path"
}

# Check if git working directory is clean
is_git_clean() {
    git diff-index --quiet HEAD --
}

# Get the commit where current branch diverged from a base branch
# Usage: get_branch_divergence_point <base_branch>
# Default base_branch: main
get_branch_divergence_point() {
    local base_branch=${1:-main}
    git merge-base "$base_branch" HEAD
}

# Get current branch name
get_current_branch() {
    git rev-parse --abbrev-ref HEAD
}

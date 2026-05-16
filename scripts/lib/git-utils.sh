set -euo pipefail
get_latest_release_tag() {
    git tag --list 'v*' --sort=-version:refname | head -1
}
tag_exists() {
    local tag=$1
    git tag --list | grep -q "^${tag}$"
}
get_changed_files() {
    local from_ref=$1
    local to_ref=${2:-HEAD}
    local path=${3:-${SFDT_SOURCE_PATH:-force-app}/}
    git diff --name-status "$from_ref" "$to_ref" -- "$path"
}
is_git_clean() {
    git diff-index --quiet HEAD --
}
get_branch_divergence_point() {
    local base_branch=${1:-main}
    git merge-base "$base_branch" HEAD
}
get_current_branch() {
    git rev-parse --abbrev-ref HEAD
}

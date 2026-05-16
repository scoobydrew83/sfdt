export RED='\033[0;31m'
export GREEN='\033[0;32m'
export YELLOW='\033[1;33m'
export BLUE='\033[0;34m'
export PURPLE='\033[0;35m'
export CYAN='\033[0;36m'
export NC='\033[0m'
log_info() {
    echo -e "${BLUE}ℹ️  INFO${NC} - $1"
}
log_success() {
    echo -e "${GREEN}✅ SUCCESS${NC} - $1"
}
log_warning() {
    echo -e "${YELLOW}⚠️  WARN${NC} - $1"
}
log_error() {
    echo -e "${RED}❌ ERROR${NC} - $1"
}
log_debug() {
    if [ "${DEBUG}" = "true" ]; then
        echo -e "${PURPLE}🐛 DEBUG${NC} - $1"
    fi
}
require_command() {
    local cmd="$1"
    local install_hint="${2:-Install it and retry.}"
    if ! command -v "$cmd" &> /dev/null; then
        log_error "Required command '$cmd' is not installed. ${install_hint}"
        return 1
    fi
    return 0
}
require_jq() {
    require_command "jq" "sfdt shell scripts use jq to parse Salesforce CLI JSON output."
}
print_header() {
    echo -e "\n${BLUE}=== $1 ===${NC}"
}
print_step() {
    echo -e "${CYAN}>>> $1${NC}"
}
print_success() {
    echo -e "${GREEN}✓ $1${NC}"
}
print_warning() {
    echo -e "${YELLOW}! $1${NC}"
}
print_error() {
    echo -e "${RED}✗ $1${NC}"
}
print_info() {
    echo -e "${BLUE}  $1${NC}"
}
show_progress() {
    local duration=$1
    local message=$2
    echo -ne "${CYAN}${message}${NC}"
    for ((i=0; i<duration; i++)); do
        echo -ne "."
        sleep 1
    done
    echo ""
}
check_sf_cli() {
    if ! command -v sf &> /dev/null; then
        log_error "Salesforce CLI is not installed"
        return 1
    fi
    if ! sf org list --json > /dev/null 2>&1; then
        log_error "Not authenticated with Salesforce CLI"
        return 1
    fi
    return 0
}
get_default_org() {
    local config_file="$1"
    if [ -f "$config_file" ]; then
        jq -r '.environments.development.org_alias // "dev"' "$config_file" 2>/dev/null || echo "dev"
    else
        sf config get target-org --json 2>/dev/null | jq -r '.result[0].value // "dev"' || echo "dev"
    fi
}
load_project_config() {
    local config_dir="${SFDT_CONFIG_DIR:-}"
    if [ -z "$config_dir" ] || [ ! -d "$config_dir" ]; then
        config_dir="${SCRIPT_DIR}/../config"
    fi
    if [ ! -d "$config_dir" ]; then
        config_dir="./config"
    fi
    if [ ! -d "$config_dir" ]; then
        log_error "Configuration directory not found: $config_dir"
        return 1
    fi
    export PROJECT_CONFIG_DIR="$config_dir"
    export PROJECT_CONFIG_FILE="$config_dir/project.json"
    export ENVIRONMENT_CONFIG_FILE="$config_dir/environments.json"
    export PULL_CONFIG_FILE="$config_dir/pull-config.json"
    export TEST_CONFIG_FILE="$config_dir/test-config.json"
    log_debug "Configuration loaded from: $config_dir"
    return 0
}
validate_configs() {
    local required_configs=(
        "$PROJECT_CONFIG_FILE"
        "$ENVIRONMENT_CONFIG_FILE"
        "$PULL_CONFIG_FILE"
        "$TEST_CONFIG_FILE"
    )
    for config in "${required_configs[@]}"; do
        if [ ! -f "$config" ]; then
            log_error "Required configuration file missing: $config"
            return 1
        fi
    done
    log_debug "All configuration files validated"
    return 0
}
get_timestamp() {
    date '+%Y-%m-%d %H:%M:%S'
}
ensure_log_dir() {
    local log_dir="${SCRIPT_DIR}/../logs"
    if [ ! -d "$log_dir" ]; then
        log_dir="./logs"
    fi
    mkdir -p "$log_dir"
    export LOG_DIR="$log_dir"
    log_debug "Log directory: $LOG_DIR"
}
init_script_env() {
    export SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    if ! load_project_config; then
        exit 1
    fi
    if ! validate_configs; then
        exit 1
    fi
    ensure_log_dir
    if ! check_sf_cli; then
        exit 1
    fi
    log_debug "Script environment initialized successfully"
}
export -f log_info log_success log_warning log_error log_debug
export -f print_header print_step print_success print_warning print_error print_info
export -f show_progress check_sf_cli get_default_org
export -f load_project_config validate_configs get_timestamp ensure_log_dir init_script_env

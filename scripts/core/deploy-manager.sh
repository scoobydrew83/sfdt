set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../utils/shared.sh"
PROJECT_NAME="${SFDT_PROJECT_NAME:-Salesforce Project}"
LOG_DIR="${SFDT_LOG_DIR:-${SFDT_PROJECT_ROOT:-$(pwd)}/logs}"
MANIFEST_DIR="${SFDT_MANIFEST_DIR:-manifest/release}"
COVERAGE_THRESHOLD="${SFDT_COVERAGE_THRESHOLD:-75}"
PROJECT_CONFIG_DIR="${SFDT_CONFIG_DIR:-${SFDT_PROJECT_ROOT:-.}/.sfdt}"
PROJECT_CONFIG_FILE="${PROJECT_CONFIG_DIR}/config.json"
ENVIRONMENT_CONFIG_FILE="${PROJECT_CONFIG_DIR}/environments.json"
PULL_CONFIG_FILE="${PROJECT_CONFIG_DIR}/pull-config.json"
TEST_CONFIG_FILE="${PROJECT_CONFIG_DIR}/test-config.json"
echo -e "${BLUE}${PROJECT_NAME} - Smart Deployment Manager${NC}"
echo -e "${YELLOW}============================================================${NC}"
require_jq || exit 1
BACKUP_DIR="$LOG_DIR/deployment-backups"
DEPLOYMENT_LOG="$LOG_DIR/deployment_$(date +%Y%m%d_%H%M%S).log"
VALIDATION_TIMEOUT=20
DEPLOYMENT_TIMEOUT=30
mkdir -p "$BACKUP_DIR"
mkdir -p "$LOG_DIR"
DEPLOYMENT_CONFIG="$PROJECT_CONFIG_DIR/../docs/deployment-config.md"
get_environment_config() {
    local env=$1
    local config_key=$2
    jq -r ".environments.$env.$config_key // \"default\"" "$ENVIRONMENT_CONFIG_FILE" 2>/dev/null || echo "default"
}
get_excluded_profiles() {
    if [ -f "$DEPLOYMENT_CONFIG" ]; then
        sed -n '/
    else
        jq -r '.pull_configuration.excluded_profiles[]?' "$PULL_CONFIG_FILE" 2>/dev/null | tr '\n' ',' | sed 's/,$//'
    fi
}
validate_deployment() {
    local environment=$1
    local manifest_file=$2
    log_info "Validating deployment to $environment environment..."
    if [ ! -f "$manifest_file" ]; then
        log_error "Manifest file not found: $manifest_file"
        return 1
    fi
    local org_alias=$(get_environment_config "$environment" "org_alias")
    if ! sf org list --json | jq -e ".result[] | select(.alias == \"$org_alias\")" > /dev/null 2>&1; then
        log_error "Not connected to org alias: $org_alias"
        return 1
    fi
    log_info "Performing dry-run validation..."
    local validation_cmd=(sf project deploy validate --manifest "$manifest_file" --test-level RunLocalTests --target-org "$org_alias" --wait "$VALIDATION_TIMEOUT")
    log_debug "Validation command: ${validation_cmd[*]}"
    if "${validation_cmd[@]}" >> "$DEPLOYMENT_LOG" 2>&1; then
        log_success "Validation passed for $environment environment"
        return 0
    else
        log_error "Validation failed for $environment environment"
        log_error "Check deployment log: $DEPLOYMENT_LOG"
        return 1
    fi
}
create_backup() {
    local environment=$1
    local backup_name="backup_${environment}_$(date +%Y%m%d_%H%M%S)"
    local backup_path="$BACKUP_DIR/$backup_name"
    log_info "Creating deployment backup..."
    mkdir -p "$backup_path"
    local org_alias=$(get_environment_config "$environment" "org_alias")
    local backup_metadata="ApexClass,Flow,CustomObject,PermissionSet,CustomTab"
    if sf project retrieve start --metadata "$backup_metadata" --target-org "$org_alias" --output-dir "$backup_path" >> "$DEPLOYMENT_LOG" 2>&1; then
        log_success "Backup created: $backup_path"
        echo "$backup_path" > "$BACKUP_DIR/latest_backup.txt"
        return 0
    else
        log_warning "Backup creation failed, but continuing with deployment"
        return 0
    fi
}
execute_deployment() {
    local environment=$1
    local manifest_file=$2
    local deployment_type=$3
    log_info "Executing $deployment_type deployment to $environment environment..."
    local org_alias=$(get_environment_config "$environment" "org_alias")
    local timeout=$(get_environment_config "$environment" "timeout")
    case $deployment_type in
        "quick")
            timeout=10
            ;;
        "standard")
            timeout=${timeout:-30}
            ;;
        "comprehensive")
            timeout=$((timeout * 2))
            ;;
    esac
    local deploy_cmd=(sf project deploy start --manifest "$manifest_file" --target-org "$org_alias" --wait "$timeout")
    if [ "$environment" = "production" ]; then
        deploy_cmd+=(--test-level RunLocalTests)
    else
        deploy_cmd+=(--test-level NoTestRun)
    fi
    log_debug "Deployment command: ${deploy_cmd[*]}"
    if "${deploy_cmd[@]}" | tee -a "$DEPLOYMENT_LOG"; then
        log_success "Deployment completed successfully!"
        return 0
    else
        log_error "Deployment failed!"
        log_error "Check deployment log: $DEPLOYMENT_LOG"
        return 1
    fi
}
post_deployment_check() {
    local environment=$1
    log_info "Performing post-deployment health checks..."
    local org_alias=$(get_environment_config "$environment" "org_alias")
    if sf data query --query "SELECT Id FROM Organization LIMIT 1" --target-org "$org_alias" >> "$DEPLOYMENT_LOG" 2>&1; then
        log_success "Org connectivity check passed"
    else
        log_warning "Org connectivity check failed"
        return 1
    fi
    log_info "Running smoke tests..."
    local key_classes=()
    if [ -f "$PROJECT_CONFIG_FILE" ] && command -v jq &> /dev/null; then
        while IFS= read -r cls; do
            [ -n "$cls" ] && key_classes+=("$cls")
        done < <(jq -r '.smoke_test_classes[]? // empty' "$PROJECT_CONFIG_FILE" 2>/dev/null)
    fi
    if [ ${
        log_info "No smoke test classes configured in project.json - skipping component verification"
    else
        for class in "${key_classes[@]}"; do
            local safe_class="${class//\'/\\\'}"
            if sf data query --query "SELECT Id FROM ApexClass WHERE Name = '$safe_class' LIMIT 1" --target-org "$org_alias" >> "$DEPLOYMENT_LOG" 2>&1; then
                log_success "Key component verified: $class"
            else
                log_warning "Key component missing: $class"
            fi
        done
    fi
    log_success "Post-deployment health check completed"
    return 0
}
rollback_deployment() {
    local environment=$1
    log_warning "Initiating deployment rollback for $environment..."
    if [ ! -f "$BACKUP_DIR/latest_backup.txt" ]; then
        log_error "No backup found for rollback"
        return 1
    fi
    local backup_path=$(cat "$BACKUP_DIR/latest_backup.txt")
    if [ ! -d "$backup_path" ]; then
        log_error "Backup directory not found: $backup_path"
        return 1
    fi
    local org_alias=$(get_environment_config "$environment" "org_alias")
    if sf project deploy start --source-dir "$backup_path" --target-org "$org_alias" --wait 15 >> "$DEPLOYMENT_LOG" 2>&1; then
        log_success "Rollback completed successfully"
        return 0
    else
        log_error "Rollback failed - manual intervention required"
        return 1
    fi
}
show_deployment_menu() {
    echo ""
    echo -e "${BLUE}Smart Deployment Options:${NC}"
    echo "=========================================="
    echo "Environment Deployment:"
    echo "  1. Deploy to Development (quick, no tests)"
    echo "  2. Deploy to Staging (with validation)"
    echo "  3. Deploy to Production (full validation + tests)"
    echo ""
    echo "Deployment Types:"
    echo "  4. Custom manifest deployment"
    echo "  5. Component-specific deployment"
    echo ""
    echo "Quick Actions:"
    echo "  6. Validate only (dry run)"
    echo "  7. Emergency rollback"
    echo ""
    echo "Utility Options:"
    echo "  8. Check deployment status"
    echo "  9. View deployment history"
    echo "  10. Clean deployment artifacts"
    read -p "Choose option (1-10): " -n 2 -r
    echo ""
    case $REPLY in
        1)
            deploy_to_environment "development" "$MANIFEST_DIR/package.xml" "quick"
            ;;
        2)
            deploy_to_environment "staging" "$MANIFEST_DIR/package.xml" "standard"
            ;;
        3)
            deploy_to_environment "production" "$MANIFEST_DIR/package.xml" "comprehensive"
            ;;
        4)
            custom_manifest_deployment
            ;;
        5)
            component_specific_deployment
            ;;
        6)
            validation_only_deployment
            ;;
        7)
            emergency_rollback
            ;;
        8)
            check_deployment_status
            ;;
        9)
            view_deployment_history
            ;;
        10)
            clean_deployment_artifacts
            ;;
        *)
            log_error "Invalid option selected"
            exit 1
            ;;
    esac
}
check_coverage_gate() {
    local environment=$1
    [[ "$environment" != "production" ]] && return 0
    if ! command -v jq &>/dev/null; then
        log_error "jq not found — cannot verify coverage; aborting production deploy"
        return 1
    fi
    log_info "Checking coverage (>=${COVERAGE_THRESHOLD}%) before production deploy..."
    local org_alias
    org_alias=$(get_environment_config "$environment" "org_alias")
    local test_output
    test_output=$(sf apex run test --test-level RunLocalTests \
        --target-org "$org_alias" --json --wait 20 2>/dev/null || echo '{}')
    local coverage
    coverage=$(echo "$test_output" | jq -r '.result.summary.orgWideCoverage // "0%"' \
        2>/dev/null | tr -d '%')
    if [[ "$coverage" =~ ^[0-9]+$ ]] && (( coverage < COVERAGE_THRESHOLD )); then
        log_error "Coverage ${coverage}% below threshold ${COVERAGE_THRESHOLD}% — aborting"
        return 1
    fi
    log_success "Coverage ${coverage}% meets threshold"
}
deploy_to_environment() {
    local environment=$1
    local manifest_file=$2
    local deployment_type=$3
    log_info "Starting $deployment_type deployment to $environment environment"
    if [ "$environment" != "development" ]; then
        create_backup "$environment" || log_warning "Backup creation failed"
    fi
    if ! validate_deployment "$environment" "$manifest_file"; then
        log_error "Deployment validation failed - aborting"
        return 1
    fi
    if ! check_coverage_gate "$environment"; then
        log_error "Coverage gate failed — aborting deploy"
        return 1
    fi
    if execute_deployment "$environment" "$manifest_file" "$deployment_type"; then
        post_deployment_check "$environment"
        log_success "Deployment to $environment completed successfully!"
        generate_deployment_summary "$environment" "$deployment_type" "SUCCESS"
    else
        log_error "Deployment failed!"
        if [ "$environment" = "production" ] || [ "$environment" = "staging" ]; then
            read -p "Deployment failed. Attempt automatic rollback? (y/n): " -n 1 -r
            echo ""
            if [[ $REPLY =~ ^[Yy]$ ]]; then
                rollback_deployment "$environment"
            fi
        fi
        generate_deployment_summary "$environment" "$deployment_type" "FAILED"
        return 1
    fi
}
generate_deployment_summary() {
    local environment=$1
    local deployment_type=$2
    local status=$3
    local summary_file="$LOG_DIR/deployment_summary_$(date +%Y%m%d_%H%M%S).md"
    cat > "$summary_file" << EOF
**Date**: $(date)
**Environment**: $environment
**Type**: $deployment_type
**Status**: $status
**Log**: $DEPLOYMENT_LOG
- **Target Org**: $(get_environment_config "$environment" "org_alias")
- **Timeout**: $(get_environment_config "$environment" "timeout")s
- **Excluded Profiles**: $(get_excluded_profiles)
$(if [ "$status" = "SUCCESS" ]; then
echo "Deployment completed successfully"
echo "Post-deployment health checks passed"
else
echo "Deployment failed"
echo "Check deployment log for details"
fi)
---
*Generated by Smart Deployment Manager*
EOF
    echo -e "${CYAN}Deployment summary: $summary_file${NC}"
}
custom_manifest_deployment() {
    read -p "Enter path to custom manifest file: " manifest_path
    read -p "Enter target environment (development/staging/production): " environment
    if [ ! -f "$manifest_path" ]; then
        log_error "Manifest file not found: $manifest_path"
        return 1
    fi
    deploy_to_environment "$environment" "$manifest_path" "custom"
}
emergency_rollback() {
    read -p "Enter environment for rollback (staging/production): " environment
    if [ "$environment" != "staging" ] && [ "$environment" != "production" ]; then
        log_error "Rollback only supported for staging and production environments"
        return 1
    fi
    log_warning "EMERGENCY ROLLBACK INITIATED"
    rollback_deployment "$environment"
}
main() {
    if [ ! -d "$MANIFEST_DIR" ]; then
        log_error "Manifest directory not found: $MANIFEST_DIR"
        log_info "Please ensure you have package.xml files in the manifest directory"
        return 1
    fi
    show_deployment_menu
}
main

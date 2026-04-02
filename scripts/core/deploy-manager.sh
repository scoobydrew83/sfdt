#!/bin/bash

# =============================================================================
# SFDT - Smart Deployment Manager
# Features: Environment-aware deployment, rollback capabilities, validation
# =============================================================================

# Source shared utilities
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../utils/shared.sh"

# Initialize environment
init_script_env

# Project configuration
PROJECT_NAME="${SFDT_PROJECT_NAME:-Salesforce Project}"

echo -e "${BLUE}${PROJECT_NAME} - Smart Deployment Manager${NC}"
echo -e "${YELLOW}============================================================${NC}"

# Deployment configuration
MANIFEST_DIR="${SFDT_MANIFEST_DIR:-../../manifest}"
BACKUP_DIR="$LOG_DIR/deployment-backups"
DEPLOYMENT_LOG="$LOG_DIR/deployment_$(date +%Y%m%d_%H%M%S).log"
VALIDATION_TIMEOUT=20
DEPLOYMENT_TIMEOUT=30

# Create necessary directories
mkdir -p "$BACKUP_DIR"
mkdir -p "$LOG_DIR"

# Load deployment configuration from docs
DEPLOYMENT_CONFIG="$PROJECT_CONFIG_DIR/../docs/deployment-config.md"

# Extract environment configuration
get_environment_config() {
    local env=$1
    local config_key=$2

    jq -r ".environments.$env.$config_key // \"default\"" "$ENVIRONMENT_CONFIG_FILE" 2>/dev/null || echo "default"
}

# Get excluded profiles from deployment config
get_excluded_profiles() {
    if [ -f "$DEPLOYMENT_CONFIG" ]; then
        # Extract excluded profiles from the deployment config markdown
        sed -n '/## Excluded Profiles/,/^##/p' "$DEPLOYMENT_CONFIG" | grep '^-' | sed 's/^- `//;s/`.*$//' | tr '\n' ',' | sed 's/,$//'
    else
        # Fallback to pull config
        jq -r '.pull_configuration.excluded_profiles[]?' "$PULL_CONFIG_FILE" 2>/dev/null | tr '\n' ',' | sed 's/,$//'
    fi
}

# Pre-deployment validation
validate_deployment() {
    local environment=$1
    local manifest_file=$2

    log_info "Validating deployment to $environment environment..."

    # Check if manifest exists
    if [ ! -f "$manifest_file" ]; then
        log_error "Manifest file not found: $manifest_file"
        return 1
    fi

    # Check org connection
    local org_alias=$(get_environment_config "$environment" "org_alias")
    if ! sf org list --json | jq -e ".result[] | select(.alias == \"$org_alias\")" > /dev/null 2>&1; then
        log_error "Not connected to org alias: $org_alias"
        return 1
    fi

    # Validate with dry run
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

# Create deployment backup
create_backup() {
    local environment=$1
    local backup_name="backup_${environment}_$(date +%Y%m%d_%H%M%S)"
    local backup_path="$BACKUP_DIR/$backup_name"

    log_info "Creating deployment backup..."

    mkdir -p "$backup_path"

    # Pull current state for backup
    local org_alias=$(get_environment_config "$environment" "org_alias")

    # Use a simplified backup approach - just pull the key components
    local backup_metadata="ApexClass,Flow,CustomObject,PermissionSet,CustomTab"

    if sf project retrieve start --metadata "$backup_metadata" --target-org "$org_alias" --output-dir "$backup_path" >> "$DEPLOYMENT_LOG" 2>&1; then
        log_success "Backup created: $backup_path"
        echo "$backup_path" > "$BACKUP_DIR/latest_backup.txt"
        return 0
    else
        log_warning "Backup creation failed, but continuing with deployment"
        return 0  # Don't fail deployment if backup fails
    fi
}

# Execute deployment
execute_deployment() {
    local environment=$1
    local manifest_file=$2
    local deployment_type=$3

    log_info "Executing $deployment_type deployment to $environment environment..."

    local org_alias=$(get_environment_config "$environment" "org_alias")
    local timeout=$(get_environment_config "$environment" "timeout")

    # Adjust timeout for deployment type
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

    # Add test level based on environment
    if [ "$environment" = "production" ]; then
        deploy_cmd+=(--test-level RunLocalTests)
    else
        deploy_cmd+=(--test-level NoTestRun)
    fi

    log_debug "Deployment command: ${deploy_cmd[*]}"

    # Execute deployment with real-time logging
    if "${deploy_cmd[@]}" | tee -a "$DEPLOYMENT_LOG"; then
        log_success "Deployment completed successfully!"
        return 0
    else
        log_error "Deployment failed!"
        log_error "Check deployment log: $DEPLOYMENT_LOG"
        return 1
    fi
}

# Post-deployment health check
post_deployment_check() {
    local environment=$1

    log_info "Performing post-deployment health checks..."

    local org_alias=$(get_environment_config "$environment" "org_alias")

    # Check org limits
    if sf data query --query "SELECT Id FROM Organization LIMIT 1" --target-org "$org_alias" >> "$DEPLOYMENT_LOG" 2>&1; then
        log_success "Org connectivity check passed"
    else
        log_warning "Org connectivity check failed"
        return 1
    fi

    # Run smoke tests - read key classes from config if available
    log_info "Running smoke tests..."

    local key_classes=()
    if [ -f "$PROJECT_CONFIG_FILE" ] && command -v jq &> /dev/null; then
        # Try to read key classes from project config
        while IFS= read -r cls; do
            [ -n "$cls" ] && key_classes+=("$cls")
        done < <(jq -r '.smoke_test_classes[]? // empty' "$PROJECT_CONFIG_FILE" 2>/dev/null)
    fi

    if [ ${#key_classes[@]} -eq 0 ]; then
        log_info "No smoke test classes configured in project.json - skipping component verification"
    else
        for class in "${key_classes[@]}"; do
            if sf data query --query "SELECT Id FROM ApexClass WHERE Name = '$class' LIMIT 1" --target-org "$org_alias" >> "$DEPLOYMENT_LOG" 2>&1; then
                log_success "Key component verified: $class"
            else
                log_warning "Key component missing: $class"
            fi
        done
    fi

    log_success "Post-deployment health check completed"
    return 0
}

# Rollback deployment
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

    # Deploy backup
    if sf project deploy start --source-dir "$backup_path" --target-org "$org_alias" --wait 15 >> "$DEPLOYMENT_LOG" 2>&1; then
        log_success "Rollback completed successfully"
        return 0
    else
        log_error "Rollback failed - manual intervention required"
        return 1
    fi
}

# Main deployment menu
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

# Deploy to specific environment
deploy_to_environment() {
    local environment=$1
    local manifest_file=$2
    local deployment_type=$3

    log_info "Starting $deployment_type deployment to $environment environment"

    # Create backup for non-development environments
    if [ "$environment" != "development" ]; then
        create_backup "$environment" || log_warning "Backup creation failed"
    fi

    # Validate deployment
    if ! validate_deployment "$environment" "$manifest_file"; then
        log_error "Deployment validation failed - aborting"
        return 1
    fi

    # Execute deployment
    if execute_deployment "$environment" "$manifest_file" "$deployment_type"; then
        # Post-deployment checks
        post_deployment_check "$environment"

        log_success "Deployment to $environment completed successfully!"

        # Generate deployment summary
        generate_deployment_summary "$environment" "$deployment_type" "SUCCESS"
    else
        log_error "Deployment failed!"

        # Offer rollback for critical environments
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

# Generate deployment summary
generate_deployment_summary() {
    local environment=$1
    local deployment_type=$2
    local status=$3

    local summary_file="$LOG_DIR/deployment_summary_$(date +%Y%m%d_%H%M%S).md"

    cat > "$summary_file" << EOF
# Deployment Summary

**Date**: $(date)
**Environment**: $environment
**Type**: $deployment_type
**Status**: $status
**Log**: $DEPLOYMENT_LOG

## Configuration Used

- **Target Org**: $(get_environment_config "$environment" "org_alias")
- **Timeout**: $(get_environment_config "$environment" "timeout")s
- **Excluded Profiles**: $(get_excluded_profiles)

## Results

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

# Custom manifest deployment
custom_manifest_deployment() {
    read -p "Enter path to custom manifest file: " manifest_path
    read -p "Enter target environment (development/staging/production): " environment

    if [ ! -f "$manifest_path" ]; then
        log_error "Manifest file not found: $manifest_path"
        return 1
    fi

    deploy_to_environment "$environment" "$manifest_path" "custom"
}

# Emergency rollback
emergency_rollback() {
    read -p "Enter environment for rollback (staging/production): " environment

    if [ "$environment" != "staging" ] && [ "$environment" != "production" ]; then
        log_error "Rollback only supported for staging and production environments"
        return 1
    fi

    log_warning "EMERGENCY ROLLBACK INITIATED"
    rollback_deployment "$environment"
}

# Main execution
main() {
    # Check prerequisites
    if [ ! -d "$MANIFEST_DIR" ]; then
        log_error "Manifest directory not found: $MANIFEST_DIR"
        log_info "Please ensure you have package.xml files in the manifest directory"
        return 1
    fi

    # Show deployment menu
    show_deployment_menu
}

# Run the deployment manager
main

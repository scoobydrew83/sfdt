#!/bin/bash

# =============================================================================
# Test Configuration Manager
# =============================================================================

# Configuration - check SFDT_CONFIG_DIR first
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="${SFDT_CONFIG_DIR:-${SCRIPT_DIR}/../config}"
CONFIG_FILE="${CONFIG_DIR}/test-config.json"

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to log info
log_info() {
    echo -e "${BLUE}ℹ️  INFO${NC} - $1"
}

# Function to log success
log_success() {
    echo -e "${GREEN}✅ SUCCESS${NC} - $1"
}

# Function to log warning
log_warning() {
    echo -e "${YELLOW}⚠️  WARN${NC} - $1"
}

# Function to log error
log_error() {
    echo -e "${RED}❌ ERROR${NC} - $1"
}

# Check if jq is available
JQ_AVAILABLE=false
if command -v jq &> /dev/null; then
    JQ_AVAILABLE=true
    log_info "Using jq for JSON manipulation"
else
    log_warning "jq not found, using basic text manipulation"
    log_info "For better functionality, consider installing jq"
fi

# Check if config file exists
if [ ! -f "$CONFIG_FILE" ]; then
    log_error "Configuration file '$CONFIG_FILE' not found!"
    echo "Please ensure the test-config.json file exists in your config directory."
    exit 1
fi

echo "Test Configuration Manager"
echo "=============================="
echo
echo "Current configuration:"
if [ "$JQ_AVAILABLE" = true ]; then
    echo "  Test classes: $(jq '.project_test_classes | length' "$CONFIG_FILE")"
    echo "  Apex classes: $(jq '.project_apex_classes | length' "$CONFIG_FILE")"
else
    # Count classes using basic text manipulation
    test_count=$(sed -n '/"project_test_classes": \[/,/\]/p' "$CONFIG_FILE" | grep '"[^"]*"' | sed 's/.*"\([^"]*\)".*/\1/' | grep -v "project_test_classes" | grep -v "project_apex_classes" | wc -l)
    apex_count=$(sed -n '/"project_apex_classes": \[/,/\]/p' "$CONFIG_FILE" | grep '"[^"]*"' | sed 's/.*"\([^"]*\)".*/\1/' | grep -v "project_test_classes" | grep -v "project_apex_classes" | wc -l)
    echo "  Test classes: $test_count"
    echo "  Apex classes: $apex_count"
fi
echo

echo "Options:"
echo "1. Add test class"
echo "2. Remove test class"
echo "3. Add apex class"
echo "4. Remove apex class"
echo "5. Add apex class + test class (recommended)"
echo "6. List all classes"
echo "7. Backup current config"
echo "8. Restore from backup"

read -p "Choose option (1-8): " -n 1 -r
echo

case $REPLY in
    1)
        read -p "Enter test class name to add: " test_class
        if [ ! -z "$test_class" ]; then
            if [ "$JQ_AVAILABLE" = true ]; then
                # Check if class already exists
                if jq -e --arg class "$test_class" '.project_test_classes[] | select(. == $class)' "$CONFIG_FILE" > /dev/null; then
                    log_warning "Test class '$test_class' already exists"
                else
                    # Add the class
                    jq --arg class "$test_class" '.project_test_classes += [$class]' "$CONFIG_FILE" > "${CONFIG_FILE}.tmp" && mv "${CONFIG_FILE}.tmp" "$CONFIG_FILE"
                    log_success "Added test class: $test_class"
                fi
            else
                # Basic text manipulation approach
                if grep -q "\"$test_class\"" "$CONFIG_FILE"; then
                    log_warning "Test class '$test_class' already exists"
                else
                    # Add the class before the closing bracket of project_test_classes
                    sed -i '/"project_test_classes": \[/,/\]/ {
    /\]/ s/]/,\n    "'"$test_class"'"\n]/
}' "$CONFIG_FILE"
                    log_success "Added test class: $test_class"
                fi
            fi
        fi
        ;;
    2)
        echo "Current test classes:"
        if [ "$JQ_AVAILABLE" = true ]; then
            jq -r '.project_test_classes[]' "$CONFIG_FILE" | nl
        else
            sed -n '/"project_test_classes": \[/,/\]/p' "$CONFIG_FILE" | grep '"[^"]*"' | sed 's/.*"\([^"]*\)".*/\1/' | grep -v "project_test_classes" | grep -v "project_apex_classes" | nl
        fi
        read -p "Enter test class name to remove: " test_class
        if [ ! -z "$test_class" ]; then
            if [ "$JQ_AVAILABLE" = true ]; then
                # Check if class exists
                if jq -e --arg class "$test_class" '.project_test_classes[] | select(. == $class)' "$CONFIG_FILE" > /dev/null; then
                    # Remove the class
                    jq --arg class "$test_class" 'del(.project_test_classes[] | select(. == $class))' "$CONFIG_FILE" > "${CONFIG_FILE}.tmp" && mv "${CONFIG_FILE}.tmp" "$CONFIG_FILE"
                    log_success "Removed test class: $test_class"
                else
                    log_warning "Test class '$test_class' not found"
                fi
            else
                # Basic text manipulation approach
                if grep -q "\"$test_class\"" "$CONFIG_FILE"; then
                    # Remove the class line
                    sed -i "/\"$test_class\"/d" "$CONFIG_FILE"
                    # Clean up any trailing commas
                    sed -i 's/,\s*]/]/g' "$CONFIG_FILE"
                    log_success "Removed test class: $test_class"
                else
                    log_warning "Test class '$test_class' not found"
                fi
            fi
        fi
        ;;
    3)
        read -p "Enter apex class name to add: " apex_class
        if [ ! -z "$apex_class" ]; then
            if [ "$JQ_AVAILABLE" = true ]; then
                # Check if class already exists
                if jq -e --arg class "$apex_class" '.project_apex_classes[] | select(. == $class)' "$CONFIG_FILE" > /dev/null; then
                    log_warning "Apex class '$apex_class' already exists"
                else
                    # Add the class
                    jq --arg class "$apex_class" '.project_apex_classes += [$class]' "$CONFIG_FILE" > "${CONFIG_FILE}.tmp" && mv "${CONFIG_FILE}.tmp" "$CONFIG_FILE"
                    log_success "Added apex class: $apex_class"
                fi
            else
                # Basic text manipulation approach
                if grep -q "\"$apex_class\"" "$CONFIG_FILE"; then
                    log_warning "Apex class '$apex_class' already exists"
                else
                    sed -i '/"project_apex_classes": \[/,/\]/ {
    /\]/ s/]/,\n    "'"$apex_class"'"\n]/
}' "$CONFIG_FILE"
                fi
            fi
        fi
        ;;
    4)
        echo "Current apex classes:"
        if [ "$JQ_AVAILABLE" = true ]; then
            jq -r '.project_apex_classes[]' "$CONFIG_FILE" | nl
        else
            sed -n '/"project_apex_classes": \[/,/\]/p' "$CONFIG_FILE" | grep '"[^"]*"' | sed 's/.*"\([^"]*\)".*/\1/' | grep -v "project_test_classes" | grep -v "project_apex_classes" | nl
        fi
        read -p "Enter apex class name to remove: " apex_class
        if [ ! -z "$apex_class" ]; then
            if [ "$JQ_AVAILABLE" = true ]; then
                # Check if class exists
                if jq -e --arg class "$apex_class" '.project_apex_classes[] | select(. == $class)' "$CONFIG_FILE" > /dev/null; then
                    # Remove the class
                    jq --arg class "$apex_class" 'del(.project_apex_classes[] | select(. == $class))' "$CONFIG_FILE" > "${CONFIG_FILE}.tmp" && mv "${CONFIG_FILE}.tmp" "$CONFIG_FILE"
                    log_success "Removed apex class: $apex_class"
                else
                    log_warning "Apex class '$apex_class' not found"
                fi
            else
                # Basic text manipulation approach
                if grep -q "\"$apex_class\"" "$CONFIG_FILE"; then
                    # Remove the class line
                    sed -i "/\"$apex_class\"/d" "$CONFIG_FILE"
                    # Clean up any trailing commas
                    sed -i 's/,\s*]/]/g' "$CONFIG_FILE"
                    log_success "Removed apex class: $apex_class"
                else
                    log_warning "Apex class '$apex_class' not found"
                fi
            fi
        fi
        ;;
    5)
        echo "Add Apex Class + Test Class"
        echo "=============================="
        read -p "Enter apex class name (e.g., EmailService): " apex_class
        if [ ! -z "$apex_class" ]; then
            echo
            echo "Test class naming options:"
            echo "1. Add 'Test' suffix (e.g., EmailServiceTest)"
            echo "2. Add '_Test' suffix (e.g., EmailService_Test)"
            echo "3. Custom test class name"
            read -p "Choose option (1-3): " -n 1 -r
            echo

            case $REPLY in
                1)
                    test_class="${apex_class}Test"
                    ;;
                2)
                    test_class="${apex_class}_Test"
                    ;;
                3)
                    read -p "Enter custom test class name: " test_class
                    ;;
                *)
                    log_error "Invalid option, using default 'Test' suffix"
                    test_class="${apex_class}Test"
                    ;;
            esac

            echo "Will add:"
            echo "  Apex class: $apex_class"
            echo "  Test class: $test_class"
            echo
            read -p "Continue? (y/N): " -n 1 -r
            echo

            if [[ $REPLY =~ ^[Yy]$ ]]; then
                # Add apex class
                if [ "$JQ_AVAILABLE" = true ]; then
                    if jq -e --arg class "$apex_class" '.project_apex_classes[] | select(. == $class)' "$CONFIG_FILE" > /dev/null; then
                        log_warning "Apex class '$apex_class' already exists"
                    else
                        jq --arg class "$apex_class" '.project_apex_classes += [$class]' "$CONFIG_FILE" > "${CONFIG_FILE}.tmp" && mv "${CONFIG_FILE}.tmp" "$CONFIG_FILE"
                        log_success "Added apex class: $apex_class"
                    fi
                else
                    if grep -q "\"$apex_class\"" "$CONFIG_FILE"; then
                        log_warning "Apex class '$apex_class' already exists"
                    else
                       sed -i '/"project_apex_classes": \[/,/\]/ {
    /\]/ s/]/,\n    "'"$apex_class"'"\n]/
}' "$CONFIG_FILE"
                    fi
                fi

                # Add test class
                if [ "$JQ_AVAILABLE" = true ]; then
                    if jq -e --arg class "$test_class" '.project_test_classes[] | select(. == $class)' "$CONFIG_FILE" > /dev/null; then
                        log_warning "Test class '$test_class' already exists"
                    else
                        jq --arg class "$test_class" '.project_test_classes += [$class]' "$CONFIG_FILE" > "${CONFIG_FILE}.tmp" && mv "${CONFIG_FILE}.tmp" "$CONFIG_FILE"
                        log_success "Added test class: $test_class"
                    fi
                else
                    if grep -q "\"$test_class\"" "$CONFIG_FILE"; then
                        log_warning "Test class '$test_class' already exists"
                    else
                       sed -i '/"project_test_classes": \[/,/\]/ {
    /\]/ s/]/,\n    "'"$test_class"'"\n]/
}' "$CONFIG_FILE"
                    fi
                fi

                echo
                log_success "Both classes added successfully!"
            else
                log_info "Operation cancelled"
            fi
        fi
        ;;
    6)
        echo
        echo "Test Classes:"
        echo "-------------"
        if [ "$JQ_AVAILABLE" = true ]; then
            jq -r '.project_test_classes[]' "$CONFIG_FILE" | nl
        else
            sed -n '/"project_test_classes": \[/,/\]/p' "$CONFIG_FILE" | grep '"[^"]*"' | sed 's/.*"\([^"]*\)".*/\1/' | grep -v "project_test_classes" | grep -v "project_apex_classes" | nl
        fi
        echo
        echo "Apex Classes:"
        echo "-------------"
        if [ "$JQ_AVAILABLE" = true ]; then
            jq -r '.project_apex_classes[]' "$CONFIG_FILE" | nl
        else
            sed -n '/"project_apex_classes": \[/,/\]/p' "$CONFIG_FILE" | grep '"[^"]*"' | sed 's/.*"\([^"]*\)".*/\1/' | grep -v "project_test_classes" | grep -v "project_apex_classes" | nl
        fi
        ;;
    7)
        backup_file="${CONFIG_DIR}/test-config-backup-$(date +%Y%m%d-%H%M%S).json"
        cp "$CONFIG_FILE" "$backup_file"
        log_success "Backup created: $backup_file"
        ;;
    8)
        echo "Available backups:"
        ls -la "${CONFIG_DIR}"/test-config-backup-*.json 2>/dev/null | nl || echo "No backups found"
        read -p "Enter backup filename to restore: " backup_file
        if [ -f "$backup_file" ]; then
            cp "$backup_file" "$CONFIG_FILE"
            log_success "Restored from: $backup_file"
        else
            log_error "Backup file not found: $backup_file"
        fi
        ;;
    *)
        log_error "Invalid option"
        exit 1
        ;;
esac

echo
echo "Tip: Run the test runner script to test your configuration changes"

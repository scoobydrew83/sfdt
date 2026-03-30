#!/bin/bash

# Metadata Parser Library
# Handles mapping of file paths to Salesforce metadata types

set -euo pipefail

# Load custom metadata mappings from config file
load_custom_mappings() {
    local config_file="${SFDT_CONFIG_DIR:-tools/config}/metadata-mapping.json"

    if [ ! -f "$config_file" ]; then
        return 0
    fi

    # Check if jq is available
    if ! command -v jq &> /dev/null; then
        return 0
    fi

    # Export custom patterns (store in global for now)
    CUSTOM_PATTERNS=$(jq -r '.customPatterns // {}' "$config_file")
}

# Hardcoded metadata type mappings
# Maps file extension/suffix to Salesforce metadata type
get_metadata_type() {
    local file_path=$1
    local filename=$(basename "$file_path")

    # Check custom patterns first
    if [ -n "${CUSTOM_PATTERNS:-}" ]; then
        # This is simplified - in practice would need more robust pattern matching
        # For now, hardcoded mappings are sufficient
        :
    fi

    # Skip test files inside LWC/Aura bundles (e.g., __tests__/*.test.js)
    if [[ "$file_path" =~ /__tests__/ ]]; then
        echo "SKIP"
        return
    fi

    # Check for bundled components by directory path (LWC, Aura)
    # These have multiple file types (.js, .html, .css) in same folder
    if [[ "$file_path" =~ /lwc/ ]]; then
        echo "LightningComponentBundle"
        return
    fi
    if [[ "$file_path" =~ /aura/ ]]; then
        echo "AuraDefinitionBundle"
        return
    fi

    # Extract extension
    case "$filename" in
        *.cls | *.cls-meta.xml)
            echo "ApexClass"
            ;;
        *.trigger | *.trigger-meta.xml)
            echo "ApexTrigger"
            ;;
        *.flow-meta.xml)
            echo "Flow"
            ;;
        *.object-meta.xml)
            echo "CustomObject"
            ;;
        *.field-meta.xml)
            echo "CustomField"
            ;;
        *.permissionset-meta.xml)
            echo "PermissionSet"
            ;;
        *.layout-meta.xml)
            echo "Layout"
            ;;
        *.page-meta.xml)
            echo "ApexPage"
            ;;
        *.component-meta.xml)
            echo "ApexComponent"
            ;;
        *.email-meta.xml)
            echo "EmailTemplate"
            ;;
        *.app-meta.xml)
            echo "CustomApplication"
            ;;
        *.tab-meta.xml)
            echo "CustomTab"
            ;;
        *.labels-meta.xml)
            echo "CustomLabels"
            ;;
        *.lwc-meta.xml)
            echo "LightningComponentBundle"
            ;;
        *.aura)
            echo "AuraDefinitionBundle"
            ;;
        *.customMetadata-meta.xml|*.md-meta.xml)
            echo "CustomMetadata"
            ;;
        *.externalServiceRegistration-meta.xml)
            echo "ExternalServiceRegistration"
            ;;
        *)
            echo "UNKNOWN"
            ;;
    esac
}

# Extract metadata member name from file path
# Handles special cases like CustomField (Account.Field__c)
get_member_name() {
    local file_path=$1
    local metadata_type=$2
    local filename=$(basename "$file_path")

    # Handle CustomField special case
    if [ "$metadata_type" == "CustomField" ]; then
        # Path like: objects/Account/fields/Custom__c.field-meta.xml
        # Extract: Account.Custom__c
        local object_name=$(echo "$file_path" | sed -n 's/.*objects\/\([^\/]*\)\/.*/\1/p')
        local field_name=$(echo "$filename" | sed 's/\.field-meta\.xml$//')
        echo "${object_name}.${field_name}"
        return
    fi

    # Handle bundled components (LWC, Aura)
    if [ "$metadata_type" == "LightningComponentBundle" ] || [ "$metadata_type" == "AuraDefinitionBundle" ]; then
        # Path like: lwc/myComponent/myComponent.js
        # Extract: myComponent (parent folder name)
        local parent_dir=$(dirname "$file_path")
        echo "$(basename "$parent_dir")"
        return
    fi

    # Standard case: strip all suffixes
    echo "$filename" | sed -E 's/\.(cls-meta\.xml|cls|trigger-meta\.xml|trigger|flow-meta\.xml|object-meta\.xml|permissionset-meta\.xml|layout-meta\.xml|page-meta\.xml|component-meta\.xml|email-meta\.xml|app-meta\.xml|tab-meta\.xml|labels-meta\.xml|lwc-meta\.xml|customMetadata-meta\.xml|md-meta\.xml|externalServiceRegistration-meta\.xml)$//'
}

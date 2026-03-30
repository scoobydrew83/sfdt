#!/bin/bash

# Enhanced Org Update Puller
# Generic version with config-driven pull groups

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Project configuration
PROJECT_NAME="${SFDT_PROJECT_NAME:-Salesforce Project}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="${SFDT_CONFIG_DIR:-${SCRIPT_DIR}/../config}"
PULL_CONFIG_FILE="${CONFIG_DIR}/pull-config.json"

echo -e "${BLUE}${PROJECT_NAME} - Enhanced Org Update Puller${NC}"
echo -e "${YELLOW}==================================================${NC}"

# Check if authenticated
echo -e "\n${YELLOW}Checking authentication...${NC}"
if ! sf org list --json > /dev/null 2>&1; then
    echo -e "${RED}Not authenticated. Please run: sf org login web${NC}"
    exit 1
fi

# Get default org
DEFAULT_ORG=$(sf config get target-org --json | grep -o '"value":"[^"]*' | grep -o '[^"]*$')

if [ -z "$DEFAULT_ORG" ]; then
    echo -e "${RED}No default org set. Please run: sf config set target-org=YOUR_ORG_ALIAS${NC}"
    exit 1
fi

echo -e "${GREEN}Connected to: ${DEFAULT_ORG}${NC}"

# Check source tracking
echo -e "\n${YELLOW}Checking source tracking status...${NC}"
TRACKING_STATUS=$(sf project retrieve preview --json 2>/dev/null | grep -o '"status":[0-9]*' | grep -o '[0-9]*$' || echo "1")

if [ "$TRACKING_STATUS" != "0" ]; then
    echo -e "${YELLOW}Source tracking may not be enabled for this org${NC}"
fi

# --- Dynamic pull group loading ---

# Load pull groups from config file
load_pull_groups() {
    if [ ! -f "$PULL_CONFIG_FILE" ]; then
        return 1
    fi

    if ! command -v jq &> /dev/null; then
        return 1
    fi

    # Check if pullGroups key exists
    jq -e '.pullGroups' "$PULL_CONFIG_FILE" > /dev/null 2>&1
}

# Get count of pull groups
get_pull_group_count() {
    jq '.pullGroups | length' "$PULL_CONFIG_FILE" 2>/dev/null || echo "0"
}

# Get pull group name by index (0-based)
get_pull_group_name() {
    local index=$1
    jq -r ".pullGroups[$index].name" "$PULL_CONFIG_FILE" 2>/dev/null
}

# Get pull group description by index (0-based)
get_pull_group_description() {
    local index=$1
    jq -r ".pullGroups[$index].description // .pullGroups[$index].name" "$PULL_CONFIG_FILE" 2>/dev/null
}

# Get pull group metadata entries by index (0-based)
# Returns newline-separated list of --metadata arguments
get_pull_group_metadata() {
    local index=$1
    jq -r ".pullGroups[$index].metadata[]" "$PULL_CONFIG_FILE" 2>/dev/null
}

# Get pull group post-commands by index (0-based) if any
get_pull_group_post_commands() {
    local index=$1
    jq -r ".pullGroups[$index].postCommands[]? // empty" "$PULL_CONFIG_FILE" 2>/dev/null
}

# Execute a pull group by index
execute_pull_group() {
    local index=$1
    local group_name=$(get_pull_group_name "$index")
    local group_desc=$(get_pull_group_description "$index")

    echo -e "\n${YELLOW}Pulling: ${group_desc}...${NC}"

    # Build the sf retrieve command with all metadata entries
    local metadata_args=""
    while IFS= read -r meta; do
        if [ -n "$meta" ]; then
            metadata_args="${metadata_args} --metadata \"${meta}\""
        fi
    done < <(get_pull_group_metadata "$index")

    if [ -z "$metadata_args" ]; then
        echo -e "${RED}No metadata entries found for group: ${group_name}${NC}"
        return 1
    fi

    # Execute the retrieve command
    eval "sf project retrieve start ${metadata_args}"

    # Execute any post-commands
    while IFS= read -r cmd; do
        if [ -n "$cmd" ]; then
            echo -e "${BLUE}Running post-command: ${cmd}${NC}"
            eval "$cmd"
        fi
    done < <(get_pull_group_post_commands "$index")

    echo -e "${GREEN}${group_desc} pulled successfully${NC}"
}

# --- Menu construction ---

# Build menu: generic options (1-5) + dynamic pull groups + profiles + exit
echo -e "\n${BLUE}Select an option:${NC}"
echo "1. Pull all changes from org"
echo "2. Pull specific metadata types (from pull-config.json)"
echo "3. Preview changes only (dry run)"
echo "4. Pull and show conflicts"
echo "5. Reset local tracking"

# Dynamic pull group options
PULL_GROUP_COUNT=0
PULL_GROUP_START=6

if load_pull_groups; then
    PULL_GROUP_COUNT=$(get_pull_group_count)
    for ((i=0; i<PULL_GROUP_COUNT; i++)); do
        local_option=$((PULL_GROUP_START + i))
        group_desc=$(get_pull_group_description "$i")
        echo -e "${GREEN}${local_option}. ${group_desc}${NC}"
    done
fi

# Profiles option comes after pull groups
PROFILES_OPTION=$((PULL_GROUP_START + PULL_GROUP_COUNT))
echo -e "${YELLOW}${PROFILES_OPTION}. Pull profiles (excluding custom org profiles)${NC}"

EXIT_OPTION=$((PROFILES_OPTION + 1))
echo "${EXIT_OPTION}. Exit"

read -p "Enter your choice (1-${EXIT_OPTION}): " choice

# --- Handle generic options (1-5) ---
if [ "$choice" -ge 1 ] 2>/dev/null && [ "$choice" -le 5 ] 2>/dev/null; then
    case $choice in
        1)
            echo -e "\n${YELLOW}Pulling all changes from org...${NC}"
            sf project retrieve start
            echo -e "${GREEN}All changes pulled successfully${NC}"
            ;;

        2)
            echo -e "\n${YELLOW}Reading pull-config.json...${NC}"
            if [ ! -f "$PULL_CONFIG_FILE" ]; then
                echo -e "${RED}pull-config.json not found at $PULL_CONFIG_FILE${NC}"
                exit 1
            fi

            # Extract metadata types from config
            METADATA_TYPES=$(jq -r '.pull_configuration.priority_metadata_types[]' "$PULL_CONFIG_FILE" 2>/dev/null | tr '\n' ',' | sed 's/,$//')

            if [ -z "$METADATA_TYPES" ]; then
                echo -e "${RED}No metadata types found in pull-config.json${NC}"
                exit 1
            fi

            # Check if profiles are excluded
            EXCLUDED_PROFILES=$(jq -r '.pull_configuration.excluded_profiles[]?' "$PULL_CONFIG_FILE" 2>/dev/null | tr '\n' ',' | sed 's/,$//')

            if [ -n "$EXCLUDED_PROFILES" ]; then
                echo -e "${YELLOW}Note: Excluding profiles: ${EXCLUDED_PROFILES}${NC}"
                echo -e "${BLUE}Profiles will be handled separately to avoid conflicts${NC}"
            fi

            echo -e "${YELLOW}Pulling metadata types: ${METADATA_TYPES}${NC}"
            sf project retrieve start --metadata "$METADATA_TYPES"
            echo -e "${GREEN}Specific metadata pulled successfully${NC}"
            ;;

        3)
            echo -e "\n${YELLOW}Previewing changes (dry run)...${NC}"
            sf project retrieve preview
            ;;

        4)
            echo -e "\n${YELLOW}Pulling changes and checking for conflicts...${NC}"
            sf project retrieve start --verbose

            # Check for conflicts
            if [ -d ".sfdx/orgs/$DEFAULT_ORG/sourcePathInfos.json" ]; then
                echo -e "\n${YELLOW}Checking for conflicts...${NC}"
                CONFLICTS=$(find "${SFDT_SOURCE_PATH:-force-app}" -name "*.dup" -type f 2>/dev/null | wc -l)
                if [ "$CONFLICTS" -gt 0 ]; then
                    echo -e "${RED}Found $CONFLICTS conflict files (.dup)${NC}"
                    find "${SFDT_SOURCE_PATH:-force-app}" -name "*.dup" -type f
                else
                    echo -e "${GREEN}No conflicts found${NC}"
                fi
            fi
            ;;

        5)
            echo -e "\n${RED}WARNING: This will reset source tracking${NC}"
            read -p "Are you sure? (y/N): " confirm
            if [[ $confirm == [yY] ]]; then
                sf project reset tracking --no-prompt
                echo -e "${GREEN}Source tracking reset${NC}"
            else
                echo -e "${YELLOW}Cancelled${NC}"
            fi
            ;;
    esac

# --- Handle dynamic pull group options ---
elif [ "$choice" -ge "$PULL_GROUP_START" ] 2>/dev/null && [ "$choice" -lt "$PROFILES_OPTION" ] 2>/dev/null; then
    group_index=$((choice - PULL_GROUP_START))
    execute_pull_group "$group_index"

# --- Handle profiles option ---
elif [ "$choice" -eq "$PROFILES_OPTION" ] 2>/dev/null; then
    echo -e "\n${YELLOW}Pulling profiles (excluding custom org profiles)...${NC}"

    # Read excluded profiles from config
    EXCLUDED_PROFILES_ARRAY=($(jq -r '.pull_configuration.excluded_profiles[]?' "$PULL_CONFIG_FILE" 2>/dev/null))

    if [ ${#EXCLUDED_PROFILES_ARRAY[@]} -gt 0 ]; then
        echo -e "${BLUE}Excluded profiles:${NC}"
        for profile in "${EXCLUDED_PROFILES_ARRAY[@]}"; do
            echo -e "  - ${profile}"
        done
    fi

    echo -e "\n${YELLOW}Pulling standard Salesforce profiles only...${NC}"

    # Read profile list from config, or fall back to defaults
    PROFILE_LIST=($(jq -r '.pull_configuration.standard_profiles[]?' "$PULL_CONFIG_FILE" 2>/dev/null))

    if [ ${#PROFILE_LIST[@]} -eq 0 ]; then
        # Fallback to common standard profiles
        PROFILE_LIST=("System Administrator" "Standard User" "ReadOnly")
    fi

    # Build metadata args for profiles
    local profile_args=""
    for profile in "${PROFILE_LIST[@]}"; do
        profile_args="${profile_args} --metadata \"Profile:${profile}\""
    done

    eval "sf project retrieve start ${profile_args}"

    echo -e "${GREEN}Standard profiles pulled successfully${NC}"
    echo -e "${BLUE}Custom org-specific profiles were excluded as configured${NC}"

# --- Handle exit ---
elif [ "$choice" -eq "$EXIT_OPTION" ] 2>/dev/null; then
    echo -e "${YELLOW}Exiting...${NC}"
    exit 0

else
    echo -e "${RED}Invalid choice${NC}"
    exit 1
fi

# Show summary
echo -e "\n${BLUE}Summary:${NC}"
echo -e "Org: ${DEFAULT_ORG}"
echo -e "Timestamp: $(date)"

# Check for uncommitted changes
UNCOMMITTED=$(git status --porcelain | wc -l)
if [ "$UNCOMMITTED" -gt 0 ]; then
    echo -e "\n${YELLOW}You have $UNCOMMITTED uncommitted changes${NC}"
    echo -e "Run '${BLUE}git status${NC}' to see changes"
fi

echo -e "\n${GREEN}Operation completed successfully!${NC}"

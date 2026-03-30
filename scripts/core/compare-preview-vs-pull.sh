#!/bin/bash

# Compare Preview vs Pull Results
# This script helps you see the difference between what preview shows and what actually gets pulled

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Project configuration
SOURCE_PATH="${SFDT_SOURCE_PATH:-force-app}"

echo -e "${BLUE}Preview vs Pull Comparison Tool${NC}"
echo -e "${YELLOW}================================${NC}"

# Step 1: Get current git status before any operations
echo -e "\n${YELLOW}Step 1: Capturing current state...${NC}"
git status --porcelain > before_state.txt

# Step 2: Run preview and capture results
echo -e "\n${YELLOW}Step 2: Running preview...${NC}"
sf project retrieve preview --json > preview_results.json

# Step 3: Extract preview information
echo -e "\n${YELLOW}Step 3: Analyzing preview results...${NC}"
echo "Preview Results:" > comparison_report.txt
echo "===============" >> comparison_report.txt

# Extract conflicts from preview
CONFLICTS=$(jq -r '.result.conflicts[].fullName' preview_results.json 2>/dev/null | tr '\n' ',' | sed 's/,$//')
if [ -n "$CONFLICTS" ]; then
    echo "Conflicts found: $CONFLICTS" >> comparison_report.txt
else
    echo "No conflicts found" >> comparison_report.txt
fi

# Extract items to retrieve from preview
TO_RETRIEVE=$(jq -r '.result.toRetrieve[].fullName' preview_results.json 2>/dev/null | tr '\n' ',' | sed 's/,$//')
if [ -n "$TO_RETRIEVE" ]; then
    echo "Items to retrieve: $TO_RETRIEVE" >> comparison_report.txt
else
    echo "No items to retrieve" >> comparison_report.txt
fi

# Step 4: Ask user if they want to proceed with pull
echo -e "\n${BLUE}Preview completed. Do you want to proceed with the pull? (y/n)${NC}"
read -p "Enter your choice: " choice

if [ "$choice" = "y" ] || [ "$choice" = "Y" ]; then
    echo -e "\n${YELLOW}Step 4: Running pull...${NC}"
    sf project retrieve start --ignore-conflicts

    # Step 5: Capture post-pull state
    echo -e "\n${YELLOW}Step 5: Capturing post-pull state...${NC}"
    git status --porcelain > after_state.txt

    # Step 6: Compare states
    echo -e "\n${YELLOW}Step 6: Comparing preview vs actual results...${NC}"
    echo "" >> comparison_report.txt
    echo "Actual Pull Results:" >> comparison_report.txt
    echo "===================" >> comparison_report.txt

    # Show what actually changed
    echo "Files actually modified/created:" >> comparison_report.txt
    git diff --name-only HEAD >> comparison_report.txt

    # Step 7: Show comparison
    echo -e "\n${GREEN}Comparison complete!${NC}"
    echo -e "${BLUE}Check comparison_report.txt for detailed results${NC}"

    # Display summary
    echo -e "\n${YELLOW}Summary:${NC}"
    echo "Preview conflicts: $(echo $CONFLICTS | tr ',' '\n' | wc -l)"
    echo "Preview to retrieve: $(echo $TO_RETRIEVE | tr ',' '\n' | wc -l)"
    echo "Actual files changed: $(git diff --name-only HEAD | wc -l)"

else
    echo -e "\n${YELLOW}Pull cancelled. Preview results saved to preview_results.json${NC}"
fi

echo -e "\n${BLUE}Files created:${NC}"
echo "- preview_results.json (preview data)"
echo "- comparison_report.txt (detailed comparison)"
echo "- before_state.txt (git state before pull)"
echo "- after_state.txt (git state after pull)"

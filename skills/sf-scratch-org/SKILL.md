---
name: sf-scratch-org
license: Apache-2.0
description: Create and manage Salesforce scratch orgs — create, push source, pull changes, assign permsets, seed data, and manage lifecycle. Use whenever the user mentions scratch orgs, Dev Hub, spinning up a dev/test environment, source push/pull conflicts, or setting up local Salesforce DX development — even if they just say "give me a fresh org".
triggers:
  - scratch org
  - create org
  - dev org
  - push source
  - pull changes
  - sf org create
---

# Scratch Org Management Skill

You manage the full scratch org lifecycle for this Salesforce DX project.

If the project uses the sfdt CLI (`.sfdt/` directory present), `sfdt scratch create|delete|list` wraps the commands below with the project's configured definition file, and `sfdt scratch pool` maintains a pool of pre-created orgs so developers don't wait on org creation. Prefer those; use the raw `sf` commands for one-offs.

## Prerequisites Check

Before any scratch org operation:
```bash
# Verify CLI is current
sf version

# Verify Dev Hub is authorized
sf org list --verbose | grep DevHub

# View scratch org definitions available
ls config/
```

## Create a Scratch Org

```bash
# Standard 30-day scratch org (default config)
sf org create scratch \
  --definition-file config/project-scratch-def.json \
  --alias dev-scratch \
  --duration-days 30 \
  --set-default

# Short-lived for quick test (7 days)
sf org create scratch \
  --definition-file config/project-scratch-def.json \
  --alias test-scratch \
  --duration-days 7 \
  --set-default

# With specific Dev Hub
sf org create scratch \
  --definition-file config/project-scratch-def.json \
  --target-dev-hub <devhubAlias> \
  --alias my-scratch \
  --duration-days 14
```

## Push Source to Scratch Org

```bash
# Push all local source changes (source-tracked)
sf project deploy start --target-org dev-scratch

# Force push ignoring conflict detection
sf project deploy start --target-org dev-scratch --ignore-conflicts

# Watch deploy progress
sf project deploy start --target-org dev-scratch --wait 30
```

## Pull Changes from Scratch Org

After making changes in the scratch org UI:
```bash
# Pull declarative changes back to local project
sf project retrieve start --target-org dev-scratch

# Pull and ignore conflicts (prefer local)
sf project retrieve start --target-org dev-scratch --ignore-conflicts
```

## Post-Creation Setup

After creating a scratch org, typical setup:
```bash
# 1. Push source
sf project deploy start --target-org dev-scratch

# 2. Assign permission sets
sf org assign permset --name MyPermissionSet --target-org dev-scratch

# 3. Import sample data
sf data import tree --plan data/sample-data-plan.json --target-org dev-scratch

# 4. Open scratch org in browser
sf org open --target-org dev-scratch
```

## Org Management

```bash
# List all orgs
sf org list

# List scratch orgs only (with expiration dates)
sf org list --verbose

# Open org in browser
sf org open --target-org <alias>

# Open specific page
sf org open --target-org dev-scratch --path /lightning/setup/ObjectManager/home

# Display org details (instance URL, username)
sf org display --target-org dev-scratch

# Delete scratch org when done
sf org delete scratch --target-org dev-scratch --no-prompt
```

## User Management

```bash
# Create additional test user
sf org create user \
  --definition-file config/user-def.json \
  --target-org dev-scratch \
  --set-alias test-user

# Generate password
sf org generate password --target-org dev-scratch

# Assign permission set to specific user
sf org assign permset \
  --name MyPermissionSet \
  --on-behalf-of test-user \
  --target-org dev-scratch
```

## Data Operations

```bash
# Export data from scratch org to files
sf data export tree \
  --query "SELECT Id, Name FROM Account LIMIT 100" \
  --output-dir data/ \
  --target-org dev-scratch

# Import data from files
sf data import tree \
  --plan data/Account-plan.json \
  --target-org dev-scratch

# Run anonymous Apex
sf apex run \
  --file scripts/apex/setupData.apex \
  --target-org dev-scratch

# Execute quick anonymous Apex
echo "System.debug('Hello from scratch org');" | sf apex run --target-org dev-scratch
```

## Conflict Resolution

```bash
# View what changed (diff between local and org)
sf project deploy preview --target-org dev-scratch

# Retrieve conflict report
sf project retrieve preview --target-org dev-scratch

# Force local wins (overwrite org)
sf project deploy start --target-org dev-scratch --ignore-conflicts

# Force org wins (overwrite local)
sf project retrieve start --target-org dev-scratch --ignore-conflicts
```

## Scratch Org Limits

- Active-org and daily-creation allocations vary by Dev Hub edition (e.g. Developer Edition allows far fewer than Enterprise/Unlimited)
- Check the actual allocation: `sf limits api display --target-org <devHubAlias>` (look for `ActiveScratchOrgs` and `DailyScratchOrgs`)
- Max scratch org duration: 30 days
- Always delete expired/unused orgs: `sf org delete scratch`

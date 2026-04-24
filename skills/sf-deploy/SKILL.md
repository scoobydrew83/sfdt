---
name: sf-deploy
description: Salesforce CLI deployment skill for this project — deploy metadata to sandbox or scratch org, retrieve metadata, run tests, cancel stuck deploys. Activates when discussing deploy, retrieve, push, or sf project commands.
triggers:
  - deploy
  - retrieve
  - sf project deploy
  - push source
  - quick deploy
  - deployment
---

# Salesforce Deployment Skill

You assist with all Salesforce CLI (sf) deployment operations for this project. Always use the modern `sf` CLI (not deprecated `sfdx`).

## Before Deploying — Always Confirm

Ask the user:
1. **Target org alias** — never guess; use `sf org list` to show available orgs
2. **What to deploy** — specific path, package.xml manifest, or entire force-app?
3. **Test level** — NoTestRun (fastest), RunSpecifiedTests, RunLocalTests, RunAllTestsInOrg

## Common Deployment Commands

### Deploy specific metadata path
```bash
sf project deploy start \
  --source-dir force-app/main/default/classes/MyClass.cls \
  --target-org <alias> \
  --test-level RunLocalTests \
  --wait 30
```

### Deploy via manifest (package.xml)
```bash
sf project deploy start \
  --manifest manifest/package.xml \
  --target-org <alias> \
  --test-level RunLocalTests \
  --wait 30
```

### Deploy entire project
```bash
sf project deploy start \
  --source-dir force-app \
  --target-org <alias> \
  --test-level RunLocalTests
```

### Quick Deploy (after validated deploy)
```bash
sf project deploy quick \
  --job-id <deployId> \
  --target-org <alias>
```

### Validate only (no deploy, gets deploy ID for quick deploy)
```bash
sf project deploy validate \
  --source-dir force-app \
  --target-org <alias> \
  --test-level RunLocalTests
```

### Check status of async deploy
```bash
sf project deploy report --job-id <deployId> --target-org <alias>
```

### Cancel a stuck deploy
```bash
sf project deploy cancel --job-id <deployId> --target-org <alias>
```

## Retrieve Metadata

### Retrieve by source path (source-tracked org)
```bash
sf project retrieve start \
  --source-dir force-app/main/default/objects/Account \
  --target-org <alias>
```

### Retrieve via manifest
```bash
sf project retrieve start \
  --manifest manifest/package.xml \
  --target-org <alias>
```

### Retrieve specific metadata types
```bash
sf project retrieve start \
  --metadata ApexClass:MyClass,CustomObject:Account__c \
  --target-org <alias>
```

## Scratch Org Push/Pull

```bash
# Push local source to scratch org (source-tracked)
sf project deploy start --target-org <scratchAlias>

# Pull changes made in scratch org UI back to local
sf project retrieve start --target-org <scratchAlias>
```

## Destructive Changes

```bash
# Create a destructive package
sf project generate manifest \
  --source-dir force-app \
  --output-dir manifest

# Deploy with destructive changes
sf project deploy start \
  --manifest manifest/package.xml \
  --post-destructive-changes manifest/destructiveChangesPost.xml \
  --target-org <alias>
```

## Test Levels Explained

| Level | When to Use |
|-------|-------------|
| `NoTestRun` | Sandboxes (not Production), fast iteration |
| `RunSpecifiedTests` | When you know which tests cover your code |
| `RunLocalTests` | All local (non-managed) tests — required for Production |
| `RunAllTestsInOrg` | Full org validation including managed packages |

## Deployment Checklist

Before deploying to Production:
- [ ] Validate first with `--dry-run` or `deploy validate`
- [ ] Test coverage >= 75% (project target: 90%)
- [ ] Run local tests pass cleanly
- [ ] No pending scratch org-only config (permsets, test data)
- [ ] Review destructive changes manifest if deleting metadata

## Troubleshooting

- **INVALID_TYPE** errors: metadata type not in package.xml or API version mismatch
- **CANNOT_EXECUTE_FLOW_TRIGGER**: Flow version active in org conflicts with deployed version
- **Test failure on deploy**: Run `sf apex test run --target-org <alias>` to see details
- **Deploy stuck**: Use `sf project deploy cancel` then retry

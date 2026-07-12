---
name: sf-deploy
description: Salesforce CLI deployment skill for this project — deploy metadata to any org, retrieve metadata, validate, quick-deploy, and cancel stuck deploys. Use whenever the user wants to deploy, push, retrieve, validate, or promote Salesforce metadata, mentions package.xml or destructive changes, or asks "how do I get this to the sandbox/production" — even if they don't say "deploy".
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

If the project uses the sfdt CLI (`.sfdt/` directory present), prefer its deployment flow — it adds preflight checks, delta computation, smart test selection, and rollback:

```bash
sfdt preflight              # pre-deploy validation gates
sfdt deploy --smart         # delta deploy: only changed metadata, minimal safe test level
sfdt deploy --smart --dry-run   # validate-only
sfdt rollback               # roll back a deployment
```

Use the raw `sf` commands below when sfdt is not configured or for one-off operations.

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

A destructive deploy needs two files: a (possibly empty) `package.xml` and a `destructiveChangesPre.xml` or `destructiveChangesPost.xml` listing the members to delete (same XML format as package.xml).

```bash
# Deploy with destructive changes applied after the deploy
sf project deploy start \
  --manifest manifest/package.xml \
  --post-destructive-changes manifest/destructiveChangesPost.xml \
  --target-org <alias>
```

With sfdt: `sfdt manifest --destructive <path>` generates the destructive manifest from the git diff (deleted files).

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
- [ ] Test coverage >= 75% (or the project's configured threshold — `.sfdt/config.json` → `deployment.coverageThreshold`)
- [ ] Run local tests pass cleanly
- [ ] No pending scratch org-only config (permsets, test data)
- [ ] Review destructive changes manifest if deleting metadata

## Troubleshooting

- **INVALID_TYPE** errors: metadata type not in package.xml or API version mismatch
- **CANNOT_EXECUTE_FLOW_TRIGGER**: Flow version active in org conflicts with deployed version
- **Test failure on deploy**: Run `sf apex test run --target-org <alias>` to see details
- **Deploy stuck**: Use `sf project deploy cancel` then retry

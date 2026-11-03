---
name: sf-deploy
license: Apache-2.0
description: Deploys, validates, quick-deploys, retrieves, and cancels Salesforce metadata deployments with the sf CLI, with a confirmation gate before anything reaches a production org. Use when the user wants to deploy, retrieve, validate, or promote metadata to a sandbox or production, mentions package.xml or destructive changes, or asks "how do I get this to the sandbox/production", even without the word "deploy". Not for scratch-org source push/pull or org lifecycle (sf-scratch-org), or for running tests on their own (sf-test).
triggers:
  - deploy
  - retrieve
  - sf project deploy
  - push source
  - quick deploy
  - deployment
---

# Salesforce Deployment Skill

Handles Salesforce CLI (sf) deployment operations for a Salesforce DX project. Use the `sf` CLI, not the deprecated `sfdx` commands. Paths below use `force-app/main/default`; substitute the `packageDirectories` from `sfdx-project.json`.

If the project uses the sfdt CLI (`.sfdt/` directory present), prefer its deployment flow — it adds preflight checks, delta computation, smart test selection, and rollback:

```bash
sfdt preflight              # pre-deploy validation gates
sfdt deploy --smart         # delta deploy: only changed metadata, minimal safe test level
sfdt deploy --smart --dry-run   # validate-only
sfdt rollback               # roll back a deployment
```

Use the raw `sf` commands below when sfdt is not configured or for one-off operations.

## Before Deploying — Confirm, Then Check for Production

1. **Target org alias** — never guess; use `sf org list` to show available orgs.
   If the user omits `--target-org`, the CLI uses the default org — name it
   back to them before running anything.
2. **What to deploy** — specific path, package.xml manifest, or the whole package directory?
3. **Test level** — see the table below.
4. **Is the target production?** Check before every deploy, retrieve-and-redeploy, or destructive change:
   ```bash
   sf org display --target-org <alias> --json   # result.isSandbox / isScratch false → production
   ```
   With sfdt, `.sfdt/environments.json` entries marked `type: production` also count.
   If detection fails, treat the org as production.

### Production gate

When the target is production, stop and get explicit confirmation from the user
before each of these steps, stating the org alias and what will change:

```
- [ ] Validate first: `sf project deploy validate ...` (or `sfdt deploy --smart --dry-run`)
- [ ] Validation passed; tests and coverage meet the threshold
- [ ] Destructive manifest reviewed line by line, if anything is being deleted
- [ ] User confirmed: "deploy <scope> to <alias> (production)"
- [ ] Quick deploy the validated job: `sf project deploy quick --job-id <id>`
```

Never deploy straight to production without a passing validation, and never add
`--pre-destructive-changes` / `--post-destructive-changes` or run `sfdt rollback`
against production without a fresh confirmation for that step.

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

Source-tracked push/pull and conflict handling for scratch orgs live in `sf-scratch-org`.

## Destructive Changes

Deletes metadata from the target org — on production, this always goes through the production gate above. A destructive deploy needs two files: a (possibly empty) `package.xml` and a `destructiveChangesPre.xml` or `destructiveChangesPost.xml` listing the members to delete (same XML format as package.xml).

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
| `NoTestRun` | Sandboxes only, fast iteration — not allowed for Apex changes in production |
| `RunSpecifiedTests` | When you know which tests cover your code; in production each changed class/trigger needs ≥ 75% coverage from the named tests |
| `RunLocalTests` | All local (non-managed) tests — the production default when Apex changes |
| `RunAllTestsInOrg` | Full org validation including managed packages |

## Deployment Checklist

Before deploying to Production (in addition to the production gate):
- [ ] Validate first with `deploy validate` (or `sfdt deploy --smart --dry-run`)
- [ ] Test coverage >= 75% org-wide (or the deploy gate in `.sfdt/config.json` → `deployment.coverageThreshold`; see `sf-test`)
- [ ] Run local tests pass cleanly
- [ ] No pending scratch org-only config (permsets, test data)
- [ ] Review destructive changes manifest if deleting metadata

## Troubleshooting

- **INVALID_TYPE** errors: metadata type not in package.xml or API version mismatch
- **CANNOT_EXECUTE_FLOW_TRIGGER**: Flow version active in org conflicts with deployed version
- **Test failure on deploy**: Run `sf apex test run --target-org <alias>` to see details
- **Deploy stuck**: Use `sf project deploy cancel` then retry

**Next steps:** When a deploy fails on tests or coverage, hand off to `sf-test`. Before a production deploy of Apex that hasn't been reviewed, suggest `sf-apex-review` (and `sf-pmd-scan` for a static-analysis gate). Skip if the deploy succeeded and the user is done.

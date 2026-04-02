# sfdt CLI — Command Reference

Detailed reference for every sfdt command, including options, arguments, and internal behavior.

## Table of Contents

- [sfdt init](#sfdt-init)
- [sfdt deploy](#sfdt-deploy)
- [sfdt test](#sfdt-test)
- [sfdt quality](#sfdt-quality)
- [sfdt release](#sfdt-release)
- [sfdt pull](#sfdt-pull)
- [sfdt preflight](#sfdt-preflight)
- [sfdt rollback](#sfdt-rollback)
- [sfdt smoke](#sfdt-smoke)
- [sfdt review](#sfdt-review)
- [sfdt drift](#sfdt-drift)
- [sfdt notify](#sfdt-notify)
- [sfdt changelog](#sfdt-changelog)

---

## sfdt init

Initialize sfdt configuration for a Salesforce DX project. Creates the `.sfdt/` directory with four config files.

**Usage**: `sfdt init`

**No options or arguments.**

**Behavior**:
1. Detects project root by finding `sfdx-project.json`
2. If `.sfdt/` already exists, prompts to overwrite
3. Interactive prompts for: projectName, defaultOrg, coverageThreshold (default 75), aiEnabled
4. Auto-scans `force-app/` for `*Test*.cls` and all `.cls` files using glob
5. Creates: `config.json`, `environments.json`, `pull-config.json`, `test-config.json`

**Prerequisite**: Must be in a directory with `sfdx-project.json` (or a subdirectory of one).

---

## sfdt deploy

Deploy to a Salesforce org using the configured deployment script.

**Usage**: `sfdt deploy [--managed]`

**Options**:
| Flag | Description |
|------|-------------|
| `--managed` | Use `deploy-manager.sh` (structured, validation gates) instead of `deployment-assistant.sh` (interactive) |

**Scripts invoked**:
- Default: `scripts/core/deployment-assistant.sh`
- With `--managed`: `scripts/core/deploy-manager.sh`

---

## sfdt test

Run Apex tests with the enhanced test runner.

**Usage**: `sfdt test [--legacy] [--analyze]`

**Options**:
| Flag | Description |
|------|-------------|
| `--legacy` | Use `run-tests.sh` instead of `enhanced-test-runner.sh` |
| `--analyze` | Run `test-analyzer.sh` after tests complete |

**Behavior**:
1. Runs selected test script (catches errors, doesn't immediately exit on failure)
2. If `--analyze`: runs `quality/test-analyzer.sh` post-tests
3. If tests failed AND AI is enabled: offers AI-powered failure analysis with Bash, Read, Grep tools
4. Exits with code 1 if tests failed

**Scripts invoked**:
- Default: `scripts/core/enhanced-test-runner.sh`
- With `--legacy`: `scripts/core/run-tests.sh`
- With `--analyze`: additionally `scripts/quality/test-analyzer.sh`

---

## sfdt quality

Run code quality analysis and optionally generate an AI fix plan.

**Usage**: `sfdt quality [--tests] [--all] [--fix-plan]`

**Options**:
| Flag | Description |
|------|-------------|
| `--tests` | Run test-analyzer only (skip code-analyzer) |
| `--all` | Run both code-analyzer and test-analyzer |
| `--fix-plan` | Generate AI-powered fix plan grouped by severity |

**Behavior**:
- Default (no flags): runs `quality/code-analyzer.sh` only
- `--tests`: runs `quality/test-analyzer.sh` only
- `--all`: runs both analyzers
- `--fix-plan`: takes accumulated output and generates AI fix plan (requires AI enabled)

---

## sfdt release

Generate a release manifest and optionally AI-powered release notes.

**Usage**: `sfdt release [version]`

**Arguments**:
| Argument | Required | Description |
|----------|----------|-------------|
| `version` | No | Version label for the release |

**Behavior**:
1. Runs `scripts/core/generate-release-manifest.sh` (passes version as arg if provided)
2. If AI enabled and Claude available: prompts user to generate release notes
3. Release notes AI prompt analyzes `git log --oneline -30`
4. Output sections: What's New, Bug Fixes, Breaking Changes, Deployment Notes

---

## sfdt pull

Pull metadata changes from the default org.

**Usage**: `sfdt pull`

**No options or arguments.**

**Script invoked**: `scripts/core/pull-org-updates.sh`

Uses `pullConfig.metadataTypes` and `pullConfig.targetDir` from `.sfdt/pull-config.json`.

---

## sfdt preflight

Run pre-deployment validation checks.

**Usage**: `sfdt preflight [--strict]`

**Options**:
| Flag | Description |
|------|-------------|
| `--strict` | Fail on any warning (sets `SFDT_PREFLIGHT_STRICT=true`) |

**Script invoked**: `scripts/new/preflight.sh`

---

## sfdt rollback

Roll back a deployment to a target org.

**Usage**: `sfdt rollback [--org <alias>]`

**Options**:
| Flag | Description |
|------|-------------|
| `--org <alias>` | Target org alias (default: config.defaultOrg) |

**Environment**: Sets `SFDT_TARGET_ORG` to specified or default org.

**Script invoked**: `scripts/new/rollback.sh`

---

## sfdt smoke

Run post-deployment smoke tests against a target org.

**Usage**: `sfdt smoke [--org <alias>]`

**Options**:
| Flag | Description |
|------|-------------|
| `--org <alias>` | Target org alias (default: config.defaultOrg) |

**Environment**: Sets `SFDT_TARGET_ORG` to specified or default org.

**Script invoked**: `scripts/new/smoke.sh`

---

## sfdt review

AI-powered Salesforce code review of current branch changes.

**Usage**: `sfdt review [--base <branch>]`

**Options**:
| Flag | Description |
|------|-------------|
| `--base <branch>` | Base branch to diff against (default: `main`) |

**Requirements**: AI must be enabled AND Claude CLI must be available.

**Behavior**:
1. Runs `git diff <base>...HEAD` to get branch diff
2. Fails if no diff found (nothing to review)
3. Sends diff to Claude with Salesforce-specific review rules
4. Review criteria: Governor Limits, Security, Null Safety, Test Coverage, LWC Best Practices, Bulk Patterns

---

## sfdt drift

Detect metadata drift between local source and a target org.

**Usage**: `sfdt drift [--org <alias>]`

**Options**:
| Flag | Description |
|------|-------------|
| `--org <alias>` | Target org alias (default: config.defaultOrg) |

**Environment**: Sets `SFDT_TARGET_ORG` to specified or default org.

**Script invoked**: `scripts/new/drift.sh`

---

## sfdt notify

Send a notification to Slack for deployment events.

**Usage**: `sfdt notify <event> [--version <ver>] [--org <alias>] [--message <msg>]`

**Arguments**:
| Argument | Required | Description |
|----------|----------|-------------|
| `event` | Yes | One of: `deploy-success`, `deploy-failure`, `test-failure`, `release-created` |

**Options**:
| Flag | Description |
|------|-------------|
| `--version <ver>` | Version label to include in notification |
| `--org <alias>` | Org alias to include in notification |
| `--message <msg>` | Custom message text |

**Requirements**: `config.notifications.slack.webhookUrl` must be set in config.

**Behavior**: Builds a Slack Block Kit payload and POSTs to the webhook URL.

---

## sfdt changelog

Manage project CHANGELOG.md. Has three subcommands.

### sfdt changelog generate

Use AI to generate [Unreleased] entries from git history.

**Usage**: `sfdt changelog generate [--limit <number>]`

**Options**:
| Flag | Description |
|------|-------------|
| `--limit <number>` | Number of commits to analyze (default: 20) |

**Requirements**: AI enabled + Claude CLI available. Creates CHANGELOG.md from template if it doesn't exist.

### sfdt changelog release

Move [Unreleased] changes to a new version section.

**Usage**: `sfdt changelog release <version>`

**Arguments**:
| Argument | Required | Description |
|----------|----------|-------------|
| `version` | Yes | Version number for the release section |

**Environment**: Sets `SFDT_VERSION` for the changelog-utils.sh script.

### sfdt changelog check

Verify [Unreleased] content against git changes.

**Usage**: `sfdt changelog check`

**Behavior**: Checks `git status --porcelain` for uncommitted changes, verifies [Unreleased] has content, and reports sync status. Offers to generate entries if section is empty.

# sfdt CLI — Configuration Reference

## Config directory structure

Created by `sfdt init` in the project root as `.sfdt/`:

```
.sfdt/
  config.json         # Core settings and feature flags
  environments.json   # Org aliases and types  
  pull-config.json    # Metadata pull configuration
  test-config.json    # Test execution settings
```

## Config file schemas

### config.json (required)

```json
{
  "projectName": "My Salesforce Project",
  "defaultOrg": "dev-org-alias",
  "features": {
    "ai": true,
    "notifications": false,
    "releaseManagement": true
  },
  "ai": {
    "provider": "claude",
    "baseURL": "",
    "model": "",
    "apiKeyEnv": ""
  },
  "deployment": {
    "coverageThreshold": 75,
    "smart": {}
  },
  "manifestDir": "manifest/release",
  "notifications": {
    "enabled": true,
    "channels": [
      {
        "type": "slack",
        "webhookUrlEnv": "SLACK_WEBHOOK_URL",
        "events": ["deploy-failure", "snapshot"],
        "severityThreshold": "warn"
      }
    ]
  }
}
```

Notes:
- `ai.provider` is one of `claude` | `gemini` | `openai` | `http`. For `http`, set `ai.baseURL`, `ai.model`, and `ai.apiKeyEnv` — the **name** of the env var holding the API key; the key itself is never stored in config.
- Notification channel secrets are likewise referenced by env-var name (`webhookUrlEnv`, SMTP `*Env`). The legacy `notifications.slack.webhookUrl` shape still works for back-compat.
- The full shape (including `audit`, `monitoring`, `docs`, and `deployment.smart` blocks) lives in `src/templates/sfdt.config.json` — the canonical source of truth for keys and defaults.

**Required keys** (validated at load): `defaultOrg`, `features`. Config is validated by AJV against `src/lib/config-schema.json` with `additionalProperties: false` — an unknown key fails `validateConfig()` at load time.

### environments.json

```json
{
  "default": "dev-org-alias",
  "orgs": [
    { "alias": "dev", "type": "development", "description": "Developer sandbox" },
    { "alias": "staging", "type": "staging", "description": "UAT environment" },
    { "alias": "prod", "type": "production", "description": "Production org" }
  ]
}
```

### pull-config.json

```json
{
  "metadataTypes": [
    "ApexClass", "ApexTrigger", "ApexPage", "ApexComponent",
    "LightningComponentBundle", "FlexiPage", "Layout",
    "CustomObject", "CustomField", "PermissionSet", "Profile"
  ],
  "targetDir": "force-app/main/default"
}
```

### test-config.json

```json
{
  "coverageThreshold": 75,
  "testLevel": "RunLocalTests",
  "suites": [],
  "testClasses": ["MyClassTest", "AccountTriggerTest"],
  "apexClasses": ["MyClass", "AccountTrigger"]
}
```

`testClasses` and `apexClasses` are auto-populated by `sfdt init` from glob scans of `force-app/`.

## Config enrichment from sfdx-project.json

At load time, config is merged with values from `sfdx-project.json`:

| Enriched field | Source |
|---------------|--------|
| `sourceApiVersion` | `sfdx-project.json` → `sourceApiVersion` |
| `defaultSourcePath` | First entry in `packageDirectories` → `path` |

## Internal fields

These are injected by `loadConfig()` and available to commands:

| Field | Value |
|-------|-------|
| `_projectRoot` | Absolute path to project root (where `sfdx-project.json` lives) |
| `_configDir` | Absolute path to `.sfdt/` directory |

## SFDT_ environment variable mapping

`script-runner.js` flattens config into these env vars before executing shell scripts. This is the complete list — when adding a new var, update `buildScriptEnv()` in `src/lib/script-runner.js` AND this table AND the CLAUDE.md table.

### Standard config mapping

| Variable | Source | Default |
|----------|--------|---------|
| `SFDT_PROJECT_ROOT` | `config._projectRoot` | `''` |
| `SFDT_CONFIG_DIR` | `config._configDir` | `''` |
| `SFDT_PROJECT_NAME` | `config.projectName` | `'Salesforce Project'` |
| `SFDT_DEFAULT_ORG` | `config.defaultOrg` | `''` |
| `SFDT_SOURCE_PATH` | `config.defaultSourcePath` | `'force-app/main/default'` |
| `SFDT_MANIFEST_DIR` | `config.manifestDir` | `'manifest/release'` |
| `SFDT_RELEASE_NOTES_DIR` | `config.releaseNotesDir` | `'release-notes'` |
| `SFDT_API_VERSION` | `config.sourceApiVersion` | `''` |
| `SFDT_COVERAGE_THRESHOLD` | `config.deployment.coverageThreshold` | `'75'` |
| `SFDT_LOG_DIR` | `config.logDir` | (optional; scripts fall back to `${SFDT_PROJECT_ROOT}/logs`) |
| `SFDT_BACKUP_BEFORE_ROLLBACK` | `config.deployment.backupBeforeRollback` | `'true'` |
| `SFDT_PREFLIGHT_ENFORCE_TESTS` | `config.deployment.preflight.enforceTests` | `''` (unset = off) |
| `SFDT_PREFLIGHT_ENFORCE_BRANCH` | `config.deployment.preflight.enforceBranchNaming` | `''` |
| `SFDT_PREFLIGHT_ENFORCE_CHANGELOG` | `config.deployment.preflight.enforceChangelog` | `''` |
| `SFDT_PREFLIGHT_ENFORCE_GIT_CLEAN` | `config.deployment.preflight.enforceGitClean` | `'true'` (default on) |
| `SFDT_PREFLIGHT_ENFORCE_SFDX_PROJECT` | `config.deployment.preflight.enforceSfdxProject` | `'true'` (default on) |
| `SFDT_PREFLIGHT_ENFORCE_UNTRACKED` | `config.deployment.preflight.enforceUntrackedFiles` | `''` |
| `SFDT_PREFLIGHT_STRICT` | `config.deployment.preflight.strict` | `''` |
| `SFDT_FEATURE_*` | `config.features.*` | (camelCase → UPPER_SNAKE) |
| `SFDT_DEFAULT_ENV` | `config.environments.default` | `''` |
| `SFDT_ENV_ORGS` | `config.environments.orgs[].alias` | (comma-separated) |
| `SFDT_TEST_*` | `config.testConfig.*` | (flattened) |
| `SFDT_TEST_CLASSES` | `config.testConfig.testClasses` | (comma-separated) |
| `SFDT_APEX_CLASSES` | `config.testConfig.apexClasses` | (comma-separated) |
| `SFDT_NON_INTERACTIVE` | detected from `stdin` TTY or `options.interactive` | `'true'` when non-interactive |
| `SFDT_PACKAGE_DIRS` | `config.packageDirectories` | JSON array of all package paths |
| `SFDT_MANIFEST_LAYOUT` | `config.manifestLayout` | `'flat'` (`'flat'` or `'subpath'`) |
| `SFDT_CHANGELOG_DIR` | `config.changelogDir` | `'changelogs'` |
| `SFDT_PARALLEL_DELAY` | `config.testConfig.parallelDelay` | script default `1` (seconds between parallel batches; exported env wins) |
| `SFDT_DEFAULT_BRANCH` | `config.defaultBranch` | `'main'` (exported env wins) |

### Per-invocation env vars

Set by individual commands via `env:` option in `runScript()` calls — not part of the standard config flattening:

| Variable | Set by | Value |
|----------|--------|-------|
| `SFDT_TARGET_ORG` | rollback, smoke, drift, gui-server | `--org` option or `config.defaultOrg` |
| `SFDT_PREFLIGHT_STRICT` | preflight | `'true'` when `--strict` is passed |
| `SFDT_PACKAGE_TARGET` | manifest, release, changelog | `'all'` or a specific package name |
| `SFDT_RELEASE_NAME` | release, manifest | Full release label (semver, free-form, or date) |
| `SFDT_CHANGELOG_FILE` | release, changelog | Resolved changelog file path |
| `SFDT_DEPLOY_SOURCE_DIR` | deploy | Source directory path for folder-mode deploys; empty string for manifest-mode |
| `SFDT_SMOKE_TESTS` | smoke | Comma-joined `config.smokeTests.testClasses` |
| `SFDT_ANALYZER_INCLUDE_FIXES` | quality `--include-fixes` | `'true'` → Code Analyzer adds `--include-fixes --include-suggestions` |
| `SFDT_TAG_RELEASE` / `SFDT_CREATE_PR` / `SFDT_NOTIFY_SLACK` | deploy `--tag`/`--create-pr`/`--notify` | Post-deploy tagging, PR creation, notifications |
| `SFDT_DESTRUCTIVE_TIMING` | deploy | `'pre'` \| `'post'` (default) \| `'none'` \| `'only'` — when destructive changes apply |
| `SFDT_VALIDATION_JOB_ID` | deploy | A validation Id (`0Af…`) for Quick Deploy — promotes a prior validation via `sf project deploy quick` |

## Adding new config fields

When extending sfdt with new config, three places move in lockstep:

1. Add the key (with default) to `src/templates/sfdt.config.json` — the canonical template `sfdt init` reads
2. Add it to `src/lib/config-schema.json` — AJV validates with `additionalProperties: false`, so a key missing from the schema fails `validateConfig()` at runtime
3. Read it in the consuming code

Then, if applicable:

4. Add the env var mapping to `buildScriptEnv()` in `src/lib/script-runner.js`
5. Update the SFDT_ env var table in the project CLAUDE.md (and this file)
6. If the field should be prompted during init, update `src/commands/init.js`

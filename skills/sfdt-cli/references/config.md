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
  "deployment": {
    "coverageThreshold": 75
  },
  "manifestDir": "manifest/release",
  "notifications": {
    "slack": {
      "webhookUrl": "https://hooks.slack.com/..."
    }
  }
}
```

**Required keys** (validated at load): `defaultOrg`, `features`

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

`script-runner.js` flattens config into these env vars before executing shell scripts:

| Variable | Config source | Default |
|----------|--------------|---------|
| `SFDT_PROJECT_ROOT` | `_projectRoot` | `''` |
| `SFDT_CONFIG_DIR` | `_configDir` | `''` |
| `SFDT_PROJECT_NAME` | `projectName` | `'Salesforce Project'` |
| `SFDT_DEFAULT_ORG` | `defaultOrg` | `''` |
| `SFDT_SOURCE_PATH` | `defaultSourcePath` | `'force-app/main/default'` |
| `SFDT_MANIFEST_DIR` | `manifestDir` | `'manifest/release'` |
| `SFDT_API_VERSION` | `sourceApiVersion` | `''` |
| `SFDT_COVERAGE_THRESHOLD` | `deployment.coverageThreshold` | `'75'` |
| `SFDT_FEATURE_{KEY}` | `features.*` | (camelCase → UPPER_SNAKE) |
| `SFDT_DEFAULT_ENV` | `environments.default` | (from config) |
| `SFDT_ENV_ORGS` | `environments.orgs[].alias` | (comma-separated) |
| `SFDT_TEST_COVERAGE_THRESHOLD` | `testConfig.coverageThreshold` | (if defined) |
| `SFDT_TEST_LEVEL` | `testConfig.testLevel` | (if defined) |
| `SFDT_TEST_SUITES` | `testConfig.suites` | (comma-separated) |
| `SFDT_PULL_METADATA_TYPES` | `pullConfig.metadataTypes` | (comma-separated) |
| `SFDT_PULL_TARGET_DIR` | `pullConfig.targetDir` | (if defined) |

### Command-specific env vars

Some commands set additional env vars beyond the standard mapping:

| Variable | Set by | Value |
|----------|--------|-------|
| `SFDT_TARGET_ORG` | rollback, smoke, drift | `--org` option or `config.defaultOrg` |
| `SFDT_PREFLIGHT_STRICT` | preflight | `'true'` when `--strict` is passed |
| `SFDT_VERSION` | changelog release | The `<version>` argument |

## Adding new config fields

When extending sfdt with new config:

1. Add the field to the appropriate `.sfdt/*.json` file
2. Add the env var mapping to `buildScriptEnv()` in `src/lib/script-runner.js`
3. Update the SFDT_ env var table in the project CLAUDE.md
4. If the field should be prompted during init, update `src/commands/init.js`

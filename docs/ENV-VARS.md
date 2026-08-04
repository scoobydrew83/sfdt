# SFDT_ Environment Variables

`script-runner.js` flattens config into `SFDT_`-prefixed env vars before invoking shell scripts. The current mapping:

| Variable | Source |
|----------|--------|
| `SFDT_PROJECT_ROOT` | `config._projectRoot` |
| `SFDT_CONFIG_DIR` | `config._configDir` |
| `SFDT_PROJECT_NAME` | `config.projectName` (default: `"Salesforce Project"`) |
| `SFDT_DEFAULT_ORG` | `config.defaultOrg` |
| `SFDT_SOURCE_PATH` | `config.defaultSourcePath` (default: `"force-app/main/default"`) |
| `SFDT_MANIFEST_DIR` | `config.manifestDir` (default: `"manifest/release"`) |
| `SFDT_RELEASE_NOTES_DIR` | `config.releaseNotesDir` (default: `"release-notes"`) |
| `SFDT_API_VERSION` | `config.sourceApiVersion` |
| `SFDT_COVERAGE_THRESHOLD` | `config.deployment.coverageThreshold` (default: `75`) |
| `SFDT_LOG_DIR` | `config.logDir` (optional; scripts fall back to `${SFDT_PROJECT_ROOT}/logs`) |
| `SFDT_TARGET_ORG` | Set by `gui-server.js` when running drift/preflight from the GUI; overrides `SFDT_DEFAULT_ORG` for that run |
| `SFDT_BACKUP_BEFORE_ROLLBACK` | `config.deployment.backupBeforeRollback` (default: `true`) |
| `SFDT_PREFLIGHT_ENFORCE_TESTS` | `"true"` when `config.deployment.preflight.enforceTests` is set; gates Apex test check in preflight |
| `SFDT_PREFLIGHT_ENFORCE_BRANCH` | `"true"` when `config.deployment.preflight.enforceBranchNaming` is set; promotes branch WARN to FAIL |
| `SFDT_PREFLIGHT_ENFORCE_CHANGELOG` | `"true"` when `config.deployment.preflight.enforceChangelog` is set; promotes CHANGELOG WARN to FAIL |
| `SFDT_PREFLIGHT_ENFORCE_GIT_CLEAN` | `"true"` (default) unless `config.deployment.preflight.enforceGitClean` is `false`; gates git-clean check |
| `SFDT_PREFLIGHT_ENFORCE_SFDX_PROJECT` | `"true"` (default) unless `config.deployment.preflight.enforceSfdxProject` is `false`; gates sfdx-project.json check |
| `SFDT_PREFLIGHT_ENFORCE_UNTRACKED` | `"true"` when `config.deployment.preflight.enforceUntrackedFiles` is set; gates untracked-files check in force-app/ |
| `SFDT_PREFLIGHT_STRICT` | `"true"` when `config.deployment.preflight.strict` is set; promotes all WARNs to FAILs (**overrides the per-check flags** — a check left as a WARN by `enforceX: false` is still promoted to a failure under strict) |
| `SFDT_FEATURE_*` | Flattened from `config.features` |
| `SFDT_DEFAULT_ENV` | `config.environments.default` |
| `SFDT_ENV_ORGS` | Comma-joined org aliases from `config.environments.orgs` |
| `SFDT_TEST_*` | Flattened from `config.testConfig` |
| `SFDT_TEST_CLASSES` | Comma-joined test class names from `config.testConfig.testClasses` |
| `SFDT_APEX_CLASSES` | Comma-joined Apex class names from `config.testConfig.apexClasses` |
| `SFDT_NON_INTERACTIVE` | `"true"` when stdin is not a TTY or `options.interactive === false` |
| `SFDT_PARALLEL_DELAY` | Seconds between parallel batch launches, from `config.testConfig.parallelDelay` when set (a user-exported env value wins); shell-script default `1` otherwise |
| `SFDT_DEFAULT_BRANCH` | `config.defaultBranch` (default: `"main"`); a user-exported env value wins. Used by `deployment-assistant.sh` for PR base branch |
| `SFDT_SMOKE_TESTS` | Per-invocation: comma-joined `config.smokeTests.testClasses`, set by `smoke.js` (a user-exported env value wins) |
| `SFDT_ANALYZER_INCLUDE_FIXES` | Per-invocation: `"true"` from `quality --include-fixes`; `scripts/quality/code-analyzer.sh` adds `--include-fixes --include-suggestions` to the Code Analyzer v5 run |
| `SFDT_ANALYZER_OUTPUT_FILE` | Per-invocation: from `quality --output-file <path>`; `scripts/quality/code-analyzer.sh` adds a second `--output-file` to the Code Analyzer v5 run (format inferred from the extension, e.g. `.sarif`) |
| `SFDT_TAG_RELEASE` / `SFDT_CREATE_PR` / `SFDT_NOTIFY_SLACK` | Per-invocation: `"true"` from `deploy --tag/--create-pr/--notify` (or the GUI Release Hub toggles); drive post-deploy tagging, PR creation, and notifications in `deployment-assistant.sh` |
| `SFDT_PACKAGE_DIRS` | JSON array of all package paths from `config.packageDirectories`, e.g. `["force-app/main/default","force-app/feature-a"]` |
| `SFDT_MANIFEST_LAYOUT` | `config.manifestLayout` (`"flat"` or `"subpath"`); default `"flat"` |
| `SFDT_CHANGELOG_DIR` | `config.changelogDir` (default: `"changelogs"`); directory for per-package changelog files |
| `SFDT_PACKAGE_TARGET` | Per-invocation: `"all"` or a specific package name; passed via `env:` option in `runScript()` calls |
| `SFDT_RELEASE_NAME` | Per-invocation: full release label (semver, free-form, or date); passed via `env:` option |
| `SFDT_CHANGELOG_FILE` | Per-invocation: resolved changelog file path (e.g., `changelogs/marketing.md` or `CHANGELOG.md`); set by `release.js` and `changelog.js` |
| `SFDT_DEPLOY_SOURCE_DIR` | Per-invocation: source directory path for folder-mode deploys; empty string for manifest-mode; passed via `env:` option |
| `SFDT_DESTRUCTIVE_TIMING` | Per-invocation: one of `"pre"`, `"post"`, `"none"`, `"only"`; controls when destructive changes are applied during deploy (default: `"post"`). `none` skips destructiveChanges, `only` runs ONLY destructive operations |
| `SFDT_VALIDATION_JOB_ID` | Per-invocation: a Salesforce deploy validation Id (`0Af…`) for Quick Deploy; when set, `core/deployment-assistant.sh` calls `sf project deploy quick` to promote the prior validation instead of running a full deploy |
| (removed) | `pullConfig` is consumed directly by `pull.js`; no longer flattened to env vars |

> Note: for the opt-in enforce flags (`enforceTests`, `enforceBranchNaming`, `enforceChangelog`, `enforceUntrackedFiles`), "is set" means **truthy** — `false` is indistinguishable from omitting the key, and both leave the check as a non-fatal WARN (they never actively suppress it). Only `enforceGitClean`/`enforceSfdxProject` are default-on (`!== false`). All preflight flags are editable from the GUI Settings page (an inline caution is shown; they are no longer API-locked).

When adding a new env var, update both `buildScriptEnv()` in `script-runner.js` and this table.

## Env vars read directly (not flattened into scripts)

These are read by the CLI itself rather than passed to shell scripts, so they are not in
`buildScriptEnv()`.

| Variable | Effect |
|----------|--------|
| `SFDT_ALLOW_UNSAFE_CONFIG` | Set to exactly `1` to load the `.sfdt/config.json` keys that are otherwise refused: `plugins[]`, `mcp.salesforce.command`/`args`, a non-loopback `ai.baseURL`, and a notification channel's `headersEnv` beside a literal remote URL. See [ARCHITECTURE §18](./ARCHITECTURE.md#18-threat-boundaries) |

`config.json` is committed by convention (`sfdt init` gitignores only `*.local.json`), so it
arrives with whatever repository was cloned. The keys above execute code or choose where
env-var-named secrets are sent, so they are stripped at load time with a message naming what was
refused. **The opt-in has to be an environment variable**: a flag inside `config.json` would be set
by the same attacker who set the dangerous key. Anything else in the config loads normally.

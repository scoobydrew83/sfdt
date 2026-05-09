# CLAUDE.md — sfdt CLI

## Project Overview

This is `@sfdt/cli`, a Node.js ESM CLI package for Salesforce DX deployment, testing, quality analysis, and release management. It is a **generic tool** — it works with any Salesforce DX project and contains no project-specific values.

## Architecture

- **CLI framework**: Commander.js for command routing
- **Shell execution**: execa for running shell scripts and sf CLI commands
- **Module system**: ESM (`"type": "module"` in package.json)
- **Entry point**: `bin/sfdt.js`

### Directory Structure

```
bin/            CLI entry point (loads plugins, then parses args)
src/
  commands/     Command modules (one file per command)
  lib/          Shared libraries (config, output, AI, script-runner, project-detect, metadata-mapper, plugin-loader, gui-server)
scripts/        Shell scripts executed by commands (de-parameterized, use SFDT_ env vars)
                Exception: scripts/postinstall.js is a Node.js ESM file run by npm on install
test/           Tests (vitest)
gui/            React + Vite web dashboard (sfdt ui); built output lives in gui/dist/
Dockerfile      Official Docker image definition
.sfdt/          Per-project config directory (created by `sfdt init` in target projects)
  plugins/      Optional local JS plugins loaded automatically at startup
```

### Key Patterns

- **Commands** in `src/commands/` export a function that receives the Commander program and registers a subcommand.
- **Shell scripts** in `scripts/` are de-parameterized — they read configuration from `SFDT_` prefixed environment variables, not from positional arguments. The `script-runner.js` lib handles setting these vars and invoking scripts. `scripts/postinstall.js` is an exception — it is a Node.js ESM script invoked by npm's `postinstall` lifecycle hook, not by `script-runner.js`.
- **Config system** uses a `.sfdt/` directory created per-project. Config is loaded by `src/lib/config.js`. At load time, config is enriched with values from `sfdx-project.json` (e.g. `sourceApiVersion`, `defaultSourcePath` derived from `packageDirectories`).
- **AI features** are optional and gated behind `features.ai` in config. The provider is selected by `ai.provider` (`claude` | `gemini` | `openai`). Claude requires the Claude Code CLI; Gemini and OpenAI use native `fetch` with an API key from `ai.apiKey` or the corresponding env var. Use `isAiAvailable(config)` / `aiUnavailableMessage(config)` from `src/lib/ai.js` instead of the legacy `isClaudeAvailable()`.
- **Plugin system** (`src/lib/plugin-loader.js`) runs before argument parsing. Plugins are loaded from: (1) `config.plugins[]` package names, (2) `sfdt-plugin-*` packages auto-discovered in the project's `node_modules/`, (3) `.sfdt/plugins/*.js` local files. Each plugin exports `register(program)`.
- **Web UI** (`src/commands/ui.js` + `src/lib/gui-server.js`) starts a local Express server on port 7654 serving a pre-built React/SLDS dashboard from `gui/dist/`. Build with `npm run build:gui`.
- **File matching** uses the `glob` package (v11) for pattern-based file discovery.
- **Metadata mapping** (`src/lib/metadata-mapper.js`) provides a pure-JS mirror of `scripts/lib/metadata-parser.sh` for use in Node commands. Used by `manifest` and `pr-description`.

### SFDT_ Environment Variables

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
| `SFDT_PREFLIGHT_STRICT` | `"true"` when `config.deployment.preflight.strict` is set; promotes all WARNs to FAILs |
| `SFDT_FEATURE_*` | Flattened from `config.features` |
| `SFDT_DEFAULT_ENV` | `config.environments.default` |
| `SFDT_ENV_ORGS` | Comma-joined org aliases from `config.environments.orgs` |
| `SFDT_TEST_*` | Flattened from `config.testConfig` |
| `SFDT_TEST_CLASSES` | Comma-joined test class names from `config.testConfig.testClasses` |
| `SFDT_APEX_CLASSES` | Comma-joined Apex class names from `config.testConfig.apexClasses` |
| `SFDT_NON_INTERACTIVE` | `"true"` when stdin is not a TTY or `options.interactive === false` |
| `SFDT_PARALLEL_DELAY` | Seconds between parallel batch launches (default: `1`, set in shell scripts) |
| `SFDT_PACKAGE_DIRS` | JSON array of all package paths from `config.packageDirectories`, e.g. `["force-app/main/default","force-app/feature-a"]` |
| `SFDT_MANIFEST_LAYOUT` | `config.manifestLayout` (`"flat"` or `"subpath"`); default `"flat"` |
| `SFDT_CHANGELOG_DIR` | `config.changelogDir` (default: `"changelogs"`); directory for per-package changelog files |
| `SFDT_PACKAGE_TARGET` | Per-invocation: `"all"` or a specific package name; passed via `env:` option in `runScript()` calls |
| `SFDT_RELEASE_NAME` | Per-invocation: full release label (semver, free-form, or date); passed via `env:` option |
| `SFDT_CHANGELOG_FILE` | Per-invocation: resolved changelog file path (e.g., `changelogs/marketing.md` or `CHANGELOG.md`); set by `release.js` and `changelog.js` |
| `SFDT_DEPLOY_SOURCE_DIR` | Per-invocation: source directory path for folder-mode deploys; empty string for manifest-mode; passed via `env:` option |
| (removed) | `pullConfig` is consumed directly by `pull.js`; no longer flattened to env vars |

When adding a new env var, update both `buildScriptEnv()` in `script-runner.js` and this table.

### Config Template

`src/templates/sfdt.config.json` is the canonical source of truth for the shape and defaults of `.sfdt/config.json`. `sfdt init` reads this template via `fs.readJson` and deep-merges user-provided answers on top. When adding new config keys, add them to the template first — `init.js` will pick them up automatically.

### Known Gaps

- **GUI not pre-built in dev**: `gui/dist/` must be compiled with `npm run build:gui` before `sfdt ui` shows the full dashboard. The server falls back to a build-instructions page when `dist/` is absent.

### Error Handling

- Commands should throw descriptive `Error` objects; the CLI entry point catches and formats them.
- `runScript()` throws on non-zero exit codes with stdout/stderr attached to the error.
- Config loading throws early with actionable messages (e.g. "Run `sfdt init` first").

## Development

```bash
npm test              # Run tests (vitest)
npm run lint          # ESLint
npm run test:coverage # Coverage report
npm link              # Link for local development
```

### GUI Development & Testing

The GUI (`gui/src/`) must be compiled before the server serves it. `gui/dist/` is NOT auto-rebuilt on source changes.

#### Step 1 — Build and link (run from sfdt package root)

```bash
npm run dev:ui
# Equivalent to: npm run build:gui && npm link
```

This ensures the `sfdt` binary on PATH resolves to THIS package, not a globally published version.

#### Step 2 — Verify the link

```bash
ls -la $(which sfdt)
# Must show a symlink into <sfdt-package-root>/bin/sfdt.js
# If it points elsewhere, re-run: npm link
```

#### Step 3 — Start against the Salesforce project

```bash
cd /path/to/your-sf-project   # or any project with .sfdt/config.json
sfdt ui                                   # starts server at http://localhost:7654
```

#### After any GUI source change

```bash
# From sfdt package root:
npm run build:gui
# Kill and restart `sfdt ui` in the SF project directory
pkill -f "sfdt ui"
cd /path/to/your-sf-project && sfdt ui
```

#### CRITICAL: Always verify before testing

Before testing or reporting on GUI behaviour in any session:
1. `ls -la $(which sfdt)` — confirm it links into the sfdt dev directory
2. `npm run build:gui` — confirm `gui/dist/` reflects the latest source changes
3. Start `sfdt ui` from the SF project, not from the sfdt package root

### Package-Internal Path Resolution — CRITICAL RULE

**Any path that references a file INSIDE the sfdt package** (scripts/, templates/, gui/dist/, bin/) MUST be resolved using `import.meta.url`, never from `process.cwd()`, `config._projectRoot`, or any CWD-based reference.

When globally installed, `config._projectRoot` points to the *user's Salesforce project*, not the sfdt package. Using it to find package files causes "No such file or directory" errors on any machine other than the developer's.

**WRONG — breaks on other machines:**
```js
path.join(config._projectRoot, 'scripts/ops/preflight.sh')
path.join(projectRoot, 'scripts/lib/changelog-utils.sh')
path.resolve(process.cwd(), 'scripts/...')
```

**CORRECT — always resolves from the npm package location:**
```js
// At the top of every file that needs package assets:
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCRIPTS_DIR = path.resolve(__dirname, '..', '..', 'scripts');  // from src/commands/ or src/lib/

// Then use it:
path.join(SCRIPTS_DIR, 'ops/preflight.sh')
path.join(SCRIPTS_DIR, 'lib/changelog-utils.sh')
```

The depth of `../..` depends on the file's location:
- From `src/commands/` or `src/lib/` → `'..', '..', 'scripts'` reaches package root
- From `bin/` → `'..', 'scripts'`

**Run `/validate-npm-paths` before every release** to catch violations.

## Guidelines

- Do not hardcode org aliases, branch names, or project-specific values
- All external tool dependencies (sf, gh, claude, bash) must be checked at runtime before use
- Shell scripts must be POSIX-compatible where possible; bash 4.0+ features are acceptable
- Use chalk for colored output, ora for spinners, inquirer for prompts
- Test with vitest; mock execa calls for shell script tests
- Keep commands thin — delegate logic to `src/lib/` or `scripts/`

# Development Guide

Working-session reference for developing `@sfdt/cli` itself. Moved from CLAUDE.md (harness H-008 map split). Rules with teeth live in [golden-principles.md](./golden-principles.md); patterns in [PATTERNS.md](./PATTERNS.md).

## Commands

```bash
npm test              # Run tests (vitest)
npm run lint          # ESLint
npm run test:coverage # Coverage report
npm link              # Link for local development
```

## Changing a Public Surface

`generated/` holds machine-generated catalogs of every public surface (commands, chrome features, GUI pages, VS Code commands, MCP tools, bridge kinds, CI capabilities, packages, parity matrix, summary). **Code is authoritative; the catalogs are derived and checked in.** CI fails on drift (`npm run check:all-contracts`). Never edit `generated/*` by hand. When you change a public surface, run `npm run generate:catalogs` and commit the diff. Specifically:

- **New/changed CLI command or flag** → add/update its `src/lib/command-policy.js` entry (mutating/requiresOrg/surfaces/mcpTools — enforced by `test/command-policy.test.js`), then regenerate.
- **New MCP tool** → map it in a command's `mcpTools` (or `MCP_INTERNAL_TOOLS`); a mutating tool MUST declare `confirmExecution`. The `sfdt_audit`/`sfdt_monitor` check enums derive from the runners' `CHECK_IDS` — never hardcode them.
- **New Chrome feature** → it must appear in `extension/lib/feature-manifests.json`; regenerate with `SFDT_WRITE_MANIFESTS=1 npm run test:extension -- feature-manifests` (parity-tested against the real registrations), then regenerate catalogs.
- **New GUI page** → add one entry to `gui/src/routes.js` (the single registry; App.jsx derives nav/labels/rendering from it) plus its ICONS/PAGES map entries, then regenerate.
- **CI provider/type/auth/runner change** → `src/lib/ci-capabilities.js` is the only place lists live.
- **License or Node-floor change** → update `tools/license-policy.json` / `package.json` engines; `check:licenses`/`check:node` enforce every other statement of them.

## GUI Development & Testing

The GUI (`gui/src/`) must be compiled before the server serves it. `gui/dist/` is NOT auto-rebuilt on source changes. The server falls back to a build-instructions page when `dist/` is absent.

### Step 1 — Build and link (run from sfdt package root)

```bash
npm run dev:ui
# Equivalent to: npm run build:gui && npm link
```

This ensures the `sfdt` binary on PATH resolves to THIS package, not a globally published version.

### Step 2 — Verify the link

```bash
ls -la $(which sfdt)
# Must show a symlink into <sfdt-package-root>/bin/sfdt.js
# If it points elsewhere, re-run: npm link
```

### Step 3 — Start against the Salesforce project

```bash
cd /path/to/your-sf-project   # or any project with .sfdt/config.json
sfdt ui                       # starts server at http://localhost:7654
```

### After any GUI source change

```bash
# From sfdt package root:
npm run build:gui
# Kill and restart `sfdt ui` in the SF project directory
pkill -f "sfdt ui"
cd /path/to/your-sf-project && sfdt ui
```

### CRITICAL: Always verify before testing

Before testing or reporting on GUI behaviour in any session:
1. `ls -la $(which sfdt)` — confirm it links into the sfdt dev directory
2. `npm run build:gui` — confirm `gui/dist/` reflects the latest source changes
3. Start `sfdt ui` from the SF project, not from the sfdt package root

## Package-Internal Path Resolution (golden principle #8)

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
```

The depth of `../..` depends on the file's location: from `src/commands/` or `src/lib/` → `'..', '..', 'scripts'`; from `bin/` → `'..', 'scripts'`.

**Run `/validate-npm-paths` before every release** to catch violations. Also enforced by `tools/check-package-internal-paths.mjs` (`check:all-contracts`).

## Documentation Site (sfdt.dev)

The public docs/support site lives in a **separate repo**: `https://github.com/scoobydrew83/sfdt-site`, deployed to Cloudflare Pages and served at **https://sfdt.dev/**. It's a Nextra 4 (Next.js App Router) static export; content is MDX under `content/`, with `_meta.js` files controlling nav order. It documents the whole SFDT suite — the `@sfdt/cli`, the Chrome extension, and the VS Code extension.

**Keep the site current.** Whenever a change here adds, removes, or alters user-facing behaviour — a new command/subcommand, a new flag, a config key, a changed default, a new feature gate — update the matching MDX in `sfdt-site/content/` in the same effort (or open a follow-up). The CLI repo and the site are released together; stale docs on a public site are a bug. After merging a feature or cutting a release, do a docs-staleness pass over `sfdt-site` (command list, flags, config reference, version/changelog highlights) before considering the work done.

## Error Handling

- Commands should throw descriptive `Error` objects; the CLI entry point catches and formats them.
- `runScript()` throws on non-zero exit codes with stdout/stderr attached to the error.
- Config loading throws early with actionable messages (e.g. "Run `sfdt init` first").

## Guidelines

- Do not hardcode org aliases, branch names, or project-specific values
- All external tool dependencies (sf, gh, claude, bash) must be checked at runtime before use
- Shell scripts must be POSIX-compatible where possible; bash 4.0+ features are acceptable
- Use chalk for colored output, ora for spinners, inquirer for prompts
- Test with vitest; mock execa calls for shell script tests
- Keep commands thin — delegate logic to `src/lib/` or `scripts/` (golden principle #1)
- User-facing changes must be mirrored to the docs site (`sfdt-site`, https://sfdt.dev/) — see above

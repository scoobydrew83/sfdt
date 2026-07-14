# SFDT Architecture

> For end-user command walkthroughs see [USAGE.md](USAGE.md); for the plugin API see
> [PLUGINS.md](PLUGINS.md); for the MCP server see [MCP.md](MCP.md). This document is for
> contributors: how the pieces fit, why they fit that way, and what to touch when you add things.

## 1. System context

SFDT (Salesforce DevTools) is a DevOps toolkit for any Salesforce DX project: deployment,
testing, org health, quality analysis, metadata intelligence, and release management. It is
deliberately generic — no org aliases, branch names, or project-specific values are baked in.

One codebase ships several **surfaces** over the same engine:

| Surface | What it is | Entry |
|---------|-----------|-------|
| CLI | `@sfdt/cli` on npm; the engine everything else drives | `sfdt <command>` |
| GUI dashboard | Local Express server + prebuilt React app | `sfdt ui` (port 7654) |
| Chrome extension | "SFDT SF Helper" — in-page tools on Salesforce Setup/Flow Builder/record pages | `extension/` (WXT) |
| VS Code extension | `sfdt.sfdt-devtools` — CLI-backed command center inside the editor | `vscode/` |
| Salesforce CLI plugin | `@sfdt/plugin` — exposes every command as `sf sfdt <command>` | `packages/plugin/` |
| MCP server | Read/write tools for AI agents over stdio | `sfdt mcp` (`src/lib/mcp-server.js`) |
| GitHub Action | Composite action, `uses: scoobydrew83/sfdt@v0` | `action.yml` |
| Docker / Homebrew | GHCR multi-arch image; Homebrew tap `scoobydrew83/homebrew-sfdt` | `Dockerfile`, tap repo |

The public docs site (https://sfdt.dev/) lives in a separate repo (`sfdt-site`) and must be
updated alongside any user-facing change here.

The CLI is pure ESM, no transpilation, targeting Node `>=22.15.0` (the `engines` floor in
`package.json` — `tools/check-node-version-consistency.mjs` enforces that every other place a
Node version appears agrees with it).

## 2. Package topology

The repo is an npm-workspaces monorepo. Root = `@sfdt/cli`; workspaces = `gui`, `extension`,
`host`, `vscode`, `packages/*` (see `generated/packages.json` for the authoritative list with
versions).

```
@sfdt/flow-core (packages/flow-core)   pure-TS shared core, zero UI deps
        ▲            ▲          ▲           ▲
        │            │          │           │
   @sfdt/cli       gui/    extension/    host/ (@sfdt/host)
        ▲
        │ (spawns the sfdt binary / reads its JSON output)
   @sfdt/plugin (packages/plugin)   ·   vscode/ (sfdt-devtools)
```

- **`@sfdt/flow-core`** is the only shared library. It is built with `tsc` to `dist/`, and every
  other build (`build:gui`, `build:ext`, `build:vscode`, `pretest`) builds it first because
  package `exports` resolve to the compiled output.
- **`@sfdt/plugin`** resolves `@sfdt/cli` at runtime via `require.resolve` (overridable with
  `SFDT_CLI_ENTRYPOINT`); its codegen and tests import the CLI from local source by relative
  path, because npm does not symlink the monorepo *root* package into `node_modules`. It
  declares `@sfdt/cli` as a `>=` dependency (not an exact pin) so the version-bump commit's
  `npm ci` never 404s on a not-yet-published version; the two always publish together.
- **`@sfdt/host`** is launched by Chrome (not by the CLI), so it cannot discover a project from
  its cwd — it reads a pointer file (`~/.config/sfdt-host.json`, written by
  `sfdt extension install-host`) to find the project's `logs/` and `.sfdt/config.json`.
- **`vscode/`** publishes to the Marketplace, which rejects scoped names — its manifest `name`
  is unscoped (`sfdt-devtools`), so root scripts select it by path (`-w vscode`), not by name.

All packages are Apache-2.0; `tools/check-license-consistency.mjs` enforces manifest/LICENSE/prose
agreement.

## 3. CLI command lifecycle

```
bin/sfdt.js
  → createCli()                 src/cli.js — builds the Commander program, registers every
                                src/commands/*.js module (one register function per command)
  → loadPlugins(program)        src/lib/plugin-loader.js — BEFORE parseAsync, so plugin
                                commands appear in --help and completion
  → program.parseAsync(argv)
        → command module action
              → src/lib/*.js runner (native Node), or
              → runScript() via src/lib/script-runner.js (shell script)
```

Plugins load from three sources: `config.plugins[]` package names, any `sfdt-plugin-*` package
in the project's `node_modules/`, and local `.sfdt/plugins/*.js` files. Each exports
`register(program)`.

**The SFDT_ env-var contract.** Shell scripts take *no positional configuration*. Before
spawning a script with execa (`stdio: 'inherit'` for full TTY passthrough), `script-runner.js`'s
`buildScriptEnv()` flattens the loaded config into `SFDT_`-prefixed environment variables
(`SFDT_PROJECT_ROOT`, `SFDT_DEFAULT_ORG`, `SFDT_API_VERSION`, …). The full variable table is
maintained in the repo `CLAUDE.md` ("SFDT_ Environment Variables") — when you add one, update
both `buildScriptEnv()` and that table.

Commands that support `--json` emit the Salesforce sf-native envelope on stdout via
`emitJson()`/`emitJsonError()` in `src/lib/output.js` — `{ status, result, warnings }`. This is a
**stdout-only** contract: on-disk snapshot files stay raw (§8), and the MCP server is the only
consumer that unwraps `.result`.

Package-internal paths (scripts/, templates/, `gui/dist/`) are always resolved from
`import.meta.url`, never from cwd or `config._projectRoot` — a globally installed CLI runs with
its cwd inside the *user's* project. `/validate-npm-paths` checks this before releases.

## 4. Configuration resolution

`sfdt init` creates a per-project `.sfdt/` directory. At load time (`src/lib/config.js`):

1. `.sfdt/config.json` is read and validated with AJV against `src/lib/config-schema.json`
   (`additionalProperties: false` on every object — unknown keys fail fast with a named path).
2. Sibling files (`environments.json`, `pull-config.json`, `test-config.json`) are merged in.
3. The result is enriched from `sfdx-project.json`: `sourceApiVersion`, and `defaultSourcePath`
   derived from `packageDirectories`.
4. Internal keys `_configDir` and `_projectRoot` are attached.

**Three-place lockstep.** Adding a config key means touching: the canonical template
(`src/templates/sfdt.config.json` — `init` deep-merges answers onto it), the AJV schema, and the
consuming code. A key present in the template but missing from the schema fails
`validateConfig()` at runtime.

## 5. Script vs native-Node ownership

The original core is bash; new features are native Node. Current split:

- **Still bash** (`scripts/`): the interactive deployment assistant and test runner
  (`scripts/core/`), preflight/drift/rollback/smoke (`scripts/ops/`), Code Analyzer and test
  quality (`scripts/quality/`), shared shell utilities (`scripts/lib/`), and the CI pipeline
  templates + partials (`scripts/ci/`). These are battle-tested `sf`-CLI orchestrations with
  interactive TTY flows that would be costly to port; they stay POSIX-leaning bash and read only
  `SFDT_` vars. Exception: `scripts/postinstall.js` is a Node ESM file run by npm's lifecycle
  hook, not by script-runner.
- **Native Node** (`src/lib/`): everything added since — audit/monitor runners, smart deploy,
  pull (SQLite delta cache), compare, dependencies, doc generator, data runner, scratch pool,
  notifier, run history, retrofit, PR decoration, and all servers. Native code gets structured
  errors, `--json` envelopes, and unit tests; bash gets neither, which is why the boundary only
  moves in one direction.

`src/lib/metadata-mapper.js` is a pure-JS mirror of `scripts/lib/metadata-parser.sh` so Node
commands (`manifest`, `pr-description`, smart deploy) don't shell out for type mapping.

## 6. Shared core: @sfdt/flow-core

`packages/flow-core/src/` is pure TypeScript with no Salesforce or UI dependencies, so the same
logic runs in Node (CLI, host) and the browser (GUI, Chrome extension):

- **Flow analysis & scoring** — `rules.ts`, `scorer.ts`, `flow-quality.ts`, plus
  `subflow-graph.ts`, `trigger-conflicts.ts`, `scheduled-calc.ts`.
- **Bridge contract** — `bridge-contract.ts` defines the `SfdtRequest`/`SfdtResponse`
  discriminated union, the protocol version, and a validator (§7).
- **Org release & health** — `org-release.ts`, `org-health-checks.ts`, `health-findings.ts`.
- **Dependency intelligence** — `dependencies.ts` (shared `METADATA_TYPE_REGISTRY` used by both
  the CLI `dependencies` command and the GUI graph) and `dependency-parsers.ts` (source-parsed
  "inferred" edges the Tooling API misses).
- **Misc shared logic** — API-name generation, coverage math, metadata cleaning, prompts.

It publishes to npm first in every release because `@sfdt/cli` depends on it at runtime. The CLI
imports it lazily in server paths so `sfdt ui` can boot with a helpful error before
`npm run build:flow-core` has run in a dev checkout.

## 7. Bridge and native host

The Chrome extension needs local capabilities (drift, quality scoring with project context,
deploys). Two transports serve one contract:

1. **HTTP bridge** — mounted at `/api/bridge/` by the GUI server (`src/lib/bridge/`):
   - `GET /api/bridge/ping` — CORS-only discovery probe; also delivers the kill-switch list.
   - `POST /api/bridge/exchange` — the request router. Requires a Bearer token and an allowed
     Origin. Payloads are validated by flow-core's contract validator before any handler runs;
     each envelope carries a `requestId` echoed back so concurrent calls pair up.
2. **Native messaging host** (`host/`) — fallback when `sfdt ui` isn't running. Chrome launches
   it via `chrome.runtime.connectNative('com.sfdt.host')`; messages are length-framed JSON per
   Chrome's native-messaging protocol. Its dispatcher deliberately mirrors the HTTP one, so the
   extension is written against a single `SfdtRequest`/`SfdtResponse` contract regardless of
   transport.

The contract is versioned (`protocolVersion`, currently 1.2 — see
`generated/bridge-contract.json` for the authoritative kind list). Each kind declares
`mutating` and `nativeHost`. **The native host is read-only by design**: mutating kinds
(`deploy`, `rollback`) and `ai` are bridge-only (`nativeHost: false`) — a Chrome-launched
process with no visible terminal must never deploy or invoke a paid AI backend; those flows
require the user to have deliberately started `sfdt ui`.

Auth: the bridge token is a user-global secret in `~/.sfdt/bridge-token` (created lazily,
chmod 0600), pasted once into the extension's options page. It is a bearer token rather than the
CSRF token because the bridge serves *cross-origin* callers (Salesforce domains and
`chrome-extension://` origins, matched by anchored regex allowlists in
`src/lib/bridge/middleware.js`).

Kill switch: `.sfdt/feature-flags.json`'s `disabled[]` (managed by `sfdt feature-flags`) is
served through the ping; the extension tears down disabled features mid-session and caches the
list for at most 24h so a dead bridge can't pin features off forever.

## 8. GUI server and security

`sfdt ui` (`src/commands/ui.js` + `src/lib/gui-server/`) starts Express on
`DEFAULT_UI_PORT = 7654` (`src/lib/ui-port.js`), **localhost only**, serving the prebuilt React
app from `gui/dist/` (build with `npm run build:gui`; the server shows build instructions when
dist is absent).

Security model (`src/lib/gui-server/security.js`):

- The browser is opened with a one-time **launch token** in the URL; the app exchanges it at
  `/api/csrf-token` (Bearer) for a per-session **CSRF token**.
- Every mutating `/api/*` route requires the `x-sfdt-csrf` header (constant-time compare). SSE
  endpoints accept `?csrf=` because EventSource cannot set headers — an accepted, documented
  tradeoff.
- An origin guard rejects non-localhost Origins and refuses mutating requests with no Origin at
  all; rate limiting on token endpoints; the bridge routes (§7) carry their own auth.

Long-running operations (preflight, drift, deploys, audits) stream as **Server-Sent Events**
through the shared cli-run helpers (`src/lib/gui-server/cli-run.js`).

**Snapshot files are the cross-surface data contract.** Runners write raw JSON snapshots
(`logs/audit-latest.json`, `logs/monitor-latest.json`, quality/coverage/test logs); the GUI, the
VS Code extension, the MCP server, and the native host all *read the same files* instead of
re-running logic. These files are deliberately not wrapped in the `--json` stdout envelope.

The GUI page registry is `gui/src/routes.js` (`GUI_ROUTES`) — plain JS on purpose so the catalog
generator can import it outside Vite.

## 9. Chrome extension runtime

`extension/` is a WXT + TypeScript project (manifest generated by `wxt.config.ts`; host
permissions cover Salesforce domains plus `http://127.0.0.1/*` for the bridge).

- **Entrypoints**: `content.ts` (the in-page feature engine), `background.ts` (session-cookie
  access — its host allowlist is kept in sync with the bridge's origin allowlist),
  `app/` (a full-page **workspace** tab hosting the larger tools: SOQL runner, REST/SOAP
  explorers, comparisons, etc.), and `options/`.
- **Feature registry** (`extension/lib/feature-registry.ts`): every feature is one file in
  `extension/features/` exporting a manifest (`id`, `name`, `contexts`, optional Zod
  `settingsSchema`) plus lifecycle hooks (`init`/`onActivate`/`refresh`/`teardown`). The
  checked-in `extension/lib/feature-manifests.json` is parity-tested against the real
  registrations and feeds `generated/chrome-features.json`.
- **Contexts** (`extension/lib/context-detector.ts`) classify the current Salesforce page (Flow
  Builder, Setup, Object Manager, record pages, …) via URL + DOM probes; the registry activates
  only matching features and re-inits on SPA navigation.
- **Gating**: a feature runs only if the user hasn't disabled it *and* the remote kill switch
  (§7) hasn't. Most features are standalone; a minority require the bridge (counts in
  `generated/summary.json`).

## 10. VS Code integration

`vscode/` is **not** a passive viewer — it is a CLI-backed command center. What it contributes
(see `generated/vscode-commands.json`):

- a **command tree** generated from a typed `COMMAND_CATALOG` (`vscode/src/lib/commands.ts`)
  that runs sfdt commands in integrated terminals or captures `--json` output;
- an **Org Health tree** and status bar fed by the snapshot files (§8);
- **diagnostics**: quality snapshots are mapped into a `DiagnosticCollection`, so analyzer
  findings appear as squiggles in the editor;
- **CodeLens**: "Run test class" on Apex `@isTest` classes and "Run agent test" on Agentforce
  test specs;
- an **embedded dashboard** webview wrapping the local `sfdt ui`.

The invariant it keeps: **it reimplements no CLI logic** — it spawns the `sfdt` binary and reads
the same JSON the CLI wrote. Testable logic lives in `vscode`-free modules under
`vscode/src/lib/`; the `vscode`-importing shell is esbuild-bundled and not unit-tested.

## 11. Salesforce CLI plugin

`packages/plugin/` is a thin oclif wrapper: `sf plugins install @sfdt/plugin` →
`sf sfdt <command>`. The oclif command files under `src/commands/sfdt/**` are **code-generated**
from `createCli()` by `scripts/generate-commands.mjs` (run by `npm run gen`/`build`) — the
Commander tree is the single source of truth; never hand-edit them (they're gitignored).
Generated commands set `strict = false` so unknown flags, positionals, and `--json` pass through
verbatim to the forwarded `sfdt` process (`forward.ts`, same execa pattern as the MCP server).
CI builds the plugin on every PR precisely because the codegen + tsc catches command-tree drift.

## 12. MCP server

`sfdt mcp` runs a stdio MCP server (`src/lib/mcp-server.js`). The `TOOLS` array is the registry
(mirrored to `generated/mcp-tools.json`; roughly 30 tools, a third of them confirm-gated —
catalog-derived, see `generated/summary.json`). Design rules:

- **confirmExecution gating**: every mutating tool's input schema requires
  `confirmExecution: true` (deploys, rollback, release, scratch create/delete, data import, …).
  The mapping of tools to commands and their mutating classification lives in
  `src/lib/command-policy.js` and is *enforced* by `test/command-policy.test.js` — a mutating
  tool without the gate fails the suite.
- **Parking** (`src/lib/mcp-parking.js`): results larger than ~50 KB are written to a local
  cache (24h TTL) and replaced by a descriptor envelope; `sfdt_get_parked_result` retrieves
  them. This keeps giant audit snapshots from blowing out an agent's context window.
- **Envelope unwrapping**: the server shells out to the CLI with `--json` and its
  `#parseCliJson` unwraps the sf-native `{ status, result }` envelope — it is the only stdout
  consumer; everything else reads snapshot files.
- Two tools are transport-internal, not command-backed: `sfdt_logs` and
  `sfdt_get_parked_result` (`MCP_INTERNAL_TOOLS`).

## 13. AI system

AI features are optional, gated on `config.features.ai`, and provider-pluggable via
`ai.provider`: `claude` | `gemini` | `openai` (each shells out to that vendor's local CLI as a
read-only-sandboxed agentic subprocess) | `http` (any OpenAI-compatible `/chat/completions`
endpoint — Ollama, OpenRouter, etc. — via native `fetch`).

Key consequences:

- Use `isAiAvailable(config)` / `aiUnavailableMessage(config)` from `src/lib/ai.js`; never the
  legacy Claude-only check.
- The `http` provider **cannot run tools**, so agentic commands pre-gather context via
  `src/lib/ai-context.js` (git log, latest test results) when
  `providerSupportsAgenticTools(config)` is false, and the command writes output files itself.
- **Prompts are data, not code**: defaults live in `src/lib/prompts.js`; per-project overrides
  are stored in `.sfdt/prompts.json` and editable from the GUI Settings page. Features name
  their prompt key (`review`, `explain`, `deploy-error`, `monitor-summary`, `doc-role-guide`, …).
- **Redaction**: `redactSensitiveData` (`src/lib/audit-logger.js`) is applied to every payload
  before it leaves the machine — mandatory for `http`, where diffs and logs go to a user-chosen
  endpoint.
- **Write-capable agents are double-gated**: `src/lib/agent-loop.js` (the `deploy --ai-fix`
  auto-fix loop) refuses to run unless `ai.agent.enabled` *and* `ai.agent.allowWrite` are both
  true, is bounded in turns, and re-validates with a dry-run each iteration. Default off.
- Secrets are configured by env-var *name* (`ai.apiKeyEnv`), never stored (§18).

## 14. Surface catalogs & drift contracts

The mechanism that keeps this document — and the docs site, and the extension listings — honest:

- `tools/generate-catalogs.mjs` regenerates everything under `generated/` from the code that
  defines it: the Commander tree + `COMMAND_POLICY` → `commands.json` / `surface-parity.json`;
  the Chrome feature manifests → `chrome-features.json`; `GUI_ROUTES` → `gui-pages.json`;
  VS Code contributes + `COMMAND_CATALOG` → `vscode-commands.json`; MCP `TOOLS` →
  `mcp-tools.json`; flow-core → `bridge-contract.json`; plus `packages.json`, `summary.json`
  (the counts), and `catalog-version.json` (versions + protocol; deliberately no timestamp so
  output is byte-identical across runs).
- `npm run check:catalogs` fails if a checked-in catalog differs from a fresh generation;
  `check:licenses`, `check:node`, and `check:auth-docs` scan prose (including this file) for
  stale license, Node-version, and auth-doc claims. `npm run check:all-contracts` runs all four
  and is a required CI step.
- `src/lib/command-policy.js` records the intent Commander cannot express — `mutating`,
  `requiresProject`/`requiresOrg`, `supportsJson`, docs category, per-surface exposure, and the
  MCP tool mapping — with its invariants enforced by `test/command-policy.test.js`.

Rule of thumb: **never hardcode a count** of commands/features/pages in prose; cite `generated/`.

## 15. Logging, run history, notifications

- `src/lib/log-writer.js` writes per-run logs under `logs/`; audit/monitor also archive full
  timestamped snapshots (`logs/audit-results/`, retention 50).
- `src/lib/run-history.js` keeps a compact SQLite index (`node:sqlite`, `logs/history.db`, 200
  rows per run type) of every preflight/test/deploy/audit/etc. run. `recordRun()` is best-effort
  — a history failure can never fail the command. Surfaced by `sfdt history` and the read-only
  `sfdt_history` MCP tool.
- `src/lib/notifier.js` dispatches to Slack, MS Teams, Google Chat, generic webhooks, Grafana
  Loki, and email (lazy-imported nodemailer, an optionalDependency). Channels declare an
  `events` filter and a `severityThreshold`; secrets are env-var names. An optional AI executive
  summary (editable `monitor-summary` prompt) can front the snapshot body.

## 16. Testing architecture

Root `vitest.config.js` declares `test.projects` for **every workspace** — CLI, extension,
flow-core, plugin, host, GUI, and vscode run in one `npm test` invocation (with `pretest`
building flow-core first) and one unified coverage report.

Conventions: execa is mocked for script-runner tests; the host tests run against an in-memory
fs + scripted execa but load the real flow-core bridge contract from `dist/`. The high-value
**parity tests** are the ones that pin cross-surface contracts:

- `test/command-policy.test.js` — policy map ↔ Commander tree ↔ MCP `TOOLS` ↔ confirmExecution
  schemas ↔ actual `--json` support;
- `extension/test/feature-manifests.test.ts` — checked-in feature manifests ↔ real feature
  registrations;
- `tools/check-catalog-drift.mjs` — checked-in catalogs ↔ regenerated catalogs.

## 17. Release architecture

Publishing is **CI-first** (`.github/workflows/ci.yml`); humans merge, CI ships:

- Push to `main` with a version bump → the `publish` job (GitHub `production` environment,
  npm **OIDC trusted publishing** with provenance — no npm token) publishes in dependency
  order: `@sfdt/flow-core` → `@sfdt/cli` → `@sfdt/plugin`. Each step is idempotent
  ("already published" is not a failure), and the bump check also compares against
  `npm view` so a half-failed publish self-heals on the next push.
- Tags: `v<version>` per release, plus a **floating `v<major>` tag** (`v0` today) force-moved on
  every stable release so `uses: scoobydrew83/sfdt@v0` consumers track the latest CLI. Beta
  publishes (prerelease versions pushed to `develop`) go out under the npm `beta` dist-tag and
  never move the floating tag.
- The `docker` job invokes the reusable `docker-publish.yml` in the same run (a
  `GITHUB_TOKEN`-created release does not re-trigger workflows) to build the multi-arch GHCR
  image; a best-effort step bumps the Homebrew tap formula (needs the `HOMEBREW_TAP_TOKEN`
  secret; `continue-on-error` so a cosmetic tap failure never blocks a release).
- Releases promote `develop` → `main` wholesale — CLI, flow-core, plugin, and extension versions
  move together (coupled release), which is also why the plugin's `>=` dependency is safe.

## 18. Threat boundaries

| Boundary | Control |
|----------|---------|
| GUI server | Binds localhost only; launch-token → CSRF-token handshake; origin guard; rate limits; constant-time token compares |
| HTTP bridge | User-global bearer token (`~/.sfdt/bridge-token`, 0600); anchored-regex origin allowlist (Salesforce domains + `chrome-extension://`); payload validation + size caps before parsing |
| Native host | **Read-only** — mutating kinds and `ai` are `nativeHost: false` in the contract; project access only via the explicit install-host pointer file |
| GitHub Action | `args-json` input is spawned **with no shell** (a JSON argv array); the legacy `command` string is restricted to shell-neutral characters unless `allow-shell-command: true` is explicitly set |
| MCP | Every mutating tool requires `confirmExecution: true`; enforced by tests, not convention |
| Secrets | Config stores env-var **names**, never values (`ai.apiKeyEnv`, `webhookUrlEnv`, SMTP `*Env`); AI payloads pass through `redactSensitiveData` |
| AI subprocesses | CLI providers run in read-only sandboxes; write-capable agent loop is double-opt-in and dry-run-verified per turn |

## 19. "Adding a ..." recipes

- **A CLI command**: create `src/commands/<name>.js` exporting `register<Name>Command(program)`;
  import + register it in `src/cli.js`; add its entry to `COMMAND_POLICY`
  (`src/lib/command-policy.js`) — the policy test fails until you do; add tests; run
  `npm run generate:catalogs`; mirror the docs to `sfdt-site`.
- **A Chrome feature**: one file in `extension/features/<id>.ts` with a `FeatureManifest` and
  lifecycle hooks; register it with the feature registry; update
  `extension/lib/feature-manifests.json` (the parity test fails on mismatch); regenerate
  catalogs.
- **A GUI page**: component in `gui/src/pages/`; one entry in `gui/src/routes.js` `GUI_ROUTES`;
  wire `ICONS`/`PAGES` in `App.jsx`; regenerate catalogs; `npm run build:gui` before manual
  testing.
- **An MCP tool**: entry in `TOOLS` + handler in `src/lib/mcp-server.js`; claim it in the owning
  command's `mcpTools` in `COMMAND_POLICY` (or `MCP_INTERNAL_TOOLS`); if mutating, add
  `confirmExecution` to its schema; regenerate catalogs.
- **A bridge kind**: add the type + validator arm in `packages/flow-core/src/bridge-contract.ts`
  (bump `protocolVersion` on shape changes); handler in `src/lib/bridge/routes.js`; mirror it in
  `host/src/index.js` **only if read-only**; `npm run build:flow-core`; regenerate catalogs.
- **A config key**: three places in lockstep — `src/templates/sfdt.config.json`,
  `src/lib/config-schema.json`, and the consuming code; if a shell script needs it, extend
  `buildScriptEnv()` and the `SFDT_` table in `CLAUDE.md`.

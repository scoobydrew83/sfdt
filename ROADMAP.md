# sfdt Project Roadmap

## Shipped

### Core & Configuration
- Standardized `.sfdt/` configuration loader with `sfdt init` and `sfdt config set/get`
- Non-interactive mode for CI/CD compatibility
- ESLint + Prettier standardization

### Deployment & Quality
- Configurable coverage threshold enforced in preflight and deploy
- Automatic preflight checks before every `sfdt deploy`
- Rollback with pre-rollback org state capture
- `sfdt quality --generate-stubs` — identify untested Apex classes and scaffold `@IsTest` stubs
- `sfdt compare` — metadata comparison between two orgs or an org vs local source; `--output` generates a package.xml of source-only items

### AI & Intelligence
- `sfdt manifest` — package.xml from git diffs with AI dependency cleanup
- `sfdt explain` — AI-powered deployment error log analysis with heuristic fallback
- `sfdt pr-description` — AI-generated GitHub PR descriptions and Slack summaries
- `sfdt review`, `sfdt explain`, `sfdt quality --fix-plan` — structured project context injected into every AI prompt (org, API version, test history, coverage trend, preflight results, deploy history)
- Multi-provider AI: `claude` (Claude Code CLI), `gemini` (REST), `openai` (REST)

### Web UI
- `sfdt ui` — local SLDS dashboard (React + Vite) with test history, preflight, drift, and quality views
- AI Chat Drawer — token-by-token streaming, page-aware context injection, `Ctrl+Shift+A` toggle
- "Ask AI" buttons on Review, Explain, Drift, and Preflight pages
- Log History Viewer — browse all structured logs by type, filter, and expand detail rows
- Structured log format — JSON envelopes (`schemaVersion`, `type`, `timestamp`, `exitCode`, `org`, `data`) across all log types with timestamped archives and `*-latest.json` pointers
- Compare page — run org-vs-org or org-vs-local comparisons and browse diff results in the dashboard
- Settings page — view and edit `.sfdt/config.json` values directly from the browser dashboard

### Platform & Ecosystem
- Plugin architecture — load from `config.plugins[]`, auto-discover `sfdt-plugin-*` packages, or drop `.sfdt/plugins/*.js` local files
- Docker support — mounts a Salesforce DX project at `/project`; ships Node 20, Salesforce CLI, git, jq, and sfdt
- DevOps Center MCP integration — pipeline status and work items injected into chat context when `config.mcp.enabled` is true; targeted Headless360 tool calling via `SalesforceMcpClient` for live pipeline and work-item data in the AI chat drawer
- sfdt skills library — 10 Salesforce domain skills for use with AI agents (apex-review, data, deploy, flow-review, lwc, org-audit, pmd-scan, scratch-org, test, sfdt-cli)
- Pre-built GUI included in the published npm package

### Chrome extension (`@sfdt/extension`)
- 14 productivity features for Salesforce Flow Builder and Setup — full list in [extension/README.md](extension/README.md)
- Three-layer feature gating — remote kill-switch (`.sfdt/feature-flags.json`) → per-user toggle → context filter
- Opt-in local telemetry (no network egress); snapshot pushed to `.sfdt/telemetry-snapshot.json` for `sfdt extension stats`
- Registry-driven options page — adding a feature with a Zod settings schema auto-generates its controls
- Privacy policy declared in [extension/PRIVACY.md](extension/PRIVACY.md)

### Native messaging host (`@sfdt/host`)
- Stdio loop with installers for Chrome / Edge / Brave / Chromium / Vivaldi on macOS, Linux, and Windows
- One-command install via `sfdt extension install-host --extension-id <id>`
- Fallback transport when the HTTP bridge (`sfdt ui`) isn't running

### Shared library (`@sfdt/flow-core`)
- Flow normalization, rules engine, scoring — same code path on the CLI and in the extension so verdicts match byte-for-byte
- Versioned bridge contract (`PROTOCOL_VERSION`, `negotiateProtocolVersion`) — extension and CLI warn on minor mismatch, refuse on major mismatch

### Bridge + diagnostics
- `GET /api/bridge/ping` and `POST /api/bridge/exchange` mounted by `sfdt ui`; surfaces `disabledFeatures` from `.sfdt/feature-flags.json` and `protocolVersion` for negotiation
- `sfdt feature-flags` CLI for operator-friendly kill-switch management
- `sfdt extension stats` CLI for telemetry visibility
- `sfdt doctor --extension` end-to-end health check (bridge / native host / kill-switch / telemetry)

---

## Next Session

Consolidated, actionable queue from the v0.14.0 release cycle (2026-06-26):

- **`sfdt plugin create`** — plugin registry & scaffolding to bootstrap a new `sfdt-plugin-*` package with example `register(program)` wiring. *(Was in progress — top of the queue.)*
- **Triage the 3 parked specs** in `docs/superpowers/specs/` — for each, decide build / defer / discard:
  - `2026-05-07-sfdt-mcp-parking-and-skills-design.md` — feeds the "Expose sfdt as MCP Server" planned item below
  - `2026-05-09-remaining-items-design.md`
  - `2026-05-09-scan-page-design.md`
- **~~Automate the Homebrew tap bump~~** — ✅ Done (PR #167): the CLI `publish` job computes the new tarball `sha256` and pushes `url`+`sha256` to the `scoobydrew83/homebrew-sfdt` tap. Activates once the `HOMEBREW_TAP_TOKEN` secret (fine-grained PAT, `contents:write` on the tap) is added; skips cleanly until then. The tap is now the single source of truth — the in-repo `Formula/sfdt.rb` mirror is redundant and slated for removal.
- **Fix the always-failing `integration` CI job** — it red-X's every release PR (DevHub org-auth; no org secrets available in PR context). Either wire the auth, restrict it to non-PR runs, or mark it non-required so release PRs stop showing a false failure.
- **Refresh the "Shipped" section below** — it predates v0.14.0. Not yet reflected: the generic **`http` AI provider** (OpenAI-compatible: Ollama / OpenRouter / MiniMax), the new **install methods** (`install.sh`, Homebrew tap, **public GHCR Docker image**), and the **VS Code extension** (`sfdt.sfdt-devtools`, live on Marketplace + Open VSX at 0.1.1). The Docker line still says "Node 20" (now built from the published npm package on Node 22).

---

## Planned

- **Expose sfdt as MCP Server** — surface sfdt commands as formal MCP tools callable by AI agents (Claude, Copilot, etc.), extending the current skills-library approach to first-class tool invocation

---

## Feedback & Suggestions

We value community feedback! If you have ideas for features, please open an issue in the repository.

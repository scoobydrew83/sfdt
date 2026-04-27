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

---

## In Progress

- **Plugin registry & scaffolding** — `sfdt plugin create` scaffold to bootstrap a new `sfdt-plugin-*` package with example `register(program)` wiring

---

## Planned

- **Expose sfdt as MCP Server** — surface sfdt commands as formal MCP tools callable by AI agents (Claude, Copilot, etc.), extending the current skills-library approach to first-class tool invocation

---

## Feedback & Suggestions

We value community feedback! If you have ideas for features, please open an issue in the repository.

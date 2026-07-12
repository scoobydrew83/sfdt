# Skills Audit — 2026-07-12

Audit of the 10 bundled agent skills under `skills/`, performed against the
skill-creator authoring methodology (frontmatter/description triggering
quality, progressive disclosure, imperative style, generality across
projects) and verified against the actual CLI (`node bin/sfdt.js --help` and
per-command help output). All fixes listed below were applied in the same
change.

## Context

The skills are shipped package assets (`"skills/"` in `package.json` `files`)
distributed to end-user Salesforce projects via `sfdt skills export
--target claude|cursor|codex|windsurf|pack`. Two consequences drove the audit
criteria:

- **The non-standard `triggers:` frontmatter field is intentional** — it is
  parsed by `src/commands/skills.js` and rendered into the exported rules
  files. It was kept (and added to `sfdt-cli`, the one skill missing it).
- **Skills must be project-generic** (CLAUDE.md rule). Any leftover
  project-specific value is a bug.

## Findings and fixes by skill

### sfdt-cli — severely stale (worst finding)

| Finding | Severity | Fix |
|---------|----------|-----|
| Quick reference covered ~18 of the CLI's 42 registered commands — `audit`, `monitor`, `docs`, `data`, `scratch`, `flow`, `history`, `coverage`, `dependencies`, `ui`, `mcp`, `pr`, `retrofit`, `ci`, `explain`, `agent-test`, `skills` and more were absent | HIGH | Rewrote the quick reference as grouped tables covering every command |
| AI docs said "Claude CLI required" — the CLI supports `claude` \| `gemini` \| `openai` \| `http` providers (`ai.provider`) | HIGH | Updated SKILL.md AI section, troubleshooting, and `references/commands.md` requirement lines |
| `deploy` documented without `--smart` (the CI-facing delta-deploy mode) or its companion flags | HIGH | Documented smart mode in SKILL.md and the full flag table in `references/commands.md` |
| `references/commands.md` `notify` section described the legacy Slack-only shape (`notifications.slack.webhookUrl`) — the notifier is provider-agnostic (Slack/Teams/Google Chat/webhook/Loki/email) with env-var-name secrets and a `snapshot` event | HIGH | Rewrote the section |
| `references/config.md` config.json example predated the `ai` block, channel-based `notifications`, and `deployment.smart`; it also omitted the AJV `config-schema.json` lockstep rule and ~9 newer `SFDT_` env vars | MEDIUM | Updated example, added schema-validation note, added missing env vars, aligned "adding config" steps with CLAUDE.md's three-places-in-lockstep rule |
| `references/development.md` scripts layout listed `new/` — the directory is `ops/` (plus `ci/`, `integration/`, `lib/` were missing); pre-commit checklist lacked the config-schema and docs-site steps | MEDIUM | Corrected layout; extended checklist |
| Only skill without a `triggers:` list (inconsistent with export rendering) | LOW | Added |

### sf-pmd-scan

| Finding | Severity | Fix |
|---------|----------|-----|
| Project-specific leftover: ruleset `<description>TWU-556 / SF-Rebuild Custom Salesforce Ruleset</description>` | HIGH | Genericized |
| `--pmd-ruleset` is not a Code Analyzer v5 flag — custom PMD rulesets are wired via `code-analyzer.yml` (`engines.pmd.custom_rulesets`) + `--config-file` | HIGH | Corrected with a working config example |
| `--path-filter` is not a v5 flag; file subsetting uses `--target` | MEDIUM | Corrected |
| No mention that `sfdt quality` wraps Code Analyzer in sfdt projects | LOW | Added cross-reference |

### sf-flow-review

| Finding | Severity | Fix |
|---------|----------|-----|
| Contradictory guidance: `{!$Label.*}` listed as a *hardcoded-ID smell* while the fix line recommended Custom Labels | HIGH | Rewrote: literal IDs are the smell; labels/metadata are the fix |
| `sf flow scan --format json --output <file>` — the Lightning Flow Scanner plugin uses `--json`, `--files`, `--failon` | MEDIUM | Corrected |
| No mention of the CLI's native `sfdt flow scan` / `sfdt flow conflicts` | MEDIUM | Added as the preferred path |

### sf-data

| Finding | Severity | Fix |
|---------|----------|-----|
| `sf data import legacy` is not a valid command for CSV inserts; flag name `--sobject-type` should be `--sobject` on the bulk commands | HIGH | Replaced with `sf data import bulk` / corrected flags; added single-record commands |
| No mention of `sfdt data export/import <set>` (named, repeatable data sets) | LOW | Added cross-reference |

### sf-test

| Finding | Severity | Fix |
|---------|----------|-----|
| Hardcoded "this project targets 90%" — project-specific; the CLI default threshold is 75 and the real value lives in `.sfdt/config.json` `deployment.coverageThreshold` | MEDIUM | Points to Salesforce's 75% floor + the configured threshold |
| No mention of `sfdt test` / `sfdt coverage` wrappers | LOW | Added |
| Only legacy `System.assert*` taught; modern `Assert` class absent | LOW | Added preference note |

### sf-deploy

| Finding | Severity | Fix |
|---------|----------|-----|
| "(project target: 90%)" hardcoded in checklist | MEDIUM | Points to configured threshold |
| Destructive-changes section labeled `sf project generate manifest` as "create a destructive package" (it generates a regular package.xml) | MEDIUM | Rewrote with the actual two-file mechanics + `sfdt manifest --destructive` |
| No mention of `sfdt preflight` / `deploy --smart` / `rollback` | LOW | Added as preferred flow in sfdt projects |

### sf-org-audit

| Finding | Severity | Fix |
|---------|----------|-----|
| Assertion grep missed the modern `Assert` class (false positives on well-tested code) | LOW | Grep now covers `System.assert*` and `Assert.` |
| Fast-path `sfdt audit all` / `monitor all` / `docs generate --ai` commands verified accurate against the CLI | — | No change needed |

### sf-scratch-org

| Finding | Severity | Fix |
|---------|----------|-----|
| "Default: 6 active scratch orgs per Dev Hub" — allocations vary by Dev Hub edition | LOW | Points to `sf limits api display` (`ActiveScratchOrgs`/`DailyScratchOrgs`) |
| No mention of `sfdt scratch` / `scratch pool` | LOW | Added cross-reference |

### sf-lwc

| Finding | Severity | Fix |
|---------|----------|-----|
| Example taught `@track` for a reassigned array — fields are reactive by default; `@track` is only for in-place mutation | MEDIUM | Example modernized + explanatory note |
| `apiVersion` example lacked "match `sourceApiVersion`" guidance | LOW | Comment added |

### sf-apex-review

Strongest skill of the set — pushy description, scope-expansion step,
severity-tiered checklist, strict output contract. Only change: noted the
modern `Assert` class in the test-quality section.

## Description (triggering) pass

Per skill-creator guidance, descriptions are the primary trigger mechanism and
should state what the skill does *and* push on when to use it (models tend to
under-trigger). Descriptions rewritten to be more assertive with concrete
trigger contexts: `sf-data`, `sf-deploy`, `sf-flow-review`, `sf-scratch-org`,
`sf-test`, `sf-lwc`, `sf-org-audit`, `sf-pmd-scan`. Already strong:
`sf-apex-review`; extended with org-health vocabulary: `sfdt-cli`.

## Recommendations (not done in this pass)

1. **Eval harness**: `.gitignore` excludes `skills/*/evals/` — the intended
   home for skill-creator-style eval prompts. None exist yet. Worth seeding
   2-3 realistic test prompts per skill locally and benchmarking with/without
   the skill before the next major skill revision.
2. **Staleness guard**: the `sfdt-cli` skill drifted badly because nothing
   ties command changes to it. Consider adding "update `skills/sfdt-cli/`"
   to the development checklist (done in this pass) *and* a CI check that
   diffs the command list in SKILL.md against `createCli()` registrations.
3. **Docs site**: skills content ships in the npm package; if sfdt.dev
   documents the skills pack, mirror the corrected command syntax there.

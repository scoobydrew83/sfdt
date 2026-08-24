# SFDevTools competitive analysis

**Reviewed:** 2026-08-22 · **Subject:** [sfdevtools.com](https://www.sfdevtools.com/) (app at
`app.sfdevtools.com`) · **Their version at review:** v1.24.1 (2026-08-16) ·
**Ours:** `@sfdt/cli` 0.22.1, `studio-by-sfdt` @ `d39d998`

Same role as the sf-pi integration review that ROADMAP.md sequences its Planned section from:
a dated read on a competitor, ending in items the roadmap can pick up. (That review is cited as
`docs/reviews/sf-pi-integration-review.md` but is **absent from this repo** — this file restores
the convention its link implies.) Everything asserted about SFDevTools is sourced to one of their own public pages
(appendix); everything asserted about us is sourced to a file path or a `generated/*` count.

---

## 1. What they built

A hosted, multi-tenant web app positioned as a **replacement for Salesforce Setup** —
"Everything Setup should have been," "17 tools in one platform." Not a DevOps tool: there is no
git, no deploy, no validate, no rollback, no CI, no scratch orgs, no test runner. It is an
*org-inspection and org-operation console* with an AI agent bolted through all of it.

They launched v1.0 on 2026-03-01 and reached v1.24.1 by 2026-08-16 — **~5.5 months at 1–2
releases per week**, publicly logged. Build order is worth reading as intent:

| Version | Date | What landed |
|---|---|---|
| v1.0.0 | 2026-03-01 | Multi-org management, query editor, schema browser |
| v1.7.0 | 2026-03-27 | SwitchBoard — view/toggle validation rules, flows, triggers |
| v1.8.0 | 2026-06-11 | Team workspaces, Deployments Tracker, design system |
| v1.9.0 | 2026-06-16 | The AI Agent (read-only at first) |
| v1.20.0 | 2026-07-05 | Navigation redesign, command palette |
| v1.22.0 | 2026-07-12 | Self-serve credit top-ups, approval-gated writes, Agent Presets |
| v1.23.0 | 2026-08-16 | Record Inspect editor, writable Permissions Matrix, multi-org dashboards |
| v1.24.0 | 2026-08-16 | Replaced the multi-template agent picker with one vetted Org Assistant |

Note the shape: **tools first, agent second, writes third, monetization fourth.** They did not
lead with AI. They built a console people wanted, then made the agent the thing that drives it,
then earned the right to let it write.

### Their 17 tools

| Tool | What it does |
|---|---|
| AI Agent | Plain-English org querying, multi-org sub-agent fan-out, approval-gated writes |
| AI Dashboards | Describe → build → share; live SOQL under the viewer's own connection |
| Query Perry | SOQL editor with autocomplete, syntax highlighting, timing |
| Security Auditor | FLS and OLS, by profile **and** by user; read/write/none matrix; shareable URL state |
| Permissions Matrix | Cross-org FLS/OLS diff, profile matching, **writable** bulk fix staging |
| SwitchBoard | Grid toggle for validation rules, flows, process builders, workflows, triggers, dup rules; production guard |
| Data Porter | Import wizard over REST + Bulk API v2, field auto-mapping, external-ID upsert, streamed status |
| Field Usage Sniper | Deep Scan past the 2,000-result ceiling; references in reports, flows, validation rules, Apex |
| All Fields Queryinator | Auto-generates the `SELECT` clause for a whole object |
| Org Health / Vital Signs | API requests, storage %, licenses, custom object counts, alerts past 90% |
| Schema Explorer | Objects, fields, relationships, field usage, deep links to Setup |
| Apex Executor | Anonymous Apex with automatic debug-log capture and history |
| Apex Log Manager | Virtual-scrolled log list, filter by user/status, bulk delete |
| Package Manager | Installed managed/unmanaged packages, namespaces, versions, space |
| Platform Events | Monitor + publish, CDC subscription, test publishing |
| WhoDunnit | Setup Audit Trail without pagination limits, **velocity alerts**, security-sensitive flagging |
| Record Inspect | Full-record editor, describe-typed field grid, before/after diff staging |

Plus **AI Guides** — a docs-only chat with citation snippets that needs no org connection.

---

## 2. How they built it

Taken from their own disclosure pages, not inferred.

**Stack.** Frontend React + Vite + TanStack Router/Query + Tailwind + shadcn (Radix), served
from **Cloudflare Pages**; the marketing site is Next.js on **Vercel**. Backend is **Bun + Hono
+ Drizzle + Better Auth** in a container on **Railway**, with **Postgres 16** and **Redis 8**.
PostHog for analytics, Sentry for errors (scrubbed), Stripe for payments. The app ships a strict
CSP that pins `connect-src` to `api.sfdevtools.com` and sets `frame-ancestors 'none'`.

**Two auth layers.** User identity is Better Auth — magic links and Google OAuth. Org connection
is **Salesforce OAuth 2.0 with PKCE**, and this is the part worth studying: they let the user
choose their own token custody.

- **Session Only** — minimal scopes (`api web`), access token destroyed at logout, no refresh
  token ever stored.
- **Persistent** — adds `refresh_token offline_access`, encrypted **AES-256-GCM** at rest in
  Postgres, decrypted in-memory only for the life of one proxied request. Access tokens cache
  in Redis, also encrypted, 90-minute TTL.

**Data path.** Every tool action is **Browser → Backend API → Salesforce**. Nothing talks to the
org from the browser. They state plainly: *"Your actual Salesforce data is never written to our
database."* Describes cache 1 hour, gzipped, per-user and per-org, purged on account deletion.
Execution history defaults to browser storage with optional cloud sync.

**LLM path.** Anthropic and Google only, both optional and user-selected. Their multi-org
technique is the interesting bit: *"the agent delegates lookups to focused sub-agents; only the
sub-agent's final answer passes back into conversation, not raw retrieved data."* Conversations
persist scoped to the account; individual record payloads never go to the model. Gemini is
configured with provider-side retention disabled.

**Money.** Free during beta — "$0 per month, forever (for now)" — with $10 in credits at signup,
no card. Past that it is a **prepaid Stripe wallet** ($5/$10/$25/$50/custom, optional auto
top-up), pooled per workspace, with the cost of each turn shown inline and typically under a
cent. **Viewing an AI Dashboard is always free; only building one spends tokens.**

---

## 3. Capability matrix

`✓` shipped · `◐` partial · `—` absent. sfdt columns: **C** = CLI, **G** = `sfdt ui` dashboard,
**X** = Chrome extension, **V** = VS Code, **M** = MCP.

| Capability | SFDevTools | sfdt (C/G/X/V/M) | Studio |
|---|:---:|:---:|:---:|
| SOQL/SOSL execution | ✓ | ✓ C·G·X·M (`soql-runner.js`, bounded) | — |
| Schema browse / describe / relationships | ✓ | ✓ C·G·X·M | — |
| Anonymous Apex | ✓ | ✓ C·X·M (`apex run`) | — |
| Debug logs + trace flags | ✓ | ✓ C·X·M (`apex logs`/`apex trace`) | — |
| Org limits / health | ✓ | ✓ C·G·X (`monitor limits`, `monitor health`) | — |
| Setup Audit Trail | ✓ + velocity alerts | ◐ C·G (`audit audittrail`, no anomaly layer) | — |
| Record view / edit | ✓ | ◐ X view-only (`inspect-record`); edit designed, unapproved | — |
| Data import/export | ✓ Bulk API v2 + mapping | ◐ C (`sf data tree` only) · X (`data-import`) | — |
| Platform Events / CDC | ✓ | ◐ X only (`event-monitor`) | — |
| Package inventory | ✓ | — | — |
| Field usage / impact | ✓ Deep Scan | ◐ C·X (`dependencies`, `field-impact`) | — |
| FLS/OLS matrix by profile **and user** | ✓ | ◐ C (`audit lint-access*`, no matrix) | — |
| Cross-org permissions diff + bulk fix | ✓ | — (`compare` diffs metadata, not permissions) | — |
| Automation on/off grid | ✓ SwitchBoard | ◐ C·X (`audit inactive-*`, read-only) | — |
| Conversational agent **over the org** | ✓ | — (`agent-loop.js` is repo-scoped) | — |
| AI dashboards | ✓ | — | — |
| Docs-grounded chat with citations | ✓ | — (10 agent skills, no cited RAG) | — |
| **Deploy / validate / quick-deploy** | — | ✓ C·G·V·M (`--smart` git-delta) | — |
| **Rollback with pre-state backup** | — | ✓ C·G·M | — |
| **Preflight + coverage gates** | — | ✓ C·G·M | — |
| **Static analysis (Code Analyzer v5, SARIF, ApexGuru)** | — | ✓ C·G·X·M | — |
| **Flow health scoring / conflicts** | — | ✓ C·G·X (`@sfdt/flow-core`) | — |
| **Metadata drift / org compare / retrofit** | — | ✓ C·G·X·M | — |
| **Manifest builder** | — | ✓ C·G·X·V | — |
| **Scratch orgs + pooling** | — | ✓ C·G·M | — |
| **Apex + Flow + LWC test runner** | — | ✓ C·G·V·M | — |
| **Agentforce agent testing** | — | ✓ C·G·M (`agent-test`) | — |
| **CI templates / GitHub Action** | — | ✓ (4 providers) | — |
| **MCP server for external agents** | — | ✓ 39 tools, 12 confirm-gated | — |
| **Runs inside Salesforce's own UI** | — | ✓ X (44 features) | — |
| **LWC/UI ideation → SFDX export** | — | — | ✓ |
| Team workspaces / shared identity | ✓ | — | ◐ single-owner + share links |
| Billing / credits | ✓ | — (BYOK) | — |

**The honest read.** On org inspection we are at rough parity or ahead, spread across four
surfaces instead of one. On the *entire software-delivery lifecycle* they have nothing. On UI
ideation neither of them has anything and Studio has a head start. Their advantage is not
capability — it is that all of theirs is behind one URL with a login.

---

## 4. Gaps worth closing

Ranked by (value to a Salesforce team) ÷ (cost to us), with the file each would extend.

### Tier 1 — clear wins, land inside existing engines

1. **FLS/OLS effective-permission matrix.** Resolve object and field access per profile *and*
   per user (profile + permission sets + permission set groups + muting), rendered as a
   read/write/none grid. We already query `PermissionSet`, `ObjectPermissions` and
   `FieldPermissions` in `src/lib/audit-runner.js` for `lint-access` / `lint-access-fields`; the
   missing piece is *effective* resolution and a matrix view, not new org access. Extends
   `audit-runner.js`, a new GUI page, `sfdt_audit` inputs.

2. **Cross-org permissions diff.** Once (1) exists, diffing two orgs' matrices is mostly free —
   `src/lib/org-diff.js` already owns two-org comparison. Ship it read-only; leave their
   "writable bulk fix" alone until the ledger in Tier 2 exists.

3. **Bulk API v2 data loading.** `sfdt data` is `sf data tree` — fine for seeding, useless past
   a few hundred records and incapable of upsert-by-external-ID. Bulk v2 + CSV field mapping +
   external ID is the single most-requested capability a Salesforce team has that we lack.
   Extends `src/commands/data.js`; `sf data upsert bulk` / `sf data import bulk` shell-outs keep
   the no-new-dependencies rule.

4. **Audit-trail anomaly layer.** We already retrieve `SetupAuditTrail`. Add velocity detection
   (N× baseline for a user/section in a window) and a security-sensitive action list (password
   policy, session settings, permission changes, connected apps, cert/key changes). Pure
   post-processing over data `audit audittrail` already has — and it feeds `sfdt notify`, which
   they cannot do because they have no notification fabric.

5. **Unblock `docs/design/record-edit-clone.md`.** Designed 2026-07-30, still "Awaiting human
   approval." They shipped the equivalent in v1.23.0. The design is done; the decision is not.

### Tier 2 — strategic, needs a trust layer first

6. **An org-operating agent with an approval → ledger → diff triad.** This is their real
   product. Ours would be different in the way that matters: it belongs in **MCP**, not in a
   chat window we own. We already have the two hard halves — `confirmExecution` gating on 12
   mutating MCP tools (golden principle #7) and `src/lib/run-history.js`. What is missing is
   (a) mutating org-*data* tools, not just metadata, (b) a **before/after diff staged for
   approval**, and (c) an append-only ledger distinct from run history. Do (b) and (c) first;
   they are valuable on their own and they are the reason anyone will trust (a).

7. **Dashboards from a spec, not from a chat.** Their describe → build → share is genuinely
   good, and the free-to-view boundary is smart. Our version should be a **committed artifact**:
   an AI-authored dashboard spec that lives in the repo, is code-reviewed, and renders in the
   GUI over `soql-runner.js`. That is a thing a SaaS structurally cannot offer, because their
   dashboards live in their database. Note the shape is close to Studio's `ComponentSpec` — see
   §6.

8. **Package inventory** (`InstalledSubscriberPackage` via Tooling) and **Platform Events/CDC**
   promoted from Chrome-only to CLI + MCP. Both are small; both close visible matrix holes.

9. **Field usage Deep Scan.** Their trick against the 2,000-result ceiling is parallel scoped
   queries. `src/lib/soql-runner.js` already owns bounds and truncation metadata — this is a
   query-planning addition, not a new surface.

### Tier 3 — mechanics to steal regardless

These cost little and improve what we already ship:

- **Show the cost of each AI turn inline.** We are BYOK, so we can show real token counts and,
  where the provider reports it, real spend — and unlike them we can show **zero** for a local
  model. Turns our weakest-looking column into our strongest.
- **Model tiering as an explicit choice bound to a task.** They surface `$`/`$$`/`$$$` per
  persona. Our `ai.provider` + `ai.model` config could carry per-command model hints so
  `sfdt explain` uses something cheap and `sfdt review` something strong.
- **Named presets as shareable objects.** They ship six personas and let users share them. We
  already have a user-overridable prompt library (`src/lib/prompts.js`) and a skills pack
  (`sfdt skills export`) — presets are the packaging we are missing, not the capability.
- **Sub-agent fan-out that returns answers, not payloads.** Their multi-org context trick. We
  solved the same problem the other way with MCP parking (`src/lib/mcp-parking.js`, SEP-2549
  cache scopes). Both are right; a fan-out helper for multi-org questions would complement it.
- **Production orgs flagged red, irreversible actions warned.** We have `sfdt.orgColor` in VS
  Code. Make production detection automatic and propagate the colour to the GUI and Chrome.
- **Shareable URL state on analysis results.** Cheap in the GUI, big usability gain.
- **A public release-notes page.** 34 published entries in 5.5 months is a trust signal we do not
  broadcast even though our CHANGELOG is 138 KB. This is an `sfdt-site` duty.

---

## 5. Where we should deliberately diverge

Not everything they do is worth copying. Five of these are moats precisely because a hosted
multi-tenant SaaS **cannot** follow.

1. **No token custody.** They hold refresh tokens under AES-256-GCM and disclose it carefully —
   which is the right thing to do *if you must hold them*. We hold nothing: the CLI inherits the
   ambient `sf` keychain, the Chrome extension rides the session cookie the user already has.
   There is no vault to breach because there is no vault. For a regulated customer this is not a
   feature comparison, it is a procurement gate. Say it louder.

2. **BYOK and local models.** Their agent runs on Anthropic or Google, metered by their wallet.
   Our `ai.provider` includes `http` — any OpenAI-compatible endpoint, which means Ollama,
   vLLM, LM Studio, or a corporate gateway, with the key referenced by **env-var name only**
   (golden principle #4). An org that cannot send org metadata to a third-party model can use
   us and cannot use them. Ever.

3. **Agent-native, not agent-shaped.** Their agent is a chat window inside their app. Ours is 39
   MCP tools plus 10 exportable skills, which means Claude Code, Cursor, or any MCP client
   drives sfdt inside the developer's existing loop. We should not build a competing chat
   window; we should make sfdt the best-instrumented Salesforce tool an external agent can hold.

4. **The delivery lifecycle is the whole moat.** Smart git-delta deploy, preflight, coverage
   gates, rollback with pre-state backup, retrofit, changelog, release notes, CI templates for
   four providers, a published GitHub Action, an `sf` plugin. None of this exists on their side
   and none of it is a weekend for them, because it requires being where the git repo is. Their
   "Deployments Tracker" is a view.

5. **Apache-2.0 and local-first.** Auditable, vendorable, no data-processing agreement required,
   no subprocessor list to get through review. Their subprocessor page lists nine.

6. **Do not build a hosted backend to chase them.** The moment sfdt operates a server that holds
   org tokens, every advantage above is gone and we have taken on their entire compliance
   surface with none of their five months of hardening. If a team surface is needed, see §6.

---

## 6. Studio's position

Studio is not a competitor to SFDevTools; it is in a category they have not entered. Worth
stating what it actually is, because the README is admirably honest and the roadmap should be
too.

**What is real.** The defensible IP is `packages/studio-core` — a `ComponentSpec` v3 IR with a
closed vocabulary, an allowlist parser that rejects unknown keys and markup in text, and a safe
patcher where `name`, `version` and `scenarios` are immutable and every patch is re-parsed
through the full validator. Alongside it, `packages/model-adapters/src/lwc-project.ts` is a
serious piece of work: the model may *select from* a vocabulary but never author executable
code, with `eval`, `Function`, `window`, `document`, `fetch`, `<script>`, Apex imports and
dynamic class interpolation all banned and binding-to-JS cross-checks enforced. Add
DB-enforced immutable versions (no UPDATE/DELETE policy on `studio_project_versions`), hashed
revocable share tokens, a nonce-CSP sandboxed preview runner, and a script-free offline review
artifact. That is a coherent, careful architecture.

**What is not.** It never touches a Salesforce org — no OAuth, no `sf` shell-out, no Metadata or
Tooling API anywhere in the tree. Export is a browser-built SFDX ZIP plus a README telling a
human to run the validate command. All three API routes live in Vite `configureServer` dev
middleware, so `build:web` emits a static SPA whose `/api/*` calls 404 — it has never been
hosted and cannot be without a backend. BYOM is a UI label: `body.provider` is validated and
discarded, and the adapter is built once at boot from env vars. All nine FEATURES.json entries
are `passes: false`. One squashed commit.

**The positioning that follows.**

- **Studio's wedge is real and unclaimed.** SFDevTools has nothing in UI ideation. The
  honest-fidelity discipline — *Layout: native-equivalent · Data: simulated · Org behavior:
  requires org validation* — is a genuine differentiator against generic AI UI builders that
  imply more than they deliver. Lean into it rather than hiding it.
- **The obvious next step is the one thing it lacks:** hand the export to `sfdt deploy --validate`
  instead of to a README. Studio does not need to learn Salesforce auth — sfdt already has it.
  A Studio → sfdt handoff turns "a ZIP you hope deploys" into "a component validated against a
  real org," and it is the shortest path from prototype to product.
- **Studio is where a team surface should live, if one is ever needed.** It is the only one of
  our repos with Clerk identity, Supabase RLS, immutable versioning and revocable share links
  already built. If sfdt needs shared dashboards or a review link, the answer is to borrow
  Studio's shell — not to grow a second backend inside a local-first CLI. (Two caveats first:
  `SupabaseProjectRepository` connects with the service-role key and so bypasses the RLS
  policies, enforcing ownership in application code instead; and `organization_id` exists as a
  column nothing reads. Both must be fixed before that shell carries anyone else's data.)
- **Studio's `ComponentSpec` is the natural substrate for the committed-dashboard idea in §4.7.**
  A spec-driven, validated, version-controlled renderer is exactly what an AI-authored dashboard
  should compile to. That is one architecture serving two products.

---

## 7. Business-model read

Their model is coherent: free tools to acquire, prepaid credits to monetize the only line item
with marginal cost, per-turn cost shown inline to build trust in the meter, and a free/paid
boundary drawn where the user's intuition already is — building a dashboard costs, looking at
one does not. The pooled per-workspace wallet is what turns a single user into a team account.

We should not copy it, because our cost structure is the opposite: **our marginal cost is zero**
because the user brings their own key. That is not a gap to close, it is the pitch. "No credits,
no meter, no wallet — point it at your own model, including one running on your laptop" is a
stronger sentence than any price. The risk is not that they under-price us; it is that a
prepaid wallet is *easier to start* than installing Node 22.15 plus the `sf` CLI plus an
agentic CLI. Our answer to that is onboarding (`sfdt doctor` already exists and should be the
front door), not pricing.

One genuine warning. Their free beta is explicitly temporary — "we may introduce paid tiers in
the future" — and they have shipped 24 minor versions in 5.5 months while we are in a
stated feature freeze. A feature freeze is the right call for 1.0 and this document is not an
argument to break it. But the freeze should end with a phase that has these gaps in it, not
with a phase seeded from whatever is next in the backlog.

---

## Appendix — sources

Fetched 2026-08-22. Claims about SFDevTools trace to these pages only; no private or
authenticated source was used, and the app itself was not accessed.

| Claim area | Source |
|---|---|
| Feature inventory, 17 tools, agent, dashboards | `https://www.sfdevtools.com/#features` |
| Free tier, credits, top-up amounts, future paid tiers | `https://www.sfdevtools.com/pricing` |
| Origin, team, positioning | `https://www.sfdevtools.com/about` |
| OAuth modes, token encryption, data flow, caching, retention | `https://www.sfdevtools.com/docs/data-flow-security` |
| Full stack, hosting, auth provider, LLM providers | `https://www.sfdevtools.com/docs/tool-disclosures` |
| Subprocessor list, Gemini retention-disabled | `https://www.sfdevtools.com/docs/subprocessors` |
| Version history and dates | `https://www.sfdevtools.com/docs/releases` |
| Hosting confirmation (Vercel/Cloudflare), CSP, PostHog | HTTP response headers, `www.` and `app.` hosts |

Our own counts come from `generated/summary.json`, `generated/commands.json`,
`generated/mcp-tools.json`, `generated/gui-pages.json`, `generated/chrome-features.json` and
`generated/vscode-commands.json` — regenerated by `npm run generate:catalogs` and drift-checked
in CI, so they cannot disagree with what ships.

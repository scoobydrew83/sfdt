# Together Items — work that needs the user in the loop

These are the tracked items that **cannot** be completed by an agent working
alone: they need org access, external secrets, an unverifiable external contract,
or a coordinated release/publish step. Each entry states *why* it's blocked and
*what the user needs to provide or do* so we can finish it together.

Last updated: 2026-07-06

---

## CI / CD

### CI-1 — `integration` CI job (DevHub auth in PR context)
- **Why blocked:** the integration job needs a Salesforce **DevHub auth** (JWT
  key + consumer key + username) to spin scratch orgs, but PR-triggered runs
  from forks don't get repo secrets, and we must not leak org credentials into
  PR context.
- **Need from user:** confirm the CI secret names + which events should run the
  org-touching job (push-to-`develop`/tags only, not fork PRs), and add the
  secrets in GitHub → Settings → Secrets. Then we wire the job to gate on
  `github.event_name`/branch.

### CI-3 — Publish the agent-skills pack (4.9 follow-up)
- **Why blocked:** `sfdt skills export --target pack` now produces a valid
  `npx skills add`-compatible pack locally, but for `npx skills add scoobydrew83/sfdt`
  to resolve, the `manifest.json` + `skills/` layout must live at a **published
  location** (repo root, or a dedicated branch/repo). That's a repo/release
  decision.
- **Need from user:** decide where the published pack lives (commit a generated
  `manifest.json` at repo root vs. a `skills`-only publish branch) and whether
  to add a release step that regenerates it. Then we automate it.

---

## Agentforce

### AF-1 — `sfdt agent-test --threshold` (pass-rate gate)
- **Why blocked:** `sfdt agent-test` currently gates on the `sf agent test run`
  **exit code** only. A numeric pass-rate threshold (`--threshold 80`) needs the
  **JSON result schema** of `sf agent test run --json` — the field names for
  per-test outcomes / aggregate pass rate — which isn't documented and we
  couldn't confirm without running a real Agentforce eval.
- **Need from user:** run `sf agent test run --api-name <spec> --json` against a
  real org with an `AiEvaluationDefinition` and share the JSON (redacted). Then
  we add threshold parsing + a unit test pinned to the real shape.

---

## Chrome extension

### CHR-1 — Summer '26 setup deep links (4.10) — Field Access SHIPPED; two targets parked
- **Field Access — DONE.** Confirmed the real URL against a live org
  (`/lightning/setup/ObjectManager/<Object>/FieldAccess/view`). It's
  object-contextual, so it ships as a conditional **Field Access** tab in
  `features/setup-tabs.ts` that appears only on Object Manager object pages and
  targets the object you're viewing.
- **Security Center Essentials + Release Manager Beta — still blocked (parked).**
  Neither is present in a standard Developer Edition org: **Security Center** is a
  paid add-on (requires the Security Center license) and **Release Manager** is a
  Beta/pilot Salesforce must enable. We can't confirm real URLs from an org that
  lacks the feature, and shipping deep links to pages most orgs 404 on is the exact
  broken-link risk this item guards against.
- **Need from user:** access to an org that *has* Security Center licensed and/or
  Release Manager Beta enabled, then open each page and copy the URL. Until then
  these two stay out.

### CHR-2 — Org release/channel badge (4.11) — version/preview SHIPPED; channel still blocked
- **Shipped:** the Workspace top-bar badge (`entrypoints/app/main.ts`) shows the
  release + `(preview instance)`, derived via the shared `@sfdt/flow-core`
  `releaseFromVersionList()` (same logic as CLI `monitor org-info`).
- **Also shipped:** `features/org-release-badge.ts` puts the same pill in the live
  **Setup tab strip** (`ul.tabBarItems`), so the release is visible on real
  Salesforce Setup pages, not only in the Workspace tab.
- **Still blocked:** the **Release Manager channel** has no queryable Beta API
  (same gap as audit check 4.7).
- **Need from user:** nothing actionable for version/preview; the channel depends
  on Salesforce exposing an API — revisit when one exists.

---


## Legend
- **DevHub auth** = JWT-based `sf org login jwt` used in CI to create scratch orgs.
- **CWS** = Chrome Web Store.
- A "together item" is closed only after the user supplies the missing piece and
  we land the code — until then it stays here with its exact blocker.

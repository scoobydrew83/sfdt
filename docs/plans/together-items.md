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

### CI-2 — Chrome Web Store publish job (2.3)
- **Why blocked:** publishing the Chrome extension needs **CWS API credentials**
  (`extensionId`, `clientId`, `clientSecret`, `refreshToken`) — secrets we can't
  generate.
- **Need from user:** register/confirm the extension in the Chrome Web Store
  Developer Dashboard, generate the OAuth credentials, and add them as CI
  secrets. Then we add the upload/publish job to `ci.yml`.

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

### CHR-1 — Summer '26 setup deep links (4.10)
- **Why blocked:** the new Summer '26 setup pages (Field Access Summary — per
  object; Security Center Essentials; Release Manager — new Beta nodes) need
  their real `setup-node` / Lightning URLs, which vary per page and can't be
  guessed without a live org. Guessing ships broken deep links.
- **Need from user:** in a real Summer '26 org, open each target setup page and
  copy the URL (or confirm the setup-node names). Then we add them to the
  setup-tabs/nav features.

### CHR-2 — Org release/channel badge (4.11)
- **Why partially blocked:** release version + preview/non-preview are derivable
  (as `monitor org-info` does) and can ship. The **Release Manager channel**,
  however, has no queryable Beta API (same gap as audit check 4.7).
- **Need from user:** nothing to ship the version/preview badge — that half can
  proceed. For the channel, we need Salesforce to expose an API (external
  dependency); revisit when one exists.

---

## Docs site

### DOC-1 — sfdt-site staleness pass
- **Why blocked here:** the public docs live in a **separate repo**
  (`scoobydrew83/sfdt-site`, https://sfdt.dev/) that isn't in this session's
  scope.
- **Need from user:** add `scoobydrew83/sfdt-site` to the session (or confirm we
  should) so we can mirror the recent CLI changes (`agent-test`, Agentforce
  metadata, `skills export --target pack`, Code Analyzer v5, `test --logic`,
  `quality --api67`, the four new MCP tools) into its MDX.

---

## Legend
- **DevHub auth** = JWT-based `sf org login jwt` used in CI to create scratch orgs.
- **CWS** = Chrome Web Store.
- A "together item" is closed only after the user supplies the missing piece and
  we land the code — until then it stays here with its exact blocker.

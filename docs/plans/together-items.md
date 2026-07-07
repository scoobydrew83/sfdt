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

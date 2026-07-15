# Live Salesforce integration CI

The `integration` job in `.github/workflows/ci.yml` runs a **Tier 2 live smoke** against a real
Dev Hub on every push to `develop`: it creates a scratch org, runs the sfdt
pull → preflight → deploy → test → smoke → drift → compare → **versions** → **audit** → rollback
cycle against it (`scripts/integration/run-integration-tests.sh`), and always deletes the scratch
org on exit.

## It's off until you configure it (by design)

The job is **gated** so it is a graceful no-op — not a failure — until the secrets are set. An
`integration-gate` job checks whether `SFDX_AUTH_URL` is present; if not, the smoke is skipped
with a `::notice::` and CI stays green. This lets the workflow ship without breaking builds for
anyone without Dev Hub credentials.

## To enable it

1. **Create the `integration` environment** (repo Settings → Environments → New environment →
   `integration`). Add required reviewers if you want a manual approval gate before each live run.

2. **Add two secrets** (scoped to the `integration` environment, or repo-wide):

   | Secret | What it is |
   |---|---|
   | `SFDX_AUTH_URL` | The Dev Hub's sfdx auth URL — get it with `sf org auth show-sfdx-auth-url --target-org <devhub-alias>` (see [CI Authentication](https://sfdt.dev/cli/ci-authentication)). Used to `sf org login sfdx-url --set-default-dev-hub`. |
   | `SF_DEVHUB_USERNAME` | The Dev Hub username/alias, passed as `--target-dev-hub` for `sf org create scratch`. |

3. Push to `develop`. The gate detects the secret and runs the `integration` job.

## Safety (blueprint Workstream L-2)

- **Never on fork PRs** — the gate requires `github.ref == refs/heads/develop` and
  `github.event_name != 'pull_request'`, so secrets are never exposed to untrusted PRs.
- **Protected environment** — the `integration` environment can require reviewer approval.
- **Least privilege** — use a dedicated Dev Hub / scratch definition, not a production org.
- **Always cleanup** — the script's `trap cleanup EXIT` deletes the scratch org on success or
  failure; the auth file is removed immediately after login.
- **No secret archival** — no auth files or org details are uploaded as artifacts.

## Scope

This is Tier 2 (per-`develop` smoke). Tier 3 (nightly compatibility matrix across sf-CLI / Node
versions) and Tier 4 (release-candidate end-to-end with an evidence bundle) remain future work.

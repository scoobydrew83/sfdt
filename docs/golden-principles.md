# Golden Principles — sfdt

The short, opinionated, mechanical list. slop-gc enforces this file and nothing
else; if a rule isn't written here, it isn't a rule yet — propose it via PR.
Every principle is phrased so a violation is checkable, and each names its
enforcement (existing check, planned lint, or gc-scan).

1. **Commands stay thin; runners own logic.** A `src/commands/*.js` file
   registers flags and delegates to `src/lib/` or `scripts/` — no business
   logic. *(gc-scan; candidate lint: max statement count in command files)*
2. **Code is authoritative; catalogs are derived.** Never hand-edit
   `generated/*`; run `npm run generate:catalogs`. *(enforced:
   `check:all-contracts` CI)*
3. **Config changes touch three places in lockstep:** template
   (`src/templates/sfdt.config.json`), schema (`src/lib/config-schema.json`,
   `additionalProperties:false`), consumer. *(candidate lint: key-set diff
   between template and schema)*
   **A fourth place when the key has teeth.** `.sfdt/config.json` is committed,
   so it arrives with whatever repo was cloned. If the new key's value becomes a
   filesystem path, a network destination, a spawned command, or a privilege,
   it belongs to a capability class in `src/lib/config-trust.js` — path keys
   join `PROJECT_PATH_CONFIG_KEYS` in `safe-path.js` and are guarded with no
   further code. Classify; do not add a sixth name to a list of five.
4. **Secrets by env-var NAME only.** Config and logs carry the name of the
   variable, never its value. *(gc-scan + existing redaction in audit-logger)*
   A key that could hold a secret value is not made safe by nothing reading it —
   `ai.apiKey` sat in the schema unread until it was removed, which is exactly
   how long it takes for someone to start populating it.
   The same reasoning forbids putting a *grant* in the file: `SFDT_ALLOW_AI_WRITE`
   and `SFDT_ALLOW_UNSAFE_CONFIG` are environment variables because a flag inside
   `config.json` would be set by whoever set the dangerous key.
5. **Telemetry is best-effort and never throws.** Anything writing history,
   audit logs, or notifications wraps in try/catch and degrades silently —
   measurement must never break the work being measured. *(pattern source:
   `run-history.js`, `audit-logger.js`)*
   **One carve-out: `src/lib/ledger.js`.** `recordIntent` THROWS, and callers
   must let it — if the before-state of an org change cannot be recorded, the
   change must not be made. An unrecorded change is an unreversible one, and
   handing someone a changed org with no way back is a worse failure than an
   aborted command. This is the only place the principle is deliberately
   inverted; recording the *outcome* afterwards stays best-effort, because by
   then the org has already changed.
6. **Envelope on stdout, raw on disk.** JSON output uses the sf-native
   `{status, result, warnings}` envelope on stdout only; on-disk snapshots
   (`logs/*-latest.json`) stay raw. *(gc-scan)*
7. **Mutating surface requires confirmation.** Every mutating MCP tool declares
   `confirmExecution`. *(enforced: `test/command-policy.test.js`)*
8. **Package-internal paths resolve via `import.meta.url`,** never
   `process.cwd()`. *(candidate lint: grep-rule with remediation message;
   currently only the `/validate-npm-paths` ritual)*
9. **The verifier never writes.** Any checker agent runs with read-only tools;
   a verdict from an agent that edited the tree is void. *(loop-harness check)*
10. **One feature per session; clean tree at handoff.** A session ends with the
    branch passing the same smoke test the next session runs on entry — revert
    or stash rather than hand off a broken tree. *(loop-harness check)*
11. **FEATURES.json is ground truth, not a scratchpad.** Every entry declares
    `id/category/description/steps/passes/evidence`. The contract, verbatim (the
    strings `tools/check-features-edits.mjs` quotes back at you on violation):
    - FEATURES.json is graded as JSON, not prose.
    - Evidence is dated and re-checkable — a command output or a path, never "done".
    - The checker is the only writer, and only of passes/evidence.
    - id/category/description/steps change by planner/human commit only; entries are added/removed only by planner/human commit.

    *(enforced: `check:features` → `tools/check-features-edits.mjs`)*
12. **Checks exclude the artifacts that define them.** A grep-based rule must
    filter out the checker, the feature file, the docs describing the fix, and
    any test fixture that names the banned value — the enforcement tool naming
    a violation is not a violation. Observed twice (H-002, H-019) before this
    was written down. *(pattern source: reflexivity guards in
    `check-harness.mjs`; applies to every future `tools/check-*.mjs`)*

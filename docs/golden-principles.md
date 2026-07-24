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
4. **Secrets by env-var NAME only.** Config and logs carry the name of the
   variable, never its value. *(gc-scan + existing redaction in audit-logger)*
5. **Telemetry is best-effort and never throws.** Anything writing history,
   audit logs, or notifications wraps in try/catch and degrades silently —
   measurement must never break the work being measured. *(pattern source:
   `run-history.js`, `audit-logger.js`)*
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

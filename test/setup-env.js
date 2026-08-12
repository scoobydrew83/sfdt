// Vitest setup file: scrub host env vars that would make the test suite write
// into the developer's real working files.
//
// `SFDT_HARNESS_TELEMETRY` names the tracked `.harness/telemetry.jsonl` that the
// weekly `harness-improver` workflow mines in CI, and the sfdt dev checkout is
// exactly where it is meant to be exported (docs/ENV-VARS.md). But
// `agent-loop.js` mirrors an `agent-fix` row on every `runFixLoop()` call, so on
// such a machine a plain `npm test` appended five synthetic rows —
// indistinguishable from real runs — straight into the file CI reads. Measurement
// must not ingest its own fixtures.
//
// Scrubbed here rather than stubbed per-test so future tests that reach
// `runFixLoop()` inherit the guard for free. Tests that want the mirroring path
// set the variable themselves (see test/lib/agent-loop.test.js).

delete process.env.SFDT_HARNESS_TELEMETRY;

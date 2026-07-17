# Apex debug-log parser (`extension/lib/apex-log`)

`parseApexLog(raw, opts?) → ParsedLog` is a **pure, synchronous** parser: zero DOM,
zero IO, zero `chrome.*`, no runtime dependencies. One pass over the lines builds
the invocation tree (executions → code-units → methods) with per-node durations,
the SOQL/DML/callout inventories, and per-namespace governor-limit snapshots. It
degrades gracefully on the three truncation shapes and never throws.

## Big-log strategy (board AC-3) — decided by measurement

**Measured: a ~5.28 MB realistic log (3,827 executions) parses synchronously in
~33 ms** on dev hardware (`test/apex-log-parser.bench.test.ts`, generated at
runtime — no committed fixture). That is ~60× under the 2000 ms CI budget the
benchmark asserts, and ~2 frames of a 60 fps budget.

**Decision: run it synchronously. No Web Worker.** A 33 ms parse does not block
the UI thread in any way a user perceives, so an off-thread mechanism is not
required to meet the AC — and would likely cost more than it saves:

- **Web Worker** offloads the parse, but the `ParsedLog` (tree + inventories) must
  come back over `postMessage`, which **structured-clones the whole result graph,
  O(result size)**. For a big log that clone can cost as much as the parse it
  offloaded — you move the work off-thread but pay a comparable serialization tax,
  plus duplicated memory and async plumbing.
- **Chunked main-thread yield** avoids serialization but forces the single-pass
  state machine to become a resumable/interruptible one (persist the invocation
  stack, pending inventories, and limit-block state across chunks) — real
  complexity for a parse that already finishes in ~33 ms.

Neither is justified by the measurement. Sync is the leanest sufficient strategy
up to ~5 MB. If a future capture is pathologically larger or slower, the escape
hatch below needs **no change to this pure function**.

## Memory lever: `collectEvents: false`

`ParseOptions.collectEvents` (default `true`) controls the flat `events[]` array —
one entry per log line. On a multi-MB log that array is the parser's largest
allocation. The tree, durations, and all inventories are built **regardless** of
the flag, so a consumer that only needs the profile tree + inventories (the P3-3
profiler UI) should pass `collectEvents: false` to skip retaining every event.
The benchmark asserts `events.length === 0` with the flag and a non-trivial count
without, and that the structural result is identical either way.

## How P3-3 (and any consumer) should invoke it for large logs

```ts
import { parseApexLog } from '~/lib/apex-log';

// Default: sync, tree + inventories, no per-event array. Sufficient up to ~5 MB.
const parsed = parseApexLog(rawLog, { collectEvents: false });
```

Because `parseApexLog` is pure and dependency-free, a consumer that ever needs to
offload a pathologically large log can host **this same function** in a Worker
without changing it — the pure parser is the unit of work, and the consumer owns
the worker-vs-inline decision:

```ts
// consumer-owned worker entrypoint (NOT part of the pure lib):
//   onmessage = (e) => postMessage(parseApexLog(e.data.raw, e.data.opts));
```

That host is deliberately *not* shipped here: the measurement says it isn't
needed, and adding it now would be speculative complexity plus a structured-clone
cost the sync path avoids entirely.

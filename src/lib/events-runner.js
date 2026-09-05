import {
  SalesforceBayeuxClient,
  eventChannelQuery,
  eventChannelPath,
  REPLAY_NEW_ONLY,
  REPLAY_ALL_RETAINED,
} from '@sfdt/flow-core';
import { query } from './org-query.js';
import { orgRest, restErrorMessage } from './org-rest.js';
import { apiVersion } from './record-runner.js';
import { getOrgSession } from './org-session.js';
import { assertApiName } from './safe-path.js';

/**
 * `sfdt events` — Platform Events and Change Data Capture, CLI side.
 *
 * Three capabilities, and only one of them needs a session token:
 *
 *   list    — plain SOQL through `sf`. No token.
 *   publish — a REST POST through `sf api request rest`. No token.
 *   tail    — a CometD long-poll, which `sf` cannot proxy. Holds a bearer token
 *             in memory for the life of the command (see org-session.js).
 *
 * The Bayeux protocol implementation is `@sfdt/flow-core`'s, shared verbatim
 * with the Chrome extension's background worker. A stateful handshake with a
 * replay extension and a reconnect policy is exactly the kind of thing two
 * copies would drift on, in ways that only show up against a real org.
 */

export { REPLAY_NEW_ONLY, REPLAY_ALL_RETAINED };

/** Channel kinds enumerated by `events list`, in the order they are reported. */
const CHANNEL_KINDS = ['platformEvent', 'standardPlatformEvent', 'customChannel', 'changeEvent'];

/**
 * Enumerate everything subscribable in the org.
 *
 * A kind whose query is refused becomes a note, not an exception: three working
 * lists plus a stated gap beats no answer at all. Same rule the field scans use.
 *
 * @returns {Promise<{channels: Array<object>, notes: string[]}>}
 */
export async function listEventChannels(orgAlias) {
  const channels = [];
  const notes = [];

  for (const kind of CHANNEL_KINDS) {
    const { soql, tooling } = eventChannelQuery(kind);
    let records;
    try {
      records = await query(orgAlias, soql, { tooling });
    } catch (err) {
      notes.push(
        `${kind} channels could not be listed (${err.message}), so NONE are shown for that kind — ` +
          `a failed query, not a finding that your org has none.`,
      );
      continue;
    }

    if (kind === 'changeEvent') {
      // The catch-all channel is not a row in PlatformEventChannelMember; it is
      // always subscribable, so it is added rather than queried for.
      channels.push({
        kind,
        name: 'ChangeEvents',
        label: 'All Change Events',
        path: eventChannelPath('ChangeEvents'),
      });
      for (const r of records) {
        if (!r.SelectedEntity) continue;
        const name = `${r.SelectedEntity}ChangeEvent`;
        channels.push({
          kind,
          name,
          label: r.MasterLabel ?? name,
          path: eventChannelPath(name),
        });
      }
      continue;
    }

    for (const r of records) {
      const name = r.QualifiedApiName ?? r.FullName;
      if (!name) continue;
      channels.push({ kind, name, label: r.Label ?? r.MasterLabel ?? name, path: eventChannelPath(name) });
    }
  }

  return { channels, notes };
}

/**
 * Publish one platform event.
 *
 * An event is created like any other sObject — a POST to
 * `/sobjects/<Event>__e/` — so this needs no token and no streaming. Paired with
 * `tailEvents({ expect })` it becomes a publish-then-assert integration test
 * that runs in CI, which is the thing a hosted console cannot put in a pipeline.
 *
 * @param {object} config - loaded sfdt config (for the API version)
 * @param {string} orgAlias
 * @param {string} eventApiName - e.g. `Order_Placed__e`
 * @param {object} fields - field API name → value
 * @param {object} [options]
 * @param {boolean} [options.dryRun] - Return the body without sending it.
 */
export async function publishEvent(config, orgAlias, eventApiName, fields, { dryRun = false } = {}) {
  // Shape first: this value is interpolated into a REST path below, and on the
  // MCP surface it is model-supplied (see safe-path.js's header). The `__e`
  // check under it is a usability check, not a security one — it is a *suffix*
  // test, so it constrains nothing about the rest of the string. On its own it
  // let `PermissionSetAssignment?x=__e` through, turning an approved "publish a
  // platform event" into an arbitrary authenticated record insert, and a
  // `../tooling/sobjects/ApexClass?x=__e` variant into an Apex class write.
  assertApiName(eventApiName, 'platform event');
  if (!/__e$/i.test(eventApiName)) {
    // A near-certain mistake, and the org's error for it is unhelpful.
    throw new Error(
      `"${eventApiName}" is not a platform event — those end in \`__e\`. ` +
        `Change Data Capture events are published by Salesforce and cannot be posted.`,
    );
  }
  if (Object.keys(fields).length === 0) {
    throw new Error('Provide at least one --field Name=Value to publish.');
  }
  if (dryRun) {
    return { outcome: 'dry-run', event: eventApiName, body: fields, id: null };
  }
  try {
    // Encoded as well as validated — the same treatment soql-runner.js:362 gives
    // its path segments. Belt and braces: the assert above already rejects
    // anything needing encoding, but the encode is what makes that non-load-bearing.
    const result = await orgRest(orgAlias, `/services/data/${apiVersion(config)}/sobjects/${encodeURIComponent(eventApiName)}/`, {
      method: 'POST',
      body: fields,
    });
    return {
      outcome: result?.success ? 'published' : 'rejected',
      event: eventApiName,
      body: fields,
      // A platform event id is transient — it identifies the publish, not a row
      // you can go and read back.
      id: result?.id ?? null,
      error: result?.success ? null : 'The org did not report success.',
    };
  } catch (err) {
    return {
      outcome: 'rejected',
      event: eventApiName,
      body: fields,
      id: null,
      error: restErrorMessage(err),
    };
  }
}

/**
 * Does one event payload satisfy every expected `Field=Value` pair?
 *
 * Deliberately literal string comparison over field paths rather than an
 * invented JSONPath dialect: a matcher nobody can predict is worse than one
 * that only does the obvious thing. Nested payloads are reachable with dots
 * (`ChangeEventHeader.changeType`), because CDC puts everything useful there.
 */
export function matchesExpectation(payload, expected) {
  const entries = Object.entries(expected);
  if (entries.length === 0) return true;
  return entries.every(([path, want]) => {
    let value = payload;
    for (const part of path.split('.')) {
      if (value == null || typeof value !== 'object') return false;
      value = value[part];
    }
    if (Array.isArray(value)) return value.map(String).includes(String(want));
    return String(value) === String(want);
  });
}

/**
 * Subscribe to a channel and collect events until a bound is hit.
 *
 * Bounded by construction. An unbounded tail is fine at a terminal, where a
 * human presses Ctrl-C, and a hang in CI — so `timeoutMs` always applies and
 * `max` and `expect` each end the tail early.
 *
 * @param {string} orgAlias
 * @param {string} channel - Name or full Bayeux path.
 * @param {object} [options]
 * @param {number} [options.replayId] - -1 new only, -2 all retained, or an id.
 * @param {number} [options.timeoutMs]
 * @param {number} [options.max] - Stop after this many events.
 * @param {object} [options.expect] - Field=Value pairs; stop on the first match.
 * @param {(event: object) => void} [options.onEvent] - Called per event, live.
 * @param {(status: string, isError: boolean) => void} [options.onStatus]
 * @param {AbortSignal} [options.signal] - Ctrl-C.
 * @returns {Promise<{channel, path, events, matched, outcome, replayId, error}>}
 */
export async function tailEvents(orgAlias, channel, {
  replayId = REPLAY_NEW_ONLY,
  timeoutMs = 60_000,
  max = 0,
  expect = null,
  onEvent,
  onStatus,
  signal,
} = {}) {
  const path = eventChannelPath(channel);
  const session = await getOrgSession(orgAlias);

  const client = new SalesforceBayeuxClient(
    session.instanceUrl,
    session.accessToken,
    session.apiVersion,
  );

  const events = [];
  let matched = false;
  let failure = null;

  const done = new Promise((resolve) => {
    let settled = false;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      // Unsubscribe before resolving, so the org is not left holding a
      // subscription for a command that has already exited.
      void client.stop().finally(() => resolve(outcome));
    };

    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    const onAbort = () => finish('interrupted');
    signal?.addEventListener('abort', onAbort, { once: true });

    client.onStatus((status, isError) => {
      onStatus?.(status, isError);
      if (isError) {
        // A failed handshake or subscribe never delivers an event, so waiting
        // for the timeout would just be a slower way to report the same thing.
        failure = status;
        finish('error');
      }
    });

    client.onMessage((data) => {
      // Drop anything that arrives after the tail has ended. `stop()` is async
      // and one `/meta/connect` response carries a BATCH, so the client hands
      // over every message in that batch before the abort can take effect —
      // without this guard `--max 2` reports three events, and a `--expect` run
      // keeps collecting after it has already succeeded.
      if (settled) return;
      events.push(data);
      onEvent?.(data);
      if (expect && matchesExpectation(data, expect)) {
        matched = true;
        finish('matched');
        return;
      }
      if (max > 0 && events.length >= max) finish('max');
    });
  });

  void client.start(path, replayId);
  const outcome = await done;

  return {
    channel,
    path,
    replayId,
    events,
    matched,
    outcome,
    error: failure,
  };
}

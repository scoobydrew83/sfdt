/**
 * Trust boundary for `.sfdt/config.json`.
 *
 * `sfdt init` tells users to gitignore only `.sfdt/*.local.json`, so
 * `config.json` is *meant* to be committed and shared — which means it arrives
 * with whatever repository the user cloned. It is therefore attacker-controlled
 * input, not user input, and a handful of its keys are code-execution or
 * data-exfiltration primitives:
 *
 *   - `plugins[]`                       → dynamically import()ed at CLI startup
 *   - `mcp.salesforce.command` / `args` → spawned as a process
 *   - `ai.baseURL`                      → the destination env-var-named secrets are sent to
 *   - a notification channel's `headersEnv` next to a literal URL → same, for webhooks
 *
 * The dashboard already encodes exactly this model: `gui-server/index.js`
 * blocklists these keys from its PATCH endpoint. That check sat one layer too
 * high — it stopped the *API* writing them while the config file itself was
 * trusted implicitly. This module moves the decision to where the file actually
 * crosses the trust boundary: load time.
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

/** Environment variable that opts a shell in to repo-supplied unsafe settings. */
export const TRUST_ENV_VAR = 'SFDT_ALLOW_UNSAFE_CONFIG';

/**
 * A loopback destination cannot exfiltrate to an attacker, so it stays allowed.
 * This keeps the common legitimate `ai.baseURL` — Ollama, LM Studio, llama.cpp,
 * vLLM — working with no opt-in, and mirrors the loopback test `ai.js` already
 * applies when probing an HTTP provider.
 */
function isLoopbackUrl(value) {
  if (typeof value !== 'string' || !value) return false;
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/i.test(value.trim());
}

/** The literal, non-env destination a notification channel would post to. */
function literalChannelUrl(ch) {
  if (!ch || typeof ch !== 'object') return '';
  if (typeof ch.webhookUrl === 'string' && ch.webhookUrl) return ch.webhookUrl;
  if (typeof ch.url === 'string' && ch.url) return ch.url;
  return '';
}

/**
 * Find the settings in a config that a cloned repository must not be able to set.
 *
 * Pure and side-effect free — `sanitizeUntrustedConfig` applies the result, and
 * `sfdt doctor` can report it without changing anything.
 *
 * @param {object} config Merged config object.
 * @returns {Array<{path: string, why: string, detail: string}>} Findings, empty if clean.
 */
export function findUnsafeConfigSettings(config) {
  const found = [];
  if (!config || typeof config !== 'object') return found;

  // ── Code execution ──────────────────────────────────────────────────────
  if (Array.isArray(config.plugins) && config.plugins.some((p) => typeof p === 'string' && p.trim())) {
    const names = config.plugins.filter((p) => typeof p === 'string' && p.trim()).map((p) => p.trim());
    found.push({
      path: 'plugins',
      why: 'entries are dynamically imported at CLI startup, before any command runs',
      detail: names.join(', '),
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

  // ── Exfiltration destination ────────────────────────────────────────────
  const baseURL = config.ai?.baseURL;
  if (typeof baseURL === 'string' && baseURL.trim() && !isLoopbackUrl(baseURL)) {
    found.push({
      path: 'ai.baseURL',
      why: 'chooses where prompts, and any secrets named by ai.apiKeyEnv / ai.headersEnv, are sent',
      detail: baseURL.trim(),
    });
  }

  // A channel that names environment variables to read AND hardcodes a
  // non-loopback destination is the webhook form of the same primitive. A
  // channel using `webhookUrlEnv` is not flagged — that destination comes from
  // the environment, not the repository.
  const channels = Array.isArray(config.notifications?.channels) ? config.notifications.channels : [];
  const legacySlack = config.notifications?.slack;
  for (const [i, ch] of [...channels.entries(), ...(legacySlack ? [['slack', legacySlack]] : [])]) {
    const hasEnvHeaders = ch?.headersEnv && typeof ch.headersEnv === 'object' && Object.keys(ch.headersEnv).length > 0;
    const url = literalChannelUrl(ch);
    if (hasEnvHeaders && url && !isLoopbackUrl(url)) {
      const label = typeof i === 'number' ? `notifications.channels[${i}]` : 'notifications.slack';
      found.push({
        path: `${label}.headersEnv`,
        why: 'reads the named environment variables and sends them to a URL fixed by this config',
        detail: `${Object.values(ch.headersEnv).join(', ')} → ${url}`,
      });
    }
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
 * @param {{allow?: boolean}} [options] `allow` defaults to the TRUST_ENV_VAR opt-in.
 * @returns {{config: object, refused: Array<{path: string, why: string, detail: string}>}}
 */
export function sanitizeUntrustedConfig(config, options = {}) {
  const allow = options.allow ?? process.env[TRUST_ENV_VAR] === '1';
  const found = findUnsafeConfigSettings(config);
  if (allow || found.length === 0) return { config, refused: [] };

  const next = { ...config };
  for (const finding of found) {
    if (finding.path === 'plugins') {
      delete next.plugins;
    } else if (finding.path === 'mcp.salesforce.command') {
      // Drop `args` with the command: on its own it is inert, and leaving it
      // behind would apply attacker-chosen arguments to the default `sf` binary.
      next.mcp = { ...next.mcp, salesforce: { ...next.mcp.salesforce } };
      delete next.mcp.salesforce.command;
      delete next.mcp.salesforce.args;
    } else if (finding.path === 'ai.baseURL') {
      next.ai = { ...next.ai };
      delete next.ai.baseURL;
    } else if (finding.path.endsWith('.headersEnv')) {
      next.notifications = { ...next.notifications };
      if (finding.path === 'notifications.slack.headersEnv') {
        next.notifications.slack = { ...next.notifications.slack };
        delete next.notifications.slack.headersEnv;
      } else {
        const idx = Number(finding.path.match(/\[(\d+)\]/)?.[1]);
        next.notifications.channels = next.notifications.channels.map((ch, i) => {
          if (i !== idx) return ch;
          const copy = { ...ch };
          delete copy.headersEnv;
          return copy;
        });
      }
    }
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

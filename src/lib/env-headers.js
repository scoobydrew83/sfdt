/**
 * Env-referenced HTTP headers.
 *
 * Config stores env-var NAMES, never secret values — the rule already followed
 * by `ai.apiKeyEnv`, `webhookUrlEnv`, and the SMTP `*Env` keys. Header maps were
 * the exception: literal values only, so any bearer token had to be written
 * into `.sfdt/config.json`.
 *
 * Two consumers resolve headers this way (the notifier's webhook channels and
 * the `http` AI provider), and their semantics must not drift — precedence and
 * the unset-var behaviour are security-relevant in both. Hence one helper.
 */

/**
 * Merge literal headers with env-referenced ones.
 *
 * @param {Record<string,string>} [headers]    Literal name → value.
 * @param {Record<string,string>} [headersEnv] Name → NAME of the env var holding the value.
 * @param {string} [context] Prefix for the thrown error, e.g. 'ai.headersEnv'.
 * @returns {Record<string,string>} Resolved headers; `headersEnv` wins on conflict.
 * @throws {Error} If a named env var is unset or empty.
 */
export function resolveEnvHeaders(headers, headersEnv, context = 'headersEnv') {
  const resolved = { ...(headers ?? {}) };
  for (const [name, envVar] of Object.entries(headersEnv ?? {})) {
    const value = process.env[envVar];
    // Unset is a hard error, not a skipped header. Silently sending the request
    // without its auth header turns a local config typo into a 401 from the far
    // end, which is far harder to trace back to here.
    if (!value) {
      throw new Error(
        `${context}: header "${name}" is configured from env var ${envVar}, which is unset or empty — ` +
          `export ${envVar}, or drop "${name}" from ${context}`,
      );
    }
    resolved[name] = value;
  }
  return resolved;
}

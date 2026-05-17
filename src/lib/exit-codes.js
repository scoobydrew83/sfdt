/**
 * Structured exit codes for sfdt — enables reliable scripting and CI integration.
 *
 * 0  SUCCESS       — command completed without errors
 * 1  ERROR         — general / unexpected failure
 * 2  CONFIG_ERROR  — configuration missing, invalid, or not initialised
 * 3  CONNECT_ERROR — org / network unreachable or authentication failure
 */
export const ExitCode = {
  SUCCESS: 0,
  ERROR: 1,
  CONFIG_ERROR: 2,
  CONNECT_ERROR: 3,
};

const CONNECTIVITY_PATTERNS = [
  /ECONNREFUSED/,
  /ETIMEDOUT/,
  /ENOTFOUND/,
  /socket hang up/i,
  /NamedOrgNotFound/i,
  /No org configuration found/i,
  /Org not found/i,
  /No authorized org/i,
  /Failed to refresh auth token/i,
  /expired access\/refresh token/i,
  /INVALID_SESSION_ID/i,
  /AuthInfo not found/i,
];

/**
 * Resolve the appropriate exit code for an error thrown by a command.
 *
 * Precedence:
 *  1. err.exitCode already set to one of the named constants (honours explicit overrides)
 *  2. ConfigError class name
 *  3. Connectivity heuristics against message + stderr
 *  4. General error (1)
 */
export function resolveExitCode(err) {
  if (!err) return ExitCode.ERROR;

  if (err.name === 'ConfigError' || err.exitCode === ExitCode.CONFIG_ERROR) {
    return ExitCode.CONFIG_ERROR;
  }

  const msg = `${err.message || ''} ${err.stderr || ''}`;
  if (CONNECTIVITY_PATTERNS.some((p) => p.test(msg))) return ExitCode.CONNECT_ERROR;

  return ExitCode.ERROR;
}

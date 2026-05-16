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
export function resolveExitCode(err) {
  if (!err) return ExitCode.ERROR;
  if (err.name === 'ConfigError' || err.exitCode === ExitCode.CONFIG_ERROR) {
    return ExitCode.CONFIG_ERROR;
  }
  const msg = `${err.message || ''} ${err.stderr || ''}`;
  if (CONNECTIVITY_PATTERNS.some((p) => p.test(msg))) return ExitCode.CONNECT_ERROR;
  return ExitCode.ERROR;
}

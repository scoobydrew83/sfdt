/**
 * Return a file path's basename with `suffix` removed, or null when the
 * basename doesn't end with `suffix` (or the result would be empty). Handles
 * both POSIX and Windows separators. Free of any `vscode` import.
 *
 * Shared by the agent-test spec (`.aiEvaluationDefinition-meta.xml`) and Apex
 * class (`.cls`) name derivations, which are the same split/endsWith/slice.
 */
export function basenameWithoutSuffix(filePath: string, suffix: string): string | null {
  if (!filePath) return null;
  const base = filePath.split(/[\\/]/).pop() ?? '';
  if (!base.endsWith(suffix)) return null;
  const name = base.slice(0, -suffix.length);
  return name.length > 0 ? name : null;
}

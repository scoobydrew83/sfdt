/**
 * Pure helpers for the Agentforce agent-test CodeLens/command. An agent test is
 * an `AiEvaluationDefinition` metadata file whose API name (the value passed to
 * `sfdt agent-test --spec`) is its file basename minus the metadata suffix.
 *
 * Free of any `vscode` import so it can be unit-tested in isolation.
 */

/** Glob (and CodeLens document pattern) for Agentforce agent-test spec files. */
export const AGENT_TEST_GLOB = '**/*.aiEvaluationDefinition-meta.xml';

const SUFFIX = '.aiEvaluationDefinition-meta.xml';

/**
 * Derive the agent-test spec (AiEvaluationDefinition API name) from a file
 * path, or null when the path is not an agent-test spec file. Handles both
 * POSIX and Windows separators.
 */
export function specNameFromFile(filePath: string): string | null {
  if (!filePath) return null;
  const base = filePath.split(/[\\/]/).pop() ?? '';
  if (!base.endsWith(SUFFIX)) return null;
  const name = base.slice(0, -SUFFIX.length);
  return name.length > 0 ? name : null;
}

/**
 * Pure helpers for the Agentforce agent-test CodeLens/command. An agent test is
 * an `AiEvaluationDefinition` metadata file whose API name (the value passed to
 * `sfdt agent-test --spec`) is its file basename minus the metadata suffix.
 *
 * Free of any `vscode` import so it can be unit-tested in isolation.
 */

import { basenameWithoutSuffix } from './basename.js';

/** Glob (and CodeLens document pattern) for Agentforce agent-test spec files. */
export const AGENT_TEST_GLOB = '**/*.aiEvaluationDefinition-meta.xml';

const SUFFIX = '.aiEvaluationDefinition-meta.xml';

/**
 * Derive the agent-test spec (AiEvaluationDefinition API name) from a file
 * path, or null when the path is not an agent-test spec file.
 */
export function specNameFromFile(filePath: string): string | null {
  return basenameWithoutSuffix(filePath, SUFFIX);
}

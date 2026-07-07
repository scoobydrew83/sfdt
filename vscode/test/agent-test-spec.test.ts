import { describe, it, expect } from 'vitest';
import { specNameFromFile, AGENT_TEST_GLOB } from '../src/lib/agent-test-spec.js';

describe('specNameFromFile', () => {
  it('derives the API name from an agent-test spec path', () => {
    expect(specNameFromFile('force-app/main/default/aiEvaluationDefinitions/MyTest.aiEvaluationDefinition-meta.xml')).toBe(
      'MyTest',
    );
  });

  it('handles a bare filename and Windows separators', () => {
    expect(specNameFromFile('SupportAgent_Eval.aiEvaluationDefinition-meta.xml')).toBe('SupportAgent_Eval');
    expect(specNameFromFile('C:\\proj\\a\\Greeting.aiEvaluationDefinition-meta.xml')).toBe('Greeting');
  });

  it('returns null for non-spec files and empty input', () => {
    expect(specNameFromFile('force-app/main/default/classes/MyClass.cls')).toBeNull();
    expect(specNameFromFile('MyBot.bot-meta.xml')).toBeNull();
    expect(specNameFromFile('.aiEvaluationDefinition-meta.xml')).toBeNull(); // no name
    expect(specNameFromFile('')).toBeNull();
  });

  it('exposes a glob that matches the suffix', () => {
    expect(AGENT_TEST_GLOB).toContain('aiEvaluationDefinition-meta.xml');
  });
});

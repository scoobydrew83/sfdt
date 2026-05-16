import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PROMPT_TEMPLATES,
  assembleDefaultPrompt,
  getDefaultPromptById,
  getFallbackDefaultPromptId,
} from '../src/default-prompts.js';
describe('flow-core/default-prompts', () => {
  it('ships the five v2.0.2 prompts', () => {
    expect(DEFAULT_PROMPT_TEMPLATES).toHaveLength(5);
    const ids = DEFAULT_PROMPT_TEMPLATES.map((t) => t.id).sort();
    expect(ids).toEqual([
      'describe-elements',
      'draw-io',
      'improvements',
      'summarise',
      'test-scenarios',
    ]);
  });
  it('each template has all required fields and a non-empty prompt body', () => {
    for (const t of DEFAULT_PROMPT_TEMPLATES) {
      expect(t.id).toBeTruthy();
      expect(t.title).toBeTruthy();
      expect(t.description).toBeTruthy();
      expect(t.category).toBeTruthy();
      expect(t.contexts).toEqual(['flow-canvas']);
      expect(typeof t.prompt).toBe('string');
      expect(t.prompt.length).toBeGreaterThan(200);
    }
  });
  it('exactly one template is marked as the fallback default', () => {
    const fallbacks = DEFAULT_PROMPT_TEMPLATES.filter((t) => t.isFallbackDefault);
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0]!.id).toBe('summarise');
  });
  it('getFallbackDefaultPromptId returns "summarise"', () => {
    expect(getFallbackDefaultPromptId()).toBe('summarise');
  });
  it('getDefaultPromptById returns the matching template', () => {
    const t = getDefaultPromptById('draw-io');
    expect(t).not.toBeNull();
    expect(t!.title).toBe('Generate Draw.io Diagram');
  });
  it('getDefaultPromptById returns null for unknown ids', () => {
    expect(getDefaultPromptById('not-a-real-id')).toBeNull();
  });
  it('assembleDefaultPrompt appends metadata JSON to the prompt body', () => {
    const json = '{"foo": "bar"}';
    const out = assembleDefaultPrompt('summarise', json);
    expect(out).not.toBeNull();
    expect(out!.endsWith(json)).toBe(true);
    expect(out!.startsWith('You are a Salesforce Flow documentation expert.')).toBe(true);
  });
  it('assembleDefaultPrompt returns null when the template id is unknown', () => {
    expect(assembleDefaultPrompt('not-real', '{}')).toBeNull();
  });
  it('draw-io prompt preserves the exact phrasing that constrains the model', () => {
    const t = getDefaultPromptById('draw-io')!;
    expect(t.prompt).toContain('Return exactly one markdown code block fenced with xml');
    expect(t.prompt).toContain('<mxfile>');
  });
});

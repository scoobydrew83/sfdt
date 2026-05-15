import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { buildField } from '../lib/zod-to-dom.js';

describe('zod-to-dom buildField', () => {
  it('renders ZodBoolean as a checkbox initialised to the current value', () => {
    const { node, getValue } = buildField(z.boolean(), true);
    const input = node as HTMLInputElement;
    expect(input.type).toBe('checkbox');
    expect(input.checked).toBe(true);
    input.checked = false;
    expect(getValue()).toBe(false);
  });

  it('renders ZodString as a text input', () => {
    const { node, getValue } = buildField(z.string(), 'hello');
    const input = node as HTMLInputElement;
    expect(input.type).toBe('text');
    expect(input.value).toBe('hello');
    input.value = 'world';
    expect(getValue()).toBe('world');
  });

  it('renders a 7-char hex string starting with # as a color input', () => {
    const { node } = buildField(z.string(), '#FFD700');
    expect((node as HTMLInputElement).type).toBe('color');
  });

  it('renders ZodEnum as a select with one option per enum value', () => {
    const { node, getValue } = buildField(z.enum(['list', 'calendar']), 'calendar');
    const sel = node as HTMLSelectElement;
    expect(sel.tagName).toBe('SELECT');
    expect(Array.from(sel.options).map((o) => o.value)).toEqual(['list', 'calendar']);
    expect(sel.value).toBe('calendar');
    sel.value = 'list';
    expect(getValue()).toBe('list');
  });

  it('renders ZodNumber as a number input that returns numbers', () => {
    const { node, getValue } = buildField(z.number(), 42);
    const input = node as HTMLInputElement;
    expect(input.type).toBe('number');
    expect(input.value).toBe('42');
    input.value = '99';
    expect(getValue()).toBe(99);
  });

  it('renders ZodObject as a fieldset of named child fields', () => {
    const { node, getValue } = buildField(
      z.object({ name: z.string(), enabled: z.boolean() }),
      { name: 'alpha', enabled: true },
    );
    expect(node.tagName).toBe('FIELDSET');
    const inputs = node.querySelectorAll('input');
    expect(inputs.length).toBe(2);
    expect(getValue()).toEqual({ name: 'alpha', enabled: true });
  });

  it('throws on unsupported Zod types', () => {
    expect(() => buildField(z.bigint(), 0n as never)).toThrow(/Unsupported zod type/i);
  });
});

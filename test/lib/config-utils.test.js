import { describe, it, expect } from 'vitest';
import { setNestedValue, getNestedValue, coerceConfigValue } from '../../src/lib/config-utils.js';

describe('setNestedValue', () => {
  it('sets a top-level key', () => {
    const obj = {};
    setNestedValue(obj, 'foo', 'bar');
    expect(obj.foo).toBe('bar');
  });

  it('sets a nested key via dot notation', () => {
    const obj = {};
    setNestedValue(obj, 'a.b.c', 42);
    expect(obj.a.b.c).toBe(42);
  });

  it('preserves existing sibling keys when setting a nested key', () => {
    const obj = { a: { x: 1 } };
    setNestedValue(obj, 'a.y', 2);
    expect(obj.a.x).toBe(1);
    expect(obj.a.y).toBe(2);
  });

  it('throws on __proto__ key segment', () => {
    expect(() => setNestedValue({}, '__proto__', 'bad')).toThrow('Invalid key segment');
  });

  it('throws on constructor key segment', () => {
    expect(() => setNestedValue({}, 'constructor', 'bad')).toThrow('Invalid key segment');
  });

  it('throws on prototype key segment', () => {
    expect(() => setNestedValue({}, 'prototype', 'bad')).toThrow('Invalid key segment');
  });

  it('throws on __proto__ in nested path', () => {
    expect(() => setNestedValue({}, 'a.__proto__.bad', 'x')).toThrow('Invalid key segment');
  });

  it('throws on numeric-only key (violates identifier regex)', () => {
    expect(() => setNestedValue({}, '123', 'bad')).toThrow('Invalid key segment');
  });

  it('does not pollute Object.prototype', () => {
    const obj = {};
    expect(() => setNestedValue(obj, '__proto__', { polluted: true })).toThrow();
    expect({}.polluted).toBeUndefined();
  });
});

describe('getNestedValue', () => {
  it('reads a top-level key', () => {
    expect(getNestedValue({ foo: 'bar' }, 'foo')).toBe('bar');
  });

  it('reads a nested key', () => {
    expect(getNestedValue({ a: { b: { c: 3 } } }, 'a.b.c')).toBe(3);
  });

  it('returns undefined for a missing path', () => {
    expect(getNestedValue({ a: {} }, 'a.b.c')).toBeUndefined();
  });

  it('throws on __proto__ key segment', () => {
    expect(() => getNestedValue({}, '__proto__')).toThrow('Invalid key segment');
  });

  it('throws on constructor key segment', () => {
    expect(() => getNestedValue({}, 'constructor')).toThrow('Invalid key segment');
  });

  it('throws on prototype key segment', () => {
    expect(() => getNestedValue({}, 'prototype')).toThrow('Invalid key segment');
  });
});

describe('coerceConfigValue', () => {
  it('converts "true" to boolean true', () => {
    expect(coerceConfigValue('true')).toBe(true);
  });

  it('converts "false" to boolean false', () => {
    expect(coerceConfigValue('false')).toBe(false);
  });

  it('converts numeric strings to numbers', () => {
    expect(coerceConfigValue('42')).toBe(42);
    expect(coerceConfigValue('3.14')).toBe(3.14);
  });

  it('passes through non-numeric strings unchanged', () => {
    expect(coerceConfigValue('hello')).toBe('hello');
  });
});

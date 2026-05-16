import { describe, it, expect } from 'vitest';
import { VERSION } from '../src/index.js';
describe('@sfdt/flow-core smoke', () => {
  it('exposes a VERSION string', () => {
    expect(typeof VERSION).toBe('string');
    expect(VERSION.length).toBeGreaterThan(0);
  });
});

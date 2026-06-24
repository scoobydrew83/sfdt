import { describe, it, expect } from 'vitest';
import { FEATURE_ICONS, WORKSPACE_TOOLS } from '../lib/feature-icons.js';

describe('feature-icons', () => {
  it('every Workspace tool has icon metadata', () => {
    for (const id of WORKSPACE_TOOLS) {
      expect(FEATURE_ICONS[id], `missing icon for ${id}`).toBeTruthy();
      expect(FEATURE_ICONS[id]?.label).toBeTruthy();
    }
  });

  it('leads with the SOQL runner', () => {
    expect(WORKSPACE_TOOLS[0]).toBe('soql-runner');
  });

  it('has no duplicate tool ids', () => {
    expect(new Set(WORKSPACE_TOOLS).size).toBe(WORKSPACE_TOOLS.length);
  });
});

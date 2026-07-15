import { describe, it, expect } from 'vitest';
import { planCommand, COMMAND_IDS } from '../lib/commands.js';

const SF_TAB = { id: 7, url: 'https://acme.lightning.force.com/lightning/setup/SetupOneHome/home' };
const NON_SF_TAB = { id: 9, url: 'https://example.com/' };

describe('planCommand — command → action routing', () => {
  it('declares exactly the three P0-6 commands', () => {
    expect([...COMMAND_IDS]).toEqual(['open-workspace', 'open-palette', 'toggle-inspector']);
  });

  it('open-workspace seeds the Workspace with the active Salesforce org', () => {
    expect(planCommand('open-workspace', SF_TAB)).toEqual({
      kind: 'open-workspace',
      org: 'acme.lightning.force.com',
    });
  });

  it('open-workspace on a non-Salesforce tab opens the Workspace with no org (picker)', () => {
    expect(planCommand('open-workspace', NON_SF_TAB)).toEqual({ kind: 'open-workspace', org: '' });
  });

  it('open-workspace with no active tab still opens the Workspace picker', () => {
    expect(planCommand('open-workspace', undefined)).toEqual({ kind: 'open-workspace', org: '' });
  });

  it('open-palette messages the active tab to open the ⚡ menu', () => {
    expect(planCommand('open-palette', SF_TAB)).toEqual({
      kind: 'message-tab',
      tabId: 7,
      message: { action: 'openPalette' },
    });
  });

  it('toggle-inspector messages the active tab', () => {
    expect(planCommand('toggle-inspector', SF_TAB)).toEqual({
      kind: 'message-tab',
      tabId: 7,
      message: { action: 'toggleInspector' },
    });
  });

  it('tab-targeted commands no-op when there is no tab id', () => {
    expect(planCommand('open-palette', { url: SF_TAB.url })).toEqual({ kind: 'noop' });
    expect(planCommand('toggle-inspector', undefined)).toEqual({ kind: 'noop' });
  });

  it('unknown commands degrade to noop', () => {
    expect(planCommand('nope', SF_TAB)).toEqual({ kind: 'noop' });
  });
});

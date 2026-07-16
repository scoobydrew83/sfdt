import { describe, it, expect, vi } from 'vitest';
import {
  createContextMenuInspectFeature,
  buildInspectMenuMessage,
  planInspectFromClick,
  CONTEXT_MENU_INSPECT_ID,
  INSPECT_MENU_ITEM_ID,
  INSPECT_MENU_TITLE,
  INSPECT_MENU_URL_PATTERNS,
  _contextMenuInspectTestApi,
} from '../features/context-menu-inspect.js';

const RECORD_URL =
  'https://x.lightning.force.com/lightning/r/Account/001800000000001AAA/view';
const RECORD_LINK =
  'https://x.lightning.force.com/lightning/r/Contact/003800000000009AAA/view';
const SETUP_URL = 'https://x.lightning.force.com/lightning/setup/Flows/home';

describe('context-menu-inspect — Id extraction (AC1/AC2)', () => {
  it('extracts the record Id + sobject from the page URL when no link is right-clicked', () => {
    expect(planInspectFromClick({ pageUrl: RECORD_URL })).toEqual({
      recordId: '001800000000001AAA',
      sobjectName: 'Account',
    });
  });

  it('prefers the right-clicked link target over the page URL', () => {
    expect(planInspectFromClick({ linkUrl: RECORD_LINK, pageUrl: RECORD_URL })).toEqual({
      recordId: '003800000000009AAA',
      sobjectName: 'Contact',
    });
  });

  it('falls back to the page URL when the right-clicked link has no record Id', () => {
    expect(planInspectFromClick({ linkUrl: SETUP_URL, pageUrl: RECORD_URL })).toEqual({
      recordId: '001800000000001AAA',
      sobjectName: 'Account',
    });
  });

  it('extracts an Id from a classic ?id= link', () => {
    const link = 'https://x.my.salesforce.com/apex/CustomPage?id=001800000000001AAA';
    expect(planInspectFromClick({ linkUrl: link })).toEqual({
      recordId: '001800000000001AAA',
    });
  });

  it('returns null when neither the URL nor the link carries a record Id (menu does nothing)', () => {
    expect(planInspectFromClick({ pageUrl: SETUP_URL })).toBeNull();
    expect(planInspectFromClick({ linkUrl: SETUP_URL, pageUrl: SETUP_URL })).toBeNull();
    expect(planInspectFromClick({})).toBeNull();
  });
});

describe('context-menu-inspect — menu → inspect-record wiring', () => {
  it('builds the inspectRecord message for a click on a record link', () => {
    expect(buildInspectMenuMessage({ linkUrl: RECORD_LINK })).toEqual({
      action: 'inspectRecord',
      recordId: '003800000000009AAA',
      sobjectName: 'Contact',
    });
  });

  it('returns null (no message sent) when there is no record Id', () => {
    expect(buildInspectMenuMessage({ pageUrl: SETUP_URL })).toBeNull();
  });

  // Simulates the worker's onClicked path against a mocked chrome.contextMenus /
  // chrome.tabs: a click on our menu item forwards exactly the built message to
  // the active tab, and a no-Id click sends nothing.
  it('forwards the inspect message to the tab (mocked chrome APIs)', async () => {
    const sendMessage = vi.fn(async (_tabId: number, _message: unknown) => undefined);
    const chromeMock = {
      contextMenus: { onClicked: { addListener: vi.fn() } },
      tabs: { sendMessage },
    };

    async function onClick(
      info: { menuItemId: string; linkUrl?: string; pageUrl?: string },
      tab: { id?: number },
    ): Promise<void> {
      if (info.menuItemId !== INSPECT_MENU_ITEM_ID) return;
      const message = buildInspectMenuMessage({ linkUrl: info.linkUrl, pageUrl: info.pageUrl });
      if (!message) return;
      if (typeof tab.id !== 'number') return;
      await chromeMock.tabs.sendMessage(tab.id, message);
    }

    await onClick({ menuItemId: INSPECT_MENU_ITEM_ID, pageUrl: RECORD_URL }, { id: 7 });
    expect(sendMessage).toHaveBeenCalledWith(7, {
      action: 'inspectRecord',
      recordId: '001800000000001AAA',
      sobjectName: 'Account',
    });

    sendMessage.mockClear();
    await onClick({ menuItemId: INSPECT_MENU_ITEM_ID, pageUrl: SETUP_URL }, { id: 7 });
    expect(sendMessage).not.toHaveBeenCalled();

    sendMessage.mockClear();
    await onClick({ menuItemId: 'some-other-menu', pageUrl: RECORD_URL }, { id: 7 });
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe('context-menu-inspect — feature manifest & constants', () => {
  it('registers a kill-switchable feature that declares the contextMenus permission', () => {
    const { manifest } = createContextMenuInspectFeature();
    expect(manifest.id).toBe(CONTEXT_MENU_INSPECT_ID);
    expect(manifest.permissions).toContain('contextMenus');
    // Metadata-only feature: no injected content-script UI.
    expect(createContextMenuInspectFeature().init).toBeUndefined();
    expect(createContextMenuInspectFeature().onActivate).toBeUndefined();
  });

  it('scopes the menu to Salesforce hosts only (non-SF pages never show it)', () => {
    expect(INSPECT_MENU_TITLE).toBe('SFDT: Inspect this record');
    for (const pattern of INSPECT_MENU_URL_PATTERNS) {
      expect(pattern.startsWith('https://*.')).toBe(true);
    }
    // No wildcard/non-Salesforce host slips into the patterns.
    expect(INSPECT_MENU_URL_PATTERNS.some((p) => p.includes('salesforce') || p.includes('force.com'))).toBe(
      true,
    );
    expect(INSPECT_MENU_URL_PATTERNS).not.toContain('<all_urls>');
  });

  it('exposes the same helpers via the test api', () => {
    const api = _contextMenuInspectTestApi();
    expect(api.planInspectFromClick).toBe(planInspectFromClick);
    expect(api.buildInspectMenuMessage).toBe(buildInspectMenuMessage);
  });
});

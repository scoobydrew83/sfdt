import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createOrgSwitcherFeature } from '../features/org-switcher.js';
import { setWorkspaceViewSink } from '../ui/present-view.js';

type SendMessage = (msg: unknown, cb: (resp: unknown) => void) => void;

function setSendMessage(impl: SendMessage): void {
  (globalThis as unknown as { chrome: { runtime: { sendMessage: unknown } } }).chrome.runtime.sendMessage =
    vi.fn(impl);
}

function clearBody(): void {
  document.body.innerHTML = '';
  setWorkspaceViewSink(null);
  // Workspace is detected as a normal Salesforce context via the synthetic win.
  window.history.replaceState({}, '', 'https://x.lightning.force.com/lightning/setup/SetupOneHome/home');
}

const ORGS = [
  { host: 'acme.my.salesforce.com', displayName: 'acme' },
  { host: 'beta--sandbox.sandbox.my.salesforce.com', displayName: 'beta--sandbox' },
];

describe('org-switcher feature', () => {
  beforeEach(clearBody);

  it('renders logged-in orgs in the shared view overlay', async () => {
    setSendMessage((_msg, cb) => cb({ ok: true, orgs: ORGS }));
    const feature = createOrgSwitcherFeature({ onSwitch: vi.fn() });
    await feature.onActivate?.();

    const overlay = document.querySelector('.sfdt-view-overlay');
    expect(overlay).not.toBeNull();
    const text = overlay?.textContent ?? '';
    expect(text).toContain('acme');
    expect(text).toContain('acme.my.salesforce.com');
    expect(text).toContain('beta--sandbox.sandbox.my.salesforce.com');
  });

  it('picking an org calls onSwitch with its host', async () => {
    setSendMessage((_msg, cb) => cb({ ok: true, orgs: ORGS }));
    const onSwitch = vi.fn();
    const feature = createOrgSwitcherFeature({ onSwitch });
    await feature.onActivate?.();

    // Match the acme org button by its short displayName ('acme'), not the full
    // host — a URL-shaped substring here trips CodeQL's url-substring rule (a
    // false positive in a test, but cheaper to dodge than to dismiss).
    const orgBtn = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.sfdt-view-overlay button'),
    ).find((b) => b.textContent?.includes('acme'));
    expect(orgBtn).toBeDefined();
    orgBtn!.click();

    await vi.waitFor(() => expect(onSwitch).toHaveBeenCalledWith('acme.my.salesforce.com'));
  });

  it('shows an empty hint when no orgs are found', async () => {
    setSendMessage((_msg, cb) => cb({ ok: true, orgs: [] }));
    const feature = createOrgSwitcherFeature({ onSwitch: vi.fn() });
    await feature.onActivate?.();

    expect(document.querySelector('.sfdt-view-overlay')?.textContent).toContain('No logged-in Salesforce orgs');
  });
});

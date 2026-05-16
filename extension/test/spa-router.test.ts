import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSpaRouter } from '../lib/spa-router.js';
describe('extension/lib/spa-router', () => {
  beforeEach(() => {
    history.replaceState(null, '', 'https://x.lightning.force.com/lightning/o/Account/list');
  });
  it('fires listener on URL change after a DOM mutation', async () => {
    const router = createSpaRouter();
    const listener = vi.fn();
    const unsubscribe = router.onChange(listener);
    router.start();
    history.replaceState(null, '', 'https://x.lightning.force.com/lightning/r/Flow/2/edit');
    document.body.appendChild(document.createElement('div'));
    await new Promise((r) => setTimeout(r, 10));
    expect(listener).toHaveBeenCalledOnce();
    const firstCall = listener.mock.calls[0]?.[0] as { url: string; previousUrl: string };
    expect(firstCall.url).toContain('/lightning/r/Flow/2/edit');
    expect(firstCall.previousUrl).toContain('/lightning/o/Account/list');
    unsubscribe();
    router.stop();
  });
  it('does not fire for non-Salesforce URLs even if location changes', async () => {
    let currentUrl = 'https://example.com/page-a';
    const fakeWin = {
      top: window,
      self: window,
      get location() {
        return { href: currentUrl } as Location;
      },
    } as unknown as Window;
    const router = createSpaRouter({ win: fakeWin });
    const listener = vi.fn();
    router.onChange(listener);
    router.start();
    currentUrl = 'https://example.com/page-b';
    document.body.appendChild(document.createElement('div'));
    await new Promise((r) => setTimeout(r, 10));
    expect(listener).not.toHaveBeenCalled();
    router.stop();
  });
  it('unsubscribed listeners do not fire', async () => {
    const router = createSpaRouter();
    const listener = vi.fn();
    const unsubscribe = router.onChange(listener);
    router.start();
    unsubscribe();
    history.replaceState(null, '', 'https://x.lightning.force.com/lightning/r/Flow/3/edit');
    document.body.appendChild(document.createElement('div'));
    await new Promise((r) => setTimeout(r, 10));
    expect(listener).not.toHaveBeenCalled();
    router.stop();
  });
  it('stop() disconnects the observer', async () => {
    const router = createSpaRouter();
    const listener = vi.fn();
    router.onChange(listener);
    router.start();
    router.stop();
    history.replaceState(null, '', 'https://x.lightning.force.com/lightning/r/Flow/4/edit');
    document.body.appendChild(document.createElement('div'));
    await new Promise((r) => setTimeout(r, 10));
    expect(listener).not.toHaveBeenCalled();
  });
});

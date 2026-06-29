import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { showToast } from '../ui/toast.js';

const CONTAINER_ID = 'sfdt-toast-container';

function clearBody(): void {
  while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
}

beforeEach(() => {
  clearBody();
});

describe('toast — showToast', () => {
  it('mounts a single shared container reused across toasts', () => {
    showToast('one');
    showToast('two');
    expect(document.querySelectorAll(`#${CONTAINER_ID}`)).toHaveLength(1);
    const container = document.getElementById(CONTAINER_ID)!;
    expect(container.querySelectorAll('.sfdt-toast')).toHaveLength(2);
  });

  it('renders the message as textContent with role=status (XSS-safe)', () => {
    showToast('<img src=x onerror=alert(1)>');
    const toast = document.querySelector('.sfdt-toast')!;
    expect(toast.getAttribute('role')).toBe('status');
    // textContent path means no <img> element is ever produced.
    expect(toast.querySelector('img')).toBeNull();
    expect(toast.textContent).toBe('<img src=x onerror=alert(1)>');
  });

  it('defaults to the info kind and colours by kind', () => {
    showToast('info-default');
    showToast('it broke', { kind: 'error' });
    const toasts = document.querySelectorAll<HTMLElement>('.sfdt-toast');
    expect(toasts[0]!.className).toContain('sfdt-toast--info');
    expect(toasts[0]!.style.background).toBe('#0070d2');
    expect(toasts[1]!.className).toContain('sfdt-toast--error');
    expect(toasts[1]!.style.background).toBe('#c23934');
  });

  it('renders into a caller-provided document', () => {
    const otherDoc = document.implementation.createHTMLDocument('other');
    showToast('hi', { doc: otherDoc });
    expect(otherDoc.getElementById(CONTAINER_ID)).not.toBeNull();
    // Default document untouched.
    expect(document.getElementById(CONTAINER_ID)).toBeNull();
  });
});

describe('toast — dismissal', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('auto-dismisses after the duration elapses', () => {
    showToast('bye', { durationMs: 1000 });
    expect(document.querySelectorAll('.sfdt-toast')).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(document.querySelectorAll('.sfdt-toast')).toHaveLength(0);
  });

  it('returns a dismiss() that removes the toast early and cancels the timer', () => {
    const dismiss = showToast('manual', { durationMs: 5000 });
    expect(document.querySelectorAll('.sfdt-toast')).toHaveLength(1);
    dismiss();
    expect(document.querySelectorAll('.sfdt-toast')).toHaveLength(0);
    // The pending auto-dismiss timer was cleared, so advancing time is a no-op.
    vi.advanceTimersByTime(5000);
    expect(document.querySelectorAll('.sfdt-toast')).toHaveLength(0);
  });

  it('dismiss() is idempotent — calling twice does not throw', () => {
    const dismiss = showToast('once');
    dismiss();
    expect(() => dismiss()).not.toThrow();
    expect(document.querySelectorAll('.sfdt-toast')).toHaveLength(0);
  });
});

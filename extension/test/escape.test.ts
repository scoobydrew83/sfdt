import { describe, it, expect } from 'vitest';
import { escapeHtml, html } from '../lib/escape.js';

describe('extension/lib/escape', () => {
  describe('escapeHtml', () => {
    it('escapes the canonical XSS characters', () => {
      expect(escapeHtml('<script>alert(1)</script>')).toBe(
        '&lt;script&gt;alert(1)&lt;&#x2F;script&gt;',
      );
    });

    it('escapes quotes and ampersands', () => {
      expect(escapeHtml(`"it's & that"`)).toBe('&quot;it&#39;s &amp; that&quot;');
    });

    it('passes through plain text unchanged', () => {
      expect(escapeHtml('A regular label')).toBe('A regular label');
    });

    it('handles null and undefined as empty string', () => {
      expect(escapeHtml(null)).toBe('');
      expect(escapeHtml(undefined)).toBe('');
    });

    it('coerces non-string values to strings before escaping', () => {
      expect(escapeHtml(42)).toBe('42');
      expect(escapeHtml(true)).toBe('true');
    });
  });

  describe('html tagged template', () => {
    it('escapes interpolated values', () => {
      const user = '<script>x</script>';
      expect(html`<div>${user}</div>`).toBe(
        '<div>&lt;script&gt;x&lt;&#x2F;script&gt;</div>',
      );
    });

    it('does not touch the static strings', () => {
      expect(html`<a href="">${'x'}</a>`).toBe('<a href="">x</a>');
    });
  });
});

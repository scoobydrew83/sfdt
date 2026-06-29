import { describe, it, expect } from 'vitest';
import { escapeHtml, escapeSoql, html } from '../lib/escape.js';

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

  describe('escapeSoql', () => {
    it("escapes single quotes with a backslash", () => {
      expect(escapeSoql("O'Brien")).toBe("O\\'Brien");
    });

    it('escapes backslashes before single quotes (order matters)', () => {
      // Input ends with a backslash; without the leading backslash-escape the
      // emitted SOQL would terminate the string early.
      expect(escapeSoql('foo\\')).toBe('foo\\\\');
    });

    it('escapes both backslashes and quotes in one pass', () => {
      expect(escapeSoql("a\\b'c")).toBe("a\\\\b\\'c");
    });

    it('returns plain text unchanged', () => {
      expect(escapeSoql('Activated Flow 01')).toBe('Activated Flow 01');
    });

    it('handles null and undefined as empty string', () => {
      expect(escapeSoql(null)).toBe('');
      expect(escapeSoql(undefined)).toBe('');
    });

    it('coerces non-string values to strings before escaping', () => {
      expect(escapeSoql(42)).toBe('42');
      expect(escapeSoql(true)).toBe('true');
    });
  });
});

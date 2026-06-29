import { describe, it, expect } from 'vitest';
import { XML } from '../lib/xml.js';

// Helper: parse a fragment and hand XML.parse the documentElement, matching how
// apiSoap feeds it a namespace-prefixed response element.
function elementOf(xml: string): Element {
  return new DOMParser().parseFromString(xml, 'text/xml').documentElement;
}

const XSI = ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"';

describe('extension/lib/xml', () => {
  describe('XML.stringify', () => {
    it('marks a null value as xsi:nil', () => {
      const out = XML.stringify({ name: 'root', attributes: XSI, value: null });
      expect(out).toContain('xsi:nil="true"');
    });

    it('writes a primitive value as element text content', () => {
      const out = XML.stringify({ name: 'root', attributes: '', value: 'hello' });
      expect(out).toContain('<root>hello</root>');
    });

    it('uses the `_` key for text content and skips undefined keys', () => {
      const out = XML.stringify({
        name: 'root',
        attributes: '',
        value: { _: 'inner', skipped: undefined },
      });
      expect(out).toContain('>inner<');
      expect(out).not.toContain('skipped');
    });

    it('marks `_: null` as xsi:nil', () => {
      const out = XML.stringify({ name: 'root', attributes: XSI, value: { _: null } });
      expect(out).toContain('xsi:nil="true"');
    });

    it('emits the $xsi:type key as an xsi:type attribute', () => {
      const out = XML.stringify({
        name: 'root',
        attributes: XSI,
        value: { '$xsi:type': 'Account', name: 'Acme' },
      });
      expect(out).toContain('xsi:type="Account"');
      expect(out).toContain('>Acme<');
    });

    it('repeats an element once per array entry', () => {
      const out = XML.stringify({
        name: 'root',
        attributes: '',
        value: { item: [{ _: 'a' }, { _: 'b' }] },
      });
      // happy-dom decorates created elements with an xmlns attr, so match the
      // opening tag prefix rather than a bare `<item>`.
      expect(out.match(/<item[ >]/g)).toHaveLength(2);
      expect(out).toContain('>a<');
      expect(out).toContain('>b<');
    });

    it('nests a child object as a child element', () => {
      const out = XML.stringify({
        name: 'root',
        attributes: '',
        value: { child: { leaf: 'v' } },
      });
      expect(out).toContain('<leaf>v</leaf>');
    });

    it('strips the empty default-namespace artifact', () => {
      const out = XML.stringify({ name: 'root', attributes: '', value: { a: '1' } });
      expect(out).not.toContain('xmlns=""');
    });
  });

  describe('XML.parse', () => {
    it('returns null for an xsi:nil element', () => {
      const el = elementOf(`<root${XSI} xsi:nil="true"/>`);
      expect(XML.parse(el)).toBeNull();
    });

    it('carries $xsi:type through on a typed (sObject) element', () => {
      const el = elementOf(`<root${XSI} xsi:type="Account"><Name>Acme</Name></root>`);
      expect(XML.parse(el)).toMatchObject({ '$xsi:type': 'Account', Name: 'Acme' });
    });

    it('collapses repeated child names into an array', () => {
      const el = elementOf('<root><item>a</item><item>b</item><item>c</item></root>');
      expect(XML.parse(el)).toEqual({ item: ['a', 'b', 'c'] });
    });

    it('reads a simple-type element as its text value', () => {
      const el = elementOf('<root>plain text</root>');
      expect(XML.parse(el)).toBe('plain text');
    });

    it('round-trips a nested complex type', () => {
      const el = elementOf('<root><a>1</a><b><c>2</c></b></root>');
      expect(XML.parse(el)).toEqual({ a: '1', b: { c: '2' } });
    });
  });
});

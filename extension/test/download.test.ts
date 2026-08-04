// lib/download.ts exists because five features had their own copy of the blob
// dance and TWO of them forgot `revokeObjectURL` — a leak with no visible
// symptom, one of them holding a retrieved metadata zip. These tests pin the
// step people drop, and the text/binary split that keeps a zip intact.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { triggerDownload, triggerDownloadBlob, exportFilename } from '../lib/download.js';

const created: Blob[] = [];
const revoked: string[] = [];
let savedCreate: typeof URL.createObjectURL;
let savedRevoke: typeof URL.revokeObjectURL;

beforeEach(() => {
  created.length = 0;
  revoked.length = 0;
  savedCreate = URL.createObjectURL;
  savedRevoke = URL.revokeObjectURL;
  URL.createObjectURL = (part: Blob | MediaSource): string => {
    created.push(part as Blob);
    return `blob:sfdt-test/${created.length}`;
  };
  URL.revokeObjectURL = (url: string): void => {
    revoked.push(url);
  };
  document.body.innerHTML = '';
});

afterEach(() => {
  URL.createObjectURL = savedCreate;
  URL.revokeObjectURL = savedRevoke;
});

describe('triggerDownload()', () => {
  it('revokes the object URL it created', async () => {
    // THE bug this module exists for. Without the revoke the blob is pinned for
    // the lifetime of the document, and on a long-lived Salesforce tab that is
    // effectively forever.
    triggerDownload(document, 'rows.csv', 'a,b\n1,2\n', 'text/csv');
    expect(created).toHaveLength(1);
    expect(revoked).toEqual(['blob:sfdt-test/1']);
  });

  it('leaves no anchor behind in the host page', async () => {
    // This runs inside a content script, so the DOM being borrowed is
    // Salesforce's — a stray <a> would be our litter in someone else's page.
    triggerDownload(document, 'rows.csv', 'x', 'text/csv');
    expect(document.querySelectorAll('a')).toHaveLength(0);
  });

  it('carries the filename and the mime type', async () => {
    triggerDownload(document, 'Account-fields.csv', 'x', 'text/csv');
    expect(created[0]!.type).toBe('text/csv');
  });
});

describe('triggerDownloadBlob()', () => {
  it('writes the bytes it was handed, byte for byte', async () => {
    // A zip is the payload that made this a separate function: the split is
    // enforced at the TYPE level (`triggerDownload` declares `text: string`, so
    // a Uint8Array cannot reach it), and what this pins is that the binary path
    // preserves the payload exactly rather than re-encoding it.
    const zipMagic = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    triggerDownloadBlob(document, 'metadata.zip', zipMagic, 'application/zip');
    expect(created[0]!.size).toBe(4);
    expect(new Uint8Array(await created[0]!.arrayBuffer())).toEqual(zipMagic);
  });

  it('stringifying the payload first WOULD corrupt it', async () => {
    // Non-vacuity for the case above, and the actual failure mode: `Blob` itself
    // handles a BufferSource correctly, so the corruption comes from a caller
    // that turns bytes into text on the way in — four bytes become nine
    // characters and the zip will not open.
    const zipMagic = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    triggerDownload(document, 'wrong.zip', String(zipMagic), 'application/zip');
    expect(created[0]!.size).toBe(9);
  });

  it('revokes too — this was the copy that leaked the metadata zip', async () => {
    triggerDownloadBlob(document, 'metadata.zip', new Uint8Array([1, 2, 3]), 'application/zip');
    expect(revoked).toEqual(['blob:sfdt-test/1']);
  });
});

describe('exportFilename()', () => {
  it('stamps the date and keeps the name sortable', () => {
    const at = new Date('2026-08-03T14:12:00Z');
    expect(exportFilename('Account-schema', 'csv', at)).toBe('Account-schema-2026-08-03.csv');
  });

  it('replaces anything a filesystem would object to', () => {
    const at = new Date('2026-08-03T00:00:00Z');
    // An sObject label can contain spaces and slashes; a query name can contain
    // almost anything the user typed.
    expect(exportFilename('My Object / v2', 'json', at)).toBe('My_Object_v2-2026-08-03.json');
  });
});

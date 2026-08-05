// Save text to a file.
//
// Five features had their own copy of this eight-line dance (create Blob →
// createObjectURL → hidden <a> → click → remove → revokeObjectURL), and two of
// them forgot the `revokeObjectURL`, which leaks the blob for the lifetime of
// the document. That is the whole argument for it living in one place: the step
// people drop is the one with no visible symptom.

/**
 * Download `text` as `filename`.
 *
 * The anchor is appended and removed rather than just constructed: a detached
 * <a> is not reliably clickable in Chrome, and this runs inside a content
 * script where the host page's own DOM is what we are borrowing.
 *
 * Returns the object URL it minted (already revoked by the time you get it, so
 * it is a receipt, not a handle). Almost every caller ignores it. It exists for
 * the one that cannot: the pre-delete backup in features/soql-bulk-delete.ts
 * has to be able to tell "the browser accepted this blob and the anchor was
 * clicked" from "nothing happened", because a delete is gated on it. Nothing
 * here can report whether the file reached DISK — that needs the `downloads`
 * permission, which the extension deliberately does not have — so this is the
 * strongest handoff signal available, and callers must not describe it as more.
 */
export function triggerDownload(
  doc: Document,
  filename: string,
  text: string,
  mime: string,
): string {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = doc.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  doc.body.appendChild(a);
  a.click();
  doc.body.removeChild(a);
  // Without this the blob is pinned until the document goes away.
  URL.revokeObjectURL(url);
  return url;
}

/**
 * Same, for binary payloads — a retrieved metadata zip, an export archive.
 *
 * Separate from `triggerDownload` rather than widening its `text` parameter:
 * the text version's `Blob([text])` on a Uint8Array would stringify it, which
 * fails silently and produces a corrupt file.
 */
export function triggerDownloadBlob(
  doc: Document,
  filename: string,
  bytes: BlobPart,
  mime: string,
): void {
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const a = doc.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  doc.body.appendChild(a);
  a.click();
  doc.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** `Account-schema-2026-08-01.csv` — sortable, and safe on every filesystem. */
export function exportFilename(base: string, ext: string, now = new Date()): string {
  const stamp = now.toISOString().slice(0, 10);
  const safe = base.replace(/[^\w.-]+/g, '_');
  return `${safe}-${stamp}.${ext}`;
}

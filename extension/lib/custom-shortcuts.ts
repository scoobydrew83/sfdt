// Validation for the options-page "Custom shortcuts" CRUD (P2-2). Kept out of
// the entrypoint so the branch/loop + URL boundary is unit-testable without
// rendering the whole options page.

import { z } from 'zod';

export interface CustomShortcutEntry {
  name: string;
  url: string;
}

const urlSchema = z.string().url();

/**
 * Validate raw custom-shortcut rows from the options CRUD. Trims name/url, drops
 * fully-blank rows, and rejects a missing name, a duplicate name, or a malformed
 * URL (the z.string().url() boundary — the same shape SettingsSchema stores).
 * Throws a user-facing Error the options page surfaces in its status pill.
 */
export function validateCustomShortcuts(
  entries: readonly CustomShortcutEntry[],
): CustomShortcutEntry[] {
  const out: CustomShortcutEntry[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    const name = e.name.trim();
    const url = e.url.trim();
    if (!name && !url) continue;
    if (!name) throw new Error('Every custom shortcut needs a name.');
    if (seen.has(name)) throw new Error(`Duplicate shortcut name: "${name}".`);
    seen.add(name);
    if (!urlSchema.safeParse(url).success) {
      throw new Error(`"${name}" has an invalid URL: ${url || '(empty)'}`);
    }
    out.push({ name, url });
  }
  return out;
}

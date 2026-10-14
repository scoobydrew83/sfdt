// /privacy says this site makes no third-party request: "loading a page here
// contacts no one but the host". That claim was false until Inter stopped being
// loaded from fonts.googleapis.com, and the cheapest way for it to become false
// again is one convenient <link> or url() in a future change. So this is the
// guard: a scan of `app/` — sources *and* stylesheets — for anything that would
// make a visitor's browser fetch from a host that is not this one.
//
// Scope, honestly. This catches a remote asset written into this app's own
// source. It cannot catch one injected at the edge, pulled in by a dependency's
// CSS, or added in the Cloudflare dashboard. Those stay a review question, the
// same limits `no-tracking.test.ts` states about itself.
//
// Golden principle #12: the patterns are code-shaped — a url(), an href, an
// import specifier — never a bare hostname. /privacy and /terms discuss Google,
// Cloudflare and fonts in prose, and must not be flagged by the rule they
// document. Nothing is excluded from the scan to keep it quiet.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const APP = join(ROOT, "app");

/** Every source and stylesheet under app/ — fonts are a CSS concern. */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(full));
    else if (/\.(tsx?|css)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * Code shapes that make the browser fetch from another origin. Each is anchored
 * to the syntax that does the fetching, so prose about a vendor never matches.
 */
const BANNED: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /url\(\s*["']?(?:https?:)?\/\//i, why: "a CSS url() pointing at a remote host" },
  { pattern: /@import\s+(?:url\(\s*)?["'](?:https?:)?\/\//i, why: "a remote CSS @import" },
  {
    pattern: /<link\b[^>]*\bhref=\{?["'](?:https?:)?\/\//i,
    why: "a <link> (stylesheet, preconnect or preload) to a remote host",
  },
  {
    pattern: /from\s+["']next\/font\/google["']/,
    why: "next/font/google, which fetches from Google at build time",
  },
  {
    pattern: /<(?:img|iframe|video|audio|source|embed)\b[^>]*\bsrc=\{?["'](?:https?:)?\/\//i,
    why: "a remotely hosted media element",
  },
];

describe("the site makes no third-party request", () => {
  const files = sources(APP);

  it("finds the app sources and stylesheets to scan", () => {
    expect(files.length).toBeGreaterThan(5);
    expect(files.some((file) => file.endsWith(".css"))).toBe(true);
  });

  it.each(BANNED)("has no $why", ({ pattern }) => {
    const offenders = files
      .filter((file) => pattern.test(readFileSync(file, "utf8")))
      .map((file) => relative(ROOT, file));
    expect(offenders).toEqual([]);
  });
});

describe("Inter is self-hosted", () => {
  const css = readFileSync(join(APP, "globals.css"), "utf8");

  it("declares the family from files in this repository", () => {
    expect(css).toMatch(/@font-face/);
    expect(css).toMatch(/font-family:\s*Inter/);
    expect(css).toContain('url("./fonts/inter-latin-wght-normal.woff2")');
    expect(css).toContain('url("./fonts/inter-latin-ext-wght-normal.woff2")');
  });

  it("ships the woff2 files those rules resolve to", () => {
    for (const file of [
      "fonts/inter-latin-wght-normal.woff2",
      "fonts/inter-latin-ext-wght-normal.woff2",
    ]) {
      const full = join(APP, file);
      expect(existsSync(full), file).toBe(true);
      // A git-lfs pointer or a truncated download would be a few hundred bytes.
      expect(statSync(full).size, file).toBeGreaterThan(10_000);
    }
  });

  it("keeps the SIL Open Font License alongside them", () => {
    const license = readFileSync(join(APP, "fonts/LICENSE"), "utf8");
    expect(license).toMatch(/SIL Open Font License/);
    expect(license).toMatch(/Inter Project Authors/);
  });

  it("is attributed in THIRD_PARTY_NOTICES.md", () => {
    const notices = readFileSync(join(ROOT, "..", "THIRD_PARTY_NOTICES.md"), "utf8");
    expect(notices).toMatch(/Inter/);
    expect(notices).toMatch(/SIL Open Font License/);
  });

  it("leaves no Google Fonts link in the document head", () => {
    const layout = readFileSync(join(APP, "layout.tsx"), "utf8");
    expect(layout).not.toContain("fonts.googleapis.com");
    expect(layout).not.toContain("fonts.gstatic.com");
  });
});

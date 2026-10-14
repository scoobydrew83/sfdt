// The footer and /privacy both tell visitors this site sets no cookies and runs
// no analytics. A promise in prose is worth whatever stops the next change from
// quietly falsifying it, so this is that thing: a source-level scan of `app/`
// for the code shapes that would make either claim false.
//
// Be honest about the scope. This catches a tracker added to this app's own
// source — a tag-manager snippet, a vendor SDK, a cookie write. It cannot catch
// one injected at the edge, added to a dependency, or turned on in the
// Cloudflare dashboard. Those stay a review question.
//
// Golden principle #12: the patterns are code-shaped, never bare words, so the
// legal pages that *describe* the policy ("runs no analytics or tag manager",
// "tokens live in sessionStorage only") are not flagged by the rule they
// document, and nothing has to be excluded from the scan to keep it quiet.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const APP = join(ROOT, "app");

/** Every .ts/.tsx source file under app/. */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Code shapes that would contradict "no cookies, no analytics". */
const BANNED: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /document\s*\.\s*cookie/, why: "writes or reads a cookie in the browser" },
  { pattern: /from\s+['"]next\/headers['"]/, why: "server-side cookies()/headers() access" },
  { pattern: /from\s+['"]next\/script['"]/, why: "third-party script tag" },
  { pattern: /<script\b/i, why: "inline or external script tag" },
  { pattern: /gtag\s*\(/, why: "Google Analytics" },
  { pattern: /googletagmanager|google-analytics/i, why: "Google Analytics / Tag Manager" },
  { pattern: /plausible|posthog|mixpanel|amplitude|heap\.io/i, why: "product analytics SDK" },
  { pattern: /hotjar|matomo|umami|fathom|clarity\.ms|segment\.com/i, why: "analytics vendor" },
  { pattern: /@sentry\/|@vercel\/analytics|@vercel\/speed-insights/, why: "telemetry package" },
  { pattern: /navigator\s*\.\s*sendBeacon/, why: "beacon transmission" },
];

describe("the site stays cookie-free and analytics-free", () => {
  const files = sources(APP);

  it("finds the app sources to scan", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it.each(BANNED)("has no $why", ({ pattern }) => {
    const offenders = files
      .filter((file) => pattern.test(readFileSync(file, "utf8")))
      .map((file) => relative(ROOT, file));
    expect(offenders).toEqual([]);
  });

  it("declares no dependency on an analytics or telemetry package", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    const suspect = deps.filter((name) =>
      /analytics|telemetry|sentry|posthog|mixpanel|plausible|gtag|insights/i.test(name),
    );
    expect(suspect).toEqual([]);
  });
});

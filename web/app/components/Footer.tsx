import Link from "next/link";

const REPO = "https://github.com/scoobydrew83/sfdt";

/**
 * Site footer. Carries the legal links on every page — `/privacy` and `/terms`
 * are reachable from anywhere, which is what the Chrome Web Store and the VS
 * Code Marketplace listings point at.
 *
 * The "no cookies, no analytics" line is a claim about this app's code, so it is
 * guarded by `test/no-tracking.test.ts` rather than left as prose anyone can
 * quietly falsify.
 */
export function Footer() {
  return (
    <footer className="site-foot">
      <span>© {new Date().getUTCFullYear()} Hallows Group LLC</span>
      <span className="sep" aria-hidden>
        ·
      </span>
      <span>No cookies. No analytics.</span>
      <nav className="foot-nav" aria-label="Legal and source">
        <Link href="/privacy">Privacy</Link>
        <Link href="/terms">Terms</Link>
        <a href={`${REPO}/blob/main/SECURITY.md`}>Security</a>
        <a href={REPO}>Source</a>
      </nav>
    </footer>
  );
}

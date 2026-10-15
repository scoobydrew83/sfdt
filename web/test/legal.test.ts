import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = join(ROOT, "..");

function read(rel: string) {
  return readFileSync(join(ROOT, rel), "utf8");
}

function readRepo(rel: string) {
  return readFileSync(join(REPO, rel), "utf8");
}

const PRIVACY = "app/privacy/page.tsx";
const TERMS = "app/terms/page.tsx";

describe("legal routes exist", () => {
  it("serves /privacy and /terms from the App Router", () => {
    for (const page of [PRIVACY, TERMS]) {
      expect(existsSync(join(ROOT, page))).toBe(true);
      expect(read(page)).toMatch(/export default function/);
    }
  });

  it("gives each page its own metadata title", () => {
    expect(read(PRIVACY)).toMatch(/Privacy Policy — SFDT/);
    expect(read(TERMS)).toMatch(/Terms of Use — SFDT/);
  });

  it("shares the entity and effective date rather than restating them", () => {
    const legal = read("app/lib/legal.ts");
    expect(legal).toMatch(/Hallows Group LLC/);
    expect(legal).toMatch(/EFFECTIVE_DATE/);
    for (const page of [PRIVACY, TERMS]) {
      expect(read(page)).toMatch(/EFFECTIVE_DATE/);
      expect(read(page)).toMatch(/from "\.\.\/lib\/legal"/);
    }
  });
});

describe("the footer links them from every page", () => {
  it("renders the footer inside the shared chrome", () => {
    const chrome = read("app/components/Chrome.tsx");
    expect(chrome).toMatch(/import \{ Footer \}/);
    expect(chrome).toMatch(/<Footer \/>/);
  });

  it("points at both policies", () => {
    const footer = read("app/components/Footer.tsx");
    expect(footer).toMatch(/href="\/privacy"/);
    expect(footer).toMatch(/href="\/terms"/);
  });

  it("uses that chrome on every route, so the links are reachable everywhere", () => {
    const routes = [
      "app/page.tsx",
      "app/trailblazers/page.tsx",
      "app/trailblazers/[handle]/page.tsx",
      "app/tools/flow-linter/page.tsx",
      "app/tools/security-audit/page.tsx",
      "app/tools/field-impact/page.tsx",
      PRIVACY,
      TERMS,
    ];
    for (const route of routes) {
      expect(read(route), route).toMatch(/<Chrome/);
    }
  });
});

describe("the privacy policy covers every surface", () => {
  const md = read(PRIVACY);

  it("names all four surfaces", () => {
    expect(md).toMatch(/browser extension/i);
    expect(md).toMatch(/VS Code extension/);
    expect(md).toMatch(/command-line tool/i);
    expect(md).toMatch(/sfdt\.dev/);
  });

  it("states what the extension stores locally and how to clear it", () => {
    for (const key of [
      "sfdt.settings",
      "sfdt.killswitch.cache",
      "sfdt.telemetry",
      "sfdt.activity",
      "chrome.storage.session",
    ]) {
      expect(md, key).toContain(key);
    }
    expect(md).toMatch(/Remove all/);
  });

  it("describes the telemetry toggle as opt-in with no egress", () => {
    expect(md).toMatch(/opt-in/i);
    expect(md).toMatch(/No network egress/i);
    expect(md).toMatch(/telemetry\.test\.ts/);
  });

  it("explains the session cookie and its enforcement", () => {
    expect(md).toMatch(/sid/);
    expect(md).toMatch(/sid-never-leaves-worker\.test\.ts/);
  });

  it("lists the manifest permissions", () => {
    for (const perm of [
      "storage",
      "clipboardWrite",
      "cookies",
      "contextMenus",
      "sidePanel",
      "host_permissions",
    ]) {
      expect(md, perm).toContain(perm);
    }
  });

  // These assertions look for a hostname *inside a page's prose*, which is a
  // substring search, not URL validation — so they use `toContain` rather than
  // an unanchored regex. CodeQL's js/regex/missing-regexp-anchor rightly reads
  // `/registry\.npmjs\.org/` as a host check that `evil-registry.npmjs.org.bad`
  // would satisfy; there is no host to check here, and a plain string says so.
  it("discloses the npm registry version check on both CLI surfaces", () => {
    expect(md).toContain("npm view @sfdt/cli version");
    expect(md).toContain("registry.npmjs.org");
  });

  it("names the host, and no third-party font service, for the site itself", () => {
    expect(md).toContain("Cloudflare");
    expect(md).toContain("No third-party requests");
    // Inter is self-hosted (web/app/fonts/), so the policy must not claim a
    // Google Fonts request that no longer happens. See
    // no-third-party-requests.test.ts for the guard on the code side.
    expect(md).not.toContain("fonts.googleapis.com");
    expect(md).not.toContain("fonts.gstatic.com");
  });

  it("states who controls the host's request logs, and on what basis", () => {
    expect(md).toContain("is the controller");
    expect(md).toContain("legitimate interest");
    expect(md).toContain("user agent");
  });

  it("leaves request-log retention to Cloudflare and promises no figure", () => {
    expect(md).toContain(
      "Cloudflare processes request data under its own privacy policy; we do not export or keep request logs.",
    );
    // The 3–7 day raw-log figure is an Enterprise-only Logpull/Logpush number.
    expect(md).not.toContain("three days and up to seven days");
    expect(md).not.toContain("logs/faq/logpull-api");
  });

  it("documents the hosted engine endpoint", () => {
    expect(md).toMatch(/\/api\/engine/);
    expect(md).toMatch(/accepts no input/i);
  });

  it("carries a Chrome Web Store Limited Use statement", () => {
    expect(md).toMatch(/Limited Use/);
    expect(md).toMatch(/creditworthiness/);
    expect(md).toMatch(/do not sell user data/i);
  });

  it("gives an effective date and a contact route", () => {
    expect(md).toMatch(/Effective \{EFFECTIVE_DATE\}/);
    expect(md).toMatch(/ISSUES_URL/);
    expect(md).toMatch(/SECURITY_URL/);
  });
});

// A privacy policy whose only contact route is a public issue tracker asks a
// data subject to publish their request. Both stores also expect a reachable
// publisher contact. So the private route is not optional, and these tests fail
// if either page loses it.
describe("both pages carry a private contact route", () => {
  it("defines one email and one postal address in the shared module", () => {
    const legal = read("app/lib/legal.ts");
    expect(legal).toContain("sales@hallowsgroup.com");
    expect(legal).toContain("5900 Balcones Drive #31966");
    expect(legal).toContain("Austin, TX 78731");
  });

  it.each([
    ["privacy", PRIVACY],
    ["terms", TERMS],
  ])("renders the email and address on /%s", (_name, page) => {
    const md = read(page);
    expect(md).toMatch(/CONTACT_MAILTO/);
    expect(md).toMatch(/CONTACT_EMAIL/);
    expect(md).toMatch(/POSTAL_ADDRESS_LINES/);
    expect(md).toMatch(/<address/);
  });

  it("keeps the issue tracker as the public option on both pages", () => {
    for (const page of [PRIVACY, TERMS]) {
      expect(read(page), page).toMatch(/ISSUES_URL/);
    }
  });
});

describe("the terms cover what counsel asked for", () => {
  const md = read(TERMS);

  it("makes no claim about Trailblazer fixture data", () => {
    expect(md).not.toContain("fixture data on the Trailblazer pages");
  });

  it("ties the software to its open-source licence without narrowing it", () => {
    expect(md).toMatch(/Apache License, Version 2\.0/);
    expect(md).toMatch(/Nothing in these terms limits the rights the Apache-2\.0 licence grants you/);
    expect(md).toMatch(/THIRD_PARTY_NOTICES\.md/);
  });

  it("disclaims warranty and limits liability", () => {
    expect(md).toMatch(/AS IS/);
    expect(md).toMatch(/without warranties or conditions of any kind/i);
    expect(md).toMatch(/Limitation of liability/i);
    expect(md).toMatch(/consequential/i);
  });

  it("disclaims any Salesforce affiliation", () => {
    expect(md).toMatch(/not affiliated with, endorsed by/i);
    expect(md).toMatch(/Salesforce, Inc\./);
    expect(md).toMatch(/trademarks/i);
  });

  it("sets governing law and names the entity", () => {
    expect(md).toMatch(/State of Texas/);
    expect(md).toMatch(/ENTITY/);
  });

  it("gives a contact route", () => {
    expect(md).toMatch(/ISSUES_URL/);
  });
});

describe("the other surfaces point here", () => {
  it("extension/PRIVACY.md names sfdt.dev/privacy as canonical", () => {
    const md = readRepo("extension/PRIVACY.md");
    expect(md).toMatch(/https:\/\/sfdt\.dev\/privacy/);
    expect(md).toMatch(/https:\/\/sfdt\.dev\/terms/);
  });

  it("extension/PRIVACY.md carries the same private contact route", () => {
    const md = readRepo("extension/PRIVACY.md");
    expect(md).toContain("sales@hallowsgroup.com");
    expect(md).toContain("5900 Balcones Drive #31966");
    expect(md).toContain("Austin, TX 78731");
    // And still offers the public one.
    expect(md).toContain("https://github.com/scoobydrew83/sfdt/issues");
  });

  it("the Chrome Web Store listing uses the hosted policy URL", () => {
    const md = readRepo("extension/listing.md");
    expect(md).toMatch(/Privacy policy: https:\/\/sfdt\.dev\/privacy/);
    expect(md).toMatch(/https:\/\/sfdt\.dev\/terms/);
  });

  it("the VS Code extension references both policies", () => {
    expect(readRepo("vscode/package.json")).toMatch(/https:\/\/sfdt\.dev\/privacy/);
    expect(readRepo("vscode/package.json")).toMatch(/https:\/\/sfdt\.dev\/terms/);
    expect(readRepo("vscode/README.md")).toMatch(/https:\/\/sfdt\.dev\/privacy/);
    expect(readRepo("vscode/README.md")).toMatch(/https:\/\/sfdt\.dev\/terms/);
  });
});

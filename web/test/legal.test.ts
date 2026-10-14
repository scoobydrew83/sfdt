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

  it("discloses the npm registry version check on both CLI surfaces", () => {
    expect(md).toMatch(/npm view @sfdt\/cli version/);
    expect(md).toMatch(/registry\.npmjs\.org/);
  });

  it("discloses the site's one third-party request", () => {
    expect(md).toMatch(/fonts\.googleapis\.com/);
    expect(md).toMatch(/Cloudflare/);
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

describe("the terms cover what counsel asked for", () => {
  const md = read(TERMS);

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

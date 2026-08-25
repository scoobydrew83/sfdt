import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(rel: string) {
  return readFileSync(join(ROOT, rel), "utf8");
}

/** Drop // and block comments so a warning in a comment is not an assignment. */
function withoutComments(src: string) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("WEB-1 scaffold", () => {
  it("does not static-export", () => {
    expect(withoutComments(read("next.config.ts"))).not.toMatch(/output:\s*['"]export['"]/);
  });

  it("does not bind D1 yet", () => {
    expect(read("wrangler.jsonc")).not.toMatch(/d1_databases/i);
  });

  it("transpiles flow-core", () => {
    expect(read("next.config.ts")).toMatch(/@sfdt\/flow-core/);
    expect(read("package.json")).toMatch(/@sfdt\/flow-core/);
  });

  it("declares the runtime split in README", () => {
    const md = read("README.md");
    expect(md).toMatch(/Edge/);
    expect(md).toMatch(/Web Worker/);
    expect(md).toMatch(/never/i);
  });
});

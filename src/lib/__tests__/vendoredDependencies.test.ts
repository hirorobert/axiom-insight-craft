/**
 * Vendored dependencies (vendor/sheetjs/PROVENANCE.md): SheetJS 0.20.3 is committed as its official tarball and as the one ESM
 * build the Edge Functions import, both pinned. The guard (scripts/ci/assertVendoredDependencies.mjs, run by CI) is exercised
 * on the real repository, as the CLI CI runs, and on copies of it with one thing broken at a time.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
// @ts-expect-error — plain ESM script shared with CI
import { checkVendoredDependencies, readTarball, VENDORED } from "../../../scripts/ci/assertVendoredDependencies.mjs";

const REPO = path.resolve(__dirname, "../../..");
const DENO_XLSX = "supabase/functions/_shared/vendor/sheetjs-0.20.3/xlsx.mjs";
const COPIED = [
  "package.json", "bun.lock", "deno.lock", ".github/workflows/ci.yml",
  "vendor/sheetjs/xlsx-0.20.3.tgz", "vendor/sheetjs/LICENSE", "vendor/sheetjs/PROVENANCE.md",
  DENO_XLSX, "supabase/functions/_shared/vendor/sheetjs-0.20.3/types/index.d.ts", "supabase/functions/_shared/vendor/sheetjs-0.20.3/LICENSE",
  "supabase/functions/trial-balance-layout/index.ts", "supabase/functions/process-trial-balance/functionpath/import_map.json",
];

const copies: string[] = [];
afterAll(() => { for (const d of copies) fs.rmSync(d, { recursive: true, force: true }); });

/** A copy of the parts of the repository the guard reads, with `edit` applied. */
function copy(edit: (dir: string) => void = () => {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vendored-"));
  copies.push(dir);
  for (const rel of COPIED) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.copyFileSync(path.join(REPO, rel), path.join(dir, rel));
  }
  edit(dir);
  return dir;
}
const write = (dir: string, rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
const replaceIn = (dir: string, rel: string, from: string, to: string) => {
  const t = fs.readFileSync(path.join(dir, rel), "utf8");
  expect(t.includes(from), `${rel} contains ${from}`).toBe(true);
  fs.writeFileSync(path.join(dir, rel), t.split(from).join(to));
};
const violations = (dir: string) => (checkVendoredDependencies(dir) as string[]).join("\n");

// Each case hashes a 2.4 MB tarball and scans supabase/ and scripts/ (about 1.5 s alone); some copy the repository's parts
// several times. Under full-suite load that exceeds the 5 s default, so the bound is explicit.
describe("vendored dependencies", { timeout: 60_000 }, () => {
  it("the repository is compliant, and the CLI CI runs says so", () => {
    expect(checkVendoredDependencies(REPO)).toEqual([]);
    const out = execFileSync(process.execPath, [path.join(REPO, "scripts/ci/assertVendoredDependencies.mjs"), REPO], { encoding: "utf8" });
    expect(out).toContain("VENDORED_DEPENDENCIES: OK");
  });

  it("the Deno build is the tarball's own package/xlsx.mjs, and the tarball is the pinned release", () => {
    const members = readTarball(fs.readFileSync(path.join(REPO, VENDORED.sheetjs.tarball.path))) as Map<string, Buffer>;
    expect(members.size).toBe(26);
    expect(members.get("package/xlsx.mjs")!.equals(fs.readFileSync(path.join(REPO, DENO_XLSX)))).toBe(true);
    expect(JSON.parse(members.get("package/package.json")!.toString("utf8"))).toMatchObject({ name: "xlsx", version: "0.20.3", license: "Apache-2.0" });
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
    expect(pkg.dependencies.xlsx).toBe("file:vendor/sheetjs/xlsx-0.20.3.tgz");
  });

  it("an untouched copy passes (the fixture is faithful)", () => {
    expect(checkVendoredDependencies(copy())).toEqual([]);
  });

  it("one changed byte in the vendored Deno build fails twice: its pin and its equality with the tarball", () => {
    const dir = copy((d) => fs.appendFileSync(path.join(d, DENO_XLSX), " "));
    expect(violations(dir)).toContain(`${DENO_XLSX}: 1008309 bytes`);
    expect(violations(dir)).toContain(`${DENO_XLSX} differs from package/xlsx.mjs inside vendor/sheetjs/xlsx-0.20.3.tgz`);
  });

  it("a replaced tarball fails on its pins and on bun.lock's integrity", () => {
    const dir = copy((d) => fs.appendFileSync(path.join(d, "vendor/sheetjs/xlsx-0.20.3.tgz"), Buffer.from([0])));
    expect(violations(dir)).toMatch(/vendor\/sheetjs\/xlsx-0\.20\.3\.tgz: SHA-256 [0-9a-f]{64}, pinned 8dc73fc3/);
    const lock = copy((d) => replaceIn(d, "bun.lock", VENDORED.sheetjs.tarball.integrity, "sha512-AAAA"));
    expect(violations(lock)).toContain("bun.lock integrity for xlsx is sha512-AAAA");
  });

  it("an unreviewed file in a vendored directory fails", () => {
    const dir = copy((d) => write(d, "supabase/functions/_shared/vendor/sheetjs-0.20.3/cpexcel.full.mjs", "export {};\n"));
    expect(violations(dir)).toContain("supabase/functions/_shared/vendor/sheetjs-0.20.3/cpexcel.full.mjs is not in the vendored manifest");
  });

  it("the first revision's cdn.sheetjs.com dependency fails in package.json and in bun.lock", () => {
    const url = "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz";
    const dir = copy((d) => {
      replaceIn(d, "package.json", '"xlsx": "file:vendor/sheetjs/xlsx-0.20.3.tgz"', `"xlsx": "${url}"`);
      replaceIn(d, "bun.lock", '"xlsx": "file:vendor/sheetjs/xlsx-0.20.3.tgz"', `"xlsx": "${url}"`);
      replaceIn(d, "bun.lock", '"xlsx@vendor/sheetjs/xlsx-0.20.3.tgz"', `"xlsx@${url}"`);
    });
    const v = violations(dir);
    expect(v).toContain(`package.json dependencies.xlsx = "${url}": a dependency fetched from a URL`);
    expect(v).toContain(`bun.lock names ${url}: not a registry tarball`);
    expect(v).toContain("package.json names sheetjs.com");
  });

  it("a Deno import of SheetJS from its CDN, esm.sh or npm: fails, and so does an import from an unreviewed host", () => {
    const fn = "supabase/functions/trial-balance-layout/index.ts";
    const vendored = 'from "../_shared/vendor/sheetjs-0.20.3/xlsx.mjs"';
    const cases: [string, RegExp][] = [
      ['from "https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs"', /names "https:\/\/cdn\.sheetjs\.com/],
      ['from "https://esm.sh/xlsx@0.18.5"', /imports SheetJS remotely \("https:\/\/esm\.sh\/xlsx@0\.18\.5"\)/],
      ['from "npm:xlsx@0.20.3"', /imports SheetJS remotely \("npm:xlsx@0\.20\.3"\)/],
      ['from "xlsx"', /an Edge Function imports only the vendored/],
    ];
    for (const [spec, message] of cases) {
      const dir = copy((d) => replaceIn(d, fn, vendored, spec));
      expect(violations(dir), spec).toMatch(message);
    }
    const other = copy((d) => write(d, "supabase/functions/demo/index.ts", 'import { x } from "https://unpkg.com/some-lib@1.0.0/index.js";\nexport { x };\n'));
    expect(violations(other)).toContain("supabase/functions/demo/index.ts: remote import from unpkg.com");
    const types = copy((d) => replaceIn(d, fn, '@deno-types="../_shared/vendor/sheetjs-0.20.3/types/index.d.ts"', '@deno-types="https://cdn.sheetjs.com/xlsx-0.20.3/package/types/index.d.ts"'));
    expect(violations(types)).toContain(`${fn}: names "https://cdn.sheetjs.com/xlsx-0.20.3/package/types/index.d.ts"`);
  });

  it("an import map, a deno.json, deno.lock or the CI workflow naming cdn.sheetjs.com fails", () => {
    const map = copy((d) => write(d, "supabase/functions/process-trial-balance/functionpath/import_map.json", JSON.stringify({ imports: { xlsx: "https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs" } })));
    expect(violations(map)).toContain("supabase/functions/process-trial-balance/functionpath/import_map.json names sheetjs.com");
    const denoJson = copy((d) => write(d, "supabase/functions/demo/deno.json", JSON.stringify({ imports: { xlsx: "npm:xlsx@0.18.5" } })));
    expect(violations(denoJson)).toContain('supabase/functions/demo/deno.json: imports SheetJS remotely ("npm:xlsx@0.18.5")');
    const lock = copy((d) => replaceIn(d, "deno.lock", '"remote": {', '"remote": {\n    "https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs": "1a0fb062ee9781b13f6687371b202aaefc53b6ce55b530c027e01f9c087b77db",'));
    expect(violations(lock)).toContain("deno.lock names https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs: host cdn.sheetjs.com is not reviewed");
    const ci = copy((d) => fs.appendFileSync(path.join(d, ".github/workflows/ci.yml"), "      - run: deno test --allow-net=cdn.sheetjs.com x.ts\n"));
    expect(violations(ci)).toContain(".github/workflows/ci.yml names sheetjs.com");
  });

  it("bun.lock may resolve packages only from the reviewed registries, as registry tarballs", () => {
    const dir = copy((d) => replaceIn(d, "bun.lock", '"ws": ["ws@8.18.3", "",', '"ws": ["ws@8.18.3", "https://registry.example.invalid/ws/-/ws-8.18.3.tgz",'));
    expect(violations(dir)).toContain("bun.lock names https://registry.example.invalid/ws/-/ws-8.18.3.tgz: not a registry tarball");
  });
});

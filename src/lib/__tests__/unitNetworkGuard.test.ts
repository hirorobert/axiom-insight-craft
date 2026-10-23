import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "../../..");
const guard = path.join(root, "scripts/ci/unitNetworkGuard.cjs");
const execute = (source: string) => spawnSync(process.execPath, ["--require", guard, "-e", source], { encoding: "utf8", timeout: 10000 });

describe("unit tests cannot contact a hosted backend", () => {
  it("refuses external fetch before it reaches the network", () => {
    const r = execute("fetch('https://blocked.example.invalid').then(() => process.exit(2), e => console.log(e.message))");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("TEST_EGRESS_BLOCKED: external fetch is forbidden");
  });
  it("refuses external TCP before it reaches the network", () => {
    const r = execute("try { require('node:net').connect({host:'blocked.example.invalid',port:443}); process.exit(2); } catch(e) { console.log(e.message); }");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("TEST_EGRESS_BLOCKED: external TCP is forbidden");
  });
  it("contains both full unit-suite CI steps, without changing real-stack targets", () => {
    const workflow = fs.readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
    const steps = workflow.split(/\n {6}- name: /).filter((s) => s.includes("run: bun run test\n"));
    expect(steps).toHaveLength(2);
    for (const s of steps) {
      expect(s).toContain("VITE_SUPABASE_URL: http://127.0.0.1:54321");
      expect(s).toContain("VITE_SUPABASE_PUBLISHABLE_KEY: synthetic-unit-test-key");
      expect(s).toContain("NODE_OPTIONS: --require=${{ github.workspace }}/scripts/ci/unitNetworkGuard.cjs");
    }
  });
});

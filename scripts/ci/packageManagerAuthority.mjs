// Package-manager authority: Bun is the ONLY package manager of this repository.
//   - `packageManager` in package.json is an exact `bun@x.y.z`;
//   - bun.lock is the only JavaScript lockfile (deno.lock belongs to the Deno edge functions and is allowed);
//   - every workflow pins the same Bun version, installs with --frozen-lockfile, and never invokes npm / yarn / pnpm.
// Pure: returns a list of violations. Used by assertSingleLockfile.mjs (CI) and packageManagerAuthority.test.ts.
import fs from "node:fs";
import path from "node:path";

const COMPETING_LOCKFILES = ["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb"];

export function checkRepository(root) {
  const violations = [];
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const m = /^bun@(\d+\.\d+\.\d+)$/.exec(pkg.packageManager ?? "");
  if (!m) violations.push(`package.json "packageManager" must be an exact "bun@x.y.z" (found ${JSON.stringify(pkg.packageManager)})`);
  const version = m?.[1];

  if (!fs.existsSync(path.join(root, "bun.lock"))) violations.push("bun.lock is missing");
  for (const f of COMPETING_LOCKFILES) if (fs.existsSync(path.join(root, f))) violations.push(`competing lockfile present: ${f}`);

  const wfDir = path.join(root, ".github/workflows");
  const workflows = fs.existsSync(wfDir) ? fs.readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f)) : [];
  for (const wf of workflows) {
    const lines = fs.readFileSync(path.join(wfDir, wf), "utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
      const at = `${wf}:${i + 1}`;
      const code = line.replace(/#.*$/, "");
      const v = /bun-version:\s*['"]?([^'"\s]+)/.exec(code);
      if (v && v[1] !== version) violations.push(`${at}: bun-version ${v[1]} does not equal packageManager ${version}`);
      if (/\bnpm\s+(ci|install|i|add)\b|\byarn\b\s+(install|add)?|\bpnpm\s+(i|install|add)\b|\bnpx\b/.test(code)) violations.push(`${at}: competing package manager invoked (${code.trim()})`);
      if (/\bbun\s+install\b/.test(code) && !/--frozen-lockfile/.test(code)) violations.push(`${at}: "bun install" must use --frozen-lockfile`);
      if (/uses:\s*actions\/setup-node/.test(code) && /package-lock/.test(code)) violations.push(`${at}: setup-node cache keyed on package-lock.json`);
    });
  }
  return violations;
}

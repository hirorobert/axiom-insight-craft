// Package-manager authority: Bun is the ONLY package manager of this repository.
//   - `packageManager` in package.json is an exact `bun@x.y.z`;
//   - bun.lock is the only JavaScript lockfile (deno.lock belongs to the Deno edge functions and is allowed);
//   - every workflow pins the same Bun version, installs with --frozen-lockfile, and never invokes npm / yarn / pnpm;
//   - every dependency comes from the registry or from a file inside the repository (a vendored tarball such as
//     vendor/sheetjs/xlsx-0.20.3.tgz): a remote URL, git or GitHub specifier in package.json, or such a resolution in
//     bun.lock, is refused, because it makes an install fetch code from a host outside the reviewed registry.
// Pure: returns a list of violations. Used by assertSingleLockfile.mjs (CI) and packageManagerAuthority.test.ts.
import fs from "node:fs";
import path from "node:path";

const COMPETING_LOCKFILES = ["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb"];
const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "overrides", "resolutions"];
// A specifier that makes the installer fetch from somewhere other than the registry. In package.json a bare "owner/repo"
// is GitHub shorthand too; bun.lock spells a GitHub resolution "github:", and writes a vendored file as a plain path.
const REMOTE_RESOLUTION = /^(?:[a-z][a-z0-9+.-]*:\/\/|git\+|git:|github:|gitlab:|bitbucket:|gist:|ssh:)/i;
const REMOTE_SPECIFIER = new RegExp(`${REMOTE_RESOLUTION.source}|^[\\w.-]+\\/[\\w.-]+(?:#.*)?$`, "i");

/** A local specifier (file:/link:) is accepted only for a relative path that stays inside the repository. */
function localPathViolation(spec) {
  const p = spec.replace(/^(?:file|link):/i, "");
  if (!p || path.isAbsolute(p) || /^[a-z]:/i.test(p) || p.startsWith("~")) return "must be a path relative to the repository";
  if (p.split(/[\\/]/).includes("..")) return "must not leave the repository";
  return null;
}

function dependencyViolations(pkg, bunLock) {
  const violations = [];
  for (const field of DEPENDENCY_FIELDS) {
    for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
      if (typeof spec !== "string") continue;
      if (/^(?:file|link):/i.test(spec)) {
        const why = localPathViolation(spec);
        if (why) violations.push(`package.json ${field}.${name} = ${JSON.stringify(spec)}: a local dependency ${why}`);
      } else if (REMOTE_SPECIFIER.test(spec)) {
        violations.push(`package.json ${field}.${name} = ${JSON.stringify(spec)}: a remote URL, git or GitHub dependency is not allowed (vendor it under vendor/ and name the file)`);
      }
    }
  }
  // bun.lock package entries: "<key>": ["<name>@<resolution>", ...]. A registry resolution is a version; a vendored one a path.
  for (const m of bunLock.matchAll(/^\s*"[^"]+":\s*\["((?:@[^@"/]+\/)?[^@"]+)@([^"]*)"/gm)) {
    const resolution = m[2];
    if (REMOTE_RESOLUTION.test(resolution)) violations.push(`bun.lock resolves ${m[1]} from ${JSON.stringify(resolution)}: a remote URL, git or GitHub resolution is not allowed`);
  }
  return violations;
}

export function checkRepository(root) {
  const violations = [];
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const m = /^bun@(\d+\.\d+\.\d+)$/.exec(pkg.packageManager ?? "");
  if (!m) violations.push(`package.json "packageManager" must be an exact "bun@x.y.z" (found ${JSON.stringify(pkg.packageManager)})`);
  const version = m?.[1];

  if (!fs.existsSync(path.join(root, "bun.lock"))) violations.push("bun.lock is missing");
  for (const f of COMPETING_LOCKFILES) if (fs.existsSync(path.join(root, f))) violations.push(`competing lockfile present: ${f}`);
  const bunLock = fs.existsSync(path.join(root, "bun.lock")) ? fs.readFileSync(path.join(root, "bun.lock"), "utf8") : "";
  violations.push(...dependencyViolations(pkg, bunLock));

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

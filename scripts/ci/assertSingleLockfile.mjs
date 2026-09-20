#!/usr/bin/env node
import path from "node:path";
import { checkRepository } from "./packageManagerAuthority.mjs";

const root = path.resolve(process.argv[2] ?? ".");
const violations = checkRepository(root);
if (violations.length) {
  for (const v of violations) console.error(`PACKAGE_MANAGER_AUTHORITY: ${v}`);
  process.exit(1);
}
console.log("PACKAGE_MANAGER_AUTHORITY: OK (bun is the only package manager; bun.lock is the only lockfile)");

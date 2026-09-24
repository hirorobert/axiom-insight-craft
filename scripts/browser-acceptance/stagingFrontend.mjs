// Builds and serves the CFOClose frontend pointed ONLY at the staging-replay project, for the browser-acceptance suite.
//
// The repository's .env is tracked and holds PRODUCTION values; Vite would load it in any mode. So the build runs
// through Vite's own API with envDir set to an EMPTY temporary directory: no .env file of any kind can be read. The
// only Supabase values the bundle can contain are the ones passed here (from the protected STAGING_* secrets). The
// result is then verified: the bundle must name the staging project and must not contain the production reference
// anywhere. Any doubt fails closed.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PRODUCTION_PROJECT_REF, parseProjectRef } from "../ci/stagingGuard.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));

/** Pure check of a built bundle's text files. */
export function verifyBundle(texts, stagingRef) {
  const problems = [];
  if (!stagingRef || stagingRef === PRODUCTION_PROJECT_REF) problems.push("STAGING_REF_INVALID");
  if (texts.some((t) => t.includes(PRODUCTION_PROJECT_REF))) problems.push("PRODUCTION_REF_IN_BUNDLE");
  if (!texts.some((t) => t.includes(`https://${stagingRef}.supabase.co`))) problems.push("STAGING_URL_NOT_IN_BUNDLE");
  return problems;
}

export async function buildStagingFrontend({ supabaseUrl, publishableKey, outDir }) {
  const ref = parseProjectRef(supabaseUrl);
  if (!ref || ref === PRODUCTION_PROJECT_REF) throw new Error("refusing to build a frontend for a non-staging project");
  const emptyEnvDir = fs.mkdtempSync(path.join(os.tmpdir(), "cfoclose-no-env-"));
  process.env.VITE_SUPABASE_URL = supabaseUrl;
  process.env.VITE_SUPABASE_PUBLISHABLE_KEY = publishableKey;
  process.env.VITE_SUPABASE_PROJECT_ID = ref;
  const { build } = await import("vite");
  await build({
    root: REPO,
    configFile: path.join(REPO, "vite.config.ts"),
    mode: "staging",
    envDir: emptyEnvDir,
    logLevel: "error",
    build: { outDir, emptyOutDir: true },
  });
  if (fs.readdirSync(emptyEnvDir).length !== 0) throw new Error("the empty env directory is not empty");
  const texts = walk(outDir).filter((f) => /\.(js|html|css|json|map)$/.test(f)).map((f) => fs.readFileSync(f, "utf8"));
  const problems = verifyBundle(texts, ref);
  if (problems.length) throw new Error(`staging bundle verification failed: ${problems.join(", ")}`);
  return { ref };
}

export async function serveStagingFrontend({ outDir, port = 4173 }) {
  const { preview } = await import("vite");
  const server = await preview({
    root: REPO,
    configFile: path.join(REPO, "vite.config.ts"),
    envDir: fs.mkdtempSync(path.join(os.tmpdir(), "cfoclose-no-env-")),
    logLevel: "error",
    build: { outDir },
    preview: { port, strictPort: true, host: "127.0.0.1" },
  });
  return { origin: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.httpServer.close(() => r())) };
}

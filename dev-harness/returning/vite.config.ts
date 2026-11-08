// NON-PRODUCTION HARNESS config: `bunx vite --config dev-harness/returning/vite.config.ts`
//   → http://127.0.0.1:8092/dev-harness/returning/index.html?bridge=http://127.0.0.1:54996&as=preparer
// The REAL pages' views (Check my books, Close Review adjustments, the reporting workbench) over the loopback bridge of
// scripts/db-proof/serveReturning.mjs (a disposable PostgreSQL). No Supabase client, no credentials, never part of `vite build`.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

const ROOT = path.resolve(__dirname, "../..");
export default defineConfig({
  root: ROOT,
  server: { host: "127.0.0.1", port: Number(process.env.RETURNING_HARNESS_PORT ?? 8092), strictPort: true },
  plugins: [react()],
  resolve: { alias: [{ find: /^@\//, replacement: `${path.resolve(ROOT, "src")}/` }] },
});

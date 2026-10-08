// NON-PRODUCTION HARNESS config: `bunx vite --config dev-harness/reporting/vite.config.ts`
//   → http://127.0.0.1:8093/dev-harness/reporting/index.html?bridge=http://127.0.0.1:54998&as=preparer
// The REAL reporting workbench components (src/components/reporting) over the loopback bridge of
// scripts/db-proof/serveReporting.mjs (a disposable PostgreSQL). No Supabase client, no credentials, never part of
// `vite build` (the app config builds index.html only).
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

const ROOT = path.resolve(__dirname, "../..");
export default defineConfig({
  root: ROOT,
  server: { host: "127.0.0.1", port: Number(process.env.REPORTING_HARNESS_PORT ?? 8093), strictPort: true },
  plugins: [react()],
  resolve: { alias: [{ find: /^@\//, replacement: `${path.resolve(ROOT, "src")}/` }] },
});

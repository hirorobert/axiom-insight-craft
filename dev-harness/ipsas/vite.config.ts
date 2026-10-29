// NON-PRODUCTION HARNESS config: `bunx vite --config dev-harness/ipsas/vite.config.ts`
//   → http://127.0.0.1:8096/dev-harness/ipsas/index.html?bridge=http://127.0.0.1:54995&as=preparer
// The REAL IPSAS preparation component (src/components/ipsas) over the loopback bridge of scripts/db-proof/serveIpsas.mjs
// (a disposable PostgreSQL). No Supabase client, no credentials, never part of `vite build`.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

const ROOT = path.resolve(__dirname, "../..");
export default defineConfig({
  root: ROOT,
  server: { host: "127.0.0.1", port: Number(process.env.IPSAS_HARNESS_PORT ?? 8096), strictPort: true },
  plugins: [react()],
  resolve: { alias: [{ find: /^@\//, replacement: `${path.resolve(ROOT, "src")}/` }] },
});

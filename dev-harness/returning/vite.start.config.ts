// NON-PRODUCTION HARNESS config: `bunx vite --config dev-harness/returning/vite.start.config.ts`
//   -> http://127.0.0.1:8095/dev-harness/returning/start.html?bridge=http://127.0.0.1:54996&as=preparer#/workspace/<company>/2026/trial-balance/review
// The REAL Trial Balance Review page (PrepareWorkspace + useWorkspaceData) and the Check my books / Adjustments / reporting views, all over the
// loopback bridge of scripts/db-proof/serveReturning.mjs started with RETURNING_SCENE=start. The Supabase client and the auth context are replaced by
// loopback stand-ins (bridgeSupabase.ts, startAuth.tsx). Never part of `vite build`.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

const ROOT = path.resolve(__dirname, "../..");
export default defineConfig({
  root: ROOT,
  server: { host: "127.0.0.1", port: Number(process.env.RETURNING_START_PORT ?? 8095), strictPort: true },
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^@\/integrations\/supabase\/client$/, replacement: path.resolve(__dirname, "bridgeSupabase.ts") },
      { find: /^@\/contexts\/AuthContext$/, replacement: path.resolve(__dirname, "startAuth.tsx") },
      { find: /^@\//, replacement: `${path.resolve(ROOT, "src")}/` },
    ],
  },
});

// NON-PRODUCTION HARNESS config: `bunx vite --config dev-harness/trial-balance/vite.config.ts`
//   → http://127.0.0.1:8092/dev-harness/trial-balance/index.html
// The REAL Prepare page (PrepareWorkspace + useWorkspaceData + the uploader, card, checks and account review) with the
// Supabase client and the auth context replaced by an in-browser synthetic backend. No network, no credentials, never
// part of `vite build` (the app config builds index.html only).
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

const ROOT = path.resolve(__dirname, "../..");
export default defineConfig({
  root: ROOT,
  server: { host: "127.0.0.1", port: 8092, strictPort: true },
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^@\/integrations\/supabase\/client$/, replacement: path.resolve(__dirname, "syntheticBackend.ts") },
      { find: /^@\/contexts\/AuthContext$/, replacement: path.resolve(__dirname, "syntheticAuth.tsx") },
      { find: /^@\//, replacement: `${path.resolve(ROOT, "src")}/` },
    ],
  },
});

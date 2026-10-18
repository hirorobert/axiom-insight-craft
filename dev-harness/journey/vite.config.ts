// NON-PRODUCTION HARNESS config: `bunx vite --config dev-harness/journey/vite.config.ts`
//   → http://127.0.0.1:8093/dev-harness/journey/index.html?scene=first|draft|existing
// The account home's first upload through to the REAL Prepare page, on the trial-balance harness's synthetic backend
// (extended by syntheticClient.ts). No network, no credentials, never part of `vite build`.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

const ROOT = path.resolve(__dirname, "../..");
export default defineConfig({
  root: ROOT,
  server: { host: "127.0.0.1", port: 8093, strictPort: true },
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^@\/integrations\/supabase\/client$/, replacement: path.resolve(__dirname, "syntheticClient.ts") },
      { find: /^@\/contexts\/AuthContext$/, replacement: path.resolve(__dirname, "../trial-balance/syntheticAuth.tsx") },
      { find: /^@\//, replacement: `${path.resolve(ROOT, "src")}/` },
    ],
  },
});

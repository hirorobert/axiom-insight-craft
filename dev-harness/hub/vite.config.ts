// NON-PRODUCTION HARNESS config: `bunx vite --config dev-harness/hub/vite.config.ts` → http://127.0.0.1:8091/dev-harness/hub/index.html
// The real hub components and hooks, with the Supabase client and the auth context replaced by in-memory synthetic
// stand-ins (no network, no credentials). Never part of `vite build` (the app config builds index.html only).
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

const ROOT = path.resolve(__dirname, "../..");
export default defineConfig({
  root: ROOT,
  server: { host: "127.0.0.1", port: 8091, strictPort: true },
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^@\/integrations\/supabase\/client$/, replacement: path.resolve(__dirname, "syntheticClient.ts") },
      { find: /^@\/contexts\/AuthContext$/, replacement: path.resolve(__dirname, "syntheticAuth.tsx") },
      { find: /^@\//, replacement: `${path.resolve(ROOT, "src")}/` },
    ],
  },
});

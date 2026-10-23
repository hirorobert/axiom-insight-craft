// NON-PRODUCTION: real UI routes with simulated auth and transport, loopback only.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

const ROOT = path.resolve(__dirname, "../..");
export default defineConfig({
  root: ROOT,
  server: { host: "127.0.0.1", port: 8094, strictPort: true },
  envDir: false,
  plugins: [{ name: "isolated-divine-routes", configureServer(server) { server.middlewares.use((req, _res, next) => { if (/^\/(dashboard|settings|workspace|companies)(\/|\?|$)/.test(req.url ?? "")) req.url = "/dev-harness/divine/index.html"; next(); }); } }, react()],
  resolve: {
    alias: [
      { find: /^@\/integrations\/supabase\/client$/, replacement: path.resolve(__dirname, "client.ts") },
      { find: /^@\/contexts\/AuthContext$/, replacement: path.resolve(__dirname, "../trial-balance/syntheticAuth.tsx") },
      { find: /^@\//, replacement: `${path.resolve(ROOT, "src")}/` },
    ],
  },
});

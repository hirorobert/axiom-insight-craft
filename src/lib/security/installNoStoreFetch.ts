// Side-effect module, imported FIRST by src/main.tsx (before the app and the generated Supabase client): every browser request to
// the project's Supabase origin is made with `cache: "no-store"`. See sensitiveDataControls.ts (D3 compensating control 1).
import { installNoStoreFetch } from "./sensitiveDataControls";

if (typeof window !== "undefined") {
  installNoStoreFetch(window as unknown as Parameters<typeof installNoStoreFetch>[0], import.meta.env.VITE_SUPABASE_URL);
}

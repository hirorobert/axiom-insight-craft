// classificationAcceptanceGate.ts — the single gate for the internal classification-states visual-acceptance page.
//
// Unlike this repository's other feature gates (a source-controlled boolean flag someone can flip on in a reviewed
// change), this page has no such flag: it is deliberately development-only, permanently. The boundary is import.meta.env.DEV
// itself — Vite's own dev-server flag, which is statically `false` in every `vite build` output (including a
// preview or staging build), so the value here is compile-time constant per environment, not something a URL,
// stored preference or deployment configuration can change.
//
// While not a dev build:
//   - the route is never registered in App.tsx (see the gated lazy <Route> there — its dynamic import() is dead
//     code once `import.meta.env.DEV` is statically false, so the page's module is not reachable);
//   - the page component itself also returns null before reading a single fixture, so even a direct mount fails
//     closed (see ClassificationStatesAcceptance.tsx);
//   - no Supabase client, hook, mutation or network call exists anywhere in the page or its fixtures.
export function isClassificationAcceptancePageRenderable(isDevBuild: boolean): boolean {
  return isDevBuild === true;
}

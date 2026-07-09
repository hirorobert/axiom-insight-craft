
# SAFF ERP Brand Asset Handoff — v3 (Iron Dome, Locked) · Rev 4

Single change from Rev 3: Auth splash now correctly reflects the decision — **keep tagline, bump to h-24, stay on `variant="full"`**. Rev 3 wrote the opposite; that was a transcription error, corrected here.

## Pre-checks completed (read-only, before any file changes)

**Consumer audit** — `rg -n "SaffLogo" src/`:
```
src/components/Header.tsx:40   variant="header"  h-11 w-auto
src/components/Footer.tsx:13   variant="header"  h-9  w-auto
src/pages/Auth.tsx:232         variant="full"    h-20 w-auto  ← height only
```
Three consumers. No mobile-nav / splash / email / avatar surprises.

**Deletion-safety grep** — `rg -n "saff-erp-logo" .` → zero hits anywhere (`index.html`, `public/`, `*.md`, OG tags). `public/saff-erp-logo.svg` is orphaned; deletion is safe.

**Manrope usage grep** — `rg -n "Manrope" src/ tailwind.config.* index.html`:
```
index.html:23  <link rel=stylesheet ...Manrope...>
src/components/SaffLogo.tsx:47,65,107  (rewritten to <img>, refs disappear)
```
Nowhere else. Removing the font link tags is safe — no other component or Tailwind config depends on Manrope.

## Files to add (verbatim bytes from upload — no re-authoring)

```
src/assets/brand/saff-icon-simple.svg
src/assets/brand/saff-icon-detailed.svg
src/assets/brand/saff-lockup-compact.svg
src/assets/brand/saff-lockup-full.svg
```

## Files to rewrite

**`src/components/SaffLogo.tsx`** — thin router. Body only imports the four SVG URLs and returns an `<img>`. No inline SVG, no `<text>`, no paths, no Manrope references.

```
variant           file                        min → max
"icon-simple"     saff-icon-simple.svg        12  → 32  px
"icon-detailed"  saff-icon-detailed.svg      32  → 256 px
"header"          saff-lockup-compact.svg     150 → 300 px
"full"            saff-lockup-full.svg        300 → unlimited
```

Optional `decorative?: boolean` prop → emits `alt=""` + `aria-hidden="true"` for icon-only instances placed next to visible wordmark text. No current consumer needs it; the escape hatch exists before it's required.

## Files to touch

- **`src/pages/Auth.tsx` line 232** — change `className="h-20 w-auto mx-auto"` → `className="h-24 w-auto mx-auto"`. **Keeps `variant="full"`.** Full lockup viewBox is 715:220 ≈ 3.25:1; h-24 (96 px) × 3.25 ≈ **312 px wide**, clears the 300 px floor for `saff-lockup-full.svg`. Tagline "Audit-Ready FS & Tax Reporting" retained on the first-impression auth screen — intentional per your decision.
- **`src/components/Header.tsx`** / **`src/components/Footer.tsx`** — no code change. Sizing math (h-11 → ~200 px; h-9 → ~165 px) *appears* in-band. Not marked ✓ until Playwright renders confirm.
- **`index.html`** — remove the three Manrope `<link>` tags. Safe per pre-check above.

## Files to delete

- `public/saff-erp-logo.svg` — orphaned, confirmed zero references.

## Verification (nothing gets checked off until this passes)

1. `bun run build` — must exit 0.
2. Playwright at 1280 × 1800: `/` header, `/` footer, `/auth` splash screenshots.
3. Open each of the four locked SVGs at 100 %; visually compare chamfered corners, R/P open counters, ledger-green ERP, assay corner. On `/auth` specifically, confirm the tagline is readable at h-24.
4. **Retyped-wordmark check** — `rg -n "SAFF\s*ERP" src/ | grep -v "components/SaffLogo.tsx"` (excludes the file path, not the string — the `alt="SAFF ERP"` inside SaffLogo.tsx is legitimate and won't trip a false alarm). Must return zero lines.
5. Only after 1–4 pass, tick the sizing-math checkboxes.

## Explicit open gaps (logged, not silently skipped)

- **Favicon still on default Lovable placeholder.** `index.html` has no `<link rel="icon">`; `public/favicon.ico` is unlinked. `saff-icon-simple.svg` exists precisely for the 12–32 px band and should be wired in — separate follow-up ticket per your sequencing.

## What this plan explicitly does NOT do

- Redraw, re-color, re-optimize, or minify any SVG.
- Add a fifth variant.
- Touch business logic, edge functions, or the tax engine.
- Fix the favicon (logged above).

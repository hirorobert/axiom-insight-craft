# Brutal Assessment of Current Logo

Looking at the header screenshot honestly: **it does look like a toy.**

Specific failures:
1. **The "S" glyph is a blocky 8-bit pixel shape** — hand-drawn stepped SVG paths (`M0 0 H64 V24…`). It reads as a Tetris block, not a financial mark.
2. **"SAFF ERP" is not real typography** — every letter is a custom rectangular path (`A` is two triangles + a rect; `F`, `E`, `R`, `P` are all axis-aligned rectangles). No optical correction, no proper stroke contrast, no true serifs or geometric precision. It's the visual language of a 1990s clip-art logo.
3. **The shield** is a chamfered rectangle with one tiny green triangle in the corner — inconsistent metaphor (why is only one corner cut?), not a real shield or vault mark.
4. **Vertical alignment is off** — the wordmark sits slightly high vs. the emblem's optical center because the emblem `translate(24,35)` and wordmark `translate(216,48) scale(0.8)` were tuned independently.
5. **Color contrast is fine** (navy + green on white), but the shapes waste the palette.
6. **Header height (`h-10`)** clips the emblem's presence — the mark needs either more height or tighter internal proportions to feel confident.

Bottom line: the geometry is amateur SVG, not a designed logo. It needs to be rebuilt using real fonts and a properly constructed emblem.

# The Fix — Diamond Bank Grade Rebuild

Replace `src/components/SaffLogo.tsx` end-to-end. Keep the same exported API (`variant`, `className`) so `Header.tsx`, footer, and auth pages don't need changes.

## New logo construction

**Emblem — refined vault shield**
- Symmetric shield silhouette with all four corners chamfered (not just one), evoking a security-deposit vault plate.
- Navy `#0A1A2E` base with a thin `#0E6B55` inner keyline (1.5px) — creates the "bank stationery" feel.
- Center monogram: a proper **serif-inspired "S"** rendered from a single continuous curved path (Bezier), not stepped rectangles. Weight optically matched to the wordmark.
- Subtle bottom-right corner accent in green kept, but scaled and mitred to feel intentional.

**Wordmark — real typography**
- Use a heavyweight geometric sans already in the project's font stack for institutional weight: **Manrope 800** for `SAFF` in navy, **Manrope 700** for `ERP` in ledger green.
- Tracking: `-0.02em` (tight, confident), not the default loose spacing.
- Optical size ratio: cap-height set to ~62% of emblem height, wordmark baseline aligned to emblem optical center (not geometric center).
- Small gap between emblem and wordmark: exactly `0.5×` emblem width (bank-standard clearspace).

**Full variant (with tagline)**
- Tagline "AUDIT-READY FS & TAX REPORTING" set in **Manrope 500**, `0.18em` tracking, `#55657A`, sitting exactly under the wordmark baseline with `1.5×` x-height gap. Uses `<text>` with a webfont, not stretched glyphs.

## Header placement fix

In `src/components/Header.tsx`:
- Bump logo container from `h-10` to `h-11` (44px) — the industry standard for premium fintech headers (Stripe, Mercury, Ramp all sit at 40–48px).
- Ensure the `<Link>` uses `inline-flex items-center` so the SVG's `display:block` doesn't cause baseline drift.
- Leave the rest of the header untouched.

## Technical notes

- Both variants stay as inline SVG (no external file dependencies, crisp at any DPI, themable).
- Font is loaded via the existing Google Fonts / Tailwind stack — Manrope is already common in the codebase; if it isn't loaded, add one `<link>` to `index.html`.
- No changes to color tokens in `index.css` — the logo uses its own brand hex values (bank logos are typically token-independent so they render correctly on any surface).
- No changes to any other component, route, edge function, or backend.

## Files touched

1. `src/components/SaffLogo.tsx` — full rewrite (both variants).
2. `src/components/Header.tsx` — one class change (`h-10` → `h-11`) and container flex tweak.
3. `index.html` — add Manrope preconnect + stylesheet link only if not already present.

## Out of scope

- Favicon / `public/saff-erp-logo.svg` regeneration (can be a follow-up if you want them synced to the new mark).
- Any layout, color-token, or content changes elsewhere.
- No backend, DB, or edge-function work.

# Project implementation rules

- Keep pricing and public plan features in the existing catalogue/matrix mirror, and render them through one reusable catalogue; the database remains the authority for entitlements, while page selection is temporary, because there is no checkout or saved plan selection.
- Decide first-run setup only after the existing workspace-discovery read and both billing/capacity reads have resolved; keep all historical workspaces reachable when a plan ends, because an absent plan must not erase archive access.
- Expose fixture-only account-state previews exclusively behind development-only routes, with no customer reads or writes, because visual acceptance must not mutate or expose live financial data.
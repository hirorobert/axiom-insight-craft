# CFOClose edge cache controls — candidate, not installed

Prepared 4 November 2026 against main 9de36519ae333102f07a67f4ba3636256a6c7e8b.
No application rewrite, database migration or automatic deployment. AGENTS.md and the proposed charter P6 / section 11.4 apply: preserve authority and financial history; distinguish candidate configuration from live evidence.

## Verified findings

- Lovable's official custom-domain documentation supports its advanced "Uses Cloudflare or similar proxy" connection mode. It supplies the exact CNAME target; do not guess it from a preview URL.
- Cloudflare supports Cache Response Rules on Free and higher plans. Response Header Transform Rules alone do not change edge caching decisions.
- Public DNS on 4 November 2026 lists dns1.registrar-servers.com and dns2.registrar-servers.com. The complete current DNS inventory has NOT been obtained.
- /auth and /dashboard were missing no-store in the last live verification.
- Candidate JSON syntax and verifier unit tests can be checked offline. Cloudflare expression/API acceptance, zone permissions and live behavior remain UNVERIFIED until the account is connected.

## Controls

1. The request-phase rule bypasses the visitor-facing edge cache for both CFOClose website hosts.
2. The response-phase rule sets unqualified no-cache and no-store, max-age=0 and must-revalidate for documents and all other responses except a narrow public asset class. It removes stale-serving, shared-TTL, public and immutable directives from protected responses. cloudflare_only=false also sends the directives to browsers.
3. The only exception requires /assets/, GET/HEAD, HTTP 200, an origin response explicitly marked public AND immutable, no Set-Cookie and a JavaScript/CSS/image/font MIME type. HTML masquerading as an asset and missing/unknown content types remain protected. This never creates new caching eligibility or extends a public asset's origin TTL.
4. Do not strip Set-Cookie, modify authentication, rewrite response bodies, add credential logging, change Supabase endpoints, or route the database/API through this website proxy.
5. Both rules are disabled in the candidate. A merged configuration file has no effect on production.

## Required account access and rollout

1. Obtain owner-authorized Cloudflare account access and Namecheap DNS access. No password or API token belongs in chat, GitHub, browser history or these files.
2. Export the COMPLETE authoritative Namecheap zone, including mail/MX, SPF, DKIM, DMARC, verification TXT, CAA, subdomains and DNSSEC/DS state. Public DNS queries are not a zone export. Save the original nameservers, records, certificate state and a rollback receipt. No cutover until this inventory is reconciled.
3. Create/reuse the owner's Cloudflare zone. Import and reconcile the exact DNS inventory. Email-related hosts stay DNS-only. Configure TLS Full (strict), not Flexible. Coordinate DNSSEC/registrar DS with the provider's documented migration flow.
4. In Lovable's domain settings, use its documented proxy mode for cfoclose.com and www.cfoclose.com. Record the exact CNAME targets shown there and the restoration procedure BEFORE changing an existing live connection. Do not delete the live connection to discover a target.
5. Inspect existing Cloudflare cache/response rules and Workers. Preserve unrelated rules. Install the two candidate rules using their stable refs, then enable them only after Cloudflare accepts the exact expressions. Place them after conflicting rules; verify no later rule overrides them. Use per-rule create/update APIs or the dashboard; NEVER replace an entire phase ruleset with rules.json. If a stable ref already exists with different content, stop and review.
6. Update the actual DNS web records with the exact Lovable-issued targets, proxied. Switch authoritative nameservers only with owner approval, reconciled email records and a DNSSEC-safe plan. Keep Namecheap as registrar and retain the old zone for rollback. Do not transfer the domain or buy a plan.
7. Confirm certificates and both hosts before releasing traffic. If the provider offers no safe way to pre-stage the existing domain, stop before cutover. Rule ordering and origin/CDN compatibility require Cloudflare Trace and live tests; offline tests are not a substitute.
8. Purge pre-existing cache entries on the affected website hosts under the approved change window. Purge does not delete application or database records.
9. Run the acceptance commands below, then signed-in sign-in/refresh/logout, OAuth return, imports and disconnect smoke checks without altering historical issued reports. Verify email delivery after the DNS change. Review/update provider disclosures before customer activation.
10. Record rule IDs, versions, exact enabled payload hashes, DNS receipts, certificate checks, HTTP results and the owner approval. Restore the captured configuration if checks fail. Disable only these named rules during rollback; never reset all zone rules. Nameserver rollback has propagation delay and is not instantaneous.

## Acceptance commands

    python -m unittest -v test_verify.py
    python verify.py
    python verify.py --full

The default HTTP probe deliberately fails on current hosting. Full mode checks two hosts, route/query/slash variants, GET and HEAD, and repeat responses. It sends no credentials, does not follow redirects, reads no response bodies, prints no cookies, and accepts neither cache HIT/STALE nor a missing edge-bypass signal. A successful public probe does not attest authenticated APIs, DNS completeness, provider contracts, absence of all caches or overall Intuit compliance.

## Boundaries

This package is ready for account-specific review, not live. Do not select Intuit's security commitment solely because these files exist. Keep QBO customer activation off until the security declaration is truthful, Intuit production access is approved, credentials are securely configured and the production connection is verified.

## Primary references (reviewed 4 November 2026)

- https://docs.lovable.dev/features/custom-domain#advanced-use-a-cdn-or-reverse-proxy
- https://developers.cloudflare.com/cache/how-to/cache-response-rules/
- https://developers.cloudflare.com/cache/how-to/cache-response-rules/settings/
- https://developers.cloudflare.com/cache/how-to/cache-response-rules/create-api/
- https://developers.cloudflare.com/rules/transform/response-header-modification/

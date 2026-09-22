# Restore the enquiry security check

## Scope
- Keep Cloudflare Turnstile and all server-side verification fail-closed.
- Make the browser widget recover from transient Cloudflare/network failures without requiring a full-page reload.
- Preserve the existing site key, secret, hostname policy, enquiry flow, and financial application behavior.

## Implementation
- Add bounded automatic retries and a clear manual retry action to the existing security-check widget.
- Remove stale widget instances before retrying and never submit unless Cloudflare returns a valid token.
- Add focused regression tests for successful load, failure, retry, cleanup, expiry, and token reset.

## Verification
- Run focused enquiry tests and type checking.
- Verify the live contact page and local preview at desktop and mobile widths.
- Confirm no enquiry is created during verification and no production publish occurs unless explicitly requested.

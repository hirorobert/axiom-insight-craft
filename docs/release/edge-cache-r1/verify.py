"""Read-only HTTP acceptance; no credentials, cookies, bodies or Intuit calls."""
import argparse
import json
import sys
import urllib.error
import urllib.request

ORIGINS = ("https://cfoclose.com", "https://www.cfoclose.com")
PATHS = ("/auth", "/dashboard", "/auth/", "/dashboard/", "/auth?mode=login", "/dashboard?cache_probe=1")

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

def check_headers(headers, status):
    errors = []
    directives = [part.strip().lower() for value in headers.get_all("Cache-Control", []) for part in value.split(",")]
    if status not in (200, 301, 302, 303, 307, 308):
        errors.append("unexpected_http_status")
    for required in ("no-cache", "no-store"):
        if required not in directives:
            errors.append("missing_" + required)
    for part in directives:
        key, _, value = part.partition("=")
        key, value = key.strip(), value.strip()
        if key in ("public", "immutable", "s-maxage", "stale-if-error", "stale-while-revalidate"):
            errors.append("unsafe_cache_directive")
        if key == "max-age" and value.strip('"') != "0":
            errors.append("positive_or_invalid_max_age")
    for age in headers.get_all("Age", []):
        if age.strip() != "0":
            errors.append("cached_or_invalid_age")
    cache_status = headers.get("CF-Cache-Status", "").upper()
    if cache_status not in ("DYNAMIC", "BYPASS"):
        errors.append("edge_bypass_not_observed")
    return sorted(set(errors))

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--full", action="store_true", help="Probe both hosts, route variants, GET/HEAD twice; otherwise fail-fast on /auth GET.")
    args = parser.parse_args()
    opener = urllib.request.build_opener(NoRedirect())
    probes = [(ORIGINS[0], PATHS[0], "GET", 1)]
    if args.full:
        probes = [(origin, path, method, repeat) for origin in ORIGINS for path in PATHS for method in ("GET", "HEAD") for repeat in (1, 2)]
    failed = False
    for origin, path, method, repeat in probes:
        request = urllib.request.Request(origin + path, method=method, headers={"User-Agent": "CFOClose-cache-acceptance/1", "Accept": "text/html"})
        try:
            try:
                response = opener.open(request, timeout=20)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                status, headers = response.status, response.headers
                errors = check_headers(headers, status)
                location = headers.get("Location", "")
                if 300 <= status < 400 and location and not (location.startswith("/") and not location.startswith("//")) and not any(location == o or location.startswith(o + "/") for o in ORIGINS):
                    errors.append("unexpected_redirect_destination")
                print(json.dumps({"url": origin + path, "method": method, "repeat": repeat, "status": status, "cache_control": headers.get_all("Cache-Control", []), "edge_cache": headers.get("CF-Cache-Status"), "errors": errors}))
                failed |= bool(errors)
        except (OSError, ValueError) as error:
            print(json.dumps({"url": origin + path, "method": method, "error": type(error).__name__}))
            failed = True
        if failed and not args.full:
            break
    return 1 if failed else 0

if __name__ == "__main__":
    sys.exit(main())

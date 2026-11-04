import unittest
from email.message import Message
from verify import check_headers

def headers(*values, age=None, edge="DYNAMIC"):
    result = Message()
    for value in values:
        result["Cache-Control"] = value
    if age is not None:
        result["Age"] = age
    if edge is not None:
        result["CF-Cache-Status"] = edge
    return result

class AcceptanceTests(unittest.TestCase):
    def test_current_hosting_header_fails(self):
        self.assertIn("missing_no-store", check_headers(headers("no-cache, must-revalidate, max-age=0"), 200))
    def test_unqualified_mixed_case_directives_pass(self):
        self.assertEqual([], check_headers(headers("No-Cache, NO-STORE, max-age=0", edge="BYPASS"), 200))
    def test_qualified_directives_are_not_full_protection(self):
        self.assertIn("missing_no-cache", check_headers(headers('no-cache="Set-Cookie", no-store'), 200))
    def test_duplicate_header_cannot_hide_public_caching(self):
        self.assertIn("unsafe_cache_directive", check_headers(headers("no-cache, no-store", "public, max-age=900"), 200))
    def test_positive_age_fails_even_with_no_store(self):
        self.assertIn("cached_or_invalid_age", check_headers(headers("no-cache, no-store", age="2"), 200))
    def test_hit_and_stale_fail(self):
        for edge in ("HIT", "STALE", "UPDATING", "REVALIDATED", "MISS", None):
            self.assertIn("edge_bypass_not_observed", check_headers(headers("no-cache, no-store", edge=edge), 200))
    def test_error_response_is_not_acceptance(self):
        self.assertIn("unexpected_http_status", check_headers(headers("no-cache, no-store"), 503))
    def test_redirect_headers_are_checked(self):
        self.assertEqual([], check_headers(headers("no-cache, no-store"), 307))
    def test_positive_and_invalid_ttl_fail(self):
        for value in ("60", "-1", "invalid"):
            self.assertIn("positive_or_invalid_max_age", check_headers(headers("no-cache, no-store, max-age=" + value), 200))
    def test_whitespace_cannot_hide_positive_ttl(self):
        self.assertIn("positive_or_invalid_max_age", check_headers(headers("no-cache, no-store, max-age = 60"), 200))
    def test_not_modified_is_not_a_fresh_page(self):
        self.assertIn("unexpected_http_status", check_headers(headers("no-cache, no-store"), 304))
    def test_stale_directives_are_refused(self):
        self.assertIn("unsafe_cache_directive", check_headers(headers("no-cache, no-store, stale-if-error=30"), 200))

if __name__ == "__main__":
    unittest.main()

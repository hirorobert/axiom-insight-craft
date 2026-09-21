// submit-service-enquiry — the ONE public entry point for every CFOClose enquiry (contact form, donor/funder expert intake,
// jurisdiction-gated tax expert intake). The browser never writes the canonical tables: this function validates, then calls
// the service-role-only submit_service_enquiry RPC, which atomically records the enquiry, its first event and its outbox rows.
// Authentication is optional; a user id is recorded only when it comes from a verified JWT. All behaviour lives in
// _shared/serviceEnquiryHandler.ts (unit-tested); this file only wires real dependencies.

import { handleSubmitEnquiry } from "../_shared/serviceEnquiryHandler.ts";
import { buildEnquiryDeps } from "../_shared/serviceEnquiryWiring.ts";

const deps = buildEnquiryDeps();

Deno.serve((req) => handleSubmitEnquiry(req, deps));

// dispatch-enquiry-notifications — staff-triggered retry of pending enquiry notifications (the transactional outbox).
// Only ACTIVE platform staff may call it (verified server-side with the caller's own JWT). It sends nothing unless
// application email is explicitly configured, and it never guesses an internal recipient. See _shared/serviceEnquiryHandler.ts.

import { handleDispatchNotifications } from "../_shared/serviceEnquiryHandler.ts";
import { buildEnquiryDeps } from "../_shared/serviceEnquiryWiring.ts";

const deps = buildEnquiryDeps();

Deno.serve((req) => handleDispatchNotifications(req, deps));

// The routes owned by the Phase 1 service enquiry experience, behind the `service_enquiry_phase1` rollout gate.
//
// While the gate is OFF this returns NO routes, so /contact and /admin/enquiries match nothing and the router falls through to
// its existing catch-all (NotFound) — exactly as on current main. Both pages are lazy: their code is never fetched or evaluated
// unless a route is actually rendered, so an OFF build never loads the enquiry form or the staff queue.
//
// The staff route is a SCREEN, not a security boundary: the database refuses every staff_* call from anyone who is not active
// platform staff regardless of this gate.

import { lazy, Suspense, type ReactElement } from "react";
import { Route } from "react-router-dom";
import { PageErrorBoundary } from "@/components/PageErrorBoundary";
import { SERVICE_ENQUIRY_SURFACES, type ServiceEnquirySurfaces } from "./serviceEnquiryGate";

const Contact = lazy(() => import("@/pages/Contact"));
const EnquiryQueue = lazy(() => import("@/pages/admin/EnquiryQueue"));

const loading = (
  <div className="p-6 text-sm text-muted-foreground" role="status">
    Loading…
  </div>
);

export function serviceEnquiryRoutes(surfaces: ServiceEnquirySurfaces = SERVICE_ENQUIRY_SURFACES): ReactElement[] {
  const routes: ReactElement[] = [];
  if (surfaces.contactRoute) {
    routes.push(
      <Route
        key="contact"
        path="/contact"
        element={
          <Suspense fallback={loading}>
            <Contact />
          </Suspense>
        }
      />,
    );
  }
  if (surfaces.staffQueueRoute) {
    routes.push(
      <Route
        key="admin-enquiries"
        path="/admin/enquiries"
        element={
          <PageErrorBoundary pageName="Enquiry queue">
            <Suspense fallback={loading}>
              <EnquiryQueue />
            </Suspense>
          </PageErrorBoundary>
        }
      />,
    );
  }
  return routes;
}

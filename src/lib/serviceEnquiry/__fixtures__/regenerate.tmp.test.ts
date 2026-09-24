/** Temporary fixture regenerator — deleted immediately after running. */
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { expect, it, vi } from "vitest";

const spies = vi.hoisted(() => ({ invoke: vi.fn(), rpc: vi.fn(), from: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { functions: { invoke: spies.invoke }, rpc: spies.rpc, from: spies.from } }));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ user: null, loading: false, signOut: async () => undefined }) }));

function renderComponent(Component: any, at = "/") {
  return renderToStaticMarkup(
    createElement(MemoryRouter, { initialEntries: [at] }, createElement(Routes, null, createElement(Route, { path: "*", element: createElement(Component) }))),
  );
}

async function withGate<T>(enabled: boolean, load: () => Promise<T>): Promise<T> {
  vi.resetModules();
  vi.doMock("@/lib/serviceEnquiry/serviceEnquiryGate", async () => {
    const real = await vi.importActual<typeof import("../serviceEnquiryGate")>("../serviceEnquiryGate");
    return { ...real, SERVICE_ENQUIRY_PHASE1_ENABLED: enabled, SERVICE_ENQUIRY_SURFACES: real.surfacesFor(enabled) };
  });
  return load();
}

it("regenerates Header/Footer gate-OFF goldens", async () => {
  const dir = __dirname;
  const { Header } = await withGate(false, () => import("@/components/Header"));
  fs.writeFileSync(path.join(dir, "main-Header-landing.html"), renderComponent(Header, "/"));
  fs.writeFileSync(path.join(dir, "main-Header-inner.html"), renderComponent(Header, "/pricing"));
  const { Footer } = await withGate(false, () => import("@/components/Footer"));
  fs.writeFileSync(path.join(dir, "main-Footer.html"), renderComponent(Footer));
  expect(true).toBe(true);
});

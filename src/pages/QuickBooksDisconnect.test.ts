// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
const m = vi.hoisted(() => ({
  user: vi.fn(),
  companies: vi.fn(),
  status: vi.fn(),
  pending: vi.fn(),
  disconnect: vi.fn(),
  listener: null as null | ((event: string) => void),
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      getUser: m.user,
      onAuthStateChange: (fn: (e: string) => void) => {
        m.listener = fn;
        return { data: { subscription: { unsubscribe: () => {} } } };
      },
    },
    rpc: m.pending,
    from: () => ({ select: m.companies }),
  },
}));
vi.mock("@/lib/workspace/qboConnectorClient", () => ({
  fetchConnections: m.status,
  disconnectQuickBooks: m.disconnect,
}));
import Page from "./QuickBooksDisconnect";
let root: Root, host: HTMLDivElement;
const row = {
  id: "connection",
  realm_id: "123",
  environment: "sandbox",
  status: "active",
  created_at: "2026-11-02",
};
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  m.user
    .mockReset()
    .mockResolvedValue({ data: { user: { id: "actor" } }, error: null });
  m.companies
    .mockReset()
    .mockResolvedValue({
      data: [{ id: "company", name: "Sandbox books" }],
      error: null,
    });
  m.status.mockReset().mockResolvedValue([row]);
  m.pending.mockReset().mockResolvedValue({ data: null, error: null });
  m.disconnect.mockReset();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
const render = () =>
  act(async () =>
    root.render(
      createElement(
        MemoryRouter,
        {
          initialEntries: [
            "/integrations/quickbooks/disconnect?realmId=forged&disconnect=true",
          ],
        },
        createElement(Page),
      ),
    ),
  );
describe("authenticated connection management", () => {
  it("provider URL parameters never cause a disconnect", async () => {
    await render();
    expect(host.textContent).toContain("Sandbox books");
    expect(m.disconnect).not.toHaveBeenCalled();
  });
  it("signed-out visitors see sign-in and cannot request company status", async () => {
    m.user.mockResolvedValue({ data: { user: null }, error: null });
    await render();
    expect(host.textContent).toContain("Sign in to manage connections");
    expect(m.companies).not.toHaveBeenCalled();
    expect(m.disconnect).not.toHaveBeenCalled();
  });
  it("an explicit click uses the selected connection ID and shows pending revocation honestly", async () => {
    m.disconnect.mockResolvedValue({
      confirmed: false,
      outcome: "revocation_pending",
    });
    await render();
    m.status.mockResolvedValue([{ ...row, status: "disconnected" }]);
    m.pending.mockResolvedValue({
      data: { connectionId: "connection", requestId: "request" },
      error: null,
    });
    await act(async () => host.querySelector("button")!.click());
    expect(m.disconnect).toHaveBeenCalledWith(
      expect.anything(),
      "connection",
      expect.any(String),
    );
    expect(host.textContent).toContain("Retry disconnect");
    expect(host.textContent).toContain("Removal of access is not confirmed");
  });
  it("discards a prior identity’s delayed company status after sign-out", async () => {
    let finish: ((r: unknown) => void) | undefined;
    m.status.mockImplementationOnce(
      () =>
        new Promise((r) => {
          finish = r;
        }),
    );
    await render();
    m.user.mockResolvedValue({ data: { user: null }, error: null });
    await act(async () => {
      m.listener?.("SIGNED_OUT");
      await Promise.resolve();
      finish?.([row]);
    });
    expect(host.textContent).not.toContain("Sandbox books");
    expect(host.textContent).toContain("Sign in to manage connections");
  });
});

// @vitest-environment jsdom
import { createElement, lazy, Suspense, act } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RouteErrorFallback } from "./ErrorBoundary";

describe("data-router recovery", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  async function verifyFailure(element: React.ReactNode, loader?: () => never) {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const router = createMemoryRouter([{ path: "*", element, loader, errorElement: createElement(RouteErrorFallback) }], { initialEntries: ["/failed?v=2"] });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => { root.render(createElement(RouterProvider, { router })); });
      expect(container.textContent).toContain("Something went wrong");
      expect(container.textContent).not.toContain("private failure detail");
      expect(container.textContent).not.toContain("Unexpected Application Error");
      expect([...container.querySelectorAll("button")].map(button => button.textContent)).toEqual(["Try Again", "Go Home"]);
    } finally {
      await act(async () => root.unmount());
      router.dispose();
      container.remove();
    }
  }

  it("handles a route render crash without exposing its error", async () => {
    function Crash(): never { throw new Error("private failure detail"); }
    await verifyFailure(createElement(Crash));
  });

  it("handles rejected lazy page imports", async () => {
    const FailedPage = lazy(async () => { throw new Error("private failure detail"); });
    await verifyFailure(createElement(Suspense, { fallback: "Loading" }, createElement(FailedPage)));
  });

  it("handles route loader failures", async () => {
    await verifyFailure(createElement("div"), () => { throw new Error("private failure detail"); });
  });
});
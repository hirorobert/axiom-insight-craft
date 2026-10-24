// @vitest-environment node
import { createElement, lazy, Suspense, act } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { JSDOM } from "jsdom";
import { afterAll, beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { RouteErrorFallback } from "./ErrorBoundary";

describe("data-router recovery", () => {
  // Keep Node's Request and AbortController in the same realm. The CI egress
  // guard initializes native fetch before Vitest; a full JSDOM environment
  // otherwise replaces only AbortController and prevents the loader from running.
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
  beforeAll(() => {
    vi.stubGlobal("window", dom.window);
    vi.stubGlobal("document", dom.window.document);
    vi.stubGlobal("navigator", dom.window.navigator);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  });
  afterEach(() => { vi.restoreAllMocks(); });
  afterAll(() => { vi.unstubAllGlobals(); dom.window.close(); });

  async function verifyFailure(element: React.ReactNode, loader?: () => never) {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const trackedLoader = loader ? vi.fn(loader) : undefined;
    const router = createMemoryRouter([{ path: "*", element, loader: trackedLoader, errorElement: createElement(RouteErrorFallback) }], { initialEntries: ["/failed?v=2"] });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => { root.render(createElement(RouterProvider, { router })); });
      if (trackedLoader) expect(trackedLoader).toHaveBeenCalledTimes(1);
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

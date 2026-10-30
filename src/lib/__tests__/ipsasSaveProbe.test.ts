// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { saveGrantsAndReadBack } from "../../../scripts/browser-acceptance/ipsasGrantsSteps.mjs";

const savedText = "This is the server's recorded version";
const reply = (body: unknown) => ({ clone: () => ({ json: async () => body }) });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const originalFetch = window.fetch;
afterEach(() => { window.fetch = originalFetch; document.body.innerHTML = ""; vi.restoreAllMocks(); });

describe("grant-save browser completion", () => {
  it("ignores an old saved banner, old read-back and pending receipt; waits for the exact new revision", async () => {
    document.body.innerHTML = `<section data-grants-revision="old-revision"><button disabled>Save grants</button><p>${savedText}</p><p data-testid="gr0-figures">Old figures</p></section>`;
    // JSDOM does not implement layout innerText. This test models its browser text view.
    Object.defineProperty(document.body, "innerText", { configurable: true, get: () => document.body.textContent });
    Object.defineProperty(document.querySelector("button")!, "innerText", { configurable: true, get: () => "Save grants" });
    let release!: (v: unknown) => void;
    const receipt = new Promise(resolve => { release = resolve; });
    const transport = vi.fn(async (url: string) => url.includes("ipsas_save_grants") ? receipt : reply({ outcome: "available", register: { id: url.includes("new=1") ? "new-revision" : "old-revision" } }));
    window.fetch = transport as never;
    let predicate!: () => unknown;
    const page = {
      evaluate: async (fn: () => unknown) => fn(),
      click: async () => { void window.fetch("/rpc/ipsas_save_grants", { body: JSON.stringify({ p_request_id: "req-2", p_expected_id: "old-revision" }) }); },
      waitFor: async (fn: () => unknown) => { predicate = fn; for (let n=0;n<200;n++) { const value=fn();if(value)return value;await tick(); } throw new Error("timed out"); },
    };
    let finished = false;
    const pending = saveGrantsAndReadBack(page).then((r: unknown) => { finished=true;return r; });
    await tick(); expect(finished).toBe(false); expect(predicate()).toBeFalsy();
    release(reply({ outcome: "recorded", revisionId: "new-revision" })); await tick();
    await window.fetch("/rpc/ipsas_grants_context");
    expect(predicate()).toBeFalsy();expect(finished).toBe(false);
    await window.fetch("/rpc/ipsas_grants_context?new=1");
    expect(predicate()).toBeFalsy();expect(finished).toBe(false);
    document.querySelector("section")!.setAttribute("data-grants-revision", "new-revision");
    expect(await pending).toEqual({ requestId: "req-2", revisionId: "new-revision" });
    expect(window.fetch).toBe(transport);
    expect(transport.mock.calls.filter(c=>c[0].includes("ipsas_save_grants"))).toHaveLength(1);
  });

  it("restores the original transport when the native click fails, without retrying", async () => {
    const transport = vi.fn();window.fetch=transport as never;
    const click=vi.fn(async()=>{throw new Error("covered target");});
    await expect(saveGrantsAndReadBack({ evaluate: async (fn: () => unknown)=>fn(),click })).rejects.toThrow("covered target");
    expect(click).toHaveBeenCalledTimes(1);expect(window.fetch).toBe(transport);
  });
});

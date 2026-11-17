// @vitest-environment jsdom
/**
 * S2-C10 — usePublicPlanPrices() is null ONLY while the read is in flight (the plan cards then show a neutral
 * placeholder); every finished read resolves, so a failed read never leaves the cards on the placeholder. A failed or
 * malformed read is "nothing purchasable" (NO_PUBLIC_PRICES): the cards then say what they said before this change.
 */
import { act, createElement as h } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, type Mounted } from "@/lib/workbench/testkit/dom";

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));

import { NO_PUBLIC_PRICES, usePublicPlanPrices } from "../checkoutClient";

let seen: unknown[] = [];
function Probe() { seen.push(usePublicPlanPrices()); return null; }
const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); }); };
let m: Mounted | null = null;
afterEach(() => { m?.unmount(); m = null; seen = []; vi.clearAllMocks(); });

describe("usePublicPlanPrices", () => {
  it("null while the read is in flight, then the server's answer", async () => {
    let answer: (v: unknown) => void = () => undefined;
    rpc.mockReturnValue(new Promise((r) => { answer = r; }));
    m = mount(h(Probe));
    await flush();
    expect(seen.at(-1)).toBeNull();
    answer({ data: { online_payment: true, offers: [{ plan_code: "SOLO", market_code: "GLOBAL", currency_code: "USD", currency_exponent: 2, amount_minor: 49000 }] }, error: null });
    await flush();
    expect(rpc).toHaveBeenCalledWith("get_public_plan_prices");
    expect(seen.at(-1)).toEqual({ onlinePayment: true, offers: [{ planCode: "SOLO", marketCode: "GLOBAL", currencyCode: "USD", currencyExponent: 2, amountMinor: 49000 }] });
  });
  for (const [label, behaviour] of [
    ["an error answer", () => rpc.mockResolvedValue({ data: null, error: { message: "boom" } })],
    ["a malformed answer", () => rpc.mockResolvedValue({ data: "nonsense", error: null })],
    ["a rejected request", () => rpc.mockRejectedValue(new Error("network"))],
  ] as const) {
    it(`${label}: resolves to nothing purchasable, never stays pending`, async () => {
      behaviour();
      m = mount(h(Probe));
      await flush();
      expect(seen.at(-1)).toBe(NO_PUBLIC_PRICES);
      expect(NO_PUBLIC_PRICES).toEqual({ onlinePayment: false, offers: [] });
    });
  }
});

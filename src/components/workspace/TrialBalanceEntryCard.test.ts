import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import TrialBalanceEntryCard from "./TrialBalanceEntryCard";
import { impliedService, LAUNCH_COPY } from "@/lib/workspace/onboardingState";
import { CUSTOMER_CAPABILITY_OUTCOMES } from "@/lib/workspace/mandate";

const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const render = (canStart: boolean) => renderToStaticMarkup(createElement(TrialBalanceEntryCard, { canStart, onUpload: async () => {} }));

describe("Phase 2 §5.1: the one way in while only one service exists", () => {
  it("the service is implied only when exactly one customer service exists", () => {
    expect(impliedService(["FINANCIAL_STATEMENTS"])).toBe("FINANCIAL_STATEMENTS");
    expect(impliedService([])).toBeNull();
    expect(impliedService(["FINANCIAL_STATEMENTS", "TAX_COMPUTATION"])).toBeNull();
    // Today there is exactly one customer service, so neither "What would you like to complete?" nor "Add financial
    // data" is shown to a customer.
    expect(impliedService(CUSTOMER_CAPABILITY_OUTCOMES.map((o) => o.capability))).toBe("FINANCIAL_STATEMENTS");
  });
  it("one explicit service-start action; there is no empty-workspace detour", () => {
    const html = render(true);
    expect(text(html)).toContain(LAUNCH_COPY.entryHeading);
    expect((html.match(/data-testid="entry-upload"/g) ?? []).length).toBe(1);
    expect(html).not.toContain('data-testid="entry-start-empty"');
    expect(text(html)).toContain("Start trial balance review");
    expect(text(html)).not.toContain(LAUNCH_COPY.secondaryAction);
    expect(text(html)).not.toMatch(/What would you like to complete|Add financial data/);
  });
  it("without permission to start work, nothing is offered and the reason is stated", () => {
    const html = render(false);
    expect(html).not.toContain('data-testid="entry-upload"');
    expect(html).toContain('data-testid="entry-no-permission"');
  });
});

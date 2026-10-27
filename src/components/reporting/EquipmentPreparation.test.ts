// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import {
  click,
  mount,
  typeInto,
  type Mounted,
} from "@/lib/workbench/testkit/dom";
import { EquipmentPreparation } from "./EquipmentPreparation";
import type { PageProps } from "./shared";
import { readPriorPage } from "@/lib/preparation/priorReport";
vi.mock("@/lib/preparation/priorReport", () => ({ readPriorPage: vi.fn() }));
const flush = async () => {
  for (let i = 0; i < 5; i++)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
};
let m: Mounted | null = null;
let record: ReturnType<typeof vi.fn>;
const text = () => m!.container.textContent ?? "";
const button = (name: string) =>
  [...m!.container.querySelectorAll("button")].find(
    (b) => b.textContent === name,
  )!;
const field = (name: string) =>
  [...m!.container.querySelectorAll("label")]
    .find((l) => l.textContent?.startsWith(name))!
    .querySelector("input,select,textarea")! as HTMLInputElement;
function fill(name: string, value: string) {
  const el = field(name);
  if (el.tagName === "SELECT")
    act(() => {
      el.value = value;
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
  else typeInto(el, value);
}
function props(over: Partial<PageProps> = {}): PageProps {
  return {
    companyId: "company-a",
    periodYear: 2025,
    legalName: "Synthetic SME",
    allowed: ["prepare_close"],
    reportVersion: 2,
    hrefFor: (page) => `/reports/${page}`,
    newRequestId: () => "request-one",
    refresh: vi.fn(async () => {}),
    state: {
      notes: { state: "evaluated", requirements: [] },
      composition: {
        state: "composed",
        pack: { packId: "ifrs-for-smes/2015" },
        compositionSha256: "a".repeat(64),
        blockers: [],
        accountsNotPresented: [],
        totals: { current: { state: "complete" } },
        comparative: { state: "unavailable" },
        current: { currency: "TZS", exponent: 2 },
        lines: [
          {
            lineId: "sfp.property_plant_and_equipment",
            current: { amountMinor: "1400000" },
          },
        ],
      },
    },
    db: {rpc: async (name: string, args: Record<string, unknown>) => {
      if(name !== "fs_create_equipment_schedule") throw new Error("Unexpected RPC");
      return {data: await record(args.p_company_id,args.p_period_year,"ppe",args.p_rows,args.p_source_ref,args.p_request_id),error:null};
    }},
    clients: {
      notes: { recordSchedule: record },
      signoff: {
        input: async () => ({ comparative: { reportingEnd: "2024-12-31" } }),
      },
    },
    ...over,
  } as unknown as PageProps;
}
async function start(p = props()) {
  m = mount(h(MemoryRouter, null, h(EquipmentPreparation, p)));
  await flush();
  click(button("Start guided equipment preparation"));
}
async function source() {
  const file = new File(["%PDF-test"], "prior.pdf", {
    type: "application/pdf",
  });
  const input = field("Prior financial statements");
  act(() => {
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [file],
    });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  click(button("Read this page locally"));
  await flush();
  fill("Prior reporting date", "2024-12-31");
  fill("Equipment carrying amount", "16000.00");
  fill("Currency printed", "TZS");
  fill("Units printed", "0");
  click(m!.container.querySelector("[data-testid=confirm-prior-figure]")!);
}
async function complete() {
  await source();
  fill("Current opening carrying amount", "16000.00");
  fill("Depreciation (positive", "2000.00");
  fill("Closing carrying amount", "14000.00");
  fill("Register, ledger", "Synthetic fixed asset register 2025");
  fill("Asset class", "Equipment");
  click(m!.container.querySelector("[data-testid=confirm-movement-coverage]")!);
}
beforeEach(() => {
  record = vi.fn(async () => ({
    outcome: "recorded",
    submissionId: "11111111-1111-4111-8111-111111111111",
  }));
  vi.mocked(readPriorPage).mockResolvedValue({
    sha256: "b".repeat(64),
    page: 1,
    pages: 10,
    text: "Equipment carrying amount 16000",
    method: "ocr",
    preview: new Blob(["preview"]),
  });
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => "blob:preview"),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn(),
  });
});
afterEach(() => {
  m?.unmount();
  m = null;
  vi.clearAllMocks();
});
it("uses normal schedule navigation and does not assume a useful life or save on reading", async () => {
  await start();
  await source();
  expect(text()).toContain("OCR — review required");
  expect(text()).toContain("workpaper");
  expect(field("Useful lives").value).toBe("");
  expect(record).not.toHaveBeenCalled();
  expect(button("Record equipment schedule").disabled).toBe(true);
});
it("requires the figure to agree to the recorded prior date, not merely the date typed by the user", async () => {
  await start();
  await complete();
  fill("Prior reporting date", "2023-12-31");
  click(m!.container.querySelector("[data-testid=confirm-prior-figure]")!);
  expect(text()).toContain("more information needed");
  expect(button("Record equipment schedule").disabled).toBe(true);
});
it("records exact signed movements through the existing authority and says what is not saved", async () => {
  await start();
  await complete();
  expect(button("Record equipment schedule").disabled).toBe(false);
  click(button("Record equipment schedule"));
  await flush();
  expect(record).toHaveBeenCalledWith(
    "company-a",
    2025,
    "ppe",
    [
      {
        classLabel: "Equipment",
        openingMinor: "1600000",
        closingMinor: "1400000",
        movements: [{ kind: "depreciation", amountMinor: "-200000" }],
      },
    ],
    expect.stringContaining("b".repeat(64)),
    "request-one",
  );
  expect(text()).toContain(
    "Policy wording and the original PDF are not stored",
  );
});
it("retains request identity after an unknown save; never says nothing was recorded", async () => {
  record.mockRejectedValueOnce(new Error("lost answer"));
  await start();
  await complete();
  click(button("Record equipment schedule"));
  await flush();
  expect(text()).toContain("Could not confirm the schedule save");
  click(button("Record equipment schedule"));
  await flush();
  expect(record.mock.calls[0][5]).toBe(record.mock.calls[1][5]);
});
it("refuses to replace any existing schedule from the single-class wizard", async () => {
  const p = props();
  p.state.notes = {state: "evaluated", requirements: [{requirementId: "smes.schedule.ppe", submissionId: "saved"}]} as never;
  await start(p);
  await complete();
  expect(button("Record equipment schedule").disabled).toBe(true);
  expect(m!.container.querySelector("[data-testid=confirm-replace-schedule]")).toBeNull();
  expect(text()).toContain("This one-class worksheet cannot replace it");
  expect([...m!.container.querySelectorAll("a")].find(a => a.textContent === "Open the full schedule editor")?.getAttribute("href")).toContain("fs-notes");
  expect(record).not.toHaveBeenCalled();
});
it("does not expose editing to a reader and never upgrades a draft to compliance", async () => {
  m = mount(
    h(
      MemoryRouter,
      null,
      h(EquipmentPreparation, props({ allowed: ["review_close"] })),
    ),
  );
  await flush();
  expect(text()).toBe("");
  expect(record).not.toHaveBeenCalled();
});

it("does not treat a malformed recorded response as a saved schedule", async () => {
  record.mockResolvedValueOnce({ outcome: "recorded" });
  await start();
  await complete();
  click(button("Record equipment schedule"));
  await flush();
  expect(text()).toContain("server receipt is incomplete");
  click(button("Record equipment schedule"));
  await flush();
  expect(record.mock.calls[0][5]).toBe(record.mock.calls[1][5]);
});
it("retains edits when server statement inputs change and requires renewed review", async () => {
  const p = props();
  await start(p);
  await complete();
  const changed = {
    ...p,
    state: {
      ...p.state,
      composition: {
        ...p.state.composition,
        compositionSha256: "c".repeat(64),
      },
    },
  } as PageProps;
  m!.rerender(h(MemoryRouter, null, h(EquipmentPreparation, changed)));
  await flush();
  expect(field("Current opening carrying amount").value).toBe("16000.00");
  expect(text()).toContain("Your workpaper is kept");
  expect(button("Record equipment schedule").disabled).toBe(true);
  click(button("Review refreshed statement figures"));
  expect(
    (
      m!.container.querySelector(
        "[data-testid=confirm-prior-figure]",
      ) as HTMLInputElement
    ).checked,
  ).toBe(false);
});
it("allows reviewed manual evidence without inventing a document fingerprint or audited status", async () => {
  await start();
  fill("Available prior-year source", "reference");
  fill("Prior figure source reference", "Reviewed opening register page A1");
  fill("Prior reporting date", "2024-12-31");
  fill("Equipment carrying amount", "16000.00");
  fill("Currency printed", "TZS");
  fill("Units printed", "0");
  click(m!.container.querySelector("[data-testid=confirm-prior-figure]")!);
  fill("Current opening carrying amount", "16000");
  fill("Depreciation (positive", "2000");
  fill("Closing carrying amount", "14000");
  fill("Register, ledger", "Current register");
  fill("Asset class", "Equipment");
  click(m!.container.querySelector("[data-testid=confirm-movement-coverage]")!);
  expect(button("Record equipment schedule").disabled).toBe(false);
  click(button("Record equipment schedule"));
  await flush();
  expect(record.mock.calls[0][4]).toContain(
    "manual prior reference Reviewed opening register",
  );
  expect(record.mock.calls[0][4]).not.toContain("sha256");
  expect(readPriorPage).not.toHaveBeenCalled();
});
it("ignores a late PDF read after changing workspace", async () => {
  let resolve!: (v: Awaited<ReturnType<typeof readPriorPage>>) => void;
  vi.mocked(readPriorPage).mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const p = props();
  await start(p);
  const input = field("Prior financial statements");
  act(() => {
    Object.defineProperty(input, "files", {
      value: [new File(["%PDF-test"], "prior.pdf")],
    });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  click(button("Read this page locally"));
  m!.rerender(
    h(
      MemoryRouter,
      null,
      h(EquipmentPreparation, { ...p, companyId: "company-b" }),
    ),
  );
  await flush();
  await act(async () =>
    resolve({
      sha256: "b".repeat(64),
      page: 1,
      pages: 1,
      text: "Late old-company text",
      method: "ocr",
      preview: new Blob(["old"]),
    }),
  );
  expect(text()).not.toContain("Late old-company text");
  expect(record).not.toHaveBeenCalled();
});

it("keeps a confirmed save distinct from a failed status refresh", async () => {
  await start(
    props({
      refresh: vi.fn(async () => {
        throw new Error("refresh lost");
      }),
    }),
  );
  await complete();
  click(button("Record equipment schedule"));
  await flush();
  expect(text()).toContain("Schedule recorded (receipt");
  expect(text()).toContain("another save is not needed");
  expect(text()).not.toContain("Could not confirm the schedule save");
  expect(record).toHaveBeenCalledTimes(1);
});

it("keeps edits when a schedule was created after the page loaded", async () => {
  record.mockResolvedValueOnce({outcome:"schedule_exists"});
  await start(); await complete(); click(button("Record equipment schedule")); await flush();
  expect(text()).toContain("Nothing was replaced");
  expect(field("Asset class").value).toBe("Equipment");
});

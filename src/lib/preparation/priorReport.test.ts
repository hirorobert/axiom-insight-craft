import { expect, it } from "vitest";
import { checkPriorPdf, PRIOR_PDF_MAX_BYTES } from "./priorReport";
it("bounds each selected PDF and page before reading it", () => {
  expect(() => checkPriorPdf(0, 1)).toThrow();
  expect(() => checkPriorPdf(PRIOR_PDF_MAX_BYTES + 1, 1)).toThrow();
  for (const page of [0, -1, 201, 1.5, NaN])
    expect(() => checkPriorPdf(1, page)).toThrow();
  expect(() => checkPriorPdf(PRIOR_PDF_MAX_BYTES, 200)).not.toThrow();
});

it("cancels a stalled operation without waiting for a provider or worker response", async () => {
  const { abortable } = await import("./priorReport");
  const controller = new AbortController();
  const result = abortable(new Promise<never>(() => {}), controller.signal);
  controller.abort();
  await expect(result).rejects.toMatchObject({ name: "AbortError" });
});

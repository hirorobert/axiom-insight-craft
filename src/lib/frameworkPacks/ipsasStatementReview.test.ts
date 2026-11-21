// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { axeViolations } from "@/lib/workbench/testkit/dom";
import { composeIpsasStatements } from "../../../release/candidates/ipsas-statements-r1/compose";
import { renderIpsasStatementReview } from "../../../release/candidates/ipsas-statements-r1/render";

const fixture = () => JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../docs/release/ipsas-statements-r1/synthetic-statement-input.json"), "utf8"));
afterEach(() => { document.body.innerHTML = ""; });
function show() {
  const page = new DOMParser().parseFromString(renderIpsasStatementReview(composeIpsasStatements(fixture())), "text/html");
  document.body.innerHTML = page.body.innerHTML;
}
it("every section, note and return link reaches a real target", () => {
  show();
  const links = [...document.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')];
  expect(links.some(a => a.getAttribute("href") === "#budget")).toBe(true);
  expect(links.some(a => a.getAttribute("href") === "#notes")).toBe(true);
  for (const a of links) expect(document.getElementById(a.getAttribute("href")!.slice(1)), a.textContent!).not.toBeNull();
  const ids = [...document.querySelectorAll("[id]")].map(n => n.id);
  expect(new Set(ids).size).toBe(ids.length);
});
it("the joined review has no detected WCAG A/AA structural violations", async () => {
  show();
  expect(await axeViolations(document.body)).toEqual([]);
});
it("retains source tracing and incomplete status in the rendered document", () => {
  show();
  expect(document.querySelectorAll("details").length).toBeGreaterThan(10);
  expect(document.querySelector("header")?.textContent).toContain("NOT APPROVED OR ISSUED");
  expect(document.querySelector("#tasks")?.textContent).toContain("ACCOUNTANT_ACCEPTANCE_OUTSTANDING");
  expect(document.querySelectorAll("script,iframe,form,input")).toHaveLength(0);
});

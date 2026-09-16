import { describe, expect, it } from "vitest";
import { resolveNextActionDestination } from "./resolveNextActionDestination";

const basePath = "/workspace/company-1/2025";

describe("resolveNextActionDestination", () => {
  it("routes to /statements/review when the active stage is statements, the remembered outcome asked for document review, and the engine's own next action already points at the plain statements screen", () => {
    const result = resolveNextActionDestination({
      activeSlug: "statements",
      basePath,
      nextActionHref: `${basePath}/statements`,
      nextActionLabel: "Open Statements",
      routeIntent: "review-existing-statements",
    });
    expect(result).toEqual({ href: `${basePath}/statements/review`, label: "Review statements" });
  });

  it("leaves the destination untouched when no outcome routeIntent is remembered", () => {
    const result = resolveNextActionDestination({
      activeSlug: "statements",
      basePath,
      nextActionHref: `${basePath}/statements`,
      nextActionLabel: "Open Statements",
      routeIntent: undefined,
    });
    expect(result).toEqual({ href: `${basePath}/statements`, label: "Open Statements" });
  });

  it("leaves the destination untouched when the active stage is not statements, even with routeIntent set", () => {
    const result = resolveNextActionDestination({
      activeSlug: "tax",
      basePath,
      nextActionHref: `${basePath}/tax`,
      nextActionLabel: "Open Tax",
      routeIntent: "review-existing-statements",
    });
    expect(result).toEqual({ href: `${basePath}/tax`, label: "Open Tax" });
  });

  it("leaves the destination untouched when the engine's own next action does not point at the plain statements screen (e.g. it points at prepare first)", () => {
    const result = resolveNextActionDestination({
      activeSlug: "statements",
      basePath,
      nextActionHref: `${basePath}/prepare`,
      nextActionLabel: "Open Prepare Data",
      routeIntent: "review-existing-statements",
    });
    expect(result).toEqual({ href: `${basePath}/prepare`, label: "Open Prepare Data" });
  });

  it("leaves the destination untouched when activeSlug is null (engagement complete)", () => {
    const result = resolveNextActionDestination({
      activeSlug: null,
      basePath,
      nextActionHref: `${basePath}/statements`,
      nextActionLabel: "Open Statements",
      routeIntent: "review-existing-statements",
    });
    expect(result).toEqual({ href: `${basePath}/statements`, label: "Open Statements" });
  });

  it("never routes to document review for stages other than statements even if their href happens to end in /statements as a substring coincidence", () => {
    const result = resolveNextActionDestination({
      activeSlug: "compliance",
      basePath,
      nextActionHref: `${basePath}/statements`, // contrived — should never happen in practice
      nextActionLabel: "Open Compliance",
      routeIntent: "review-existing-statements",
    });
    expect(result.href).toBe(`${basePath}/statements`);
    expect(result.href).not.toContain("/review");
  });
});

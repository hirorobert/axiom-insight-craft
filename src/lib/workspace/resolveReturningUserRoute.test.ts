import { describe, expect, it } from "vitest";
import { decideReturningUserRoute } from "./resolveReturningUserRoute";

interface E { companyId: string; periodYear: number; tag: string }
interface C { id: string; tag: string }

const e = (tag: string, companyId = tag): E => ({ companyId, periodYear: 2025, tag });
const c = (tag: string, id = tag): C => ({ id, tag });

describe("decideReturningUserRoute — the returning-user routing invariant: never guess among multiple engagements", () => {
  it("zero companies at all → first_run", () => {
    expect(decideReturningUserRoute<E, C>([], [])).toEqual({ kind: "first_run" });
  });

  it("exactly one open engagement → resume, regardless of dormant companies", () => {
    expect(decideReturningUserRoute<E, C>([e("e1")], [])).toEqual({ kind: "resume", entry: e("e1") });
  });

  it("one open engagement resumes directly even with ONE dormant company present", () => {
    expect(decideReturningUserRoute<E, C>([e("e1")], [c("c2")])).toEqual({ kind: "resume", entry: e("e1") });
  });

  it("one open engagement resumes directly even with MANY dormant companies present", () => {
    expect(decideReturningUserRoute<E, C>([e("e1")], [c("c2"), c("c3"), c("c4")])).toEqual({
      kind: "resume",
      entry: e("e1"),
    });
  });

  it("two open engagements → chooser, never a guess at either one", () => {
    expect(decideReturningUserRoute<E, C>([e("e1"), e("e2")], [])).toEqual({ kind: "chooser" });
  });

  it("many open engagements plus dormant companies → still chooser", () => {
    expect(decideReturningUserRoute<E, C>([e("e1"), e("e2"), e("e3")], [c("c4"), c("c5")])).toEqual({ kind: "chooser" });
  });

  it("zero open engagements, exactly one company → start_single_company", () => {
    expect(decideReturningUserRoute<E, C>([], [c("c1")])).toEqual({ kind: "start_single_company", company: c("c1") });
  });

  it("zero open engagements, more than one company → chooser, never guesses which company", () => {
    expect(decideReturningUserRoute<E, C>([], [c("c1"), c("c2")])).toEqual({ kind: "chooser" });
  });

  it("is a pure function: the same input always produces a deep-equal result", () => {
    const entries = [e("e1")];
    const companies = [c("c2")];
    const first = decideReturningUserRoute<E, C>(entries, companies);
    const second = decideReturningUserRoute<E, C>(entries, companies);
    expect(first).toEqual(second);
  });
});

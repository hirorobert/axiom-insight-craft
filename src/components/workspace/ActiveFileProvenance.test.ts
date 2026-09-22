import { describe, expect, it } from "vitest";
import { uploadStateLabel } from "./ActiveFileProvenance";

describe("uploadStateLabel — the 'state' shown alongside a trial balance's name, size and upload time", () => {
  it("maps every status process-trial-balance actually writes to a practitioner-facing word", () => {
    expect(uploadStateLabel("processing")).toBe("Processing");
    expect(uploadStateLabel("complete")).toBe("Complete");
    expect(uploadStateLabel("needs_review")).toBe("Needs review");
    expect(uploadStateLabel("error")).toBe("Error");
    expect(uploadStateLabel("blocked")).toBe("Blocked");
  });

  it("an unrecognised status is shown as-is rather than silently hidden", () => {
    expect(uploadStateLabel("some_future_status")).toBe("some_future_status");
  });

  it("a missing status is 'Unknown', never fabricated as a success state", () => {
    expect(uploadStateLabel(null)).toBe("Unknown");
    expect(uploadStateLabel(undefined)).toBe("Unknown");
  });
});

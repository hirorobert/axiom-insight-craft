import { describe, it, expect } from "vitest";
import { getAuthLinkError } from "@/components/AuthLinkErrorScreen";

describe("getAuthLinkError", () => {
  it("parses a consumed/expired confirmation-link fragment", () => {
    const result = getAuthLinkError(
      "#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired"
    );
    expect(result).toEqual({
      error: "access_denied",
      errorCode: "otp_expired",
      errorDescription: "Email link is invalid or has expired",
    });
  });

  it("returns null when there is no error fragment", () => {
    expect(getAuthLinkError("")).toBeNull();
    expect(getAuthLinkError("#access_token=abc&type=signup")).toBeNull();
  });

  it("parses other auth errors without an error code", () => {
    const result = getAuthLinkError("#error=server_error&error_description=Something+failed");
    expect(result?.error).toBe("server_error");
    expect(result?.errorCode).toBeNull();
  });
});

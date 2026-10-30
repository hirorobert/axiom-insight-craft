import { afterEach, describe, expect, it, vi } from "vitest";
import { Page } from "../../../scripts/browser-acceptance/cdp.mjs";

afterEach(() => vi.useRealTimers());
const point = (x = 10) => ({ x, y: 20, hit: true, disabled: false });
function driver(positions: unknown[]) {
  const send = vi.fn(async () => ({}));
  const locate = vi.fn();
  for (const p of positions) locate.mockResolvedValueOnce(p);
  const page = Object.assign(Object.create(Page.prototype), { send, locate });
  return { page, send, locate };
}

describe("native coordinate input safety", () => {
  it.each([null, { ...point(), disabled: true }, { ...point(), hit: false }])("does not press a disappeared, disabled or covered target after hover (%j)", async position => {
    vi.useFakeTimers();
    const { page, send } = driver([point(), position]);
    const pending = expect(page.click("#download")).rejects.toThrow(/disappeared|covered|disabled/);
    await vi.runAllTimersAsync(); await pending;
    expect(send.mock.calls.some(c => c[0] === "Input.dispatchMouseEvent" && c[1]?.type === "mousePressed")).toBe(false);
  });

  it("waits for a moving target, brings its page to front and sends one press/release at the final location", async () => {
    vi.useFakeTimers();
    const { page, send } = driver([point(10), point(30), point(60), point(60)]);
    const pending = page.click("#download");
    await vi.runAllTimersAsync(); await pending;
    expect(send.mock.calls[0][0]).toBe("Page.bringToFront");
    const native = send.mock.calls.filter(c => c[0] === "Input.dispatchMouseEvent").map(c => c[1]);
    expect(native.filter(p => p.type === "mousePressed")).toEqual([expect.objectContaining({ x: 60, y: 20, type: "mousePressed" })]);
    expect(native.filter(p => p.type === "mouseReleased")).toEqual([expect.objectContaining({ x: 60, y: 20, type: "mouseReleased" })]);
  });

  it("refuses a target that never settles, without sending any click", async () => {
    vi.useFakeTimers();
    const { page, send, locate } = driver([]);let x=0;
    locate.mockImplementation(async () => point(++x * 10));
    const pending = expect(page.click("#download", { timeout: 350 })).rejects.toThrow(/did not settle/);
    await vi.runAllTimersAsync(); await pending;
    expect(send.mock.calls.some(c => c[1]?.type === "mousePressed")).toBe(false);
  });
});

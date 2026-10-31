import { afterEach, describe, expect, it, vi } from "vitest";
import { Page } from "../../../scripts/browser-acceptance/cdp.mjs";

afterEach(() => vi.useRealTimers());
const point = (x = 10) => ({ x, y: 20, hit: true, disabled: false });
function driver(positions: unknown[]) {
  const send = vi.fn(async () => ({}));
  const locate = vi.fn(async (): Promise<unknown> => null);
  for (const p of positions) locate.mockResolvedValueOnce(p);
  const page = Object.assign(Object.create(Page.prototype), { send, locate, waitFor: vi.fn(async () => true) });
  return { page, send, locate };
}

describe("native coordinate input safety", () => {
  it("does not send mouse input until the foreground document reports focus", async () => {
    vi.useFakeTimers();
    const { page, send } = driver([point(), point()]);
    let focus!: () => void;
    page.waitFor = vi.fn(() => new Promise<void>(resolve => { focus=resolve; }));
    const pending=page.click("#download");
    await Promise.resolve();
    expect(send.mock.calls.some(c=>c[0]==="Input.dispatchMouseEvent")).toBe(false);
    focus();await vi.runAllTimersAsync();await pending;
    expect(send.mock.calls.filter(c=>c[1]?.type==="mousePressed")).toHaveLength(1);
  });
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

  it("waits through transient hover coverage without pressing until the target is stable and enabled", async () => {
    vi.useFakeTimers();
    const { page, send } = driver([point(10), { ...point(10), hit: false }, { ...point(30), disabled: true }, point(60), point(60)]);
    const pending = page.click("#download");
    await vi.runAllTimersAsync(); await pending;
    const pressed = send.mock.calls.filter(c => c[1]?.type === "mousePressed");
    expect(pressed).toHaveLength(1);
    expect(pressed[0][1]).toMatchObject({ x: 60, y: 20 });
  });
});

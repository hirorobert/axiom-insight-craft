// Test double for https://deno.land/std@0.168.0/http/server.ts: captures the handler instead of listening.
const g = globalThis as unknown as { __ptbHandler?: (req: Request) => Promise<Response> };
export function serve(handler: (req: Request) => Response | Promise<Response>): void {
  g.__ptbHandler = async (req) => await handler(req);
}
export function capturedHandler(): (req: Request) => Promise<Response> {
  if (!g.__ptbHandler) throw new Error("functionpath: handler not captured");
  return g.__ptbHandler;
}

import type { GuardedRequest } from "./qboReadOnlyGuard.ts";
/** Only idempotent Accounting GETs retry. Never retry a token POST, an import, or a vendor quota refusal. */
export async function boundedQboRead(fetcher: (r: GuardedRequest) => Promise<Response>, request: GuardedRequest,
  pause: (ms: number) => Promise<void> = ms => new Promise(r => setTimeout(r, ms))): Promise<{ status: number; text: string }> {
  if (request.method !== "GET" || request.body !== undefined) throw new Error("read_only_required");
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetcher(request);
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = []; let bytes = 0;
    if (reader) {
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          bytes += value.byteLength;
          if (bytes > 5_000_000) { await reader.cancel(); return { status: 413, text: "" }; }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
    }
    const raw = new Uint8Array(bytes); let offset = 0;
    for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.byteLength; }
    // 429 and 402 may be workspace-wide quota limits: no immediate retry and no invented remaining balance.
    if (res.status >= 500 && attempt === 0) { await pause(500); continue; }
    return { status: res.status, text: new TextDecoder().decode(raw) };
  }
  return { status: 503, text: "" };
}
/**
 * Request consistency (workbench F3). Pure.
 *
 * Every asynchronous read is bound to the context it was issued in (company · period · report version, see
 * context.ts contextKey) and to a monotonically increasing sequence number per channel. A response is applied only if
 * it is the newest one issued on its channel AND its context is still the active one. Anything else is discarded, so a
 * slow, older response can never overwrite newer screen state or restore an invalidated result.
 */
export interface RequestTicket {
  readonly channel: string;
  readonly seq: number;
  readonly contextKey: string;
}

export interface RequestGuard {
  /** Issue a ticket for a new request on `channel` in `contextKey`. */
  begin(channel: string, contextKey: string): RequestTicket;
  /** True only when `ticket` is the newest on its channel and was issued in `activeContextKey`. */
  accepts(ticket: RequestTicket, activeContextKey: string): boolean;
  /** Discarded responses so far (for diagnostics and tests). */
  readonly discarded: readonly RequestTicket[];
}

export function createRequestGuard(): RequestGuard {
  let seq = 0;
  const latest = new Map<string, number>();
  const discarded: RequestTicket[] = [];
  return {
    begin(channel, contextKey) {
      seq += 1;
      latest.set(channel, seq);
      return { channel, seq, contextKey };
    },
    accepts(ticket, activeContextKey) {
      const ok = latest.get(ticket.channel) === ticket.seq && ticket.contextKey === activeContextKey;
      if (!ok) discarded.push(ticket);
      return ok;
    },
    discarded,
  };
}

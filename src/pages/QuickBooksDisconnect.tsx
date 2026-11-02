import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import {
  disconnectQuickBooks,
  fetchConnections,
} from "@/lib/workspace/qboConnectorClient";
interface Connection {
  id: string;
  requestId?: string;
  company: string;
  environment: string;
  status: string;
}
/** Query parameters never authorize a disconnect. Every action uses a verified session and server capability checks. */
export default function QuickBooksDisconnect() {
  const [rows, setRows] = useState<Connection[]>([]);
  const [signedIn, setSignedIn] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const generation = useRef(0);
  const requests = useRef(new Map<string, string>());
  const refresh = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    let live = true;
    const invalidate = () => {
      generation.current++;
    };
    const load = async () => {
      const mine = ++generation.current;
      setRows([]);
      setLoading(true);
      setNotice(null);
      const { data, error } = await supabase.auth.getUser();
      if (!live || mine !== generation.current) return;
      setSignedIn(!error && !!data.user);
      if (error || !data.user) {
        setLoading(false);
        return;
      }
      const companies = await supabase.from("companies").select("id,name");
      if (!live || mine !== generation.current) return;
      if (companies.error) {
        setNotice("Company connections could not be loaded. Try again later.");
        setLoading(false);
        return;
      }
      const results = await Promise.all(
        (companies.data ?? []).map(async (company) => {
          const connections = await fetchConnections(
            supabase as never,
            company.id,
          );
          if (connections === null) throw new Error("status_unavailable");
          const { data: pending, error: pendingError } = await (
            supabase as unknown as {
              rpc(
                name: string,
                args: Record<string, unknown>,
              ): PromiseLike<{ data: unknown; error: unknown }>;
            }
          ).rpc("qbo_pending_disconnect", { p_company: company.id });
          if (pendingError) throw new Error("pending_status_unavailable");
          const result: Connection[] = connections
            .filter((c) => c.status !== "disconnected")
            .map((c) => ({
              id: c.id,
              company: company.name,
              environment: c.environment,
              status: c.status,
            }));
          if (pending && typeof pending === "object") {
            const operation = pending as {
              connectionId?: unknown;
              requestId?: unknown;
            };
            if (
              typeof operation.connectionId !== "string" ||
              typeof operation.requestId !== "string"
            )
              throw new Error("invalid_pending_identity");
            const connection = connections.find(
              (c) => c.id === operation.connectionId,
            );
            result.push({
              id: operation.connectionId,
              requestId: operation.requestId,
              company: company.name,
              environment: connection?.environment ?? "unknown",
              status: "revocation_pending",
            });
          }
          return result;
        }),
      ).catch(() => null);
      if (!live || mine !== generation.current) return;
      if (results === null)
        setNotice("Connection status could not be verified. Try again later.");
      else setRows(results.flat());
      setLoading(false);
    };
    refresh.current = load;
    void load();
    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event === "TOKEN_REFRESHED" || event === "INITIAL_SESSION") return;
      generation.current++;
      requests.current.clear();
      setRows([]);
      setSignedIn(false);
      setBusy(null);
      queueMicrotask(() => {
        if (live) void load();
      });
    });
    return () => {
      live = false;
      invalidate();
      data.subscription.unsubscribe();
    };
  }, []);
  const disconnect = async (id: string) => {
    if (busy) return;
    const mine = generation.current;
    setBusy(id);
    const selected = rows.find((row) => row.id === id);
    if (!selected) {
      setBusy(null);
      return;
    }
    const requestId =
      selected.requestId ?? requests.current.get(id) ?? crypto.randomUUID();
    requests.current.set(id, requestId);
    const result = await disconnectQuickBooks(supabase as never, id, requestId);
    if (mine !== generation.current) return;
    await refresh.current();
    if (generation.current !== mine + 1) return;
    if (result.confirmed) requests.current.delete(id);
    setNotice(
      result.confirmed
        ? "QuickBooks disconnected. Saved imports are unchanged."
        : result.outcome === "busy"
          ? "An import is running. Wait for it to finish, then retry disconnect."
          : result.outcome === "shared_connection"
            ? "Another workspace uses this QuickBooks company. An administrator must reconcile those connections before revoking shared access."
            : result.outcome === "local_only"
              ? "Imports are stopped. Remove CFOClose access in QuickBooks; upstream revocation is unverified."
              : "Removal of access is not confirmed. Retry the same disconnect request after a minute.",
    );
    setBusy(null);
  };
  return (
    <main className="mx-auto max-w-3xl space-y-5 px-6 py-16">
      <h1 className="text-2xl font-semibold">QuickBooks connections</h1>
      <p>
        If you removed CFOClose from QuickBooks, review the connection here.
        Previously imported files stay in your workspace.
      </p>
      <p>
        Opening this page does not change a connection or confirm that
        QuickBooks has removed access.
      </p>
      {loading ? (
        <p role="status">Checking connections…</p>
      ) : !signedIn ? (
        <Link
          to="/auth"
          className="inline-block rounded bg-primary px-5 py-3 text-primary-foreground"
        >
          Sign in to manage connections
        </Link>
      ) : (
        <>
          {rows.length === 0 && !notice && (
            <p>No connected QuickBooks companies were found.</p>
          )}
          {rows.map((row) => (
            <section
              key={row.id}
              className="space-y-3 rounded border border-border p-4"
            >
              <h2 className="font-semibold">{row.company}</h2>
              <p>
                {row.environment === "sandbox"
                  ? "Sandbox test connection"
                  : row.environment === "production"
                    ? "Production connection"
                    : "QuickBooks connection"}{" "}
                ·{" "}
                {row.status === "revocation_pending"
                  ? "Removal of access awaiting confirmation"
                  : row.status === "active"
                    ? "Connected"
                    : "Reconnect needed"}
              </p>
              <Button
                variant="outline"
                disabled={busy !== null}
                onClick={() => void disconnect(row.id)}
              >
                {busy === row.id
                  ? "Disconnecting…"
                  : row.status === "revocation_pending"
                    ? "Retry disconnect"
                    : "Disconnect QuickBooks"}
              </Button>
            </section>
          ))}
        </>
      )}
      {notice && <p role="status">{notice}</p>}
      <Link to="/dashboard" className="inline-block underline">
        Back to your companies
      </Link>
    </main>
  );
}

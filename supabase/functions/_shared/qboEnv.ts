/**
 * qboEnv — reads the connector's configuration from the Edge Function environment. A pure function of a name -> value getter, so it is unit-tested in
 * Node without a runtime. Nothing here logs, and a missing or malformed value yields null (the function then answers "not configured"), never a default.
 *
 *   QBO_CLIENT_ID_SANDBOX / QBO_CLIENT_SECRET_SANDBOX       the development app's credentials (Keys & OAuth, Development)
 *   QBO_CLIENT_ID_PRODUCTION / QBO_CLIENT_SECRET_PRODUCTION the production app's credentials (set only once Intuit has approved production access)
 *   QBO_REDIRECT_URI    the https address of the qbo-oauth-callback function, registered with Intuit for the app
 *   QBO_APP_URL         the https origin of this application (where the browser is sent back, with a status word only)
 *   QBO_TOKEN_KEY_ID / QBO_TOKEN_KEY_B64            the CURRENT envelope key (exactly 32 bytes, base64); new tokens are sealed with it
 *   QBO_TOKEN_KEY_PREV_ID / QBO_TOKEN_KEY_PREV_B64  an optional PREVIOUS key, kept only while old envelopes are still being re-sealed (rotation)
 *   QBO_TOKEN_KEY_NEXT_ID / QBO_TOKEN_KEY_NEXT_B64  an optional NEXT key (rotation WITHOUT re-entering the current key): when BOTH are set it
 *                       becomes the sealing key and QBO_TOKEN_KEY_ID / _B64 stays in the ring as an opening-only key, so envelopes sealed with it
 *                       still open until qbo-realm-protect "reseal" has re-sealed every live row. A half-configured pair (one of the two) is
 *                       refused (not configured), never ignored. Its id and bytes must differ from every other key's.
 *   QBO_REALM_INDEX_KEY_ID / QBO_REALM_INDEX_KEY_B64  the realmID INDEX key (exactly 32 bytes, base64; its own key, never a token key): the keyed
 *                       equality index of a QuickBooks company (qboRealmProtection.ts). Without it no function that stores a realm runs.
 *   QBO_REALM_INDEX_KEY_NEXT_ID / QBO_REALM_INDEX_KEY_NEXT_B64  an optional NEXT index key (index-key rotation, 20261230500000): when BOTH are
 *                       set it computes every new index, and the configured index key stays only to RECOGNISE indexes it made, until
 *                       qbo-realm-protect "reindex" has moved every live row. A half-configured pair is refused (not configured), never
 *                       ignored. Its id and bytes must differ from the configured index key's and from every token key's.
 *   QBO_MINOR_VERSION   the API minor version to ask for (default 75, the one the recorded samples were requested with)
 */
import { keyFromBase64, type EnvelopeKey } from "./qboTokenEnvelope.ts";
import type { QboEnvironment } from "./qboReadOnlyGuard.ts";
import type { RealmKeys } from "./qboRealmProtection.ts";

type Get = (name: string) => string | undefined;
const present = (v: string | undefined): v is string => typeof v === "string" && v.trim() !== "";

export interface QboEnvConfig {
  oauth(environment: QboEnvironment): { clientId: string; redirectUri: string } | null;
  credentials(environment: QboEnvironment): { clientId: string; clientSecret: string } | null;
  revocationCredentials(environment: QboEnvironment): { clientId: string; clientSecret: string } | null;
  keys(): { current: EnvelopeKey; all: EnvelopeKey[] } | null;
  /** The token key ring plus the separate realm index key; null unless BOTH are configured and the index key is not a token key. */
  realmKeys(): RealmKeys | null;
  appUrl(): string | null;
  minorVersion: number;
}

export function readQboEnv(get: Get): QboEnvConfig {
  const upper = (e: QboEnvironment) => e.toUpperCase();
  const revocationCredentials = (e: QboEnvironment) => {
    const id = get(`QBO_CLIENT_ID_${upper(e)}`), secret = get(`QBO_CLIENT_SECRET_${upper(e)}`);
    if (e === "production" && (id?.trim() === get("QBO_CLIENT_ID_SANDBOX")?.trim() || secret?.trim() === get("QBO_CLIENT_SECRET_SANDBOX")?.trim())) return null;
    return present(id) && present(secret) ? { clientId: id.trim(), clientSecret: secret.trim() } : null;
  };
  const credentials = (e: QboEnvironment) => e === "production" && get("QBO_PRODUCTION_APPROVED") !== "true" ? null : revocationCredentials(e);
  const redirect = get("QBO_REDIRECT_URI");
  const redirectUri = present(redirect) && /^https:\/\/[^\s?#]+$/.test(redirect.trim()) ? redirect.trim() : null;
  const app = get("QBO_APP_URL");
  const appUrl = present(app) && /^https:\/\/[^\s?#]+$/.test(app.trim()) ? app.trim().replace(/\/+$/, "") : null;
  const mv = Number(get("QBO_MINOR_VERSION") ?? "75");
  const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
  const keys = () => {
    try {
      const id = get("QBO_TOKEN_KEY_ID"), b64 = get("QBO_TOKEN_KEY_B64");
      if (!present(id) || !present(b64)) return null;
      const configured = keyFromBase64(id.trim(), b64);
      let current = configured;
      const all = [configured];
      const nid = get("QBO_TOKEN_KEY_NEXT_ID"), nb64 = get("QBO_TOKEN_KEY_NEXT_B64");
      if (present(nid) !== present(nb64)) return null; // half a key pair is a configuration error, never silently ignored
      if (present(nid) && present(nb64)) {
        current = keyFromBase64(nid.trim(), nb64); // seals from now on; the configured key only opens what it sealed
        all.unshift(current);
      }
      const pid = get("QBO_TOKEN_KEY_PREV_ID"), pb64 = get("QBO_TOKEN_KEY_PREV_B64");
      if (present(pid) && present(pb64)) all.push(keyFromBase64(pid.trim(), pb64));
      // Every key in the ring has its own name and its own bytes (a name chooses the key that opens an envelope).
      if (new Set(all.map((k) => k.id)).size !== all.length) return null;
      if (all.some((a, i) => all.some((b, j) => i < j && sameBytes(a.bytes, b.bytes)))) return null;
      return { current, all };
    } catch { return null; }
  };
  const realmKeys = (): RealmKeys | null => {
    const ring = keys();
    const id = get("QBO_REALM_INDEX_KEY_ID"), b64 = get("QBO_REALM_INDEX_KEY_B64");
    if (!ring || !present(id) || !present(b64)) return null;
    try {
      const configured = keyFromBase64(id.trim(), b64);
      const nid = get("QBO_REALM_INDEX_KEY_NEXT_ID"), nb64 = get("QBO_REALM_INDEX_KEY_NEXT_B64");
      if (present(nid) !== present(nb64)) return null; // half an index key pair is a configuration error, never silently ignored
      const index = present(nid) && present(nb64) ? keyFromBase64(nid.trim(), nb64) : configured;
      const indexAll = index === configured ? [configured] : [index, configured];
      // Its own keys: never a token key's name or bytes (rotating the token key must never change equality, and one leaked key must not open
      // both), and the two index keys never share a name or bytes (a name chooses the key that recognises an index).
      if (indexAll.some((x) => ring.all.some((k) => k.id === x.id || sameBytes(k.bytes, x.bytes)))) return null;
      if (indexAll.length === 2 && (indexAll[0].id === indexAll[1].id || sameBytes(indexAll[0].bytes, indexAll[1].bytes))) return null;
      return { current: ring.current, all: ring.all, index, indexAll };
    } catch { return null; }
  };
  return {
    credentials,
    revocationCredentials,
    oauth: (e) => { const c = credentials(e); return c && redirectUri ? { clientId: c.clientId, redirectUri } : null; },
    keys,
    realmKeys,
    appUrl: () => appUrl,
    minorVersion: Number.isInteger(mv) && mv >= 0 && mv <= 999 ? mv : 75,
  };
}

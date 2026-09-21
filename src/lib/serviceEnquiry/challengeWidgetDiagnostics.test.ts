// Regression tests for the Turnstile widget failure on the controlled preview ("Unable to connect to website" in the widget,
// "The security check could not be loaded" from the app). The widget used to DISCARD Cloudflare's client error code and showed
// one generic "check your connection" line for every cause, including configuration causes, and a failure banner could
// outlive a widget that then solved. These tests pin: the code is preserved and sanitised, the message names the kind of
// failure, a solve clears a stale failure, and everything that could otherwise explain the failure is verified from source —
// the script URL, single loading, the site key format, the action/hostname contract and the absence of blocking headers.
// Nothing here reaches the network, and the form still refuses to send whenever the widget has failed (fail closed).

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHALLENGE_ACTION,
  TURNSTILE_SCRIPT_URL,
  WIDGET_INITIAL,
  challengeErrorCodeFromThrown,
  classifyChallengeError,
  challengeState,
  readSiteKey,
  sanitizeChallengeErrorCode,
  widgetReducer,
  type WidgetState,
} from "./challenge";
import { ENQUIRY_FORM_COPY } from "./copy";
import { resolveChallengeConfig } from "../../../supabase/functions/_shared/serviceEnquiryChallenge";

const ROOT = path.resolve(__dirname, "../../..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("the client error code is preserved, sanitised and never a leak", () => {
  it("keeps a plain numeric Cloudflare code, from a string or a number", () => {
    for (const c of ["110200", "110100", "110110", "200500", "300030", "600010", "400070", "102"]) expect(sanitizeChallengeErrorCode(c), c).toBe(c);
    expect(sanitizeChallengeErrorCode(110200)).toBe("110200");
    expect(sanitizeChallengeErrorCode("  110200 ")).toBe("110200");
  });

  it("drops anything that is not a plain code — a token, a key, a URL, an object, an oversized string", () => {
    const token = "0.AbCdEf_token-value.SECRET";
    const siteKey = "0x4AAAAAAE--3Vt-EC18NRJm";
    for (const bad of [token, siteKey, "110200 https://evil.example", "https://x.example/110200", "1102000", "12", "", "  ", null, undefined, {}, [], true, "110200\n<script>", "1e5"]) {
      expect(sanitizeChallengeErrorCode(bad), String(bad)).toBeNull();
    }
  });

  it("recovers the code from a TurnstileError thrown by render(), and from nothing else", () => {
    expect(challengeErrorCodeFromThrown(new Error("[Cloudflare Turnstile] Error: 110200."))).toBe("110200");
    expect(challengeErrorCodeFromThrown(new Error("[Cloudflare Turnstile] Error: 110100"))).toBe("110100");
    expect(challengeErrorCodeFromThrown("Error 300030 occurred")).toBe("300030");
    for (const none of [new Error("turnstile_load_failed"), new Error("turnstile_missing"), null, undefined, 5, {}, "12345", "1234567"]) expect(challengeErrorCodeFromThrown(none), String(none)).toBeNull();
  });

  it("classifies the documented codes by KIND, and treats anything else as unknown", () => {
    for (const c of ["110100", "110110", "110200", "400020", "400070"]) expect(classifyChallengeError(c), c).toBe("configuration");
    for (const c of ["110600", "110620", "200100"]) expect(classifyChallengeError(c), c).toBe("expired");
    expect(classifyChallengeError("200500")).toBe("blocked");
    for (const c of ["300030", "300010", "600010", "600020"]) expect(classifyChallengeError(c), c).toBe("challenge");
    for (const c of [null, "102", "999999", "123456"]) expect(classifyChallengeError(c as string | null), String(c)).toBe("unknown");
  });

  it("there is a message for every kind, none blames the connection for a configuration error, and none implies success", () => {
    const kinds = Object.keys(ENQUIRY_FORM_COPY.challengeFailureByKind).sort();
    expect(kinds).toEqual(["blocked", "challenge", "configuration", "expired", "unknown"]);
    expect(ENQUIRY_FORM_COPY.challengeFailureByKind.configuration).not.toMatch(/connection/i);
    expect(ENQUIRY_FORM_COPY.challengeFailureByKind.blocked).toMatch(/challenges\.cloudflare\.com/);
    for (const [k, msg] of Object.entries(ENQUIRY_FORM_COPY.challengeFailureByKind)) expect(msg, k).not.toMatch(/succe(ss|eded)|passed|verified/i);
  });
});

describe("the widget state machine keeps the code and never leaves a stale failure behind", () => {
  const run = (events: Parameters<typeof widgetReducer>[1][], from: WidgetState = WIDGET_INITIAL) => events.reduce(widgetReducer, from);

  it("starts loading with no error, renders to ready, and re-enters loading on a reset", () => {
    expect(WIDGET_INITIAL).toEqual({ phase: "loading", errorCode: null });
    expect(run([{ type: "rendered" }])).toEqual({ phase: "ready", errorCode: null });
    expect(run([{ type: "error", code: "110200" }, { type: "loading" }])).toEqual({ phase: "loading", errorCode: null });
  });

  it("an error keeps Cloudflare's code (or null when it was not a plain code)", () => {
    expect(run([{ type: "rendered" }, { type: "error", code: "110200" }])).toEqual({ phase: "failed", errorCode: "110200" });
    expect(run([{ type: "error", code: null }])).toEqual({ phase: "failed", errorCode: null });
  });

  it("'rendered' arriving after an error does not hide the failure (the error callback can fire during render)", () => {
    expect(run([{ type: "error", code: "110100" }, { type: "rendered" }])).toEqual({ phase: "failed", errorCode: "110100" });
  });

  it("a later SOLVE clears an earlier failure — Turnstile's automatic retry can recover", () => {
    expect(run([{ type: "rendered" }, { type: "error", code: "300030" }, { type: "solved" }])).toEqual({ phase: "ready", errorCode: null });
  });

  it("the state never contains anything but a phase and a numeric code (there is no room for a token)", () => {
    const s = run([{ type: "rendered" }, { type: "error", code: sanitizeChallengeErrorCode("token.with.dots") }]);
    expect(Object.keys(s).sort()).toEqual(["errorCode", "phase"]);
    expect(s.errorCode).toBeNull();
  });
});

describe("the widget component reports the code safely and stays fail-closed", () => {
  const widget = code("src/components/enquiry/ChallengeWidget.tsx");

  it("its error callback RECEIVES the code, sanitises it, clears the token and reports only the sanitised value", () => {
    expect(widget).toMatch(/"error-callback": \(code: unknown\) => \{[\s\S]*?sanitizeChallengeErrorCode\(code\)[\s\S]*?onTokenRef\.current\(null\)[\s\S]*?dispatch\(\{ type: "error", code: safe \}\)/);
    expect(widget).toMatch(/\.catch\(\(thrown: unknown\) => \{[\s\S]*?challengeErrorCodeFromThrown\(thrown\)/);
  });

  it("every console call and rendered value uses the sanitised code — never a token, key, error object or raw callback argument", () => {
    const consoleCalls = widget.split("\n").filter((l) => /console\./.test(l));
    expect(consoleCalls.length).toBe(2);
    for (const l of consoleCalls) {
      expect(l, l).toMatch(/safe \?\? "unrecognised"/);
      expect(l, l).not.toMatch(/token|siteKey|thrown\b(?!\))|code\b(?!,)/);
    }
    expect(widget).not.toMatch(/console\.(log|error|info|debug)/);
    expect(widget).not.toMatch(/JSON\.stringify|\.message|\.stack/);
    expect(widget).toMatch(/widget\.errorCode/);
  });

  it("a solve clears a stale failure, and a failed widget always reports an empty token", () => {
    expect(widget).toMatch(/if \(!cancelled && usable\) dispatch\(\{ type: "solved" \}\)/);
    expect(widget).toMatch(/onTokenRef\.current\(usable\)/);
    expect((widget.match(/onTokenRef\.current\(null\)/g) ?? []).length).toBeGreaterThanOrEqual(3); // start, expired, error
  });

  it("the failure message is chosen by kind and shows the reference code; the widget renders exactly once per (siteKey, resetKey)", () => {
    expect(widget).toMatch(/challengeFailureByKind\[classifyChallengeError\(widget\.errorCode\)\]/);
    expect(widget).toMatch(/challengeReference/);
    expect(widget).toMatch(/\}, \[siteKey, resetKey\]\);/);
    expect((widget.match(/\.render\(/g) ?? []).length).toBe(1);
    expect(widget).toMatch(/return \(\) => \{[\s\S]*?cancelled = true;[\s\S]*?api\.remove\(widgetId\)/); // no stale widget instance survives a re-render
  });
});

describe("the script is the official one, loaded exactly once", () => {
  it("is Cloudflare's official explicit-render URL — nothing else is ever loaded", () => {
    expect(TURNSTILE_SCRIPT_URL).toBe("https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit");
    for (const f of ["src/lib/serviceEnquiry/challenge.ts", "src/components/enquiry/ChallengeWidget.tsx", "index.html"]) {
      const urls = [...read(f).matchAll(/https?:\/\/[^\s"'`)]+/g)].map((m) => m[0]).filter((u) => /cloudflare|turnstile/i.test(u));
      for (const u of urls) expect(u, f).toMatch(/^https:\/\/challenges\.cloudflare\.com\/turnstile\/v0\/api\.js(\?render=explicit)?$|^https:\/\/challenges\.cloudflare\.com\/turnstile\/v0\/siteverify$/);
    }
    expect(read("index.html")).not.toMatch(/turnstile|challenges\.cloudflare\.com/i); // never a second, static tag
  });

  function fakeDom() {
    const appended: { src: string; onload?: () => void; onerror?: () => void }[] = [];
    const win: { turnstile?: unknown } = {};
    vi.stubGlobal("window", win);
    vi.stubGlobal("document", {
      createElement: () => {
        const el: { src: string; onload?: () => void; onerror?: () => void; async?: boolean; defer?: boolean } = { src: "" };
        return el;
      },
      head: { appendChild: (el: (typeof appended)[number]) => appended.push(el) },
    });
    return { appended, win };
  }

  it("concurrent callers share ONE script tag and resolve with the same API object", async () => {
    const { appended, win } = fakeDom();
    const { loadTurnstile } = await import("./challenge");
    const api = { render: vi.fn(), remove: vi.fn() };
    const a = loadTurnstile();
    const b = loadTurnstile();
    const c = loadTurnstile();
    expect(appended).toHaveLength(1);
    expect(appended[0].src).toBe(TURNSTILE_SCRIPT_URL);
    win.turnstile = api;
    appended[0].onload?.();
    expect(await Promise.all([a, b, c])).toEqual([api, api, api]);
    expect(await loadTurnstile()).toBe(api); // later callers reuse window.turnstile: no second tag
    expect(appended).toHaveLength(1);
  });

  it("a failed load rejects every waiter, then a retry creates ONE new tag (no permanent poison, no duplicates)", async () => {
    const { appended } = fakeDom();
    const { loadTurnstile } = await import("./challenge");
    const first = loadTurnstile();
    const second = loadTurnstile();
    expect(appended).toHaveLength(1);
    appended[0].onerror?.();
    await expect(first).rejects.toThrow("turnstile_load_failed");
    await expect(second).rejects.toThrow("turnstile_load_failed");
    const retry = loadTurnstile();
    expect(appended).toHaveLength(2);
    retry.catch(() => undefined);
  });

  it("a script that loads without defining window.turnstile is a rejected load, not a hang", async () => {
    const { appended } = fakeDom();
    const { loadTurnstile } = await import("./challenge");
    const p = loadTurnstile();
    appended[0].onload?.();
    await expect(p).rejects.toThrow("turnstile_missing");
  });

  it("only the enquiry widget loads Turnstile: one loader, one render call site in the whole source tree", () => {
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    const files = walk(path.join(ROOT, "src")).filter((p) => /\.(ts|tsx)$/.test(p) && !/\.test\.tsx?$/.test(p));
    const loaders = files.filter((f) => /createElement\(["']script["']\)/.test(fs.readFileSync(f, "utf8")) && /turnstile/i.test(fs.readFileSync(f, "utf8"))).map((f) => path.relative(ROOT, f).split(path.sep).join("/"));
    expect(loaders).toEqual(["src/lib/serviceEnquiry/challenge.ts"]);
    const renderers = files.filter((f) => /turnstile.*\.render\(|\bt\.render\(/.test(fs.readFileSync(f, "utf8"))).map((f) => path.relative(ROOT, f).split(path.sep).join("/"));
    expect(renderers).toEqual(["src/components/enquiry/ChallengeWidget.tsx"]);
  });
});

describe("the site key compiled into the build is well-formed and defined exactly once", () => {
  const envFiles = fs.readdirSync(ROOT).filter((n) => /^\.env(\..+)?$/.test(n) && !/\.example$/.test(n));
  const keyLines = envFiles.flatMap((f) => read(f).split(/\r?\n/).filter((l) => /^VITE_TURNSTILE_SITE_KEY=/.test(l)).map((l) => ({ file: f, value: l.slice("VITE_TURNSTILE_SITE_KEY=".length) })));

  it("the committed value is a real-format key: no quotes, spaces, hidden or non-ASCII characters, and not a Cloudflare test key", () => {
    expect(keyLines.length).toBeGreaterThanOrEqual(1);
    for (const { file, value } of keyLines) {
      expect(value, file).toMatch(/^[0-9A-Za-z_-]{20,40}$/);
      expect(value.startsWith("0x4"), file).toBe(true); // Cloudflare's production key prefix
      expect(value, file).not.toMatch(/^[123]x0{6,}/); // never a documented test/dummy key
      expect([...value].every((c) => c.charCodeAt(0) > 32 && c.charCodeAt(0) < 127), file).toBe(true);
      expect(readSiteKey(value), file).toBe(value); // the app accepts it verbatim (no trimming or rewriting changes it)
    }
  });

  it("every env file that defines it defines the SAME value (no build can pick a different key)", () => {
    expect(new Set(keyLines.map((k) => k.value)).size).toBe(1);
  });

  it("the site key is read in exactly one place, and the secret key never appears in browser source", () => {
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    const src = walk(path.join(ROOT, "src")).filter((p) => /\.(ts|tsx)$/.test(p) && !/\.test\.tsx?$/.test(p));
    expect(src.filter((f) => /VITE_TURNSTILE_SITE_KEY/.test(fs.readFileSync(f, "utf8"))).map((f) => path.relative(ROOT, f).split(path.sep).join("/"))).toEqual(["src/lib/serviceEnquiry/challenge.ts"]);
    for (const f of src) expect(fs.readFileSync(f, "utf8"), f).not.toMatch(/TURNSTILE_SECRET_KEY/);
    for (const { file } of keyLines) expect(read(file), file).not.toMatch(/TURNSTILE_SECRET/);
  });

  it("a key with a stray character (quote, space, control) never reaches the widget: the form refuses instead", () => {
    for (const bad of ['"0x4AAAAAAE--3Vt-EC18NRJm"', "0x4AAAAAAE 3Vt", "0x4AAAAAAE" + String.fromCharCode(8203) + "3Vt-EC18NRJm", "0x4AAAAAAE--3Vt-EC18NRJm\r", "", "'0x4AAAAAAE--3Vt-EC18NRJm'"]) {
      const k = readSiteKey(bad);
      if (k !== null) expect(k, JSON.stringify(bad)).toBe(bad.trim()); // only trailing whitespace is tolerated, and it is removed
      if (new RegExp("[\"'" + String.fromCharCode(8203) + "]").test(bad) || bad === "") expect(k, JSON.stringify(bad)).toBeNull();
    }
    expect(challengeState({ signedIn: false, forced: false, siteKey: readSiteKey('"0x4AAAAAAE--3Vt-EC18NRJm"') })).toBe("unavailable");
  });
});

describe("the frontend and backend agree on the widget action, and on what a hostname is", () => {
  it("ONE constant is the action: the widget renders it and the server verifies against it, and it is a valid Turnstile action", () => {
    expect(CHALLENGE_ACTION).toBe("service_enquiry");
    expect(CHALLENGE_ACTION).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
    expect(code("src/components/enquiry/ChallengeWidget.tsx")).toMatch(/action: CHALLENGE_ACTION,/);
    const server = code("supabase/functions/_shared/serviceEnquiryChallenge.ts");
    expect(server).toMatch(/import \{ CHALLENGE_ACTION \} from "\.\/serviceEnquiryContract\.ts";/);
    expect(server).toMatch(/b\.action !== CHALLENGE_ACTION/);
    const contractDefs = [...read("supabase/functions/_shared/serviceEnquiryContract.ts").matchAll(/CHALLENGE_ACTION\s*=\s*"([^"]+)"/g)];
    expect(contractDefs.map((m) => m[1])).toEqual([CHALLENGE_ACTION]); // defined once, nowhere else
    expect(read("src/lib/serviceEnquiry/contract.ts")).toMatch(/export \* from "\.\.\/\.\.\/\.\.\/supabase\/functions\/_shared\/serviceEnquiryContract"/);
  });

  it("the frontend passes NO hostname: the server compares the hostname Cloudflare reports with the configured list", () => {
    expect(code("src/components/enquiry/ChallengeWidget.tsx")).not.toMatch(/hostname|location/i);
    expect(code("src/lib/serviceEnquiry/challenge.ts")).not.toMatch(/window\.location|location\.hostname/);
  });

  // The hostnames named in the diagnosis request, character for character.
  const PREVIEW_HOST = "id-preview--e7cc5596-c434-423c-b1bd-49383335f2fe.lovable.app";
  const HOSTS = ["cfoclose.com", "www.cfoclose.com", PREVIEW_HOST, "tbcommand.lovable.app"];
  const BARE_HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

  it("each named hostname is a bare, lower-case ASCII hostname: no protocol, path, port, trailing dot, space or hidden character", () => {
    for (const h of HOSTS) {
      expect(h, h).toMatch(BARE_HOSTNAME);
      expect([...h].every((c) => c.charCodeAt(0) > 32 && c.charCodeAt(0) < 127), h).toBe(true);
      expect(h, h).not.toMatch(/[:/?#@\s]|\.$|^https?/i);
      expect(new URL(`https://${h}/`).hostname, h).toBe(h); // the browser's own parse yields exactly the same string
    }
    expect(PREVIEW_HOST.split(".")[0]).toBe("id-preview--e7cc5596-c434-423c-b1bd-49383335f2fe");
    expect(PREVIEW_HOST.split(".")[0].length).toBeLessThanOrEqual(63); // a DNS label limit
  });

  it("the server matches those hostnames exactly (case-insensitively) and refuses a decorated entry rather than guessing", () => {
    const env = (v: string) => ({ get: (n: string) => ({ SUPABASE_URL: "https://abcdefghijklmnop.supabase.co", TURNSTILE_SECRET_KEY: "0x4AAAAAAA_this_is_a_server_secret_value_9f3c", TURNSTILE_EXPECTED_HOSTNAMES: v })[n] });
    const ok = resolveChallengeConfig(env(HOSTS.join(", ")));
    expect(ok.mode === "turnstile" && ok.expectedHostnames).toEqual(HOSTS);
    const upper = resolveChallengeConfig(env(HOSTS.map((h) => h.toUpperCase()).join(",")));
    expect(upper.mode === "turnstile" && upper.expectedHostnames).toEqual(HOSTS);
    // A decorated value is kept verbatim, so it can never equal Cloudflare's bare hostname: fail-closed, and visible in the tests.
    const decorated = resolveChallengeConfig(env(`https://${PREVIEW_HOST}/, ${PREVIEW_HOST}:443, ${PREVIEW_HOST}.`));
    expect(decorated.mode === "turnstile" && decorated.expectedHostnames.every((h) => !HOSTS.includes(h))).toBe(true);
  });
});

describe("nothing in the repository can block Turnstile, and a failed widget cannot spend server state", () => {
  it("the app sets no Content-Security-Policy, Permissions-Policy, Referrer-Policy, COOP/COEP/CORP or frame header anywhere it ships", () => {
    const blockers = /Content-Security-Policy|Permissions-Policy|Referrer-Policy|Cross-Origin-(Opener|Embedder|Resource)-Policy|X-Frame-Options|frame-ancestors|http-equiv|name="referrer"|sandbox=/i;
    for (const f of ["index.html", "vite.config.ts"]) expect(read(f), f).not.toMatch(blockers);
    for (const f of ["_headers", "public/_headers", "vercel.json", "netlify.toml", "public/_redirects", "wrangler.toml", "nginx.conf"]) expect(fs.existsSync(path.join(ROOT, f)), f).toBe(false);
    for (const f of ["src/components/enquiry/ChallengeWidget.tsx", "src/lib/serviceEnquiry/challenge.ts", "src/components/enquiry/ServiceEnquiryForm.tsx"]) expect(read(f), f).not.toMatch(/referrerPolicy|sandbox|setAttribute\(["']allow/i);
  });

  it("the widget mounts in a plain container: not inside an <iframe>, not behind an overlay that could block it", () => {
    expect(code("src/components/enquiry/ChallengeWidget.tsx")).not.toMatch(/<iframe|createPortal|aria-hidden|display:\s*none|"hidden"/);
  });

  const form = code("src/components/enquiry/ServiceEnquiryForm.tsx");
  it("a failed or unsolved widget returns BEFORE any fingerprint, idempotency key, attempt record or network call", () => {
    const gate = form.indexOf('challenge === "required" && !challengeToken');
    expect(gate).toBeGreaterThan(-1);
    for (const later of ["requestFingerprint(check.normalized)", "resolveAttempt(", "saveAttempt(formKey, attempt)", "submitServiceEnquiry("]) {
      expect(form.indexOf(later), later).toBeGreaterThan(gate);
    }
    expect(form).toMatch(/challenge === "unavailable"[\s\S]*?return;/);
    expect(form).toMatch(/challenge === "required" && !challengeToken[\s\S]*?setNotice\(ENQUIRY_FORM_COPY\.challengeIncomplete\);\s*return;/);
  });

  it("the submit call can only carry a token that the widget produced, and a failed widget always empties it", () => {
    expect(form).toMatch(/challenge === "required" \? challengeToken : null/);
    expect(form).toMatch(/onToken=\{setChallengeToken\}/);
    expect(code("src/components/enquiry/ChallengeWidget.tsx")).toMatch(/"error-callback"[\s\S]*?onTokenRef\.current\(null\)/);
  });

  it("the signed-in exemption is decided by the SERVER: the browser only chooses whether to SHOW the widget", () => {
    expect(challengeState({ signedIn: true, forced: false, siteKey: null })).toBe("not_needed");
    expect(challengeState({ signedIn: true, forced: true, siteKey: "0x4AAAAAAE--3Vt-EC18NRJm" })).toBe("required"); // a session the server refused
    const handler = code("supabase/functions/_shared/serviceEnquiryHandler.ts");
    expect(handler).toMatch(/userId = await deps\.verifyUserId\(token\)/);
    expect(handler).toMatch(/if \(userId === null\) \{[\s\S]*?deps\.challenge\.verify\(extractChallengeToken\(parsed\)\)/);
    expect(code("src/lib/serviceEnquiry/client.ts")).not.toMatch(/skip|bypass|signedIn|isAuthenticated/i); // the client sends what the widget produced; it never decides to skip
  });
});

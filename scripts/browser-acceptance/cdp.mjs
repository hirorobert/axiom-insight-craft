// A minimal, dependency-free Chrome DevTools Protocol driver for the staging browser-acceptance suite (PR #32).
//
// Why not Playwright/Puppeteer: this branch may not add a package.json dependency (pinned by
// src/lib/financialStatementsWorkspace/databaseInert.test.ts) and bun.lock must stay the only lockfile. Chrome is
// preinstalled on GitHub's Ubuntu runners, and CDP over --remote-debugging-pipe needs nothing but Node's own
// child_process: messages are JSON, NUL-terminated, written to fd 3 and read from fd 4.
//
// Scope is deliberately small: isolated browser contexts (separate cookies/storage per test user), navigation, DOM
// queries through Runtime.evaluate, real mouse/keyboard input, file inputs, viewports, screenshots, and a record of
// every network request (used to prove no request reaches production).

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function findChrome(env = process.env) {
  const candidates = [
    env.CHROME_PATH,
    "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser",
    "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter(Boolean);
  const found = candidates.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
  if (!found) throw new Error("No Chrome/Chromium executable found (set CHROME_PATH)");
  return found;
}

export class Browser {
  static async launch({ executablePath = findChrome(), headless = true } = {}) {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cfoclose-browser-"));
    const args = [
      "--remote-debugging-pipe", `--user-data-dir=${userDataDir}`, "--no-first-run", "--no-default-browser-check",
      "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-extensions",
      "--disable-features=Translate,MediaRouter", "--hide-scrollbars", "--mute-audio", "--password-store=basic",
      ...(headless ? ["--headless=new"] : []), ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []), "about:blank",
    ];
    const proc = spawn(executablePath, args, { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
    const b = new Browser(proc, userDataDir);
    await b.send("Target.setDiscoverTargets", { discover: false });
    return b;
  }

  constructor(proc, userDataDir) {
    this.proc = proc;
    this.userDataDir = userDataDir;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.writer = proc.stdio[3];
    let buf = "";
    proc.stdio[4].on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let i;
      while ((i = buf.indexOf("\0")) >= 0) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let msg;
        try { msg = JSON.parse(raw); } catch { continue; }
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve, reject, method } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
          else resolve(msg.result);
        } else if (msg.method) {
          for (const l of this.listeners) l(msg);
        }
      }
    });
    proc.on("exit", () => { for (const { reject, method } of this.pending.values()) reject(new Error(`browser exited during ${method}`)); this.pending.clear(); });
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const msg = { id, method, params, ...(sessionId ? { sessionId } : {}) };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.writer.write(JSON.stringify(msg) + "\0");
    });
  }

  /** A fresh, isolated context: its own cookies, localStorage and cache. One per test identity. */
  async newContext() {
    const { browserContextId } = await this.send("Target.createBrowserContext", { disposeOnDetach: true });
    return { browserContextId, newPage: () => this.newPage(browserContextId) };
  }

  async newPage(browserContextId) {
    const { targetId } = await this.send("Target.createTarget", { url: "about:blank", browserContextId });
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
    const page = new Page(this, sessionId, targetId);
    await page.init();
    return page;
  }

  async close() {
    try { await this.send("Browser.close"); } catch { /* already gone */ }
    await sleep(300);
    try { this.proc.kill("SIGKILL"); } catch { /* ignore */ }
    try { fs.rmSync(this.userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

export class Page {
  constructor(browser, sessionId, targetId) {
    this.browser = browser;
    this.sessionId = sessionId;
    this.targetId = targetId;
    this.requests = [];   // every request URL this page issued (including WebSockets)
    this.responses = [];  // { url, status, method }
    this.methods = new Map();
    this.consoleErrors = [];
    this.loadWaiters = [];
    browser.listeners.add((msg) => {
      if (msg.sessionId !== sessionId) return;
      const p = msg.params ?? {};
      if (msg.method === "Network.requestWillBeSent") { this.requests.push(p.request?.url ?? ""); this.methods.set(p.requestId, p.request?.method ?? ""); }
      else if (msg.method === "Network.webSocketCreated") this.requests.push(p.url ?? "");
      else if (msg.method === "Network.responseReceived") this.responses.push({ url: p.response?.url ?? "", status: p.response?.status ?? 0, method: this.methods.get(p.requestId) ?? "" });
      else if (msg.method === "Page.loadEventFired") { const w = this.loadWaiters; this.loadWaiters = []; w.forEach((r) => r()); }
      else if (msg.method === "Runtime.exceptionThrown") this.consoleErrors.push(p.exceptionDetails?.text ?? "exception");
    });
  }

  send(method, params) { return this.browser.send(method, params, this.sessionId); }

  async init() {
    await this.send("Page.enable");
    await this.send("Runtime.enable");
    await this.send("Network.enable");
    await this.send("DOM.enable");
  }

  async goto(url, { timeout = 30000 } = {}) {
    const loaded = new Promise((resolve) => this.loadWaiters.push(resolve));
    const res = await this.send("Page.navigate", { url });
    if (res.errorText) throw new Error(`navigate ${url}: ${res.errorText}`);
    await Promise.race([loaded, sleep(timeout)]);
  }

  async evaluate(fn, ...args) {
    const expression = typeof fn === "function" ? `(${fn.toString()})(...${JSON.stringify(args)})` : fn;
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(`evaluate: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result?.value;
  }

  url() { return this.evaluate(() => location.href); }

  /** Polls a page-side predicate until it returns a truthy value (which is returned). */
  async waitFor(fn, args = [], { timeout = 30000, interval = 200, label = "condition" } = {}) {
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
      try { last = await this.evaluate(fn, ...args); if (last) return last; } catch { /* page navigating */ }
      await sleep(interval);
    }
    throw new Error(`timed out waiting for ${label}`);
  }

  waitForSelector(selector, opts = {}) {
    return this.waitFor((s) => { const el = document.querySelector(s); if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 || r.height > 0 || el.tagName === "INPUT"; }, [selector], { label: `selector ${selector}`, ...opts });
  }

  waitForText(text, opts = {}) {
    // Case-insensitive: CSS text-transform changes what innerText reports.
    return this.waitFor((t) => document.body && document.body.innerText.toLowerCase().includes(t.toLowerCase()), [text], { label: `text "${text}"`, ...opts });
  }

  waitForUrl(re, opts = {}) {
    return this.waitFor((src, flags) => new RegExp(src, flags).test(location.href) && location.href, [re.source, re.flags], { label: `url ${re}`, ...opts });
  }

  bodyText() { return this.evaluate(() => document.body?.innerText ?? ""); }

  /** An element that exists and has finished every CSS animation/transition (dialogs animate in). */
  waitForSettled(selector, opts = {}) {
    return this.waitFor((s) => { const el = document.querySelector(s); return !!el && el.getAnimations({ subtree: true }).every((a) => a.playState !== "running"); }, [selector], { label: `settled ${selector}`, ...opts });
  }

  /** Center of the first visible element matching a selector, or a clickable element containing the text. */
  async locate({ selector, text, within }) {
    return this.evaluate((sel, txt, scope) => {
      const root = scope ? document.querySelector(scope) : document;
      if (!root) return null;
      const visible = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none"; };
      let el = null;
      if (sel) el = [...root.querySelectorAll(sel)].find(visible) ?? null;
      else {
        const cands = [...root.querySelectorAll("button, a, [role=button], [role=option], [role=menuitem], [role=tab], label, summary")];
        const t = txt.toLowerCase();
        el = cands.find((c) => visible(c) && c.innerText.trim().toLowerCase() === t) ?? cands.find((c) => visible(c) && c.innerText.toLowerCase().includes(t)) ?? null;
      }
      if (!el) return null;
      el.scrollIntoView({ block: "center", inline: "center" });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, disabled: !!(el.disabled || el.getAttribute("aria-disabled") === "true") };
    }, selector ?? null, text ?? null, within ?? null);
  }

  async click(target, { timeout = 20000, allowDisabled = false } = {}) {
    const t = typeof target === "string" ? { selector: target } : target;
    const deadline = Date.now() + timeout;
    let pos = null;
    while (Date.now() < deadline) {
      pos = await this.locate(t).catch(() => null);
      if (pos && (allowDisabled || !pos.disabled)) break;
      pos = null;
      await sleep(200);
    }
    if (!pos) throw new Error(`click: nothing clickable for ${JSON.stringify(t)}`);
    // Hover first, then re-locate once layout settles: hover can move the target (a toast stack expands under the
    // pointer), and a press at the stale position would land on whatever moved there instead.
    await this.mouse("mouseMoved", pos);
    await sleep(350);
    const settled = await this.locate(t).catch(() => null);
    if (settled && (Math.abs(settled.x - pos.x) > 1 || Math.abs(settled.y - pos.y) > 1)) {
      pos = settled;
      await this.mouse("mouseMoved", pos);
      await sleep(350);
    }
    await this.mouse("mousePressed", pos);
    await this.mouse("mouseReleased", pos);
  }

  mouse(type, { x, y }) { return this.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1, pointerType: "mouse" }); }

  /** Replaces a text input's value the way a person would: focus, select all, type. */
  async fill(selector, value) {
    await this.waitForSelector(selector);
    await this.evaluate((s) => { const el = document.querySelector(s); el.focus(); el.select?.(); }, selector);
    await this.send("Input.insertText", { text: value });
  }

  async press(key) {
    const codes = { Tab: 9, Enter: 13, Escape: 27, ArrowDown: 40, ArrowUp: 38, " ": 32 };
    const base = { key, code: key === " " ? "Space" : key, windowsVirtualKeyCode: codes[key] ?? 0, nativeVirtualKeyCode: codes[key] ?? 0 };
    await this.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base, ...(key === "Enter" ? { text: "\r" } : {}) });
    if (key === "Enter") await this.send("Input.dispatchKeyEvent", { type: "char", ...base, text: "\r" });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }

  /** Sets files on an <input type=file> (hidden inputs included) and fires the change event React listens for. */
  async setFiles(selector, files) {
    await this.waitFor((s) => !!document.querySelector(s), [selector], { label: `file input ${selector}` });
    const { root } = await this.send("DOM.getDocument", { depth: 0 });
    const { nodeId } = await this.send("DOM.querySelector", { nodeId: root.nodeId, selector });
    if (!nodeId) throw new Error(`setFiles: ${selector} not found`);
    await this.send("DOM.setFileInputFiles", { nodeId, files: files.map((f) => path.resolve(f)) });
  }

  async setViewport(width, height) {
    await this.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 768 });
  }

  async screenshot(file) {
    const { data } = await this.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    const buf = Buffer.from(data, "base64");
    if (buf.length < 100) throw new Error(`screenshot ${file} is empty`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buf);
    return file;
  }

  /** Network throttling, used to hold authorization reads in flight while a guard is inspected. */
  throttle(latencyMs) {
    return this.send("Network.emulateNetworkConditions", { offline: false, latency: latencyMs, downloadThroughput: -1, uploadThroughput: -1 });
  }
}

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import vm from "node:vm";
import test from "node:test";
import { chromium } from "playwright-core";
import { BrowserControlPlane } from "../lib/control-plane.mjs";

const origin = "https://control.example.test";
const ready = { status: 200, contentType: "application/json", json: { id: "test" } };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));

function fixture(options = {}) {
  const control = new BrowserControlPlane({
    baseUrl: origin, tunnelId: "test", token: "test",
    diagnosticsEnabled: false, watchdogIntervalMs: 0,
    requestTimeoutMs: 15, pollTimeoutGraceMs: 15,
    ssoProbeIntervalMs: 1, ssoWaitMs: 180_000, ...options,
  });
  control.context = { async close() {} };
  control.page = {
    url: () => origin, isClosed: () => false,
    async goto() {}, async bringToFront() {}, frames: () => [],
  };
  return control;
}
function cdpFixture(held) {
  const gate = deferred();
  const calls = [];
  let detached = 0;
  return {
    gate, calls, detached: () => detached,
    cdp: {
      async detach() { detached++; },
      async send(method) {
        calls.push(method);
        if (method === held) await gate.promise;
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "test" } } };
        if (method === "Page.createIsolatedWorld") return { executionContextId: 1 };
        return { result: { value: { status: 204, text: "", contentType: "" } } };
      },
    },
  };
}

for (const held of ["Page.getFrameTree", "Page.createIsolatedWorld", "Runtime.evaluate"]) {
  test(`deadline interrupts ${held} and ignores its late completion`, { timeout: 1000 }, async () => {
    const control = fixture();
    const fake = cdpFixture(held);
    control.cdp = fake.cdp;
    const pending = control.poll(1, 1);
    await delay(40);
    const result = await pending;
    assert.equal(result.status, 0);
    assert.match(result.networkError, /timed out/);
    assert.equal(control.isBrowserTransportReady(), false);
    assert.equal(fake.detached(), 1);
    assert.equal(control.activeRequests.size, 0);
    const calls = [...fake.calls];
    fake.gate.resolve();
    await tick();
    assert.deepEqual(fake.calls, calls, "late completion must not send another CDP command");
    await control.close();
  });
}

test("metadata and response calls have a local deadline too", { timeout: 1000 }, async () => {
  for (const kind of ["metadata", "response"]) {
    const control = fixture();
    const fake = cdpFixture("Runtime.evaluate");
    control.cdp = fake.cdp;
    const pending = kind === "metadata" ? control.metadata() : control.postResponse({}, {});
    await delay(35);
    assert.match((await pending).networkError, /timed out/);
    fake.gate.resolve();
    await control.close();
  }
});

test("a timed out old request cannot detach the replacement browser", { timeout: 1000 }, async () => {
  const control = fixture();
  const old = cdpFixture("Page.getFrameTree");
  control.cdp = old.cdp;
  const pending = control.poll(1, 1);
  await tick();
  const replacement = cdpFixture();
  control.cdp = replacement.cdp;
  control.page = { url: () => origin, isClosed: () => false };
  await delay(35);
  assert.equal((await pending).status, 0);
  assert.equal(control.cdp, replacement.cdp);
  assert.equal(replacement.detached(), 0);
  assert.equal(control.isBrowserTransportReady(), true);
  old.gate.resolve();
  await tick();
  assert.deepEqual(old.calls, ["Page.getFrameTree"]);
  assert.deepEqual(replacement.calls, []);
  await control.close();
});

test("one timeout cancels sibling requests and the next recovery rebuilds once", { timeout: 1000 }, async () => {
  const control = fixture();
  const old = cdpFixture("Runtime.evaluate");
  control.cdp = old.cdp;
  let closed = 0, launches = 0;
  control.context.close = async () => { closed++; };
  const pending = [control.poll(1, 1), control.postResponse({}, {})];
  await delay(40);
  assert.ok((await Promise.all(pending)).every((r) => r.status === 0));
  assert.equal(old.detached(), 1);
  control.launchBrowserContext = async () => {
    launches++;
    control.context = { async close() {} };
    control.page = { url: () => origin, isClosed: () => false, async goto() {} };
    control.cdp = cdpFixture().cdp;
  };
  control.metadata = async () => ready;
  await Promise.all([control.recover(), control.recover()]);
  assert.equal(closed, 1);
  assert.equal(launches, 1);
  old.gate.resolve();
  await control.close();
});

test("browser fetch deadline remains active while reading the body", { timeout: 1000 }, async () => {
  const control = fixture();
  const fake = cdpFixture();
  let bodyAborted = false;
  control.cdp = {
    detach: async () => {},
    send: async (method, args) => {
      if (method !== "Runtime.evaluate") return fake.cdp.send(method);
      const value = await vm.runInNewContext(args.expression, {
        AbortController, setTimeout, clearTimeout,
        fetch: async (_url, init) => ({
          status: 200, url: origin, redirected: false, headers: new Headers(),
          text: () => new Promise((_, reject) => init.signal.addEventListener("abort", () => {
            bodyAborted = true;
            reject(new Error("body aborted"));
          }, { once: true })),
        }),
      });
      return { result: { value } };
    },
  };
  const pending = control.metadata();
  await delay(45);
  assert.equal((await pending).status, 0);
  assert.equal(bodyAborted, true);
  await control.close();
});

test("close interrupts a pending poll and closes context only once", { timeout: 1000 }, async () => {
  const control = fixture({ requestTimeoutMs: 10_000 });
  const fake = cdpFixture("Runtime.evaluate");
  control.cdp = fake.cdp;
  let closed = 0;
  control.context.close = async () => { closed++; };
  const poll = control.poll(1, 10_000);
  await tick();
  await Promise.all([control.close(), control.close()]);
  assert.match((await poll).networkError, /stopping/);
  assert.equal(closed, 1);
  assert.equal(control.activeRequests.size, 0);
  fake.gate.resolve();
});

function fakeContext(heldEnable) {
  const context = new EventEmitter();
  const page = new EventEmitter();
  let closed = 0;
  page.url = () => origin;
  page.isClosed = () => false;
  page.goto = async () => {};
  const cdp = new EventEmitter();
  cdp.send = async (method) => {
    if (method === "Page.enable" && heldEnable) return heldEnable.promise;
    return {};
  };
  context.pages = () => [page];
  context.newCDPSession = async () => cdp;
  context.close = async () => {
    closed++;
    heldEnable?.reject(new Error("context closed"));
    context.emit("close");
  };
  return { context, closed: () => closed };
}

test("close during Page.enable closes the provisional context and settles launch", { timeout: 1000 }, async (t) => {
  const gate = deferred();
  const fake = fakeContext(gate);
  t.mock.method(chromium, "launchPersistentContext", async () => fake.context);
  const control = fixture({ requestTimeoutMs: 10_000 });
  control.context = undefined;
  control.page = undefined;
  const started = assert.rejects(control.start(), /stopping|cancelled|closed/);
  await tick();
  assert.equal(control.launchingContext, fake.context);
  await control.close();
  await started;
  assert.equal(fake.closed(), 1);
  assert.equal(control.context, undefined);
  assert.equal(control.launchingContext, undefined);
  assert.equal(control.watchdogTimer, undefined);
});

test("browser setup deadline also bounds a stalled Page.enable", { timeout: 1000 }, async (t) => {
  const fake = fakeContext(deferred());
  t.mock.method(chromium, "launchPersistentContext", async () => fake.context);
  const control = fixture();
  control.context = undefined;
  control.page = undefined;
  await assert.rejects(control.start(), /setup timed out/);
  assert.equal(fake.closed(), 1);
  assert.equal(control.context, undefined);
  await control.close();
});

test("late browser launch after close is cleaned up without resurrecting transport", { timeout: 1000 }, async (t) => {
  const launch = deferred();
  const fake = fakeContext();
  t.mock.method(chromium, "launchPersistentContext", () => launch.promise);
  const control = fixture();
  control.context = undefined;
  control.page = undefined;
  const started = assert.rejects(control.start(), /stopping|cancelled/);
  const closing = control.close();
  launch.resolve(fake.context);
  await Promise.all([started, closing]);
  assert.equal(fake.closed(), 1);
  assert.equal(control.isBrowserTransportReady(), false);
  assert.equal(control.watchdogTimer, undefined);
});

test("ambiguous metadata CORS failure permits one explicit login action", { timeout: 1000 }, async () => {
  const control = fixture();
  control.cdp = {};
  let authenticated = false, clicks = 0;
  control.metadata = async () => authenticated ? ready : { status: 0, networkError: "TypeError: Failed to fetch" };
  control.collectSsoActionCandidates = async () => [{
    label: "登录", kind: "a", tag: "a", frameUrl: origin + "/home",
    locator: { async click() { clicks++; authenticated = true; } },
  }];
  await control.ensureAuthorized();
  assert.equal(clicks, 1);
  await control.close();
});

test("network error without explicit login action fails promptly without fallback click", { timeout: 1000 }, async () => {
  const control = fixture();
  control.cdp = {};
  control.metadata = async () => ({ status: 0, networkError: "Failed to fetch" });
  control.collectSsoActionCandidates = async () => [{
    label: "Details", kind: "button", tag: "button", frameUrl: origin,
    locator: { async click() { assert.fail("unrelated single button clicked"); } },
  }];
  await assert.rejects(control.ensureAuthorized(), /metadata transport failed/);
  await control.close();
});

test("ambiguous metadata failure respects disabled auto approval", { timeout: 1000 }, async () => {
  const control = fixture({ autoApprove: false });
  control.cdp = {};
  control.metadata = async () => ({ status: 0, networkError: "Failed to fetch" });
  control.collectSsoActionCandidates = async () => [];
  await assert.rejects(control.ensureAuthorized(), /metadata transport failed/);
  await control.close();
});

test("a login action followed by another transport failure does not loop", { timeout: 1000 }, async () => {
  const control = fixture();
  control.cdp = {};
  let clicks = 0;
  control.metadata = async () => ({ status: 0, networkError: "Failed to fetch" });
  control.tryApproveSso = async () => { clicks++; return true; };
  await assert.rejects(control.ensureAuthorized(), /metadata transport failed/);
  assert.equal(clicks, 1);
  await control.close();
});

test("recognized SSO page keeps manual approval waiting through ambiguous CORS errors", { timeout: 1000 }, async () => {
  const control = fixture({ autoApprove: false });
  control.cdp = {};
  let probes = 0;
  control.metadata = async () => ++probes >= 3 ? ready : { status: 0, networkError: "Failed to fetch" };
  control.collectSsoActionCandidates = async () => [{
    label: "登录", kind: "a", tag: "a", frameUrl: origin + "/home",
    locator: { async click() { assert.fail("manual SSO clicked automatically"); } },
  }];
  await control.ensureAuthorized();
  assert.equal(probes, 3);
  await control.close();
});

import assert from "node:assert/strict";
import test from "node:test";
import { BrowserControlPlane } from "../lib/control-plane.mjs";

const origin = "https://control.example.test";
const tunnelId = "test-tunnel";
const tick = () => new Promise((resolve) => setImmediate(resolve));
const ready = () => ({
  status: 200, networkError: null, contentType: "application/json",
  json: { id: tunnelId },
});
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
};

function fixture(options = {}) {
  const control = new BrowserControlPlane({
    baseUrl: origin, tunnelId, token: "test-token",
    diagnosticsEnabled: false, watchdogIntervalMs: 0,
    ssoProbeIntervalMs: 1, ssoWaitMs: 180_000,
    ...options,
  });
  const page = {
    currentUrl: origin,
    isClosed: () => false,
    url() { return this.currentUrl; },
    async goto(url) { this.currentUrl = url; },
    async bringToFront() {},
  };
  control.context = { async close() {} };
  control.page = page;
  control.cdp = {};
  control.metadata = async () => ready();
  return { control, page };
}

test("concurrent recoveries share one navigation and authorization check", { timeout: 1_000 }, async () => {
  const { control, page } = fixture();
  const navigation = deferred();
  let navigations = 0;
  let probes = 0;
  page.goto = async () => { navigations++; await navigation.promise; };
  control.metadata = async () => { probes++; return ready(); };
  const pending = Array.from({ length: 5 }, () => control.recover("test concurrency"));
  await tick();
  assert.equal(navigations, 1);
  assert.equal(probes, 0);
  navigation.resolve();
  await Promise.all(pending);
  assert.equal(probes, 1);
  assert.equal(control.authorizationRecoveryPromise, undefined);
});

test("failed shared recovery releases its slot so the next attempt can retry", { timeout: 1_000 }, async () => {
  const { control, page } = fixture();
  const navigation = deferred();
  let navigations = 0;
  page.goto = async () => { navigations++; await navigation.promise; };
  const pending = [control.recover(), control.recover()];
  const settled = Promise.allSettled(pending);
  navigation.reject(new Error("net::ERR_CONNECTION_CLOSED"));
  assert.ok((await settled).every((result) => result.status === "rejected"));
  assert.equal(navigations, 1);
  assert.equal(control.authorizationRecoveryPromise, undefined);
  page.goto = async () => { navigations++; };
  await control.recover();
  assert.equal(navigations, 2);
});

test("recover joins browser restart even after its new page becomes ready", { timeout: 1_000 }, async () => {
  const { control } = fixture();
  const authorization = deferred();
  let navigations = 0;
  let authorizations = 0;
  control.launchBrowserContext = async () => {
    control.context = { async close() {} };
    control.page = {
      isClosed: () => false, url: () => origin,
      async goto() { navigations++; }, async bringToFront() {},
    };
    control.cdp = {};
  };
  control.metadata = async () => { authorizations++; return authorization.promise; };
  const restart = control.restartBrowser("test restart");
  await tick();
  assert.equal(control.isBrowserTransportReady(), true);
  const recovery = control.recover("while restarting");
  await tick();
  assert.equal(navigations, 1);
  assert.equal(authorizations, 1);
  authorization.resolve(ready());
  await Promise.all([restart, recovery]);
});

test("missing browser recovery does not wait on its own authorization promise", { timeout: 1_000 }, async () => {
  const { control } = fixture();
  control.context = undefined;
  control.page = undefined;
  control.cdp = undefined;
  let launches = 0;
  control.launchBrowserContext = async () => {
    launches++;
    control.context = { async close() {} };
    control.page = {
      isClosed: () => false, url: () => origin,
      async goto() {}, async bringToFront() {},
    };
    control.cdp = {};
  };
  await Promise.all([control.recover(), control.recover()]);
  assert.equal(launches, 1);
});

test("an old navigation joins replacement recovery without navigating its new page", { timeout: 1_000 }, async () => {
  const { control, page } = fixture();
  const oldNavigation = deferred();
  const newAuthorization = deferred();
  page.goto = async () => oldNavigation.promise;
  const recovery = control.recover("old page");
  await tick();
  let newNavigations = 0;
  let newProbes = 0;
  control.launchBrowserContext = async () => {
    control.context = { async close() {} };
    control.page = {
      isClosed: () => false, url: () => origin,
      async goto() { newNavigations++; }, async bringToFront() {},
    };
    control.cdp = {};
  };
  control.metadata = async () => { newProbes++; return newAuthorization.promise; };
  const restart = control.restartBrowser("closed page");
  await tick();
  oldNavigation.resolve();
  await tick();
  assert.equal(newNavigations, 1);
  assert.equal(newProbes, 1);
  newAuthorization.resolve(ready());
  await Promise.all([restart, recovery]);
});

test("an old SSO probe cannot click or probe a replacement page", { timeout: 1_000 }, async () => {
  const { control } = fixture();
  const probe = deferred();
  let probes = 0;
  control.metadata = async () => { probes++; return probe.promise; };
  control.tryApproveSso = async () => assert.fail("stale recovery clicked SSO");
  const authorization = control.ensureAuthorized();
  const checked = assert.rejects(authorization, /transport changed/);
  await tick();
  control.page = { isClosed: () => false, url: () => origin };
  probe.resolve({ status: 401, contentType: "application/json" });
  await checked;
  assert.equal(probes, 1);
});

test("Chrome error pages leave SSO waiting immediately without scanning buttons", { timeout: 1_000 }, async () => {
  const { control, page } = fixture();
  page.currentUrl = "chrome-error://chromewebdata/";
  control.tryApproveSso = async () => assert.fail("network error page treated as SSO");
  control.metadata = async () => assert.fail("network error page was probed");
  await assert.rejects(control.ensureAuthorized(), /network error page/);
  // A subsequent attempt is allowed to navigate away from the error page.
  control.metadata = async () => ready();
  await control.recover();
  assert.equal(page.url(), origin + "/");
});

test("metadata network errors and status zero do not enter SSO approval waiting", { timeout: 1_000 }, async (t) => {
  for (const result of [
    { status: 0, networkError: "TypeError: Failed to fetch" },
    { status: 0, networkError: null },
    { status: 200, networkError: "CDP context missing" },
  ]) {
    await t.test(JSON.stringify(result), async () => {
      const { control } = fixture();
      control.metadata = async () => result;
      control.tryApproveSso = async () => assert.fail("transport error treated as SSO");
      await assert.rejects(control.ensureAuthorized(), /metadata transport failed/);
    });
  }
});

test("network failure detected during a real SSO wait exits the same attempt", { timeout: 1_000 }, async (t) => {
  for (const failure of ["page", "metadata"]) {
    await t.test(failure, async () => {
      const { control, page } = fixture();
      let clicks = 0;
      control.metadata = async () => ({ status: 401, contentType: "application/json" });
      control.tryApproveSso = async () => {
        clicks++;
        if (failure === "page") page.currentUrl = "chrome-error://chromewebdata/";
        else control.metadata = async () => ({ status: 0, networkError: "Failed to fetch" });
      };
      await assert.rejects(control.ensureAuthorized(), /network error page|metadata transport failed/);
      assert.equal(clicks, 1);
    });
  }
});

test("a genuine SSO redirect still waits for approval and tolerates ERR_ABORTED", { timeout: 1_000 }, async () => {
  const { control, page } = fixture();
  let clicks = 0;
  page.goto = async () => {
    page.currentUrl = "https://sso.example.test/login";
    throw new Error("page.goto: net::ERR_ABORTED; redirected to SSO");
  };
  control.tryApproveSso = async () => {
    clicks++;
    page.currentUrl = origin;
  };
  await control.recover();
  assert.equal(clicks, 1);
});

test("navigation network failures leave the attempt even if Chrome retains the old URL", { timeout: 1_000 }, async () => {
  const { control, page } = fixture();
  page.goto = async () => { throw new Error("page.goto: net::ERR_TIMED_OUT"); };
  control.metadata = async () => assert.fail("failed navigation continued to authentication");
  await assert.rejects(control.recover(), /network navigation failed/);
});

test("a control request keeps its original CDP session across browser replacement", { timeout: 1_000 }, async () => {
  const { control } = fixture();
  const frame = deferred();
  const calls = [];
  control.cdp = {
    async send(method) {
      calls.push(method);
      if (method === "Page.getFrameTree") return frame.promise;
      if (method === "Page.createIsolatedWorld") return { executionContextId: 1 };
      return { result: { value: { status: 204, text: "", contentType: "" } } };
    },
  };
  const request = control.poll(1, 30_000);
  await tick();
  control.cdp = { async send() { assert.fail("old request used new browser CDP session"); } };
  frame.resolve({ frameTree: { frame: { id: "test-frame" } } });
  assert.equal((await request).status, 204);
  assert.deepEqual(calls, ["Page.getFrameTree", "Page.createIsolatedWorld", "Runtime.evaluate"]);
});

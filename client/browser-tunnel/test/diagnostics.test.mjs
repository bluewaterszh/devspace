import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { BrowserControlPlane } from "../lib/control-plane.mjs";
import { TunnelDiagnostics, installTimestampedConsole } from "../lib/diagnostics.mjs";

const origin = "https://control.example.test";
const tunnel = "private-tunnel-sentinel";
const tick = () => new Promise((resolve) => setImmediate(resolve));
const result204 = { networkError: null, status: 204, text: "", contentType: "", redirected: false };

function fixture() {
  let time = 0;
  const records = [];
  const diagnostics = new TunnelDiagnostics({
    now: () => time,
    write: (record) => records.push(record),
    runtime: () => ({ loop: "polling", activeWorkers: 0, browserReady: true }),
  });
  return { diagnostics, records, advance: (ms) => { time += ms; } };
}

class FakeCDP extends EventEmitter {
  constructor(hold) {
    super();
    this.hold = hold;
    this.calls = [];
  }
  async send(method) {
    this.calls.push(method);
    if (method === this.hold) await new Promise((resolve) => { this.release = resolve; });
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "private-frame" } } };
    if (method === "Page.createIsolatedWorld") return { executionContextId: 1 };
    if (method === "Runtime.evaluate") return { result: { value: { ...result204 } } };
    return {};
  }
}

test("reports each blocked CDP phase without timing out or retrying the request", async (t) => {
  for (const [method, phase] of [
    ["Page.getFrameTree", "get_frame_tree"],
    ["Page.createIsolatedWorld", "create_world"],
    ["Runtime.evaluate", "evaluate"],
  ]) {
    await t.test(phase, async () => {
      const f = fixture();
      const cdp = new FakeCDP(method);
      const control = new BrowserControlPlane({ baseUrl: origin, tunnelId: tunnel, token: "private-token" });
      control.context = {};
      control.page = { isClosed: () => false, url: () => origin };
      control.cdp = cdp;
      control.diagnostics = f.diagnostics;
      let settled = false;
      const pending = control.poll(20, 30_000).then((value) => { settled = true; return value; });
      await tick();
      f.advance(660_000);
      f.diagnostics.heartbeat();
      assert.equal(settled, false);
      const heartbeat = f.records.at(-1);
      assert.equal(heartbeat.pending[0].phase, phase);
      assert.equal(heartbeat.pending[0].elapsed_ms, 660_000);
      assert.equal(heartbeat.tick_gap_ms, 660_000);
      assert.equal(cdp.calls.filter((call) => call === method).length, 1);
      cdp.release();
      assert.equal((await pending).status, 204);
      assert.equal(f.diagnostics.ops.size, 0);
      assert.equal(f.records.at(-1).event, "request_end");
    });
  }
});

test("distinguishes Chrome finishing a 204 from an evaluate promise that is still pending", async () => {
  const f = fixture();
  const cdp = new FakeCDP("Runtime.evaluate");
  const control = new BrowserControlPlane({ baseUrl: origin, tunnelId: tunnel, token: "private-token" });
  control.context = {};
  control.page = { isClosed: () => false, url: () => origin };
  control.cdp = cdp;
  control.diagnostics = f.diagnostics;
  f.diagnostics.attachNetwork(cdp, origin, tunnel);
  const pending = control.poll(20, 30_000);
  await tick();
  cdp.emit("Network.requestWillBeSent", { requestId: "private-network-id", request: {
    url: `${origin}/v1/tunnels/${tunnel}/poll?private=query`,
    headers: { Authorization: "private-auth", Cookie: "private-cookie" }, postData: "private-body",
  } });
  f.advance(30_000);
  cdp.emit("Network.responseReceived", { requestId: "private-network-id", response: {
    status: 204, protocol: "h2", connectionId: 12345, connectionReused: true,
    url: "private-response-url", headers: { "set-cookie": "private-cookie" },
  } });
  cdp.emit("Network.loadingFinished", { requestId: "private-network-id" });
  f.advance(60_000);
  f.diagnostics.heartbeat();
  const heartbeat = f.records.at(-1);
  assert.equal(heartbeat.pending[0].phase, "evaluate");
  assert.equal(heartbeat.last_network.event, "network_finished");
  assert.equal(heartbeat.last_network.ms_ago, 60_000);
  assert.equal(heartbeat.network_pending, 0);
  const response = f.records.find((r) => r.event === "network_response");
  assert.equal(response.protocol, "h2");
  assert.equal(response.connection, 1);
  assert.equal(response.reused, true);
  assert.equal(JSON.stringify(f.records).includes("private"), false);
  cdp.release();
  assert.equal((await pending).status, 204);
  f.diagnostics.stop();
});

test("filters unrelated traffic, tracks redirects safely, and bounds and cleans network state", async () => {
  const f = fixture();
  const cdp = new FakeCDP();
  f.diagnostics.attachNetwork(cdp, origin, tunnel);
  await tick();
  const request = (requestId, url) => cdp.emit("Network.requestWillBeSent", { requestId, request: { url } });
  request("ignored", "https://unrelated.example.test/v1/tunnels/another/poll");
  request("ignored2", `${origin}/v1/tunnels/another/poll`);
  assert.equal(f.diagnostics.network.size, 0);
  request("private-id", `${origin}/v1/tunnels/${tunnel}/poll`);
  cdp.emit("Network.requestWillBeSent", {
    requestId: "private-id", request: { url: "https://sso.example.test/private-token" },
    redirectResponse: { status: 302, headers: { Cookie: "private-cookie" } },
  });
  cdp.emit("Network.loadingFailed", {
    requestId: "private-id", errorText: "net::ERR_CONNECTION_RESET https://private-token/", canceled: false,
  });
  assert.equal(f.records.at(-1).error, "net::ERR_CONNECTION_RESET");
  assert.equal(f.diagnostics.network.size, 0);
  assert.equal(JSON.stringify(f.records).includes("private"), false);
  for (let i = 0; i < 140; i++) request(`private-${i}`, `${origin}/v1/tunnels/${tunnel}/response`);
  assert.equal(f.diagnostics.network.size, 128);
  const replacement = new FakeCDP();
  f.diagnostics.attachNetwork(replacement, origin, tunnel);
  await tick();
  const count = f.records.length;
  request("private-old", `${origin}/v1/tunnels/${tunnel}/poll`);
  assert.equal(f.records.length, count);
  assert.equal(f.diagnostics.network.size, 0);
  assert.equal(cdp.listenerCount("Network.requestWillBeSent"), 0);
  f.diagnostics.stop();
});

test("disabled or unavailable observation leaves transport usable", async () => {
  const disabled = new TunnelDiagnostics({ enabled: false, write: () => assert.fail("disabled logger wrote") });
  const cdp = new FakeCDP();
  disabled.start();
  disabled.attachNetwork(cdp, origin, tunnel);
  assert.equal(disabled.begin("poll"), undefined);
  disabled.heartbeat();
  assert.deepEqual(cdp.calls, []);
  const f = fixture();
  cdp.send = async () => { throw new Error("private-error"); };
  f.diagnostics.attachNetwork(cdp, origin, tunnel);
  await tick();
  assert.equal(f.diagnostics.networkObserver, "unavailable");
  assert.equal(f.records.at(-1).event, "network_observer_unavailable");
  assert.equal(JSON.stringify(f.records).includes("private"), false);
  f.diagnostics.stop();
});

test("recovery failure and shutdown detach the failed browser observer", async (t) => {
  for (const stopping of [false, true]) {
    await t.test(stopping ? "stopping during launch" : "navigation failed", async () => {
      const f = fixture();
      const cdp = new FakeCDP();
      const control = new BrowserControlPlane({
        baseUrl: origin, tunnelId: tunnel, token: "private-token", browserRestartAttempts: 1,
      });
      control.diagnostics = f.diagnostics;
      let closed = 0;
      control.launchBrowserContext = async () => {
        control.context = { close: async () => { closed++; } };
        control.page = { isClosed: () => false, url: () => origin };
        control.cdp = cdp;
        f.diagnostics.attachNetwork(cdp, origin, tunnel);
        if (stopping) control.stopping = true;
      };
      control.openSsoPage = async () => { throw new Error("test navigation failure"); };
      await assert.rejects(control.doRestartBrowser("test recovery"), /could not be recovered/);
      assert.equal(closed, 1);
      assert.equal(f.diagnostics.networkObserver, "off");
      assert.equal(cdp.listenerCount("Network.requestWillBeSent"), 0);
      f.diagnostics.stop();
    });
  }
});

test("timestamps every console line while preserving formatting and level", () => {
  const lines = [];
  const target = Object.fromEntries(["log", "info", "warn", "error", "debug"].map((level) => [level, (s) => lines.push([level, s])]));
  const original = target.warn;
  const restore = installTimestampedConsole(target, () => new Date("2026-10-28T08:00:00Z"));
  target.warn("phase=%s\nnext", "evaluate");
  assert.deepEqual(lines, [["warn", "[2026-10-28T08:00:00.000Z] phase=evaluate\n[2026-10-28T08:00:00.000Z] next"]]);
  restore();
  assert.equal(target.warn, original);
});

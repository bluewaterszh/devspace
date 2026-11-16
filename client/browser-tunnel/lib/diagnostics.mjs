import { format } from "node:util";

const MAX_TRACKED = 128;

// Install only in the CLI; importing the library must not change global logging.
export function installTimestampedConsole(target = console, now = () => new Date()) {
  const originals = new Map();
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    const original = target[level];
    originals.set(level, original);
    target[level] = (...args) => {
      const prefix = `[${now().toISOString()}] `;
      original.call(target, format(...args).split("\n").map((line) => prefix + line).join("\n"));
    };
  }
  return () => {
    for (const [level, original] of originals) target[level] = original;
  };
}

// Passive observation only: never abort, retry, navigate, or restart a request.
export class TunnelDiagnostics {
  constructor(options = {}) {
    this.enabled = options.enabled ?? true;
    this.intervalMs = options.intervalMs ?? 30_000;
    this.now = options.now ?? (() => performance.now());
    this.write = options.write ?? ((record) => console.log(`TUNNEL_DIAG ${JSON.stringify(record)}`));
    this.runtime = options.runtime ?? (() => ({}));
    this.ops = new Map();
    this.network = new Map();
    this.connections = new Map();
    this.nextOp = 0;
    this.nextNet = 0;
    this.nextConnection = 0;
    this.lastTick = this.now();
    this.lastPollAt = undefined;
    this.lastNetwork = undefined;
    this.networkObserver = "off";
  }

  emit(event, fields = {}) {
    if (this.enabled) this.write({ event, ...fields });
  }

  start() {
    if (!this.enabled || this.timer) return;
    this.lastTick = this.now();
    this.timer = setInterval(() => this.heartbeat(), this.intervalMs);
    this.timer.unref?.();
    this.emit("diagnostics_started", { pid: process.pid, interval_ms: this.intervalMs });
  }

  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
    this.detachNetwork();
  }

  begin(kind) {
    if (!this.enabled) return undefined;
    const op = ++this.nextOp;
    if (this.ops.size >= MAX_TRACKED) this.ops.delete(this.ops.keys().next().value);
    const now = this.now();
    this.ops.set(op, { op, kind, phase: "request", started: now, changed: now });
    this.emit("request_start", { op, kind });
    return op;
  }

  stage(op, phase) {
    const item = this.ops.get(op);
    if (!item) return;
    item.phase = phase;
    item.changed = this.now();
  }

  end(op, result) {
    const item = this.ops.get(op);
    if (!item) return;
    this.emit("request_end", {
      op, kind: item.kind, phase: item.phase,
      elapsed_ms: Math.round(this.now() - item.started),
      status: result.status, network_error: Boolean(result.networkError),
      redirected: Boolean(result.redirected),
    });
    if (item.kind === "poll") this.lastPollAt = this.now();
    this.ops.delete(op);
  }

  heartbeat() {
    const now = this.now();
    const runtime = this.runtime();
    this.emit("heartbeat", {
      tick_gap_ms: Math.round(now - this.lastTick),
      loop: runtime.loop, active_workers: runtime.activeWorkers,
      browser_ready: runtime.browserReady,
      network_observer: this.networkObserver,
      last_poll_return_ms_ago: this.lastPollAt === undefined ? null : Math.round(now - this.lastPollAt),
      pending: [...this.ops.values()].map((item) => ({
        op: item.op, kind: item.kind, phase: item.phase,
        elapsed_ms: Math.round(now - item.started),
        phase_ms: Math.round(now - item.changed),
      })),
      network_pending: this.network.size,
      last_network: this.lastNetwork && {
        ...this.lastNetwork.record, ms_ago: Math.round(now - this.lastNetwork.at),
      },
    });
    this.lastTick = now;
  }

  attachNetwork(cdp, baseUrl, tunnelId) {
    this.detachNetwork();
    if (!this.enabled) return;
    const paths = new Map([
      [`/v1/tunnels/${encodeURIComponent(tunnelId)}`, "metadata"],
      [`/v1/tunnels/${encodeURIComponent(tunnelId)}/poll`, "poll"],
      [`/v1/tunnels/${encodeURIComponent(tunnelId)}/response`, "response"],
    ]);
    const origin = new URL(baseUrl).origin;
    const listeners = [];
    this.networkSession = cdp;
    this.networkObserver = "enabling";
    const on = (name, handler) => {
      const listener = (event) => {
        if (this.networkSession === cdp) handler(event);
      };
      cdp.on(name, listener);
      listeners.push([name, listener]);
    };
    this.removeNetworkListeners = () => {
      for (const [name, listener] of listeners) cdp.off(name, listener);
    };
    const emitNetwork = (event, item, fields = {}) => {
      const record = {
        net: item.net, kind: item.kind,
        elapsed_ms: Math.round(this.now() - item.started), ...fields,
      };
      this.lastNetwork = { at: this.now(), record: { event, ...record } };
      this.emit(event, record);
    };
    on("Network.requestWillBeSent", (event) => {
      let item = this.network.get(event.requestId);
      if (item) {
        emitNetwork("network_redirect", item, { status: event.redirectResponse?.status });
        return;
      }
      let url;
      try { url = new URL(event.request.url); } catch { return; }
      const kind = url.origin === origin && paths.get(url.pathname);
      if (!kind) return;
      if (this.network.size >= MAX_TRACKED) {
        this.network.delete(this.network.keys().next().value);
        this.emit("network_tracking_limit", { limit: MAX_TRACKED });
      }
      item = { net: ++this.nextNet, kind, started: this.now() };
      this.network.set(event.requestId, item);
      emitNetwork("network_request", item);
    });
    on("Network.responseReceived", (event) => {
      const item = this.network.get(event.requestId);
      if (!item) return;
      const response = event.response;
      let connection;
      if (typeof response.connectionId === "number") {
        if (!this.connections.has(response.connectionId)) {
          if (this.connections.size >= MAX_TRACKED) this.connections.delete(this.connections.keys().next().value);
          this.connections.set(response.connectionId, ++this.nextConnection);
        }
        connection = this.connections.get(response.connectionId);
      }
      emitNetwork("network_response", item, {
        status: response.status, connection,
        reused: response.connectionReused,
        protocol: ["h2", "h3", "http/1.0", "http/1.1"].includes(response.protocol)
          ? response.protocol : "other",
      });
    });
    on("Network.loadingFinished", (event) => {
      const item = this.network.get(event.requestId);
      if (!item) return;
      emitNetwork("network_finished", item);
      this.network.delete(event.requestId);
    });
    on("Network.loadingFailed", (event) => {
      const item = this.network.get(event.requestId);
      if (!item) return;
      emitNetwork("network_failed", item, {
        error: String(event.errorText ?? "").match(/net::ERR_[A-Z0-9_]+/)?.[0] ?? "network_error",
        canceled: Boolean(event.canceled),
      });
      this.network.delete(event.requestId);
    });
    // Enabling observation must not add a new blocking await to the transport.
    // Bound DevTools payload retention; this does not cap actual HTTP bodies.
    void cdp.send("Network.enable", {
      maxTotalBufferSize: 1024, maxResourceBufferSize: 1024, maxPostDataSize: 1,
    }).then(() => {
      if (this.networkSession !== cdp) return;
      this.networkObserver = "on";
      this.emit("network_observer_ready");
    }).catch(() => {
      if (this.networkSession !== cdp) return;
      this.networkObserver = "unavailable";
      this.emit("network_observer_unavailable");
    });
  }

  detachNetwork() {
    this.networkSession = undefined;
    this.removeNetworkListeners?.();
    this.removeNetworkListeners = undefined;
    this.network.clear();
    this.connections.clear();
    this.lastNetwork = undefined;
    this.networkObserver = "off";
  }
}

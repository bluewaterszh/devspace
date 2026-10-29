import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { processTunnelCommand } from "../lib/mcp-forwarder.mjs";
import { RequestNotPendingError } from "../lib/response-delivery.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function within(promise, ms = 1500) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("operation did not finish in time")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function withServer(handler, fn) {
  const server = createServer((req, res) => {
    req.resume();
    handler(req, res);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await fn(`http://127.0.0.1:${server.address().port}/mcp`);
  } finally {
    const closed = once(server, "close");
    server.close();
    server.closeAllConnections();
    await closed;
  }
}

function command(overrides = {}) {
  return {
    request_id: "lifecycle-test",
    command_type: "jsonrpc",
    response_timeout: "250ms",
    jsonrpc: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    ...overrides,
  };
}

for (const bodyType of ["JSON", "SSE"]) {
  test(`local ${bodyType} body obeys the deadline after response headers`, { timeout: 5000 }, async (t) => {
    t.mock.method(console, "error", () => {});
    const reached = deferred();
    await withServer((_req, res) => {
      const closed = once(res, "close");
      res.writeHead(200, { "Content-Type": bodyType === "JSON"
        ? "application/json" : "text/event-stream" });
      res.write(bodyType === "JSON" ? '{"jsonrpc":"2.0","id":1,"result":'
        : 'data: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n');
      // Deliberately leave the body unfinished.
      reached.resolve(closed);
    }, async (mcpUrl) => {
      const delivered = [];
      const running = processTunnelCommand(command(), {
        mcpUrl, deliver: async (_command, payload) => delivered.push(payload),
      });
      const socketClosed = reached.promise;
      await within(running);
      await within(socketClosed);
      assert.equal(delivered.length, 1);
      assert.equal(delivered[0].resp_code, 502);
    });
  });
}

for (const kind of ["notification", "termination"]) {
  test(`${kind} cancels an unused response body before acknowledging`, { timeout: 5000 }, async () => {
    const socketClosed = deferred();
    await withServer((req, res) => {
      assert.equal(req.method, kind === "termination" ? "DELETE" : "POST");
      res.on("close", () => socketClosed.resolve());
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write('{"unused":');
      // The local server never finishes its body.
    }, async (mcpUrl) => {
      const delivered = [];
      await within(processTunnelCommand(command(kind === "termination"
        ? { command_type: "session_termination" }
        : { jsonrpc: { jsonrpc: "2.0", method: "notifications/initialized" } }), {
        mcpUrl, deliver: async (_command, payload) => delivered.push(payload),
      }));
      await within(socketClosed.promise);
      assert.equal(delivered.length, 1);
      assert.equal(delivered[0].resp_code, 200);
    });
  });
}

for (const stage of ["headers", "body"]) {
  test(`shutdown aborts an active local request waiting for ${stage} without fallback delivery`, { timeout: 5000 }, async (t) => {
    const errors = t.mock.method(console, "error", () => {});
    const arrived = deferred();
    const socketClosed = deferred();
    await withServer((_req, res) => {
      res.on("close", () => socketClosed.resolve());
      if (stage === "body") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.write('{"jsonrpc":"2.0","id":1,"result":');
      }
      arrived.resolve();
    }, async (mcpUrl) => {
      const controller = new AbortController();
      let deliveries = 0;
      const running = processTunnelCommand(command({ response_timeout: "30s" }), {
        mcpUrl,
        signal: controller.signal,
        deliver: async () => { deliveries++; },
      });
      await within(arrived.promise);
      controller.abort();
      await within(running);
      await within(socketClosed.promise);
      assert.equal(deliveries, 0);
      assert.equal(errors.mock.callCount(), 0);
    });
  });
}

test("a command already cancelled at shutdown never reaches the local server", { timeout: 5000 }, async () => {
  let requests = 0;
  await withServer((_req, res) => { requests++; res.end(); }, async (mcpUrl) => {
    const controller = new AbortController();
    controller.abort();
    await processTunnelCommand(command(), {
      mcpUrl,
      signal: controller.signal,
      deliver: async () => assert.fail("cancelled command was delivered"),
    });
    assert.equal(requests, 0);
  });
});

test("a completed response removes its abort listener", { timeout: 5000 }, async () => {
  await withServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"jsonrpc":"2.0","id":1,"result":{}}');
  }, async (mcpUrl) => {
    const controller = new AbortController();
    let added = 0;
    let removed = 0;
    const signal = controller.signal;
    const add = signal.addEventListener.bind(signal);
    const remove = signal.removeEventListener.bind(signal);
    signal.addEventListener = (...args) => { added++; return add(...args); };
    signal.removeEventListener = (...args) => { removed++; return remove(...args); };
    await processTunnelCommand(command(), { mcpUrl, signal, deliver: async () => {} });
    assert.equal(added, 1);
    assert.equal(removed, 1);
  });
});

test("deadline failure followed by terminal relay rejection stops without another response", { timeout: 5000 }, async (t) => {
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "warn", () => {});
  await withServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write('data: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n');
  }, async (mcpUrl) => {
    let deliveries = 0;
    await within(processTunnelCommand(command(), {
      mcpUrl,
      deliver: async () => {
        deliveries++;
        throw new RequestNotPendingError();
      },
    }));
    assert.equal(deliveries, 1);
  });
});

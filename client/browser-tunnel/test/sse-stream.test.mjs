import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { parseSseJson, readSseJson } from "../lib/sse.mjs";
import { processTunnelCommand } from "../lib/mcp-forwarder.mjs";
import { RequestNotPendingError, ResponseDeliveryError } from "../lib/response-delivery.mjs";

const progress = { jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } };
const final = { jsonrpc: "2.0", id: 1, result: { text: "中文🙂" } };
const event = (value) => `data: ${JSON.stringify(value)}\n\n`;
const command = (timeout = "2s") => ({
  request_id: "stream-test", command_type: "jsonrpc", response_timeout: timeout,
  jsonrpc: { jsonrpc: "2.0", id: 1, method: "tools/list" },
});

function byteStream(chunks, onCancel = () => {}) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
    cancel: onCancel,
  });
}

async function collect(stream) {
  const result = [];
  for await (const value of readSseJson(stream)) result.push(value);
  return result;
}

test("incremental parser handles every UTF-8 byte boundary, BOM, CRLF and multiline data", async () => {
  const input = '\uFEFF: keepalive\r\nevent: message\r\ndata: {"value":\r\ndata: "中文🙂"}\r\n\r\n'
    + 'id: primer\r\ndata:\r\n\r\n: comment\rdata: {"n":2}\r\r';
  const bytes = new TextEncoder().encode(input);
  assert.deepEqual(await collect(byteStream([...bytes].map((byte) => Uint8Array.of(byte)))), [
    { value: "中文🙂" }, { n: 2 },
  ]);
});

test("a split CRLF is one delimiter and EOF retains complete trailing JSON compatibility", async () => {
  const encoder = new TextEncoder();
  const chunks = ['data: {"a":', '\r', '\ndata: 1}', '\r', '\n', '\r', '\n', 'data: {"b":2}'];
  assert.deepEqual(await collect(byteStream(chunks.map((chunk) => encoder.encode(chunk)))), [{ a: 1 }, { b: 2 }]);
  assert.deepEqual(parseSseJson('data: {"a":1}'), [{ a: 1 }]);
});

test("stopping a parser after the first event cancels without parsing later malformed data", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(event(final) + "data: not-json\n\n"));
    },
    cancel() { cancelled = true; },
  });
  for await (const value of readSseJson(body)) {
    assert.deepEqual(value, final);
    break;
  }
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
});

async function withServer(handler, run) {
  let requests = 0;
  const server = createServer((req, res) => {
    requests++;
    req.resume();
    handler(req, res);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await run(`http://127.0.0.1:${server.address().port}/mcp`, () => requests);
  } finally {
    const closed = once(server, "close");
    server.close();
    server.closeAllConnections();
    await closed;
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("progress arrives before EOF and a final response closes an otherwise endless stream", { timeout: 5000 }, async () => {
  const closed = deferred();
  let response;
  const delivered = [];
  await withServer((_req, res) => {
    response = res;
    res.once("close", closed.resolve);
    res.writeHead(200, { "Content-Type": "text/event-stream", "Mcp-Session-Id": "test-session" });
    res.write(event(progress));
  }, async (mcpUrl, requests) => {
    await processTunnelCommand(command(), {
      mcpUrl,
      deliver: async (_command, payload) => {
        delivered.push(payload);
        assert.equal(response.writableEnded, false, "server never sends EOF");
        if (payload.resp_type === "jsonrpc_notify") response.write(event(final));
        else await bounded(closed.promise, "final delivery started before the local stream was cancelled");
      },
    });
    assert.equal(requests(), 1);
    assert.deepEqual(delivered.map((x) => x.resp_type), ["jsonrpc_notify", "jsonrpc_response"]);
    assert.deepEqual(delivered[1].resp_json, final);
    assert.deepEqual(delivered[1].resp_headers["Mcp-Session-Id"], ["test-session"]);
  });
});

test("final response is delivered before malformed trailing data in the same chunk", { timeout: 5000 }, async () => {
  const delivered = [];
  await withServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(event(final) + "data: malformed-after-final\n\n");
  }, async (mcpUrl) => {
    await processTunnelCommand(command(), { mcpUrl, deliver: async (_command, payload) => delivered.push(payload) });
    assert.equal(delivered.length, 1);
    assert.deepEqual(delivered[0].resp_json, final);
  });
});

test("a server request with the same id is not mistaken for the final result", { timeout: 5000 }, async () => {
  const delivered = [];
  const serverRequest = { jsonrpc: "2.0", id: 1, method: "ping" };
  await withServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(event({ ...final, id: 2 }) + event(serverRequest) + event(final));
  }, async (mcpUrl) => {
    await processTunnelCommand(command(), { mcpUrl, deliver: async (_command, payload) => delivered.push(payload) });
    assert.deepEqual(delivered.map((x) => x.resp_type), ["jsonrpc_notify", "jsonrpc_response"]);
    assert.deepEqual(delivered[1].resp_json, final);
  });
});

for (const terminal of [true, false]) {
  test(`${terminal ? "terminal 404" : "delivery error"} on first event cancels the stream without another response`, { timeout: 5000 }, async (t) => {
    t.mock.method(console, "warn", () => {});
    const errors = t.mock.method(console, "error", () => {});
    const closed = deferred();
    let deliveries = 0;
    await withServer((_req, res) => {
      res.once("close", closed.resolve);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(event(progress) + event(progress) + event(final));
    }, async (mcpUrl, requests) => {
      const pending = processTunnelCommand(command(), {
        mcpUrl,
        deliver: async () => {
          deliveries++;
          throw terminal ? new RequestNotPendingError() : new ResponseDeliveryError("test delivery failed");
        },
      });
      if (terminal) await pending;
      else await assert.rejects(pending, ResponseDeliveryError);
      await bounded(closed.promise, "stream stayed open after delivery failure");
      assert.equal(deliveries, 1);
      assert.equal(requests(), 1);
      assert.equal(errors.mock.callCount(), 0);
    });
  });
}

test("shutdown while waiting for the next SSE chunk closes the body without a fallback", { timeout: 5000 }, async () => {
  const abort = new AbortController();
  const closed = deferred();
  const first = deferred();
  const delivered = [];
  await withServer((_req, res) => {
    res.once("close", closed.resolve);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(event(progress));
  }, async (mcpUrl) => {
    const pending = processTunnelCommand(command(), {
      mcpUrl, signal: abort.signal,
      deliver: async (_command, payload) => { delivered.push(payload); first.resolve(); },
    });
    await first.promise;
    await delay(20);
    abort.abort();
    await pending;
    await bounded(closed.promise, "shutdown left the stream open");
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].resp_type, "jsonrpc_notify");
  });
});

test("a stalled SSE stream still expires at the local deadline", { timeout: 5000 }, async (t) => {
  t.mock.method(console, "error", () => {});
  const closed = deferred();
  const delivered = [];
  await withServer((_req, res) => {
    res.once("close", closed.resolve);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(event(progress));
  }, async (mcpUrl) => {
    await processTunnelCommand(command("150ms"), {
      mcpUrl, deliver: async (_command, payload) => delivered.push(payload),
    });
    await bounded(closed.promise, "deadline left the stream open");
    assert.deepEqual(delivered.map((x) => x.resp_code), [200, 502]);
    assert.equal(delivered[1].resp_json.error.code, -32603);
  });
});

test("a slow progress delivery cannot release a buffered final result after its deadline", { timeout: 5000 }, async (t) => {
  t.mock.method(console, "error", () => {});
  const closed = deferred();
  const delivered = [];
  await withServer((_req, res) => {
    res.once("close", closed.resolve);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(event(progress) + event(final));
  }, async (mcpUrl) => {
    await processTunnelCommand(command("150ms"), {
      mcpUrl,
      deliver: async (_command, payload) => {
        delivered.push(payload);
        if (payload.resp_type === "jsonrpc_notify") await delay(230);
      },
    });
    await bounded(closed.promise, "deadline left the stream open");
    assert.equal(delivered.length, 2);
    assert.equal(delivered[0].resp_type, "jsonrpc_notify");
    assert.equal(delivered[1].resp_code, 502);
    assert.equal(delivered.some((x) => x.resp_json?.result), false);
  });
});

for (const invalid of [false, true]) {
  test(`SSE ${invalid ? "malformed event" : "EOF without a final result"} sends one failure and releases the body`, { timeout: 5000 }, async (t) => {
    t.mock.method(console, "error", () => {});
    const closed = deferred();
    const delivered = [];
    await withServer((_req, res) => {
      res.once("close", closed.resolve);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(event(progress));
      if (invalid) res.write("data: invalid-json\n\n");
      else res.end();
    }, async (mcpUrl) => {
      await processTunnelCommand(command(), {
        mcpUrl, deliver: async (_command, payload) => delivered.push(payload),
      });
      await bounded(closed.promise, "failed SSE stream stayed open");
      assert.deepEqual(delivered.map((x) => x.resp_code), [200, 502]);
    });
  });
}

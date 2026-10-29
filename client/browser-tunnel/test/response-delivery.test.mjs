import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import {
  createResponseDelivery,
  RequestNotPendingError,
  ResponseDeliveryError,
} from "../lib/response-delivery.mjs";
import { processTunnelCommand } from "../lib/mcp-forwarder.mjs";

const stale = {
  status: 404,
  contentType: "application/json",
  json: { error: { code: "request_not_found" } },
};
const ok = {
  status: 200,
  contentType: "application/json",
  json: { status: "ok" },
};

function deliveryFixture(results, recovered = true) {
  const posts = [];
  const recoveries = [];
  return {
    posts,
    recoveries,
    deliver: createResponseDelivery({
      postResponse: async (command, payload) => {
        posts.push({ command, payload });
        const result = results[posts.length - 1];
        if (result instanceof Error) throw result;
        assert.ok(result, "unexpected extra response delivery");
        return result;
      },
    }, async (reason, result) => {
      recoveries.push({ reason, result });
      return recovered;
    }),
  };
}

test("response request_not_found is terminal without recovery or retry", async () => {
  const fixture = deliveryFixture([stale]);
  await assert.rejects(fixture.deliver({}, {}), RequestNotPendingError);
  assert.equal(fixture.posts.length, 1);
  assert.equal(fixture.recoveries.length, 0);
});

for (const result of [
  { status: 404, contentType: "text/html", text: "Not Found" },
  { status: 404, contentType: "application/json", json: { error: { code: "other" } } },
  { status: 401, contentType: "application/json", json: { error: { code: "request_not_found" } } },
  { status: 0, networkError: "Failed to fetch" },
]) {
  test(`nonterminal response status=${result.status} code=${result.json?.error?.code ?? "none"} still recovers`, async () => {
    const fixture = deliveryFixture([result, ok]);
    await fixture.deliver({}, {});
    assert.equal(fixture.posts.length, 2);
    assert.equal(fixture.recoveries.length, 1);
  });
}

test("request expiring during recovery ends delivery after the retry", async () => {
  const fixture = deliveryFixture([{ status: 401 }, stale]);
  await assert.rejects(fixture.deliver({}, {}), RequestNotPendingError);
  assert.equal(fixture.posts.length, 2);
  assert.equal(fixture.recoveries.length, 1);
});

test("stopping during recovery does not post again", async () => {
  const fixture = deliveryFixture([{ status: 401 }], false);
  await assert.rejects(fixture.deliver({}, {}), ResponseDeliveryError);
  assert.equal(fixture.posts.length, 1);
});

async function withMcp(kind, fn) {
  let requests = 0;
  const server = createServer((req, res) => {
    requests += 1;
    req.resume();
    if (kind === "notification") {
      res.writeHead(202).end();
    } else if (kind === "termination") {
      assert.equal(req.method, "DELETE");
      res.writeHead(200).end();
    } else if (kind === "sse") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(
        'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":1}}\n\n'
        + 'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":2}}\n\n'
        + 'data: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n',
      );
    } else if (kind === "invalid") {
      res.writeHead(502, { "Content-Type": "text/plain" }).end("unavailable");
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}');
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await fn(`http://127.0.0.1:${server.address().port}/mcp`, () => requests);
  } finally {
    const closed = once(server, "close");
    server.close();
    server.closeAllConnections();
    await closed;
  }
}

function commandFor(kind) {
  return {
    request_id: "test-request",
    command_type: kind === "termination" ? "session_termination" : "jsonrpc",
    response_timeout: "5s",
    jsonrpc: kind === "notification"
      ? { jsonrpc: "2.0", method: "notifications/initialized" }
      : { jsonrpc: "2.0", id: 1, method: "tools/list" },
  };
}

for (const kind of ["json", "notification", "termination", "sse", "invalid"]) {
  test(`stale ${kind} delivery ends the whole command without a fallback response`, { timeout: 5000 }, async (t) => {
    const warnings = t.mock.method(console, "warn", () => {});
    const errors = t.mock.method(console, "error", () => {});
    await withMcp(kind, async (mcpUrl, requestCount) => {
      const fixture = deliveryFixture([stale]);
      await processTunnelCommand(commandFor(kind), { mcpUrl, deliver: fixture.deliver });
      assert.equal(requestCount(), 1, "local operation must not be replayed");
      assert.equal(fixture.posts.length, 1, "no later SSE or fallback response");
      assert.equal(fixture.recoveries.length, 0);
      assert.equal(warnings.mock.callCount(), 1);
      assert.equal(errors.mock.callCount(), kind === "invalid" ? 1 : 0);
      if (kind === "invalid") {
        assert.equal(fixture.posts[0].payload.resp_code, 502);
      }
    });
  });
}

test("delivery failure is not reported as a local MCP failure or posted again", { timeout: 5000 }, async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  await withMcp("json", async (mcpUrl, requestCount) => {
    const fixture = deliveryFixture([{ status: 503 }, { status: 503 }]);
    await assert.rejects(
      processTunnelCommand(commandFor("json"), { mcpUrl, deliver: fixture.deliver }),
      ResponseDeliveryError,
    );
    assert.equal(requestCount(), 1);
    assert.equal(fixture.posts.length, 2, "one retry, no fallback delivery");
    assert.equal(fixture.recoveries.length, 1);
    assert.equal(errors.mock.callCount(), 0);
  });
});

test("a thrown transport delivery error does not trigger a fallback response", { timeout: 5000 }, async (t) => {
  t.mock.method(console, "error", () => {});
  await withMcp("termination", async (mcpUrl, requestCount) => {
    let deliveries = 0;
    const transportError = new Error("connection closed");
    await assert.rejects(
      processTunnelCommand(commandFor("termination"), {
        mcpUrl,
        deliver: async () => {
          deliveries += 1;
          throw transportError;
        },
      }),
      (error) => error instanceof ResponseDeliveryError && error.cause === transportError,
    );
    assert.equal(requestCount(), 1);
    assert.equal(deliveries, 1);
  });
});

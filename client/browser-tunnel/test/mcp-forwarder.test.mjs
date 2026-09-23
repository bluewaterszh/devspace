import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { once } from "node:events";
import { processTunnelCommand } from "../lib/mcp-forwarder.mjs";

async function withServer(handler, fn) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  try {
    await fn(`http://127.0.0.1:${address.port}/mcp`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

test("forwards SSE final response and MCP session header", async () => {
  await withServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => body += chunk);
    req.on("end", () => {
      const json = JSON.parse(body);
      assert.equal(json.method, "initialize");
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Mcp-Session-Id", "session-123");
      res.end(
        'event: message\n'
        + 'data: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n',
      );
    });
  }, async (mcpUrl) => {
    const delivered = [];
    await processTunnelCommand({
      request_id: "req-1",
      shard_token: "shard-1",
      command_type: "jsonrpc",
      channel: "main",
      response_timeout: "30s",
      headers: {
        Accept: ["application/json", "text/event-stream"],
        "Content-Type": ["application/json"],
      },
      jsonrpc: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      },
    }, {
      mcpUrl,
      deliver: async (_command, payload) => delivered.push(payload),
    });

    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].resp_type, "jsonrpc_response");
    assert.equal(delivered[0].resp_code, 200);
    assert.equal(
      delivered[0].resp_headers["Mcp-Session-Id"][0],
      "session-123",
    );
    assert.deepEqual(delivered[0].resp_json, {
      jsonrpc: "2.0",
      id: 1,
      result: { ok: true },
    });
  });
});

test("acknowledges JSON-RPC notification after local 202", async () => {
  await withServer((req, res) => {
    assert.equal(req.method, "POST");
    res.statusCode = 202;
    res.end();
  }, async (mcpUrl) => {
    const delivered = [];
    await processTunnelCommand({
      request_id: "req-2",
      shard_token: "shard-2",
      command_type: "jsonrpc",
      channel: "main",
      response_timeout: "30s",
      headers: {
        "Content-Type": ["application/json"],
        "Mcp-Session-Id": ["session-123"],
      },
      jsonrpc: {
        jsonrpc: "2.0",
        method: "notifications/initialized",
      },
    }, {
      mcpUrl,
      deliver: async (_command, payload) => delivered.push(payload),
    });

    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].resp_type, "notify_ack");
    assert.equal(delivered[0].resp_code, 202);
  });
});

test("forwards session termination as DELETE", async () => {
  await withServer((req, res) => {
    assert.equal(req.method, "DELETE");
    assert.equal(req.headers["mcp-session-id"], "session-123");
    res.statusCode = 200;
    res.end();
  }, async (mcpUrl) => {
    const delivered = [];
    await processTunnelCommand({
      request_id: "req-3",
      shard_token: "shard-3",
      command_type: "session_termination",
      channel: "main",
      response_timeout: "30s",
      headers: {
        "Mcp-Session-Id": ["session-123"],
      },
    }, {
      mcpUrl,
      deliver: async (_command, payload) => delivered.push(payload),
    });

    assert.equal(delivered.length, 1);
    assert.equal(
      delivered[0].resp_type,
      "session_termination_response",
    );
    assert.equal(delivered[0].resp_code, 200);
  });
});

import assert from "node:assert/strict";
import test from "node:test";
import { parseSseJson } from "../lib/sse.mjs";

test("parses multiple JSON SSE messages", () => {
  const input = [
    "event: message",
    'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"p":1}}',
    "",
    "event: message",
    'data: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}',
    "",
  ].join("\n");

  assert.deepEqual(parseSseJson(input), [
    {
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: { p: 1 },
    },
    {
      jsonrpc: "2.0",
      id: 1,
      result: { ok: true },
    },
  ]);
});

test("joins multiline SSE data", () => {
  assert.deepEqual(
    parseSseJson('data: {"a":\ndata: 1}\n\n'),
    [{ a: 1 }],
  );
});

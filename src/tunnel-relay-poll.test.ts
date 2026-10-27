import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { get, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { ServerConfig } from "./config.js";
import { createRelayApplications } from "./tunnel-relay.js";

interface Command {
  request_id: string;
  shard_token: string;
  jsonrpc: { id: number; method: string };
}

async function fixture(t: TestContext) {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-poll-test-"));
  const listener = {
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: "http://127.0.0.1",
    allowedHosts: ["127.0.0.1"],
    trustProxy: false,
  };
  const config: ServerConfig = {
    configDir: stateDir,
    stateDir,
    openai: { ...listener },
    tunnel: { ...listener },
    oauth: {
      ownerToken: "poll-test-owner-token",
      accessTokenTtlSeconds: 3600,
      refreshTokenTtlSeconds: 86400,
      scopes: ["devspace"],
      allowedResourceUrls: [],
      allowedRedirectHosts: ["127.0.0.1"],
    },
    relay: {
      tunnelToken: "poll-test-tunnel-token",
      responseTimeoutMs: 5000,
      maxPollWaitMs: 3000,
    },
  };
  const tunnelId = "tunnel_0123456789abcdef0123456789abcdef";
  const apps = createRelayApplications(config, [{ slug: "probe", tunnelId }]);
  const servers: Server[] = [];
  t.after(async () => {
    await apps.close();
    await Promise.all(servers.map((server) => {
      server.closeAllConnections();
      return new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }));
    rmSync(stateDir, { recursive: true, force: true });
  });
  async function listen(app: { listen(port: number, host: string): Server }) {
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address === "object");
    return { server, base: "http://127.0.0.1:" + address.port };
  }
  const openai = await listen(apps.openaiApp);
  const tunnel = await listen(apps.tunnelApp);
  const accessToken = await authorize(openai.base, config);
  const headers = { authorization: "Bearer " + config.relay.tunnelToken };
  const path = tunnel.base + "/v1/tunnels/" + tunnelId;
  const pollUrl = (waitMs: number, limit = 25) =>
    path + "/poll?timeout_ms=" + waitMs + "&limit=" + limit;

  async function snapshot() {
    const response = await fetch(tunnel.base + "/healthz");
    const body = await response.json() as {
      tunnels: Record<string, { queued: number; pending: number }>;
    };
    const { queued, pending } = body.tunnels.probe!;
    return { queued, pending };
  }
  async function waitQueued(count: number) {
    for (let i = 0; i < 100; i++) {
      if ((await snapshot()).queued === count) return;
      await delay(10);
    }
    assert.equal((await snapshot()).queued, count);
  }
  async function pendingPoll(waitMs = 3000) {
    const arrived = once(tunnel.server, "request");
    const response = fetch(pollUrl(waitMs), { headers });
    await arrived;
    return { response };
  }
  async function abandonPoll() {
    const arrived = once(tunnel.server, "request");
    const request = get(pollUrl(3000), { headers, agent: false });
    request.on("error", () => {});
    t.after(() => { request.destroy(); });
    const [, response] = await arrived as [unknown, ServerResponse];
    const closed = once(response, "close");
    request.destroy();
    await closed;
  }
  function initialize(id: number) {
    return fetch(openai.base + "/mcp/probe", {
      method: "POST",
      headers: {
        authorization: "Bearer " + accessToken,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "poll-test", version: "1" },
        },
      }),
    });
  }
  async function poll(limit = 25) {
    return fetch(pollUrl(0, limit), { headers });
  }
  async function commands(response: Response): Promise<Command[]> {
    assert.equal(response.status, 200);
    return (await response.json() as { commands: Command[] }).commands;
  }
  async function respond(command: Command) {
    const response = await fetch(path + "/response", {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json",
        "x-tunnel-shard-token": command.shard_token,
      },
      body: JSON.stringify({
        request_id: command.request_id,
        resp_code: 200,
        resp_type: "jsonrpc_response",
        resp_json: { jsonrpc: "2.0", id: command.jsonrpc.id, result: { ok: true } },
      }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok" });
  }
  async function completed(response: Promise<Response>, id: number) {
    const result = await response;
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), { jsonrpc: "2.0", id, result: { ok: true } });
  }
  return {
    snapshot, waitQueued, pendingPoll, abandonPoll, initialize,
    poll, commands, respond, completed,
  };
}

test("a disconnected poll leaves the next initialization for the reconnected client", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  await f.abandonPoll();
  const response = f.initialize(1);
  await f.waitQueued(1);
  assert.deepEqual(await f.snapshot(), { queued: 1, pending: 1 });
  const commands = await f.commands(await f.poll());
  assert.equal(commands.length, 1);
  assert.equal(commands[0]!.jsonrpc.id, 1);
  await f.respond(commands[0]!);
  await f.completed(response, 1);
  assert.equal((await f.poll()).status, 204);
  assert.deepEqual(await f.snapshot(), { queued: 0, pending: 0 });
});

test("disconnecting an older poll does not consume work intended for a live poll", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  await f.abandonPoll();
  const live = await f.pendingPoll();
  const response = f.initialize(2);
  const commands = await f.commands(await live.response);
  assert.equal(commands.length, 1);
  assert.equal(commands[0]!.jsonrpc.id, 2);
  await f.respond(commands[0]!);
  await f.completed(response, 2);
  assert.deepEqual(await f.snapshot(), { queued: 0, pending: 0 });
});

test("repeated reconnects preserve queued batches without duplicate delivery", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 12; i++) await f.abandonPoll();
  const responses = new Map<number, Promise<Response>>();
  for (const id of [3, 4, 5]) {
    responses.set(id, f.initialize(id));
    await f.waitQueued(responses.size);
  }
  const first = await f.commands(await f.poll(2));
  const second = await f.commands(await f.poll(2));
  assert.deepEqual(first.map((command) => command.jsonrpc.id), [3, 4]);
  assert.deepEqual(second.map((command) => command.jsonrpc.id), [5]);
  assert.equal((await f.poll()).status, 204);
  for (const command of [...first, ...second]) {
    await f.respond(command);
    await f.completed(responses.get(command.jsonrpc.id)!, command.jsonrpc.id);
  }
  assert.deepEqual(await f.snapshot(), { queued: 0, pending: 0 });
});

test("an idle poll times out normally and a later poll still receives work", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const idle = await f.pendingPoll(25);
  assert.equal((await idle.response).status, 204);
  const live = await f.pendingPoll();
  const response = f.initialize(6);
  const commands = await f.commands(await live.response);
  assert.equal(commands.length, 1);
  await f.respond(commands[0]!);
  await f.completed(response, 6);
  assert.deepEqual(await f.snapshot(), { queued: 0, pending: 0 });
});

async function authorize(base: string, config: ServerConfig): Promise<string> {
  const redirectUri = "http://127.0.0.1/callback";
  const registration = await fetch(base + "/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "poll-regression",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
    }),
  });
  assert.equal(registration.status, 201);
  const client = await registration.json() as { client_id: string };
  const verifier = "poll-regression-verifier-".repeat(3);
  const resource = new URL("/mcp/probe", config.openai.publicBaseUrl).href;
  const authorization = await fetch(base + "/authorize", {
    method: "POST",
    redirect: "manual",
    body: new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: redirectUri,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      scope: "devspace",
      resource,
      owner_token: config.oauth.ownerToken,
    }),
  });
  assert.equal(authorization.status, 302);
  const code = new URL(authorization.headers.get("location")!).searchParams.get("code");
  assert.ok(code);
  await authorization.text();
  const token = await fetch(base + "/token", {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: client.client_id,
      redirect_uri: redirectUri,
      code,
      code_verifier: verifier,
      resource,
    }),
  });
  assert.equal(token.status, 200);
  return (await token.json() as { access_token: string }).access_token;
}

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { ServerConfig } from "./config.js";
import {
  createRelayApplications,
  type TunnelDefinition,
} from "./tunnel-relay.js";

const stateDir = mkdtempSync(join(tmpdir(), "devspace-relay-state-"));
const config: ServerConfig = {
  configDir: stateDir,
  openai: {
    host: "127.0.0.1",
    port: 18550,
    publicBaseUrl: "http://127.0.0.1:18550",
    allowedHosts: ["127.0.0.1"],
    trustProxy: false,
  },
  tunnel: {
    host: "127.0.0.1",
    port: 18551,
    publicBaseUrl: "http://127.0.0.1:18551",
    allowedHosts: ["127.0.0.1"],
    trustProxy: false,
  },
  stateDir,
  oauth: {
    ownerToken: "owner-secret-value-123456",
    accessTokenTtlSeconds: 3600,
    refreshTokenTtlSeconds: 86400,
    scopes: ["devspace"],
    allowedResourceUrls: [],
    allowedRedirectHosts: ["localhost", "127.0.0.1", "chatgpt.com"],
  },
  relay: {
    tunnelToken: "tunnel-secret-value-123456",
    responseTimeoutMs: 10000,
    maxPollWaitMs: 1000,
  },
};

const tunnels: TunnelDefinition[] = [
  {
    slug: "lisa",
    tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
  },
  {
    slug: "10236",
    tunnelId: "tunnel_fedcba9876543210fedcba9876543210",
  },
];

const apps = createRelayApplications(config, tunnels);
const openai = await listen(apps.openaiApp);
const tunnel = await listen(apps.tunnelApp);

try {
  const openaiBase = base(openai);
  const tunnelBase = base(tunnel);

  assert.equal((await fetch(`${openaiBase}/healthz`)).status, 200);
  assert.equal((await fetch(`${openaiBase}/mcp`)).status, 404);
  assert.equal((await fetch(`${openaiBase}/mcp/lisa`)).status, 405);
  assert.equal((await fetch(`${openaiBase}/mcp/10236`)).status, 405);

  assert.equal((await fetch(`${tunnelBase}/healthz`)).status, 200);
  assert.equal((await fetch(`${tunnelBase}/mcp`, { method: "POST" })).status, 404);

  for (const entry of tunnels) {
    assert.equal(
      (await fetch(`${tunnelBase}/v1/tunnels/${entry.tunnelId}`)).status,
      401,
    );

    const control = await fetch(
      `${tunnelBase}/v1/tunnels/${entry.tunnelId}`,
      {
        headers: { authorization: `Bearer ${config.relay.tunnelToken}` },
      },
    );
    assert.equal(control.status, 200);
    assert.equal((await control.json() as { id: string }).id, entry.tunnelId);
  }

  const wrong = await fetch(
    `${tunnelBase}/v1/tunnels/tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`,
    {
      headers: { authorization: `Bearer ${config.relay.tunnelToken}` },
    },
  );
  assert.equal(wrong.status, 404);
} finally {
  await Promise.all([close(openai), close(tunnel)]);
  await apps.close();
  rmSync(stateDir, { recursive: true, force: true });
}

console.log("relay surface tests passed");

function listen(app: { listen(port: number, host: string): Server }): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1");
    server.once("listening", () => resolve(server));
    server.once("error", reject);
  });
}

function base(server: Server): string {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing address");
  return `http://127.0.0.1:${address.port}`;
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import {
  BrowserControlPlane,
  isControlPlaneResponse,
} from "../lib/control-plane.mjs";
import { processTunnelCommand } from "../lib/mcp-forwarder.mjs";

const { values } = parseArgs({
  options: {
    "control-plane": { type: "string" },
    "tunnel-id": { type: "string" },
    "mcp-url": { type: "string" },
    proxy: { type: "string" },
    browser: { type: "string" },
    "profile-dir": { type: "string" },
    "approve-selector": { type: "string" },
    "sso-wait-seconds": { type: "string" },
    "probe-only": { type: "boolean" },
    "poll-timeout-ms": { type: "string" },
    "poll-limit": { type: "string" },
    concurrency: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
  allowPositionals: false,
});

if (values.help) {
  printHelp();
  process.exit(0);
}

const config = {
  controlPlane: values["control-plane"]
    ?? process.env.DEVSPACE_CONTROL_PLANE
    ?? "https://www.astmars.com",
  tunnelId: values["tunnel-id"]
    ?? process.env.TUNNEL_ID
    ?? process.env.CONTROL_PLANE_TUNNEL_ID,
  token: process.env.DEVSPACE_TUNNEL_TOKEN
    ?? process.env.CONTROL_PLANE_API_KEY,
  mcpUrl: values["mcp-url"]
    ?? process.env.MCP_URL
    ?? process.env.MCP_SERVER_URL
    ?? "http://127.0.0.1:3010/",
  proxy: values.proxy
    ?? process.env.HTTPS_PROXY
    ?? process.env.https_proxy
    ?? process.env.HTTP_PROXY
    ?? process.env.http_proxy,
  browserChannel: values.browser
    ?? process.env.DEVSPACE_BROWSER
    ?? "chrome",
  profileDir: values["profile-dir"]
    ? resolve(values["profile-dir"])
    : process.env.DEVSPACE_BROWSER_PROFILE
      ? resolve(process.env.DEVSPACE_BROWSER_PROFILE)
      : undefined,
  approveSelector: values["approve-selector"]
    ?? process.env.DEVSPACE_SSO_APPROVE_SELECTOR,
  ssoWaitMs: 1000 * positiveInt(
    values["sso-wait-seconds"] ?? process.env.DEVSPACE_SSO_WAIT_SECONDS,
    180,
  ),
  probeOnly: values["probe-only"] ?? false,
  pollTimeoutMs: positiveInt(values["poll-timeout-ms"], 30_000),
  pollLimit: positiveInt(values["poll-limit"], 20),
  concurrency: positiveInt(values.concurrency, 4),
  mcpAuthorization: process.env.MCP_TOKEN
    ? `Bearer ${process.env.MCP_TOKEN}`
    : undefined,
};

if (!config.tunnelId) fail("missing --tunnel-id or TUNNEL_ID");
if (!config.token) fail("missing DEVSPACE_TUNNEL_TOKEN/CONTROL_PLANE_API_KEY");

const control = new BrowserControlPlane({
  baseUrl: config.controlPlane,
  tunnelId: config.tunnelId,
  token: config.token,
  browserChannel: config.browserChannel,
  profileDir: config.profileDir,
  proxy: config.proxy,
  approveSelector: config.approveSelector,
  ssoWaitMs: config.ssoWaitMs,
});

let stopping = false;
const active = new Set();

const stop = () => {
  stopping = true;
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

try {
  console.log(
    `starting browser tunnel tunnel=${config.tunnelId} `
      + `control=${config.controlPlane} mcp=${config.mcpUrl} `
      + `browser=${config.browserChannel} proxy=${config.proxy ? "configured" : "system/default"}`,
  );

  await control.start();

  if (config.probeOnly) {
    console.log("probe-only succeeded; browser-backed control plane is usable.");
    process.exitCode = 0;
  } else {
    while (!stopping) {
      let polled;

      try {
        polled = await control.poll(config.pollLimit, config.pollTimeoutMs);
      } catch (error) {
        console.warn(
          `poll browser fetch failed: ${error instanceof Error ? error.message : error}`,
        );
        await control.ensureAuthorized();
        continue;
      }

      const receivedAtMs = Date.now();

      if (polled.status === 204) continue;

      if (
        !isControlPlaneResponse(polled)
        || polled.status !== 200
        || !Array.isArray(polled.json?.commands)
      ) {
        await control.recoverSso(polled);
        continue;
      }

      for (const command of polled.json.commands) {
        while (!stopping && active.size >= config.concurrency) {
          await Promise.race(active);
        }
        if (stopping) break;

        const task = processTunnelCommand(command, {
          mcpUrl: config.mcpUrl,
          mcpAuthorization: config.mcpAuthorization,
          receivedAtMs,
          deliver: async (sourceCommand, payload) => {
            let result = await control.postResponse(sourceCommand, payload);
            if (
              !isControlPlaneResponse(result)
              || result.status !== 200
              || result.json?.status !== "ok"
            ) {
              await control.recoverSso(result);
              result = await control.postResponse(sourceCommand, payload);
            }

            if (
              !isControlPlaneResponse(result)
              || result.status !== 200
              || result.json?.status !== "ok"
            ) {
              throw new Error(
                `response delivery failed status=${result.status} `
                  + `url=${result.url} request_id=${sourceCommand.request_id}`,
              );
            }
          },
        }).catch((error) => {
          console.error(
            `worker failed id=${command.request_id ?? randomUUID()}: `
              + (error instanceof Error ? error.stack ?? error.message : error),
          );
        }).finally(() => {
          active.delete(task);
        });

        active.add(task);
      }
    }
  }

  await Promise.allSettled(active);
} finally {
  await control.close();
}

function positiveInt(raw, fallback) {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail(`expected positive integer, got ${raw}`);
  }
  return value;
}

function fail(message) {
  console.error(message);
  process.exit(2);
}

function printHelp() {
  console.log(`
DevSpace browser-backed tunnel client

Usage:
  devspace-browser-tunnel [options]

Required environment:
  DEVSPACE_TUNNEL_TOKEN    Tunnel control-plane bearer token
  TUNNEL_ID                Tunnel id (or pass --tunnel-id)

Common options:
  --control-plane URL      Default: https://www.astmars.com
  --tunnel-id ID           Tunnel id
  --mcp-url URL            Default: http://127.0.0.1:3010/
  --proxy URL              Browser proxy; defaults to HTTPS_PROXY/HTTP_PROXY
  --browser NAME           chrome (default) or msedge
  --profile-dir PATH       Persistent browser profile directory
  --approve-selector CSS   Optional exact SSO approve button selector
  --sso-wait-seconds N     Wait for browser SSO approval; default: 180
  --probe-only             Verify browser-backed control-plane access and exit
  --poll-timeout-ms N      Default: 30000
  --poll-limit N           Default: 20
  --concurrency N          Default: 4

The program launches a dedicated persistent browser profile. The browser handles
enterprise SSO; Node handles local MCP forwarding. Control-plane fetches execute
inside a blank same-origin browser page so the tunnel bearer token is not exposed
to third-party page scripts.
`.trim());
}

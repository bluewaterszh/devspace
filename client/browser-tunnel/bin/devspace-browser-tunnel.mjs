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
    browser: { type: "string" },
    "profile-dir": { type: "string" },
    "approve-selector": { type: "string" },
    "sso-wait-seconds": { type: "string" },
    "browser-watchdog-seconds": { type: "string" },
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
  autoApprove: envFlag(process.env.DEVSPACE_SSO_AUTO_APPROVE, true),
  ssoWaitMs: 1000 * positiveInt(
    values["sso-wait-seconds"] ?? process.env.DEVSPACE_SSO_WAIT_SECONDS,
    180,
  ),
  watchdogIntervalMs: 1000 * positiveInt(
    values["browser-watchdog-seconds"]
      ?? process.env.DEVSPACE_BROWSER_WATCHDOG_SECONDS,
    15,
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
  approveSelector: config.approveSelector,
  autoApprove: config.autoApprove,
  ssoWaitMs: config.ssoWaitMs,
  watchdogIntervalMs: config.watchdogIntervalMs,
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
      + `browser=${config.browserChannel}`,
  );

  if (config.probeOnly) {
    await control.start();
    console.log("probe-only succeeded; browser-backed control plane is usable.");
    process.exitCode = 0;
  } else {
    try {
      await control.start();
    } catch (error) {
      console.warn(
        `initial browser/session setup needs recovery: ${errorMessage(error)}`,
      );
      await recoverUntilReady("initial browser/session setup");
    }

    while (!stopping) {
      let polled;

      try {
        polled = await control.poll(config.pollLimit, config.pollTimeoutMs);
      } catch (error) {
        console.warn(`poll browser fetch failed: ${errorMessage(error)}`);
        await recoverUntilReady("poll browser fetch failed");
        continue;
      }

      const receivedAtMs = Date.now();

      if (polled.status === 204) continue;

      if (
        !isControlPlaneResponse(polled)
        || polled.status !== 200
        || !Array.isArray(polled.json?.commands)
      ) {
        await recoverUntilReady("poll response requires browser/session recovery", polled);
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
              await recoverUntilReady(
                `response delivery recovery request_id=${sourceCommand.request_id}`,
                result,
              );
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

async function recoverUntilReady(reason, result) {
  let attempt = 0;
  let diagnostic = result;

  while (!stopping) {
    attempt += 1;
    try {
      await control.recover(reason, diagnostic);
      return true;
    } catch (error) {
      console.warn(
        `AUTH_RECOVERY_PENDING attempt=${attempt} reason=${reason}: ${errorMessage(error)}`,
      );
      diagnostic = undefined;
      await sleep(Math.min(10_000, 2_000 * attempt));
    }
  }

  return false;
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error ?? "unknown error");
}

function envFlag(raw, fallback) {
  if (raw === undefined || raw === "") return fallback;
  const value = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  fail(`expected boolean flag, got ${raw}`);
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
  --browser NAME           chrome (default) or msedge
  --profile-dir PATH       Persistent browser profile directory
  --approve-selector CSS   Optional exact SSO approve button selector
                           (otherwise safe text-based auto-approval is enabled)
  --sso-wait-seconds N     Wait per SSO recovery attempt; default: 180
  --browser-watchdog-seconds N
                           Detect/relaunch a closed browser; default: 15
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

import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthRouter,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import express, { type Express, type Request, type Response } from "express";
import type { ServerConfig } from "./config.js";
import { SingleUserOAuthProvider } from "./oauth-provider.js";

const MAX_POLL_BATCH = 25;
const RESPONSE_HEADER_ALLOWLIST = new Set([
  "content-type",
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
  "access-control-expose-headers",
  "www-authenticate",
]);
const REQUEST_HEADER_ALLOWLIST = [
  "accept",
  "content-type",
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
] as const;

interface JsonRpcCommand {
  request_id: string;
  shard_token: string;
  command_type: "jsonrpc";
  channel: "main";
  created_at: string;
  response_timeout: string;
  headers: Record<string, string[]>;
  jsonrpc: unknown;
}

interface SessionTerminationCommand {
  request_id: string;
  shard_token: string;
  command_type: "session_termination";
  channel: "main";
  created_at: string;
  response_timeout: string;
  headers: Record<string, string[]>;
}

type TunnelCommand = JsonRpcCommand | SessionTerminationCommand;

interface TunnelResponsePayload {
  request_id?: unknown;
  resp_json?: unknown;
  resp_headers?: unknown;
  resp_code?: unknown;
  resp_type?: unknown;
}

interface PendingRequest {
  requestId: string;
  shardToken: string;
  response: Response;
  acceptsSse: boolean;
  sseStarted: boolean;
  timer: NodeJS.Timeout;
}

interface PollWaiter {
  wake(): void;
  timer: NodeJS.Timeout;
}

export interface RelayApplications {
  openaiApp: ReturnType<typeof createMcpExpressApp>;
  tunnelApp: Express;
  close(): Promise<void>;
}

class TunnelRelayState {
  private readonly commands: TunnelCommand[] = [];
  private readonly pending = new Map<string, PendingRequest>();
  private readonly pollWaiters = new Set<PollWaiter>();
  private closed = false;
  private lastPollAt?: string;

  constructor(private readonly config: ServerConfig) {}

  snapshot(): { queued: number; pending: number; lastPollAt?: string } {
    return {
      queued: this.commands.length,
      pending: this.pending.size,
      lastPollAt: this.lastPollAt,
    };
  }

  enqueueJsonRpc(req: Request, res: Response): void {
    this.enqueue(req, res, "jsonrpc", req.body);
  }

  enqueueSessionTermination(req: Request, res: Response): void {
    this.enqueue(req, res, "session_termination");
  }

  async poll(limit: number, waitMs: number): Promise<TunnelCommand[]> {
    this.lastPollAt = new Date().toISOString();
    const ready = this.take(limit);
    if (ready.length > 0 || waitMs === 0 || this.closed) return ready;

    await new Promise<void>((resolve) => {
      const waiter: PollWaiter = {
        wake: () => {
          clearTimeout(waiter.timer);
          this.pollWaiters.delete(waiter);
          resolve();
        },
        timer: setTimeout(() => {
          this.pollWaiters.delete(waiter);
          resolve();
        }, waitMs),
      };
      waiter.timer.unref?.();
      this.pollWaiters.add(waiter);
    });

    return this.take(limit);
  }

  acceptResponse(
    shardToken: string | undefined,
    payload: TunnelResponsePayload,
  ): "ok" | "not_found" | "invalid_shard" | "invalid_payload" {
    if (typeof payload.request_id !== "string") return "invalid_payload";
    const pending = this.pending.get(payload.request_id);
    if (!pending) return "not_found";
    if (!shardToken || !safeEquals(shardToken, pending.shardToken)) return "invalid_shard";

    const responseType = typeof payload.resp_type === "string"
      ? payload.resp_type
      : "jsonrpc_response";

    if (responseType === "jsonrpc_notify") {
      if (payload.resp_json === undefined) return "invalid_payload";
      if (pending.acceptsSse) {
        if (!pending.sseStarted) startSse(pending.response);
        pending.sseStarted = true;
        writeSse(pending.response, payload.resp_json);
      }
      return "ok";
    }

    if (![
      "jsonrpc_response",
      "notify_ack",
      "session_termination_response",
    ].includes(responseType)) {
      return "invalid_payload";
    }

    clearTimeout(pending.timer);
    this.pending.delete(pending.requestId);
    const status = normalizeStatus(payload.resp_code);

    if (pending.acceptsSse && payload.resp_json !== undefined) {
      if (!pending.sseStarted) {
        pending.response.status(status >= 200 && status < 300 ? 200 : status);
        startSse(pending.response);
        pending.sseStarted = true;
      }
      writeSse(pending.response, payload.resp_json);
      pending.response.end();
      return "ok";
    }

    applyResponseHeaders(pending.response, responseHeaders(payload.resp_headers));
    pending.response.status(status);
    if (payload.resp_json === undefined) pending.response.end();
    else pending.response.json(payload.resp_json);
    return "ok";
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.wakePollers();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      if (!pending.response.headersSent) {
        pending.response.status(503).json({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32603, message: "Relay is shutting down" },
        });
      } else {
        pending.response.end();
      }
    }
    this.pending.clear();
    this.commands.length = 0;
  }

  private enqueue(
    req: Request,
    res: Response,
    commandType: "jsonrpc" | "session_termination",
    jsonrpc?: unknown,
  ): void {
    if (this.closed) {
      res.status(503).json({ error: "relay is shutting down" });
      return;
    }

    const requestId = `req_${randomUUID()}`;
    const shardToken = randomBytes(24).toString("base64url");
    const base = {
      request_id: requestId,
      shard_token: shardToken,
      channel: "main" as const,
      created_at: new Date().toISOString(),
      response_timeout: `${Math.ceil(this.config.relay.responseTimeoutMs / 1000)}s`,
      headers: requestHeaders(req),
    };
    const command: TunnelCommand = commandType === "jsonrpc"
      ? { ...base, command_type: "jsonrpc", jsonrpc }
      : { ...base, command_type: "session_termination" };

    const timer = setTimeout(() => {
      const current = this.pending.get(requestId);
      if (!current) return;
      this.pending.delete(requestId);
      if (!current.response.headersSent) {
        current.response.status(504).json({
          jsonrpc: "2.0",
          id: jsonRpcId(jsonrpc),
          error: { code: -32603, message: "Tunnel response timed out" },
        });
      } else {
        current.response.end();
      }
    }, this.config.relay.responseTimeoutMs);
    timer.unref?.();

    this.pending.set(requestId, {
      requestId,
      shardToken,
      response: res,
      acceptsSse: req.accepts("text/event-stream") === "text/event-stream",
      sseStarted: false,
      timer,
    });
    this.commands.push(command);
    this.wakePollers();

    res.once("close", () => {
      if (res.writableEnded) return;
      const current = this.pending.get(requestId);
      if (!current) return;
      clearTimeout(current.timer);
      this.pending.delete(requestId);
    });
  }

  private take(limit: number): TunnelCommand[] {
    return this.commands.splice(0, limit);
  }

  private wakePollers(): void {
    for (const waiter of Array.from(this.pollWaiters)) waiter.wake();
  }
}

export function createRelayApplications(config: ServerConfig): RelayApplications {
  const state = new TunnelRelayState(config);
  const mcpUrl = new URL("/mcp", config.openai.publicBaseUrl);
  const resourceServerUrl = resourceUrlFromServerUrl(mcpUrl);
  const oauthProvider = new SingleUserOAuthProvider(config.oauth, mcpUrl, config.stateDir);
  const bearerAuth = requireBearerAuth({
    verifier: oauthProvider,
    requiredScopes: [config.oauth.scopes[0] ?? "devspace"],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl),
  });

  const openaiApp = createMcpExpressApp({
    host: config.openai.host,
    allowedHosts: config.openai.allowedHosts,
  });
  if (config.openai.trustProxy) openaiApp.set("trust proxy", true);

  openaiApp.use(mcpAuthRouter({
    provider: oauthProvider,
    issuerUrl: new URL(config.openai.publicBaseUrl),
    baseUrl: new URL(config.openai.publicBaseUrl),
    resourceServerUrl,
    scopesSupported: config.oauth.scopes,
    resourceName: config.relay.name,
  }));

  openaiApp.get("/healthz", (_req, res) => {
    res.json({ ok: true, surface: "openai", pending: state.snapshot().pending });
  });

  openaiApp.post("/mcp", async (req, res) => {
    await runBearerAuth(bearerAuth, req, res);
    if (res.headersSent) return;
    if (!req.auth?.resource || !oauthProvider.isResourceAllowed(req.auth.resource)) {
      res.status(401).json({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32001, message: "Unauthorized" },
      });
      return;
    }
    if (!req.body || typeof req.body !== "object") {
      res.status(400).json({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid Request" },
      });
      return;
    }
    state.enqueueJsonRpc(req, res);
  });

  openaiApp.delete("/mcp", async (req, res) => {
    await runBearerAuth(bearerAuth, req, res);
    if (res.headersSent) return;
    if (!req.header("mcp-session-id")) {
      res.status(400).json({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Mcp-Session-Id is required" },
      });
      return;
    }
    state.enqueueSessionTermination(req, res);
  });

  openaiApp.get("/mcp", (_req, res) => {
    res.setHeader("Allow", "POST, DELETE");
    res.status(405).end();
  });

  const tunnelApp = express();
  tunnelApp.disable("x-powered-by");
  tunnelApp.use(express.json({ limit: "2mb" }));
  if (config.tunnel.trustProxy) tunnelApp.set("trust proxy", true);

  tunnelApp.get("/healthz", (_req, res) => {
    res.json({
      ok: true,
      surface: "tunnel",
      tunnel_id: config.relay.tunnelId,
      ...state.snapshot(),
    });
  });

  tunnelApp.get("/v1/tunnels/:tunnelId", (req, res) => {
    if (!authorizeTunnel(req, res, config)) return;
    res.json({
      id: config.relay.tunnelId,
      name: config.relay.name,
      description: config.relay.description,
    });
  });

  tunnelApp.get("/v1/tunnels/:tunnelId/poll", async (req, res) => {
    if (!authorizeTunnel(req, res, config)) return;
    const commands = await state.poll(
      parsePollLimit(req.query.limit),
      parsePollWait(req.query.timeout_ms, config.relay.maxPollWaitMs),
    );
    if (commands.length === 0) {
      res.status(204).end();
      return;
    }
    res.json({ commands });
  });

  tunnelApp.post("/v1/tunnels/:tunnelId/response", (req, res) => {
    if (!authorizeTunnel(req, res, config)) return;
    const result = state.acceptResponse(
      req.header("x-tunnel-shard-token"),
      (req.body ?? {}) as TunnelResponsePayload,
    );
    if (result === "not_found") {
      res.status(404).json({ error: { code: "request_not_found", message: "Request is no longer pending" } });
      return;
    }
    if (result === "invalid_shard") {
      res.status(403).json({ error: { code: "invalid_shard_token", message: "Invalid shard token" } });
      return;
    }
    if (result === "invalid_payload") {
      res.status(400).json({ error: { code: "invalid_response_payload", message: "Invalid tunnel response" } });
      return;
    }
    res.json({ status: "ok" });
  });

  return {
    openaiApp,
    tunnelApp,
    close: async () => {
      state.close();
      oauthProvider.close();
    },
  };
}

function authorizeTunnel(req: Request, res: Response, config: ServerConfig): boolean {
  if (req.params.tunnelId !== config.relay.tunnelId) {
    res.status(404).json({ error: { code: "tunnel_not_found", message: "Tunnel not found" } });
    return false;
  }
  const token = bearerToken(req);
  if (!token || !safeEquals(token, config.relay.tunnelToken)) {
    res.status(401).json({ error: { code: "invalid_api_key", message: "Invalid tunnel API key" } });
    return false;
  }
  return true;
}

async function runBearerAuth(
  middleware: ReturnType<typeof requireBearerAuth>,
  req: Request,
  res: Response,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    middleware(req, res, (error?: unknown) => error ? reject(error) : resolve());
  });
}

function bearerToken(req: Request): string | undefined {
  const value = req.header("authorization");
  const match = value ? /^Bearer\s+(.+)$/i.exec(value) : null;
  return match?.[1];
}

function safeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

function requestHeaders(req: Request): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const name of REQUEST_HEADER_ALLOWLIST) {
    const value = req.header(name);
    if (value) result[canonicalHeaderName(name)] = [value];
  }
  return result;
}

function canonicalHeaderName(name: string): string {
  return name.split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join("-");
}

function parsePollLimit(value: unknown): number {
  const parsed = Number(value ?? MAX_POLL_BATCH);
  if (!Number.isInteger(parsed)) return MAX_POLL_BATCH;
  return Math.max(1, Math.min(MAX_POLL_BATCH, parsed));
}

function parsePollWait(value: unknown, maxWaitMs: number): number {
  const parsed = Number(value ?? maxWaitMs);
  if (!Number.isInteger(parsed) || parsed < 0) return maxWaitMs;
  return Math.min(parsed, maxWaitMs);
}

function normalizeStatus(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return 502;
  if (value >= 100 && value < 200) return 502;
  return value >= 200 && value <= 599 ? value : 502;
}

function responseHeaders(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, string[]> = {};
  for (const [name, rawValues] of Object.entries(value)) {
    if (!RESPONSE_HEADER_ALLOWLIST.has(name.toLowerCase()) || !Array.isArray(rawValues)) continue;
    const values = rawValues.filter(
      (entry): entry is string => typeof entry === "string" && entry.length > 0,
    );
    if (values.length > 0) result[name] = values;
  }
  return result;
}

function applyResponseHeaders(res: Response, headers: Record<string, string[]>): void {
  for (const [name, values] of Object.entries(headers)) res.setHeader(name, values);
}

function startSse(res: Response): void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
}

function writeSse(res: Response, payload: unknown): void {
  res.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
}

function jsonRpcId(value: unknown): unknown {
  return value && typeof value === "object" && "id" in value
    ? (value as { id?: unknown }).id ?? null
    : null;
}

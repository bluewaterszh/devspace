import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthRouter,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import type { Request, Response } from "express";
import type { ServerConfig } from "./config.js";
import { logEvent, requestIp, requestPath } from "./logger.js";
import { SingleUserOAuthProvider } from "./oauth-provider.js";

const DEFAULT_RESPONSE_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_POLL_WAIT_MS = 30_000;
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

export interface TunnelRelayOptions {
  tunnelId: string;
  tunnelToken: string;
  name: string;
  description: string;
  responseTimeoutMs: number;
  maxPollWaitMs: number;
}

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
  channel?: unknown;
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

export interface TunnelRelayServer {
  app: ReturnType<typeof createMcpExpressApp>;
  config: ServerConfig;
  options: TunnelRelayOptions;
  close(): Promise<void>;
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function loadTunnelRelayOptions(
  env: NodeJS.ProcessEnv = process.env,
): TunnelRelayOptions {
  const tunnelId = env.DEVSPACE_RELAY_TUNNEL_ID?.trim();
  if (!tunnelId) {
    throw new Error("DEVSPACE_RELAY_TUNNEL_ID is required");
  }
  if (!/^tunnel_[0-9a-f]{32}$/.test(tunnelId)) {
    throw new Error(
      "DEVSPACE_RELAY_TUNNEL_ID must match tunnel_ followed by 32 lowercase hex characters",
    );
  }

  const tunnelToken = env.DEVSPACE_RELAY_TUNNEL_TOKEN?.trim();
  if (!tunnelToken || tunnelToken.length < 16) {
    throw new Error(
      "DEVSPACE_RELAY_TUNNEL_TOKEN is required and must be at least 16 characters",
    );
  }

  return {
    tunnelId,
    tunnelToken,
    name: env.DEVSPACE_RELAY_TUNNEL_NAME?.trim() || tunnelId,
    description:
      env.DEVSPACE_RELAY_TUNNEL_DESCRIPTION?.trim()
      || "DevSpace SSH MCP relay",
    responseTimeoutMs: parsePositiveInteger(
      env.DEVSPACE_RELAY_RESPONSE_TIMEOUT_MS,
      DEFAULT_RESPONSE_TIMEOUT_MS,
      "DEVSPACE_RELAY_RESPONSE_TIMEOUT_MS",
    ),
    maxPollWaitMs: parsePositiveInteger(
      env.DEVSPACE_RELAY_MAX_POLL_WAIT_MS,
      DEFAULT_MAX_POLL_WAIT_MS,
      "DEVSPACE_RELAY_MAX_POLL_WAIT_MS",
    ),
  };
}

function safeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.byteLength !== b.byteLength) return false;
  return timingSafeEqual(a, b);
}

function bearerToken(req: Request): string | undefined {
  const value = req.header("authorization");
  if (!value) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(value);
  return match?.[1];
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
  return name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join("-");
}

function normalizeStatus(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return 502;
  if (value >= 100 && value < 200) return 502;
  if (value >= 200 && value <= 599) return value;
  return 502;
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

function responseHeaders(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, string[]> = {};
  for (const [name, rawValues] of Object.entries(value)) {
    if (!RESPONSE_HEADER_ALLOWLIST.has(name.toLowerCase())) continue;
    if (!Array.isArray(rawValues)) continue;
    const values = rawValues.filter(
      (entry): entry is string => typeof entry === "string" && entry.length > 0,
    );
    if (values.length > 0) result[name] = values;
  }
  return result;
}

function applyResponseHeaders(res: Response, headers: Record<string, string[]>): void {
  for (const [name, values] of Object.entries(headers)) {
    res.setHeader(name, values);
  }
}

function writeSse(res: Response, payload: unknown): void {
  res.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
}

function jsonRpcId(value: unknown): unknown {
  if (!value || typeof value !== "object") return null;
  return "id" in value ? (value as { id?: unknown }).id ?? null : null;
}

class TunnelRelayState {
  private readonly commands: TunnelCommand[] = [];
  private readonly pending = new Map<string, PendingRequest>();
  private readonly pollWaiters = new Set<PollWaiter>();
  private closed = false;
  private lastPollAt?: string;

  constructor(private readonly options: TunnelRelayOptions) {}

  snapshot(): {
    queued: number;
    pending: number;
    lastPollAt?: string;
  } {
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
    const commandBase = {
      request_id: requestId,
      shard_token: shardToken,
      channel: "main" as const,
      created_at: new Date().toISOString(),
      response_timeout: `${Math.ceil(this.options.responseTimeoutMs / 1000)}s`,
      headers: requestHeaders(req),
    };
    const command: TunnelCommand = commandType === "jsonrpc"
      ? {
          ...commandBase,
          command_type: "jsonrpc",
          jsonrpc,
        }
      : {
          ...commandBase,
          command_type: "session_termination",
        };

    const timer = setTimeout(() => {
      const pending = this.pending.get(requestId);
      if (!pending) return;
      this.pending.delete(requestId);
      if (!pending.response.headersSent) {
        pending.response.status(504).json({
          jsonrpc: "2.0",
          id: jsonRpcId(jsonrpc),
          error: {
            code: -32603,
            message: "Tunnel response timed out",
          },
        });
      } else {
        pending.response.end();
      }
    }, this.options.responseTimeoutMs);
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
      const pending = this.pending.get(requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(requestId);
    });
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
    if (!shardToken || !safeEquals(shardToken, pending.shardToken)) {
      return "invalid_shard";
    }

    const responseType = typeof payload.resp_type === "string"
      ? payload.resp_type
      : "jsonrpc_response";

    if (responseType === "jsonrpc_notify") {
      if (payload.resp_json === undefined) return "invalid_payload";
      if (pending.acceptsSse) {
        if (!pending.sseStarted) {
          pending.response.status(200);
          pending.response.setHeader("Content-Type", "text/event-stream");
          pending.response.setHeader("Cache-Control", "no-cache");
          pending.response.setHeader("Connection", "keep-alive");
          pending.response.flushHeaders?.();
          pending.sseStarted = true;
        }
        writeSse(pending.response, payload.resp_json);
      }
      return "ok";
    }

    if (
      responseType !== "jsonrpc_response"
      && responseType !== "notify_ack"
      && responseType !== "session_termination_response"
    ) {
      return "invalid_payload";
    }

    clearTimeout(pending.timer);
    this.pending.delete(pending.requestId);

    const status = normalizeStatus(payload.resp_code);
    const headers = responseHeaders(payload.resp_headers);

    if (pending.acceptsSse && payload.resp_json !== undefined) {
      if (!pending.sseStarted) {
        pending.response.status(status >= 200 && status < 300 ? 200 : status);
        pending.response.setHeader("Content-Type", "text/event-stream");
        pending.response.setHeader("Cache-Control", "no-cache");
        pending.response.setHeader("Connection", "keep-alive");
        pending.response.flushHeaders?.();
        pending.sseStarted = true;
      }
      writeSse(pending.response, payload.resp_json);
      pending.response.end();
      return "ok";
    }

    applyResponseHeaders(pending.response, headers);
    pending.response.status(status);
    if (payload.resp_json === undefined) {
      pending.response.end();
    } else {
      pending.response.json(payload.resp_json);
    }
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

  private take(limit: number): TunnelCommand[] {
    if (this.commands.length === 0) return [];
    return this.commands.splice(0, limit);
  }

  private wakePollers(): void {
    for (const waiter of Array.from(this.pollWaiters)) waiter.wake();
  }
}

function requestLogFields(
  req: Request,
  config: ServerConfig,
): Record<string, unknown> {
  return {
    ip: requestIp(req, config.logging.trustProxy),
    host: req.header("host"),
    userAgent: req.header("user-agent"),
  };
}

function requireTunnelAuth(
  req: Request,
  res: Response,
  options: TunnelRelayOptions,
): boolean {
  const token = bearerToken(req);
  if (!token || !safeEquals(token, options.tunnelToken)) {
    res.status(401).json({
      error: {
        code: "invalid_api_key",
        message: "Invalid tunnel API key",
      },
    });
    return false;
  }
  return true;
}

function requireTunnelId(
  req: Request,
  res: Response,
  options: TunnelRelayOptions,
): boolean {
  if (req.params.tunnelId !== options.tunnelId) {
    res.status(404).json({
      error: {
        code: "tunnel_not_found",
        message: "Tunnel not found",
      },
    });
    return false;
  }
  return true;
}

export function createTunnelRelayServer(
  config: ServerConfig,
  options: TunnelRelayOptions = loadTunnelRelayOptions(),
): TunnelRelayServer {
  const allowedHosts = config.allowedHosts.includes("*")
    ? undefined
    : Array.from(new Set([config.host, ...config.allowedHosts]));
  const app = createMcpExpressApp({
    host: config.host,
    ...(allowedHosts ? { allowedHosts } : {}),
  });
  const mcpUrl = new URL("/mcp", config.publicBaseUrl);
  const resourceServerUrl = resourceUrlFromServerUrl(mcpUrl);
  const oauthProvider = new SingleUserOAuthProvider(
    config.oauth,
    mcpUrl,
    config.stateDir,
  );
  const bearerAuth = requireBearerAuth({
    verifier: oauthProvider,
    requiredScopes: [config.oauth.scopes[0] ?? "devspace"],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl),
  });
  const state = new TunnelRelayState(options);

  if (config.logging.trustProxy) app.set("trust proxy", true);

  app.use((req, res, next) => {
    const requestId = randomUUID();
    const startedAt = performance.now();
    res.locals.requestId = requestId;
    res.on("finish", () => {
      if (!config.logging.requests) return;
      logEvent(config.logging, "info", "relay_http_request", {
        requestId,
        method: req.method,
        path: requestPath(req),
        status: res.statusCode,
        durationMs: Math.round(performance.now() - startedAt),
        ...requestLogFields(req, config),
      });
    });
    next();
  });

  app.use(
    mcpAuthRouter({
      provider: oauthProvider,
      issuerUrl: new URL(config.publicBaseUrl),
      baseUrl: new URL(config.publicBaseUrl),
      resourceServerUrl,
      scopesSupported: config.oauth.scopes,
      resourceName: options.name,
    }),
  );

  app.get("/healthz", (_req, res) => {
    res.json({
      ok: true,
      name: "devspace-tunnel-relay",
      tunnel_id: options.tunnelId,
      ...state.snapshot(),
    });
  });

  app.get("/v1/tunnels/:tunnelId", (req, res) => {
    if (!requireTunnelId(req, res, options)) return;
    if (!requireTunnelAuth(req, res, options)) return;
    res.json({
      id: options.tunnelId,
      name: options.name,
      description: options.description,
    });
  });

  app.get("/v1/tunnels/:tunnelId/poll", async (req, res) => {
    if (!requireTunnelId(req, res, options)) return;
    if (!requireTunnelAuth(req, res, options)) return;
    const limit = parsePollLimit(req.query.limit);
    const waitMs = parsePollWait(req.query.timeout_ms, options.maxPollWaitMs);
    const commands = await state.poll(limit, waitMs);
    if (commands.length === 0) {
      res.status(204).end();
      return;
    }
    res.json({ commands });
  });

  app.post("/v1/tunnels/:tunnelId/response", (req, res) => {
    if (!requireTunnelId(req, res, options)) return;
    if (!requireTunnelAuth(req, res, options)) return;
    const result = state.acceptResponse(
      req.header("x-tunnel-shard-token"),
      (req.body ?? {}) as TunnelResponsePayload,
    );
    if (result === "not_found") {
      res.status(404).json({
        error: { code: "request_not_found", message: "Request is no longer pending" },
      });
      return;
    }
    if (result === "invalid_shard") {
      res.status(403).json({
        error: { code: "invalid_shard_token", message: "Invalid shard token" },
      });
      return;
    }
    if (result === "invalid_payload") {
      res.status(400).json({
        error: { code: "invalid_response_payload", message: "Invalid tunnel response" },
      });
      return;
    }
    res.json({ status: "ok" });
  });

  app.post("/mcp", async (req, res) => {
    await new Promise<void>((resolve, reject) => {
      bearerAuth(req, res, (error?: unknown) => {
        if (error) reject(error);
        else resolve();
      });
    });
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

  app.delete("/mcp", async (req, res) => {
    await new Promise<void>((resolve, reject) => {
      bearerAuth(req, res, (error?: unknown) => {
        if (error) reject(error);
        else resolve();
      });
    });
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

  app.get("/mcp", (_req, res) => {
    res.setHeader("Allow", "POST, DELETE");
    res.status(405).end();
  });

  let closed = false;
  return {
    app,
    config,
    options,
    close: async () => {
      if (closed) return;
      closed = true;
      state.close();
      oauthProvider.close();
    },
  };
}

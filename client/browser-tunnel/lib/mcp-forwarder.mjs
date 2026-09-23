import { parseSseJson } from "./sse.mjs";

const RESPONSE_HEADER_ALLOWLIST = [
  "content-type",
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
  "access-control-expose-headers",
  "www-authenticate",
];

export async function processTunnelCommand(
  command,
  { mcpUrl, deliver, receivedAtMs = Date.now() },
) {
  const deadlineAt = commandDeadline(command, receivedAtMs);
  if (deadlineAt !== undefined && Date.now() >= deadlineAt) return;

  if (command.command_type === "session_termination") {
    await processSessionTermination(command, { mcpUrl, deliver, deadlineAt });
    return;
  }

  if (command.command_type !== "jsonrpc") {
    throw new Error(`unsupported command_type: ${String(command.command_type)}`);
  }

  try {
    await processJsonRpc(command, { mcpUrl, deliver, deadlineAt });
  } catch (error) {
    console.error(
      `MCP command failed request_id=${command.request_id}: `
        + (error instanceof Error ? error.message : String(error)),
    );
    await deliverFailure(command, deliver);
  }
}

async function processJsonRpc(command, { mcpUrl, deliver, deadlineAt }) {
  const payload = command.jsonrpc;
  const hasId = payload
    && typeof payload === "object"
    && Object.prototype.hasOwnProperty.call(payload, "id");

  const response = await fetchWithDeadline(
    mcpUrl,
    {
      method: "POST",
      headers: requestHeaders(command.headers, true),
      body: JSON.stringify(payload),
      redirect: "manual",
    },
    deadlineAt,
  );

  const responseHeaders = selectedResponseHeaders(response);

  if (!hasId) {
    // JSON-RPC notifications are terminally acknowledged after the downstream
    // write succeeds. Streamable HTTP MCP servers commonly answer 202 here.
    await deliver(command, {
      request_id: command.request_id,
      channel: command.channel ?? "main",
      resp_headers: responseHeaders,
      resp_code: response.status,
      resp_type: "notify_ack",
    });
    return;
  }

  const body = await response.text();
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";

  if (contentType.includes("text/event-stream")) {
    const events = parseSseJson(body);
    let finalPayload;

    for (const event of events) {
      if (sameJsonRpcId(event?.id, payload.id)) {
        finalPayload = event;
        continue;
      }
      if (event && typeof event === "object" && typeof event.method === "string") {
        await deliver(command, {
          request_id: command.request_id,
          channel: command.channel ?? "main",
          resp_json: event,
          resp_headers: responseHeaders,
          resp_code: response.status,
          resp_type: "jsonrpc_notify",
        });
      }
    }

    if (!finalPayload) {
      throw new Error("MCP SSE stream ended without a final JSON-RPC response");
    }

    await deliver(command, {
      request_id: command.request_id,
      channel: command.channel ?? "main",
      resp_json: finalPayload,
      resp_headers: responseHeaders,
      resp_code: response.status,
      resp_type: "jsonrpc_response",
    });
    return;
  }

  if (!body) {
    throw new Error(
      `MCP returned HTTP ${response.status} with an empty response body`,
    );
  }

  let json;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error(
      `MCP returned non-JSON content-type=${contentType || "unknown"}`,
    );
  }

  await deliver(command, {
    request_id: command.request_id,
    channel: command.channel ?? "main",
    resp_json: json,
    resp_headers: responseHeaders,
    resp_code: response.status,
    resp_type: "jsonrpc_response",
  });
}

async function processSessionTermination(
  command,
  { mcpUrl, deliver, deadlineAt },
) {
  try {
    const response = await fetchWithDeadline(
      mcpUrl,
      {
        method: "DELETE",
        headers: requestHeaders(command.headers, false),
        redirect: "manual",
      },
      deadlineAt,
    );

    await deliver(command, {
      request_id: command.request_id,
      channel: command.channel ?? "main",
      resp_headers: selectedResponseHeaders(response),
      resp_code: response.status,
      resp_type: "session_termination_response",
    });
  } catch (error) {
    console.error(
      `MCP session termination failed request_id=${command.request_id}: `
        + (error instanceof Error ? error.message : String(error)),
    );
    await deliver(command, {
      request_id: command.request_id,
      channel: command.channel ?? "main",
      resp_code: 502,
      resp_type: "session_termination_response",
    });
  }
}

async function deliverFailure(command, deliver) {
  const payload = command.jsonrpc;
  const hasId = payload
    && typeof payload === "object"
    && Object.prototype.hasOwnProperty.call(payload, "id");

  if (!hasId) {
    await deliver(command, {
      request_id: command.request_id,
      channel: command.channel ?? "main",
      resp_code: 502,
      resp_type: "notify_ack",
    });
    return;
  }

  await deliver(command, {
    request_id: command.request_id,
    channel: command.channel ?? "main",
    resp_json: {
      jsonrpc: "2.0",
      id: payload.id ?? null,
      error: {
        code: -32603,
        message: "Browser tunnel failed to reach the local MCP server",
      },
    },
    resp_headers: {
      "Content-Type": ["application/json"],
    },
    resp_code: 502,
    resp_type: "jsonrpc_response",
  });
}

function requestHeaders(values, includeJsonContentType) {
  const headers = new Headers();

  for (const [name, rawValues] of Object.entries(values ?? {})) {
    if (!Array.isArray(rawValues) || rawValues.length === 0) continue;
    headers.set(name, rawValues.join(", "));
  }

  if (includeJsonContentType && !headers.has("content-type")) {
    headers.set("Content-Type", "application/json");
  }
  if (!headers.has("accept")) {
    headers.set("Accept", "application/json, text/event-stream");
  }

  return headers;
}

function selectedResponseHeaders(response) {
  const result = {};
  for (const name of RESPONSE_HEADER_ALLOWLIST) {
    const value = response.headers.get(name);
    if (value) result[canonicalHeaderName(name)] = [value];
  }
  return result;
}

function canonicalHeaderName(name) {
  return name
    .split("-")
    .map((part) => part ? part[0].toUpperCase() + part.slice(1) : part)
    .join("-");
}

async function fetchWithDeadline(url, init, deadlineAt) {
  if (deadlineAt === undefined) return fetch(url, init);

  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) throw new Error("command deadline already expired");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), remainingMs);
  timer.unref?.();
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function commandDeadline(command, receivedAtMs) {
  const timeoutMs = parseRelativeDuration(command.response_timeout);
  return timeoutMs === undefined ? undefined : receivedAtMs + timeoutMs;
}

function parseRelativeDuration(value) {
  if (typeof value !== "string") return undefined;
  const match = /^(\d+(?:\.\d+)?)(ms|s|m)$/.exec(value.trim());
  if (!match) return undefined;

  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount < 0) return undefined;

  const multiplier = match[2] === "ms"
    ? 1
    : match[2] === "s"
      ? 1000
      : 60_000;

  return Math.floor(amount * multiplier);
}

function sameJsonRpcId(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

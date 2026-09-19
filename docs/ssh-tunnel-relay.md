# SSH tunnel relay mode

This fork adds an SSH-only relay mode that reuses DevSpace OAuth while keeping
the target SSH MCP server private.

The first version intentionally binds one public MCP endpoint to one
`tunnel_id`. Run one relay instance per ChatGPT plugin / SSH target.

## End-to-end layout

```text
ChatGPT
  |
  | HTTPS + DevSpace OAuth
  v
https://mcp-238.example.com/mcp
  |
  | in-memory request queue
  v
DevSpace relay (public server)
  ^
  | GET  /v1/tunnels/<id>/poll
  | POST /v1/tunnels/<id>/response
  | Bearer <relay tunnel token>
  |
OpenAI tunnel-client.exe (Windows)
  |
  | http://127.0.0.1:3006/
  v
ssh-mcp-238
  |
  | SSH
  v
target server
```

ChatGPT uses **Server URL** mode, not OpenAI Tunnel mode. The `tunnel_id`
exists only between this relay and `tunnel-client.exe`.

## Public relay configuration

Use the normal DevSpace setup for OAuth:

```bash
corepack pnpm install
corepack pnpm build
devspace init
devspace config set publicBaseUrl https://mcp-238.example.com
```

Then set one relay tunnel:

```bash
export DEVSPACE_RELAY_TUNNEL_ID=tunnel_0123456789abcdef0123456789abcdef
export DEVSPACE_RELAY_TUNNEL_TOKEN='<long-random-secret>'
export DEVSPACE_RELAY_TUNNEL_NAME='SSH-238'
export DEVSPACE_RELAY_TUNNEL_DESCRIPTION='SSH MCP relay for 238'

devspace relay
```

Optional tuning:

```bash
export DEVSPACE_RELAY_RESPONSE_TIMEOUT_MS=120000
export DEVSPACE_RELAY_MAX_POLL_WAIT_MS=30000
```

The public MCP URL is:

```text
https://mcp-238.example.com/mcp
```

The tunnel-client control-plane base URL is the host root:

```text
https://mcp-238.example.com
```

## Windows tunnel-client

The existing OpenAI tunnel client can use a private control-plane host. Point
it at the DevSpace relay instead of `api.openai.com`:

```bash
export CONTROL_PLANE_BASE_URL=https://mcp-238.example.com
export CONTROL_PLANE_TUNNEL_ID=tunnel_0123456789abcdef0123456789abcdef
export CONTROL_PLANE_API_KEY='<same-relay-tunnel-token>'

tunnel-client.exe run \
  --mcp.server-url=http://127.0.0.1:3006/ \
  --health.listen-addr=127.0.0.1:8086 \
  --log.level=info
```

If ssh-mcp itself requires a bearer token, keep using tunnel-client's
`--mcp.extra-headers` mechanism. The ChatGPT OAuth bearer token is terminated
at the public relay and is not forwarded to ssh-mcp.

## Relay endpoints

ChatGPT-facing:

```text
POST   /mcp
DELETE /mcp
```

OAuth discovery, dynamic client registration, authorization, token issuance,
refresh tokens, and Owner Password approval are provided by the existing
DevSpace OAuth implementation.

Tunnel-client-facing:

```text
GET  /v1/tunnels/<tunnel_id>
GET  /v1/tunnels/<tunnel_id>/poll
POST /v1/tunnels/<tunnel_id>/response
```

The control-plane routes require:

```http
Authorization: Bearer <DEVSPACE_RELAY_TUNNEL_TOKEN>
```

The relay implements the public OpenAI tunnel-client wire contract needed for
JSON-RPC commands, session termination, response correlation, and SSE
notifications.

## One plugin per SSH server

Do not multiplex targets through a `target` tool argument. For another
server, run a separate relay instance with a separate public URL, local port,
state directory, tunnel id, and tunnel token.

Example conceptual mapping:

```text
SSH-238 plugin -> mcp-238.example.com -> tunnel_A -> ssh-mcp-238
SSH-155 plugin -> mcp-155.example.com -> tunnel_B -> ssh-mcp-155
```

This keeps the target identity fixed at plugin creation time.

For multiple relay processes on one public host, use separate
`DEVSPACE_CONFIG_DIR` values and ports, then route each hostname with Caddy.

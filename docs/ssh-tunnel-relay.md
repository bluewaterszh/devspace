# SSH tunnel relay

## Architecture

```text
ChatGPT / OpenAI
  |
  | HTTPS :8550
  | DevSpace OAuth
  v
Caddy
  |
  v
127.0.0.1:18550
  |
  | /mcp + OAuth endpoints only
  v
DevSpace relay
  ^
  | shared in-memory request queue
  |
127.0.0.1:18551
  ^
  | /v1/tunnels/... only
  | tunnel bearer token
  |
Caddy
  ^
  | HTTPS :8551
  |
Windows tunnel-client.exe
  |
  v
local ssh-mcp -> SSH target
```

The OpenAI and Windows surfaces are separate application listeners. OAuth endpoints are not mounted on the Windows listener, and tunnel-control endpoints are not mounted on the OpenAI listener.

## Configuration

`~/.devspace/config.jsonc` contains only non-secret settings:

```jsonc
{
  "openai": {
    "host": "127.0.0.1",
    "port": 18550,
    "publicBaseUrl": "https://www.astmars.com:8550",
    "allowedHosts": ["www.astmars.com"],
    "trustProxy": true
  },
  "tunnel": {
    "host": "127.0.0.1",
    "port": 18551,
    "publicBaseUrl": "https://www.astmars.com:8551",
    "allowedHosts": ["www.astmars.com"],
    "trustProxy": true,
    "tunnelId": "tunnel_0123456789abcdef0123456789abcdef",
    "name": "Lisa SSH relay",
    "description": "Windows SSH MCP relay via Lisa",
    "responseTimeoutMs": 120000,
    "maxPollWaitMs": 30000
  },
  "storage": {
    "stateDir": "/var/lib/devspace-relay"
  },
  "oauth": {
    "accessTokenTtlSeconds": 3600,
    "refreshTokenTtlSeconds": 2592000,
    "scopes": ["devspace"],
    "allowedResourceUrls": [],
    "allowedRedirectHosts": ["chatgpt.com", "localhost", "127.0.0.1"]
  }
}
```

`~/.devspace/auth.json` contains secrets and must be mode `0600`:

```json
{
  "ownerToken": "<owner-password>",
  "tunnelToken": "<long-random-tunnel-secret>"
}
```

## Windows tunnel-client

Use the Windows-side control plane URL:

```text
CONTROL_PLANE_BASE_URL=https://www.astmars.com:8551
CONTROL_PLANE_TUNNEL_ID=<tunnelId from config.jsonc>
CONTROL_PLANE_API_KEY=<tunnelToken from auth.json>
```

Then point tunnel-client at the local ssh-mcp endpoint as before.

## ChatGPT / OpenAI

Use this MCP server URL:

```text
https://www.astmars.com:8550/mcp
```

ChatGPT performs OAuth against the same `:8550` origin. The Owner password is `ownerToken` from `auth.json`.

## Caddy

The Lisa deployment uses two TLS listeners:

```caddy
https://www.astmars.com:8550 {
    tls /etc/caddy/certs/astmars.com_bundle.crt /etc/caddy/certs/astmars.com.key
    reverse_proxy 127.0.0.1:18550
}

https://www.astmars.com:8551 {
    tls /etc/caddy/certs/astmars.com_bundle.crt /etc/caddy/certs/astmars.com.key
    reverse_proxy 127.0.0.1:18551
}
```

The existing `https://www.astmars.com/` site on port 443 is unchanged.

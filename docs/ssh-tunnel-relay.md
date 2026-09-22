# SSH tunnel relay

## Authentication model

There are two independent authentication mechanisms:

1. ChatGPT/OpenAI -> DevSpace uses OAuth and the `ownerToken`.
2. Windows tunnel-client -> DevSpace control plane uses one global `tunnelToken`.

The global `tunnelToken` is shared by every tunnel-client. Different MCP targets are separated by distinct `tunnelId` values and independent relay state.

## Current Lisa layout

```text
ChatGPT Lisa connector
  -> https://www.astmars.com:8550/mcp
  -> 127.0.0.1:18550
  -> Lisa relay queue

Windows devspace-lisa
  -> https://www.astmars.com:8551
  -> 127.0.0.1:18551
  -> Lisa relay queue


ChatGPT 10236 connector
  -> https://www.astmars.com:8552/mcp
  -> 127.0.0.1:18552
  -> 10236 relay queue

Windows devspace-10236
  -> https://www.astmars.com:8553
  -> 127.0.0.1:18553
  -> 10236 relay queue
```

Both Windows clients use the same `tunnelToken`. The two queues cannot consume each other's requests.

## config.jsonc

The legacy top-level `openai` and `tunnel` sections remain as defaults/backward compatibility. Multi-tunnel instances are declared in `tunnels`:

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

  "tunnels": {
    "lisa": {
      "tunnelId": "tunnel_0123456789abcdef0123456789abcdef",
      "name": "Lisa SSH relay",
      "description": "Windows SSH MCP relay for Lisa",
      "openaiPort": 18550,
      "openaiPublicBaseUrl": "https://www.astmars.com:8550",
      "controlPort": 18551,
      "controlPublicBaseUrl": "https://www.astmars.com:8551"
    },
    "10236": {
      "tunnelId": "tunnel_fedcba9876543210fedcba9876543210",
      "name": "10236 SSH relay",
      "description": "Windows SSH MCP relay for 10236",
      "openaiPort": 18552,
      "openaiPublicBaseUrl": "https://www.astmars.com:8552",
      "controlPort": 18553,
      "controlPublicBaseUrl": "https://www.astmars.com:8553"
    }
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

## auth.json

```json
{
  "ownerToken": "<owner-password>",
  "tunnelToken": "<one-global-windows-tunnel-token>"
}
```

The same `tunnelToken` is used by every Windows profile.

## Windows examples

Lisa:

```text
DEVSPACE_CONTROL_PLANE=https://www.astmars.com:8551
TUNNEL_ID=<Lisa tunnelId>
DEVSPACE_TUNNEL_TOKEN=<global tunnelToken>
```

10236:

```text
DEVSPACE_CONTROL_PLANE=https://www.astmars.com:8553
TUNNEL_ID=<10236 tunnelId>
DEVSPACE_TUNNEL_TOKEN=<same global tunnelToken>
```

## ChatGPT connectors

Lisa:

```text
https://www.astmars.com:8550/mcp
```

10236:

```text
https://www.astmars.com:8552/mcp
```

Both use the same Owner password from `ownerToken`, but OAuth tokens are bound to the corresponding MCP resource URL.

## Caddy

```caddy
https://www.astmars.com:8550 {
    tls /etc/caddy/certs/astmars.com_bundle.crt /etc/caddy/certs/astmars.com.key
    reverse_proxy 127.0.0.1:18550
}

https://www.astmars.com:8551 {
    tls /etc/caddy/certs/astmars.com_bundle.crt /etc/caddy/certs/astmars.com.key
    reverse_proxy 127.0.0.1:18551
}

https://www.astmars.com:8552 {
    tls /etc/caddy/certs/astmars.com_bundle.crt /etc/caddy/certs/astmars.com.key
    reverse_proxy 127.0.0.1:18552
}

https://www.astmars.com:8553 {
    tls /etc/caddy/certs/astmars.com_bundle.crt /etc/caddy/certs/astmars.com.key
    reverse_proxy 127.0.0.1:18553
}
```

The existing `https://www.astmars.com/` site on port 443 is unchanged.

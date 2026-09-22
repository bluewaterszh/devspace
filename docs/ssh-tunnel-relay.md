# SSH tunnel relay

## Architecture

Only two public ports are exposed:

```text
ChatGPT / OpenAI
    |
    | HTTPS :8550
    v
DevSpace OpenAI listener
    |
    +-- /mcp/lisa  ------> Lisa queue
    |
    +-- /mcp/10236 ------> 10236 queue


Windows tunnel-client(s)
    |
    | HTTPS :8551
    | one shared tunnelToken
    v
DevSpace control listener
    |
    +-- TUNNEL_ID Lisa  ------> Lisa queue
    |
    +-- TUNNEL_ID 10236 ------> 10236 queue
```

No per-device ports are used.

## Minimal config.jsonc

```json
{
  "openai": {
    "port": 18550,
    "publicBaseUrl": "https://www.astmars.com:8550"
  },
  "tunnel": {
    "port": 18551,
    "publicBaseUrl": "https://www.astmars.com:8551"
  },
  "tunnels": {
    "lisa": "tunnel_0123456789abcdef0123456789abcdef",
    "10236": "tunnel_fedcba9876543210fedcba9876543210"
  },
  "storage": {
    "stateDir": "/var/lib/devspace-relay"
  }
}
```

The key under `tunnels` becomes the MCP path:

```text
lisa  -> https://www.astmars.com:8550/mcp/lisa
10236 -> https://www.astmars.com:8550/mcp/10236
```

## auth.json

```json
{
  "ownerToken": "<owner-password>",
  "tunnelToken": "<one-global-windows-tunnel-token>"
}
```

- `ownerToken`: used by ChatGPT OAuth authorization.
- `tunnelToken`: shared by every Windows tunnel-client.
- Different devices are distinguished by `TUNNEL_ID`, not by token or port.

## Windows profiles

Lisa:

```text
DEVSPACE_CONTROL_PLANE=https://www.astmars.com:8551
TUNNEL_ID=tunnel_0123456789abcdef0123456789abcdef
DEVSPACE_TUNNEL_TOKEN=<shared tunnelToken>
```

10236:

```text
DEVSPACE_CONTROL_PLANE=https://www.astmars.com:8551
TUNNEL_ID=tunnel_fedcba9876543210fedcba9876543210
DEVSPACE_TUNNEL_TOKEN=<same shared tunnelToken>
```

Both profiles can run at the same time.

## Caddy

Only these two listeners are needed:

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

The existing port 443 website is unchanged.

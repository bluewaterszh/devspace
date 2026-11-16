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
    +-- /mcp/server-a ------> Server A queue
    |
    +-- /mcp/server-b ------> Server B queue


Windows tunnel-client(s)
    |
    | HTTPS :8551
    | one shared tunnelToken
    v
DevSpace control listener
    |
    +-- TUNNEL_ID Server A ------> Server A queue
    |
    +-- TUNNEL_ID Server B ------> Server B queue
```

No per-device ports are used.

## Minimal config.jsonc

Replace `example.com`, the target names, and the sample tunnel IDs with your own
deployment values. Use the same tunnel ID in each matching server/client pair.

```json
{
  "openai": {
    "port": 18550,
    "publicBaseUrl": "https://example.com:8550"
  },
  "tunnel": {
    "port": 18551,
    "publicBaseUrl": "https://example.com:8551"
  },
  "tunnels": {
    "server-a": "tunnel_11111111111111111111111111111111",
    "server-b": "tunnel_22222222222222222222222222222222"
  },
  "storage": {
    "stateDir": "/var/lib/devspace-relay"
  }
}
```

The key under `tunnels` becomes the MCP path:

```text
server-a -> https://example.com:8550/mcp/server-a
server-b -> https://example.com:8550/mcp/server-b
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

Server A:

```text
DEVSPACE_CONTROL_PLANE=https://example.com:8551
TUNNEL_ID=tunnel_11111111111111111111111111111111
DEVSPACE_TUNNEL_TOKEN=<shared tunnelToken>
```

Server B:

```text
DEVSPACE_CONTROL_PLANE=https://example.com:8551
TUNNEL_ID=tunnel_22222222222222222222222222222222
DEVSPACE_TUNNEL_TOKEN=<same shared tunnelToken>
```

Both profiles can run at the same time.

## Caddy

Only these two listeners are needed:

```caddy
https://example.com:8550 {
    tls /etc/caddy/certs/example.com_bundle.crt /etc/caddy/certs/example.com.key
    reverse_proxy 127.0.0.1:18550
}

https://example.com:8551 {
    tls /etc/caddy/certs/example.com_bundle.crt /etc/caddy/certs/example.com.key
    reverse_proxy 127.0.0.1:18551
}
```

The existing port 443 website is unchanged.

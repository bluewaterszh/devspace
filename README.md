# DevSpace Relay

A low-resource MCP relay that connects ChatGPT/OpenAI to Windows-hosted `tunnel-client.exe` instances.

## Ports

Only two public ports are used:

- `https://www.astmars.com:8550` — OpenAI / ChatGPT OAuth + MCP
- `https://www.astmars.com:8551` — Windows tunnel-client control plane

Different MCP targets do not use extra ports. They are separated by MCP path and `TUNNEL_ID`.

Current MCP URLs:

- Lisa: `https://www.astmars.com:8550/mcp/lisa`
- 10236: `https://www.astmars.com:8550/mcp/10236`

All Windows tunnel clients use the same global `tunnelToken`, while each target has its own `TUNNEL_ID`.

Configuration is stored in `~/.devspace/config.jsonc`; secrets are in `~/.devspace/auth.json`.

See [docs/ssh-tunnel-relay.md](docs/ssh-tunnel-relay.md) for details.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

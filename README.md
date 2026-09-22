# DevSpace Relay

A low-resource MCP relay for one machine:

- ChatGPT/OpenAI connects to an OAuth-protected MCP endpoint.
- Windows `tunnel-client.exe` connects to a separate tunnel control-plane endpoint.
- Both surfaces share an in-memory request queue, but they use different listeners and authentication mechanisms.

This branch is intentionally relay-only. The original DevSpace UI, workspace tools, subagents, worktrees, skills, artifact exchange, and local agent daemon have been removed.

## Lisa deployment

Public endpoints:

- OpenAI OAuth + MCP: `https://www.astmars.com:8550/mcp`
- Windows tunnel control plane: `https://www.astmars.com:8551/v1/tunnels/<tunnel_id>`

Local listeners:

- `127.0.0.1:18550` — OpenAI OAuth/MCP only
- `127.0.0.1:18551` — Windows tunnel control plane only

Configuration is stored in `~/.devspace/config.jsonc`. Secrets are stored separately in `~/.devspace/auth.json`.

See [docs/ssh-tunnel-relay.md](docs/ssh-tunnel-relay.md) for the exact configuration and deployment layout.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

Runtime:

```bash
npm start
```

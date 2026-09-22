# DevSpace Relay

A low-resource MCP relay that connects ChatGPT/OpenAI to Windows-hosted `tunnel-client.exe` instances.

- One global `tunnelToken` authenticates all Windows tunnel clients.
- Each MCP target has its own `tunnelId`, request queue, OpenAI listener, and control-plane listener.
- ChatGPT/OpenAI uses OAuth on the OpenAI listener.
- Windows tunnel-client uses the shared tunnel bearer token on the control-plane listener.

This branch is relay-only. The original DevSpace UI, workspace tools, subagents, worktrees, skills, artifact exchange, and local agent daemon have been removed.

## Lisa deployment

Current public endpoints:

| Target | OpenAI MCP | Windows control plane |
| --- | --- | --- |
| Lisa | `https://www.astmars.com:8550/mcp` | `https://www.astmars.com:8551` |
| 10236 | `https://www.astmars.com:8552/mcp` | `https://www.astmars.com:8553` |

All tunnel clients use the same `tunnelToken` from `~/.devspace/auth.json`, while each profile uses a different `TUNNEL_ID`.

Configuration is stored in `~/.devspace/config.jsonc`. Secrets are stored separately in `~/.devspace/auth.json`.

See [docs/ssh-tunnel-relay.md](docs/ssh-tunnel-relay.md) for details.

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

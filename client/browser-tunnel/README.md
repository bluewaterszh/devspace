# DevSpace browser tunnel client

Standalone PoC client for networks where the enterprise proxy requires an
interactive browser SSO/approval flow before external HTTPS requests are
allowed.

It deliberately does **not** implement or reverse-engineer the enterprise SSO.
Instead:

1. Node launches a dedicated persistent Chrome/Edge profile.
2. The user completes the enterprise SSO/approval in that real browser.
3. DevSpace control-plane requests (metadata, poll, response) run via browser
   `fetch()`, so they inherit the browser's authenticated network context.
4. Node forwards tunnel commands to the local Streamable HTTP MCP server.

The DevSpace relay/server package remains independent.

## Install

Run in Git Bash / PowerShell from this directory:

```bash
npm install
```

Node 22.16+ is required. The PoC uses the installed Chrome or Edge; it does not
download a Playwright browser.

## Run

Use the same script + per-instance env-file workflow as the original tunnel
client.

Create an instance env file:

```bash
cp devspace.env.example devspace-22.env
```

Edit `devspace-22.env` and set the SSH target plus tunnel settings:

```bash
SSH_HOST=<remote-host>
SSH_PORT=22
SSH_USER=<remote-user>
SSH_PASSWORD=<remote-password>
WORKDIR=~

SSH_MCP_TIMING=1
SSH_GROUP=dev
SSH_AUTH_MODE=password

MCP_PORT=3010
MCP_TOKEN=test-123456

DEVSPACE_CONTROL_PLANE=https://www.astmars.com
DEVSPACE_TUNNEL_TOKEN=<same tunnel token used by DevSpace>
TUNNEL_ID=tunnel_<32-lowercase-hex>

DEVSPACE_BROWSER=chrome
```

`MCP_URL` normally does not need to be set; it is derived as
`http://127.0.0.1:$MCP_PORT/`.

The browser client does not read `HTTP_PROXY` / `HTTPS_PROXY` and does not force
a Playwright proxy. Chrome/Edge uses the normal Windows system proxy/PAC and
enterprise browser networking, matching the user's normal browser behavior.

First test only the browser-backed control-plane access:

```bash
./devspace-tunnelctl.sh probe devspace-22
```

The browser opens visibly. Complete the enterprise SSO/approval in the browser.
No terminal confirmation is required: the client probes every few seconds and
detects successful approval automatically.

After the probe succeeds, start the full stack in the background:

```bash
./devspace-tunnelctl.sh start devspace-22
```

`start` first launches `ssh-mcp` with the SSH settings from the env file,
then launches the browser-backed tunnel client. If `MCP_TOKEN` is configured,
the browser client automatically sends the same bearer token to the local
`ssh-mcp` endpoint.

Lifecycle commands:

```bash
./devspace-tunnelctl.sh status devspace-22
./devspace-tunnelctl.sh log devspace-22
./devspace-tunnelctl.sh ssh-log devspace-22
./devspace-tunnelctl.sh restart devspace-22
./devspace-tunnelctl.sh stop devspace-22
```

Each instance uses its own files:

```text
devspace-22.env
.devspace-22.ssh-mcp.pid
.devspace-22.ssh-mcp.log
.devspace-22.browser-tunnel.pid
.devspace-22.browser-tunnel.log
```

The first run creates a dedicated persistent browser profile under
`~/.devspace-browser-tunnel/<tunnel-id>`.

To use Edge, set this in the env file:

```bash
DEVSPACE_BROWSER=msedge
```

If the SSO approval button later proves to have a stable CSS selector, automatic
clicking can be enabled in the env file:

```bash
DEVSPACE_SSO_APPROVE_SELECTOR='#approve-button'
```

## Security design

The tunnel bearer token is not exposed to the page's normal JavaScript.
The client keeps a single visible browser tab and executes control-plane
`fetch()` calls inside a Chrome isolated world attached to that tab.

The enterprise SSO is still handled by the real browser context/profile.

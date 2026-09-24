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

The long-running client now treats that browser as a recoverable transport. If
the Chrome/Edge window, browser context, or transport tab is closed, a watchdog
relaunches the same persistent profile automatically. If the enterprise session
has expired, the client keeps running and retries SSO recovery instead of
exiting after one timeout. The default watchdog interval is 15 seconds and can
be changed with:

```bash
DEVSPACE_BROWSER_WATCHDOG_SECONDS=15
```

To use Edge, set this in the env file:

```bash
DEVSPACE_BROWSER=msedge
```

SSO approval is auto-clicked by default. The client recognizes the current
enterprise interstitial action `接受风险并访问` with highest priority, plus
common positive actions such as Continue / Approve / Allow / Sign in / 继续 /
允许 / 授权 / 登录. Explicit negative actions such as Cancel / Deny / Back /
取消 / 拒绝 / 返回 are never selected.

To disable text-based auto approval:

```bash
DEVSPACE_SSO_AUTO_APPROVE=0
```

If a future SSO page needs an exact selector, it can still be configured:

```bash
DEVSPACE_SSO_APPROVE_SELECTOR='#approve-button'
```

During SSO recovery the client retries the selector/text match periodically, so
an action that appears after a redirect or delayed page load is not missed.

## Security design

The tunnel bearer token is not exposed to the page's normal JavaScript.
The client keeps a single visible browser tab and executes control-plane
`fetch()` calls inside a Chrome isolated world attached to that tab.

The enterprise SSO is still handled by the real browser context/profile.

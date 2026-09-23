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

Node 22.19+ is required. The PoC uses the installed Chrome or Edge; it does not
download a Playwright browser.

## Run

Example for tunnel `22`:

```bash
export DEVSPACE_CONTROL_PLANE="https://www.astmars.com"
export DEVSPACE_TUNNEL_TOKEN="<same tunnel token used by DevSpace>"
export TUNNEL_ID="tunnel_<32-lowercase-hex>"
export MCP_URL="http://127.0.0.1:3010/"
export HTTPS_PROXY="http://<enterprise-proxy-host>:8080"

npm start -- --probe-only
```

Use `--probe-only` first. It verifies that the browser-authenticated context
can call the DevSpace tunnel metadata endpoint and then exits without polling.

After that succeeds, run the full client:

```bash
npm start
```

The first run creates a dedicated persistent browser profile under
`~/.devspace-browser-tunnel/<tunnel-id>`. Complete the SSO/approval in the
browser and press Enter in the terminal when asked.

To use Edge:

```bash
npm start -- --browser msedge
```

If the SSO approval button has a stable CSS selector, it can be automated:

```bash
npm start -- --approve-selector '#approve-button'
```

or:

```bash
export DEVSPACE_SSO_APPROVE_SELECTOR='#approve-button'
npm start
```

## Security design

The tunnel bearer token is not injected into the enterprise SSO page or the
normal astmars.com website. The client creates a blank, locally-fulfilled
same-origin page at `https://www.astmars.com/__devspace_browser_tunnel__` and
executes control-plane `fetch()` calls there.

The enterprise SSO is still handled by the real browser context/profile.

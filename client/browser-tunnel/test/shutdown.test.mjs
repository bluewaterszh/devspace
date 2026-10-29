import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

const signalTestOptions = {
  timeout: 6000,
  skip: process.platform === "win32"
    ? "Native Windows SIGTERM does not exercise POSIX handlers; validate the Git Bash launcher separately"
    : false,
};

const mockControl = `
export class BrowserControlPlane {
  async start() {
    if (process.env.TEST_SHUTDOWN_SCENARIO === "backoff") throw new Error("test network failure");
  }
  async poll() {
    if (process.env.TEST_SHUTDOWN_SCENARIO === "active" && !this.dispatched) {
      this.dispatched = true;
      return {
        status: 200, contentType: "application/json",
        json: { commands: [{
          request_id: "shutdown-test", command_type: "jsonrpc",
          response_timeout: "30s",
          jsonrpc: { jsonrpc: "2.0", id: 1, method: "tools/list" },
        }] },
      };
    }
    console.log("TEST_POLL_WAIT");
    return new Promise((resolve) => {
      this.releasePoll = resolve;
      // A real browser/poll keeps Node alive while the request is pending.
      this.pollTimer = setTimeout(() => resolve({ status: 204 }), 30_000);
    });
  }
  async postResponse() {
    console.log("TEST_DELIVERY");
    return { status: 200, contentType: "application/json", json: { status: "ok" } };
  }
  async recover() {
    console.log("TEST_RECOVERY_FAILED");
    throw new Error("test network failure");
  }
  async close() {
    console.log("TEST_CLOSE");
    clearTimeout(this.pollTimer);
    this.releasePoll?.({ status: 204 });
  }
}
export function isControlPlaneResponse(result) {
  return result.status >= 200 && result.status < 300;
}
`;

async function launch(t, scenario, mcpUrl = "http://127.0.0.1:1/") {
  const dir = await mkdtemp(join(tmpdir(), "devspace-cli-shutdown-"));
  const source = await readFile(new URL("../bin/devspace-browser-tunnel.mjs", import.meta.url), "utf8");
  // Run the real CLI with only the browser control plane mocked. The forwarding,
  // delivery and shutdown code all come from the repository under test.
  const modified = source
    .replace('"../lib/control-plane.mjs"', '"./control-plane.mjs"')
    .replaceAll('"../lib/', '"' + new URL("../lib/", import.meta.url).href);
  await writeFile(join(dir, "cli.mjs"), modified);
  await writeFile(join(dir, "control-plane.mjs"), mockControl);
  const child = spawn(process.execPath, [join(dir, "cli.mjs")], {
    env: {
      ...process.env,
      DEVSPACE_CONTROL_PLANE: "https://control.example.test",
      TUNNEL_ID: "shutdown-test",
      DEVSPACE_TUNNEL_TOKEN: "test-token",
      DEVSPACE_TUNNEL_DIAGNOSTICS: "0",
      TEST_SHUTDOWN_SCENARIO: scenario,
      MCP_URL: mcpUrl,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (data) => { output += data; });
  child.stderr.on("data", (data) => { output += data; });
  const exited = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
    await rm(dir, { recursive: true, force: true });
  });

  async function waitFor(marker) {
    for (let i = 0; i < 150 && !output.includes(marker); i++) {
      if (child.exitCode !== null || child.signalCode !== null) break;
      await delay(20);
    }
    assert.ok(output.includes(marker), `missing ${marker}: ${output}`);
  }
  async function stop() {
    const startedAt = Date.now();
    child.kill("SIGTERM");
    let timer;
    const exit = await Promise.race([
      exited,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`shutdown timed out: ${output}`)), 1500);
      }),
    ]).finally(() => clearTimeout(timer));
    assert.deepEqual(exit, [0, null], output);
    assert.ok(Date.now() - startedAt < 1500);
    assert.equal(output.split("TEST_CLOSE").length - 1, 1, "close must be shared");
    assert.equal(output.includes("TEST_DELIVERY"), false, "shutdown must not send a fallback");
  }
  return { waitFor, stop };
}

test("SIGTERM interrupts an outstanding poll and closes before the launcher grace period", signalTestOptions, async (t) => {
  const child = await launch(t, "poll");
  await child.waitFor("TEST_POLL_WAIT");
  await child.stop();
});

test("SIGTERM interrupts recovery backoff instead of waiting for the next retry", signalTestOptions, async (t) => {
  const child = await launch(t, "backoff");
  await child.waitFor("AUTH_RECOVERY_PENDING");
  await child.stop();
});

test("SIGTERM aborts an active local MCP body read and closes the browser once", signalTestOptions, async (t) => {
  let bodyStarted;
  const started = new Promise((resolve) => { bodyStarted = resolve; });
  let bodyClosed;
  const closed = new Promise((resolve) => { bodyClosed = resolve; });
  const server = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write('{"jsonrpc":"2.0","id":1,"result":');
    res.once("close", bodyClosed);
    bodyStarted();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    const stopped = once(server, "close");
    server.close();
    server.closeAllConnections();
    await stopped;
  });
  const child = await launch(t, "active", `http://127.0.0.1:${server.address().port}/mcp`);
  await child.waitFor("TEST_POLL_WAIT");
  await started;
  await child.stop();
  await closed;
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("client requires an explicit control-plane URL before opening a browser", () => {
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL("../bin/devspace-browser-tunnel.mjs", import.meta.url)),
  ], {
    env: {
      ...process.env,
      DEVSPACE_CONTROL_PLANE: "",
      TUNNEL_ID: "test-tunnel",
      DEVSPACE_TUNNEL_TOKEN: "test-token",
    },
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /missing --control-plane or DEVSPACE_CONTROL_PLANE/);
  assert.doesNotMatch(result.stdout, /starting browser tunnel/);
});

test("launcher rejects a profile without a control-plane URL before starting services", {
  skip: process.platform === "win32" ? "requires a POSIX shell" : false,
}, () => {
  const dir = mkdtempSync(join(tmpdir(), "devspace-launcher-config-"));
  try {
    const script = join(dir, "devspace-tunnelctl.sh");
    copyFileSync(new URL("../devspace-tunnelctl.sh", import.meta.url), script);
    writeFileSync(join(dir, "test.env"), [
      "SSH_HOST='server.example.com'", "SSH_USER='test-user'", "WORKDIR='/tmp'",
      "TUNNEL_ID='test-tunnel'", "DEVSPACE_TUNNEL_TOKEN='test-token'",
      "DEVSPACE_CONTROL_PLANE=''",
    ].join("\n") + "\n");
    const result = spawnSync("bash", [script, "start", "test"], {
      env: { ...process.env, DEVSPACE_CONTROL_PLANE: "" },
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /DEVSPACE_CONTROL_PLANE is empty/);
    assert.doesNotMatch(result.stdout, /Starting ssh-mcp|Starting browser-tunnel/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";

const dir = mkdtempSync(join(tmpdir(), "devspace-relay-config-"));

try {
  writeFileSync(join(dir, "config.jsonc"), JSON.stringify({
    openai: {
      port: 18550,
      publicBaseUrl: "https://www.astmars.com:8550"
    },
    tunnel: {
      port: 18551,
      publicBaseUrl: "https://www.astmars.com:8551",
      responseTimeoutMs: 90000,
      maxPollWaitMs: 12000
    },
    storage: { stateDir: join(dir, "state") }
  }, null, 2));

  const authPath = join(dir, "auth.json");
  writeFileSync(authPath, JSON.stringify({
    ownerToken: "owner-secret-value-123456",
    tunnelToken: "tunnel-secret-value-123456"
  }));
  chmodSync(authPath, 0o600);

  const config = loadConfig({ DEVSPACE_CONFIG_DIR: dir });

  assert.equal(config.openai.host, "127.0.0.1");
  assert.equal(config.tunnel.host, "127.0.0.1");
  assert.equal(config.openai.port, 18550);
  assert.equal(config.tunnel.port, 18551);
  assert.equal(config.openai.publicBaseUrl, "https://www.astmars.com:8550");
  assert.equal(config.tunnel.publicBaseUrl, "https://www.astmars.com:8551");
  assert.equal(config.relay.tunnelToken, "tunnel-secret-value-123456");
  assert.equal(config.oauth.ownerToken, "owner-secret-value-123456");
  assert.equal(config.relay.responseTimeoutMs, 90000);
  assert.equal(config.relay.maxPollWaitMs, 12000);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log("config tests passed");

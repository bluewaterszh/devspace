import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultDevspaceConfig } from "./config-schema.js";
import { loadTunnelRelayOptions } from "./tunnel-relay.js";
import {
  devspaceAuthPath,
  devspaceConfigPath,
  writeDevspaceAuth,
  writeDevspaceConfig,
} from "./user-config.js";

const configDir = mkdtempSync(join(tmpdir(), "devspace-tunnel-relay-test-"));
const env = { DEVSPACE_CONFIG_DIR: configDir };

try {
  const config = defaultDevspaceConfig();
  config.relay.tunnelId = "tunnel_0123456789abcdef0123456789abcdef";
  config.relay.name = "SSH-238";
  config.relay.description = "SSH relay for 238";
  config.relay.responseTimeoutMs = 91_000;
  config.relay.maxPollWaitMs = 17_000;
  writeDevspaceConfig(config, env);
  writeDevspaceAuth({
    ownerToken: "test-only-owner-value-123456",
    tunnelToken: "test-only-relay-secret-123456",
  }, env);

  assert.deepEqual(loadTunnelRelayOptions(env), {
    tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
    tunnelToken: "test-only-relay-secret-123456",
    name: "SSH-238",
    description: "SSH relay for 238",
    responseTimeoutMs: 91_000,
    maxPollWaitMs: 17_000,
  });

  const configSource = readFileSync(devspaceConfigPath(env), "utf8");
  const authSource = readFileSync(devspaceAuthPath(env), "utf8");
  assert.doesNotMatch(configSource, /test-only-relay-secret-123456/);
  assert.match(authSource, /test-only-relay-secret-123456/);

  assert.deepEqual(loadTunnelRelayOptions({
    ...env,
    DEVSPACE_RELAY_TUNNEL_ID: "tunnel_fedcba9876543210fedcba9876543210",
    DEVSPACE_RELAY_TUNNEL_TOKEN: "test-only-env-secret-123456",
    DEVSPACE_RELAY_TUNNEL_NAME: "env-name",
    DEVSPACE_RELAY_TUNNEL_DESCRIPTION: "env-description",
    DEVSPACE_RELAY_RESPONSE_TIMEOUT_MS: "12345",
    DEVSPACE_RELAY_MAX_POLL_WAIT_MS: "6789",
  }), {
    tunnelId: "tunnel_fedcba9876543210fedcba9876543210",
    tunnelToken: "test-only-env-secret-123456",
    name: "env-name",
    description: "env-description",
    responseTimeoutMs: 12_345,
    maxPollWaitMs: 6_789,
  });
} finally {
  rmSync(configDir, { recursive: true, force: true });
}

console.log("tunnel relay config tests passed");

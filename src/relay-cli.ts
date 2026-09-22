#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { shutdownHttpServer } from "./server-shutdown.js";
import {
  createTunnelRelayServer,
  loadTunnelRelayOptions,
} from "./tunnel-relay.js";
import { loadDevspaceFiles } from "./user-config.js";

async function main(): Promise<void> {
  const files = loadDevspaceFiles();
  if (files.migratedLegacyConfig) {
    console.log(`Migrated legacy configuration to ${files.configPath}`);
  }
  if (!files.configExists || !files.authExists) {
    throw new Error("DevSpace is not configured. Run: devspace init");
  }

  const config = loadConfig();
  const options = loadTunnelRelayOptions();
  const { app, close } = createTunnelRelayServer(config, options);
  const httpServer = app.listen(config.port, config.host, () => {
    console.log(`devspace relay listening on http://${config.host}:${config.port}/mcp`);
    console.log(`public MCP URL: ${new URL("/mcp", config.publicBaseUrl).toString()}`);
    console.log(`tunnel id: ${options.tunnelId}`);
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await shutdownHttpServer(httpServer, close);
    process.exit(0);
  };
  const handleShutdown = () => {
    void shutdown().catch((error) => {
      console.error("devspace relay shutdown failed", error);
      process.exit(1);
    });
  };

  process.once("SIGINT", handleShutdown);
  process.once("SIGTERM", handleShutdown);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

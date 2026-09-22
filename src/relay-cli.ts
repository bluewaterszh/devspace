#!/usr/bin/env node
import type { Server } from "node:http";
import { loadConfig } from "./config.js";
import { createRelayApplications } from "./tunnel-relay.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const applications = createRelayApplications(config);

  const openaiServer = await listen(
    applications.openaiApp,
    config.openai.port,
    config.openai.host,
  );
  let tunnelServer: Server;
  try {
    tunnelServer = await listen(
      applications.tunnelApp,
      config.tunnel.port,
      config.tunnel.host,
    );
  } catch (error) {
    await closeHttpServer(openaiServer);
    await applications.close();
    throw error;
  }

  console.log(
    `openai MCP: ${config.openai.publicBaseUrl}/mcp -> `
    + `http://${config.openai.host}:${config.openai.port}`,
  );
  console.log(
    `windows tunnel: ${config.tunnel.publicBaseUrl}/v1/tunnels/${config.relay.tunnelId} -> `
    + `http://${config.tunnel.host}:${config.tunnel.port}`,
  );

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await Promise.all([
      closeHttpServer(openaiServer),
      closeHttpServer(tunnelServer),
    ]);
    await applications.close();
  };

  const handleSignal = () => {
    void shutdown()
      .then(() => process.exit(0))
      .catch((error) => {
        console.error(error);
        process.exit(1);
      });
  };

  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);
}

function listen(
  app: { listen(port: number, host: string): Server },
  port: number,
  host: string,
): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host);
    server.once("listening", () => resolve(server));
    server.once("error", reject);
  });
}

function closeHttpServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

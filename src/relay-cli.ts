#!/usr/bin/env node
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { parse, type ParseError, printParseErrorCode } from "jsonc-parser";
import { loadConfig } from "./config.js";
import {
  createRelayApplications,
  type TunnelDefinition,
} from "./tunnel-relay.js";

interface StoredMultiTunnelConfig {
  tunnels?: Record<string, string | { tunnelId?: string }>;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const tunnels = loadTunnelDefinitions(config.configDir);
  const applications = createRelayApplications(config, tunnels);

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
    `openai: ${config.openai.publicBaseUrl} -> http://`
    + `${config.openai.host}:${config.openai.port}`,
  );
  console.log(
    `windows control: ${config.tunnel.publicBaseUrl} -> http://`
    + `${config.tunnel.host}:${config.tunnel.port}`,
  );

  for (const tunnel of tunnels) {
    console.log(
      `[${tunnel.slug}] MCP ${config.openai.publicBaseUrl}/mcp/${tunnel.slug}; `
      + `tunnelId=${tunnel.tunnelId}`,
    );
  }

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

function loadTunnelDefinitions(
  configDir: string,
): TunnelDefinition[] {
  const configPath = join(configDir, "config.jsonc");
  const errors: ParseError[] = [];
  const stored = parse(
    readFileSync(configPath, "utf8"),
    errors,
    { allowTrailingComma: true },
  ) as StoredMultiTunnelConfig | undefined;

  if (errors.length > 0) {
    const first = errors[0]!;
    throw new Error(
      `Unable to parse ${configPath}: `
      + `${printParseErrorCode(first.error)} at offset ${first.offset}`,
    );
  }

  const raw = stored?.tunnels;
  if (!raw || Object.keys(raw).length === 0) {
    throw new Error("At least one tunnel must be configured in tunnels");
  }

  const tunnels: TunnelDefinition[] = [];
  const ids = new Set<string>();

  for (const [slug, value] of Object.entries(raw)) {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(slug)) {
      throw new Error(
        `tunnels key "${slug}" must match [a-z0-9][a-z0-9_-]{0,63}`,
      );
    }

    const tunnelId = typeof value === "string"
      ? value.trim()
      : value.tunnelId?.trim();

    if (!tunnelId || !/^tunnel_[0-9a-f]{32}$/.test(tunnelId)) {
      throw new Error(
        `tunnels.${slug} must match tunnel_ followed by 32 lowercase hex characters`,
      );
    }

    if (ids.has(tunnelId)) {
      throw new Error(`Duplicate tunnelId: ${tunnelId}`);
    }
    ids.add(tunnelId);

    tunnels.push({ slug, tunnelId });
  }

  return tunnels;
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
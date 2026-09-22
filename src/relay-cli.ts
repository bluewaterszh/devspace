#!/usr/bin/env node
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { parse, type ParseError, printParseErrorCode } from "jsonc-parser";
import { loadConfig, type ServerConfig } from "./config.js";
import { createRelayApplications, type RelayApplications } from "./tunnel-relay.js";

interface TunnelInstanceConfig {
  tunnelId: string;
  name?: string;
  description?: string;
  openaiPort: number;
  openaiPublicBaseUrl: string;
  controlPort: number;
  controlPublicBaseUrl: string;
}

interface StoredMultiTunnelConfig {
  tunnels?: Record<string, TunnelInstanceConfig>;
}

interface RunningTunnel {
  slug: string;
  config: ServerConfig;
  applications: RelayApplications;
  openaiServer: Server;
  tunnelServer: Server;
}

async function main(): Promise<void> {
  const baseConfig = loadConfig();
  const tunnelDefinitions = loadTunnelDefinitions(baseConfig);
  const running: RunningTunnel[] = [];

  try {
    for (const [slug, definition] of Object.entries(tunnelDefinitions)) {
      const config = configForTunnel(baseConfig, slug, definition);
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

      running.push({
        slug,
        config,
        applications,
        openaiServer,
        tunnelServer,
      });

      console.log(
        `[${slug}] openai MCP: ${config.openai.publicBaseUrl}/mcp -> `
        + `http://${config.openai.host}:${config.openai.port}`,
      );
      console.log(
        `[${slug}] windows tunnel: ${config.tunnel.publicBaseUrl}/v1/tunnels/`
        + `${config.relay.tunnelId} -> http://${config.tunnel.host}:${config.tunnel.port}`,
      );
    }
  } catch (error) {
    await shutdownAll(running);
    throw error;
  }

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await shutdownAll(running);
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
  baseConfig: ServerConfig,
): Record<string, TunnelInstanceConfig> {
  const configPath = join(baseConfig.configDir, "config.jsonc");
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

  const definitions = stored?.tunnels;
  if (!definitions || Object.keys(definitions).length === 0) {
    return {
      default: {
        tunnelId: baseConfig.relay.tunnelId,
        name: baseConfig.relay.name,
        description: baseConfig.relay.description,
        openaiPort: baseConfig.openai.port,
        openaiPublicBaseUrl: baseConfig.openai.publicBaseUrl,
        controlPort: baseConfig.tunnel.port,
        controlPublicBaseUrl: baseConfig.tunnel.publicBaseUrl,
      },
    };
  }

  validateTunnelDefinitions(definitions);
  return definitions;
}

function validateTunnelDefinitions(
  definitions: Record<string, TunnelInstanceConfig>,
): void {
  const ids = new Set<string>();
  const localPorts = new Set<number>();

  for (const [slug, value] of Object.entries(definitions)) {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(slug)) {
      throw new Error(
        `tunnels key "${slug}" must match [a-z0-9][a-z0-9_-]{0,63}`,
      );
    }

    if (!/^tunnel_[0-9a-f]{32}$/.test(value.tunnelId)) {
      throw new Error(
        `tunnels.${slug}.tunnelId must match tunnel_ followed by 32 lowercase hex characters`,
      );
    }

    if (ids.has(value.tunnelId)) {
      throw new Error(`Duplicate tunnelId: ${value.tunnelId}`);
    }
    ids.add(value.tunnelId);

    for (const [name, port] of [
      ["openaiPort", value.openaiPort],
      ["controlPort", value.controlPort],
    ] as const) {
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`tunnels.${slug}.${name} must be a valid TCP port`);
      }
      if (localPorts.has(port)) {
        throw new Error(`Duplicate local listener port: ${port}`);
      }
      localPorts.add(port);
    }

    requireHttpsUrl(value.openaiPublicBaseUrl, `tunnels.${slug}.openaiPublicBaseUrl`);
    requireHttpsUrl(value.controlPublicBaseUrl, `tunnels.${slug}.controlPublicBaseUrl`);
  }
}

function configForTunnel(
  base: ServerConfig,
  slug: string,
  definition: TunnelInstanceConfig,
): ServerConfig {
  return {
    ...base,
    openai: {
      ...base.openai,
      port: definition.openaiPort,
      publicBaseUrl: normalizeBaseUrl(definition.openaiPublicBaseUrl),
    },
    tunnel: {
      ...base.tunnel,
      port: definition.controlPort,
      publicBaseUrl: normalizeBaseUrl(definition.controlPublicBaseUrl),
    },
    relay: {
      ...base.relay,
      tunnelId: definition.tunnelId,
      name: definition.name?.trim() || slug,
      description:
        definition.description?.trim() || `DevSpace SSH MCP relay for ${slug}`,
    },
  };
}

function requireHttpsUrl(value: string, name: string): void {
  const url = new URL(value);
  if (url.protocol !== "https:") {
    throw new Error(`${name} must use https`);
  }
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
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

async function shutdownAll(running: RunningTunnel[]): Promise<void> {
  await Promise.all(
    running.flatMap((entry) => [
      closeHttpServer(entry.openaiServer),
      closeHttpServer(entry.tunnelServer),
    ]),
  );
  await Promise.all(running.map((entry) => entry.applications.close()));
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

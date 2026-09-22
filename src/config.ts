import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import type { OAuthConfig } from "./oauth-provider.js";

export interface ListenerConfig {
  host: string;
  port: number;
  publicBaseUrl: string;
  allowedHosts: string[];
  trustProxy: boolean;
}

export interface RelayConfig {
  tunnelToken: string;
  responseTimeoutMs: number;
  maxPollWaitMs: number;
}

export interface ServerConfig {
  configDir: string;
  openai: ListenerConfig;
  tunnel: ListenerConfig;
  stateDir: string;
  oauth: OAuthConfig;
  relay: RelayConfig;
}

interface StoredConfig {
  openai?: Partial<ListenerConfig>;
  tunnel?: Partial<ListenerConfig> & {
    responseTimeoutMs?: number;
    maxPollWaitMs?: number;
  };
  storage?: { stateDir?: string };
  oauth?: {
    accessTokenTtlSeconds?: number;
    refreshTokenTtlSeconds?: number;
    scopes?: string[];
    allowedResourceUrls?: string[];
    allowedRedirectHosts?: string[];
  };
}

interface AuthConfig {
  ownerToken?: string;
  tunnelToken?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const configDir = resolve(env.DEVSPACE_CONFIG_DIR ?? join(homedir(), ".devspace"));
  const configPath = join(configDir, "config.jsonc");
  const authPath = join(configDir, "auth.json");
  const stored = readJsonc<StoredConfig>(configPath);
  const auth = readJson<AuthConfig>(authPath);
  assertPrivateFile(authPath);

  return {
    configDir,
    openai: listener(stored.openai, {
      host: "127.0.0.1",
      port: 18550,
      publicBaseUrl: "https://www.astmars.com:8550",
    }),
    tunnel: listener(stored.tunnel, {
      host: "127.0.0.1",
      port: 18551,
      publicBaseUrl: "https://www.astmars.com:8551",
    }),
    stateDir: resolve(stored.storage?.stateDir ?? join(configDir, "state")),
    oauth: {
      ownerToken: requiredSecret(auth.ownerToken, "ownerToken"),
      accessTokenTtlSeconds: positiveInt(
        stored.oauth?.accessTokenTtlSeconds,
        3600,
        "oauth.accessTokenTtlSeconds",
      ),
      refreshTokenTtlSeconds: positiveInt(
        stored.oauth?.refreshTokenTtlSeconds,
        30 * 24 * 3600,
        "oauth.refreshTokenTtlSeconds",
      ),
      scopes: stringArray(stored.oauth?.scopes, ["devspace"]),
      allowedResourceUrls: stringArray(stored.oauth?.allowedResourceUrls, []),
      allowedRedirectHosts: stringArray(
        stored.oauth?.allowedRedirectHosts,
        ["chatgpt.com", "localhost", "127.0.0.1"],
      ),
    },
    relay: {
      tunnelToken: requiredSecret(auth.tunnelToken, "tunnelToken"),
      responseTimeoutMs: positiveInt(
        stored.tunnel?.responseTimeoutMs,
        120_000,
        "tunnel.responseTimeoutMs",
      ),
      maxPollWaitMs: positiveInt(
        stored.tunnel?.maxPollWaitMs,
        30_000,
        "tunnel.maxPollWaitMs",
      ),
    },
  };
}

function listener(
  value: Partial<ListenerConfig> | undefined,
  defaults: Pick<ListenerConfig, "host" | "port" | "publicBaseUrl">,
): ListenerConfig {
  const host = value?.host?.trim() || defaults.host;
  const port = positiveInt(value?.port, defaults.port, "listener.port");
  const publicBaseUrl = normalizeUrl(value?.publicBaseUrl ?? defaults.publicBaseUrl);
  const publicHost = new URL(publicBaseUrl).hostname;

  return {
    host,
    port,
    publicBaseUrl,
    allowedHosts: Array.from(new Set([
      host,
      publicHost,
      ...(value?.allowedHosts ?? []),
    ].map((entry) => entry.trim()).filter(Boolean))),
    trustProxy: value?.trustProxy ?? true,
  };
}

function normalizeUrl(value: string): string {
  const parsed = new URL(value);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("publicBaseUrl must use http or https");
  }
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

function positiveInt(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return result;
}

function stringArray(value: string[] | undefined, fallback: string[]): string[] {
  const result = value ?? fallback;
  return result.map((entry) => entry.trim()).filter(Boolean);
}

function requiredSecret(value: string | undefined, name: string): string {
  const secret = value?.trim();
  if (!secret || secret.length < 16) {
    throw new Error(`${name} must be at least 16 characters`);
  }
  return secret;
}

function readJsonc<T>(path: string): T {
  const errors: ParseError[] = [];
  const value = parse(readFileSync(path, "utf8"), errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    const first = errors[0]!;
    throw new Error(
      `Unable to parse ${path}: ${printParseErrorCode(first.error)} at offset ${first.offset}`,
    );
  }
  return (value ?? {}) as T;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function assertPrivateFile(path: string): void {
  if (process.platform === "win32") return;
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(`${path} must not be accessible by group/other; run chmod 600 ${path}`);
  }
}

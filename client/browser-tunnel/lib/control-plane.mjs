import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

const CLIENT_NAME = "devspace-browser-tunnel";
const CLIENT_VERSION = "0.1.0";

export class BrowserControlPlane {
  constructor(options) {
    this.baseUrl = new URL(options.baseUrl);
    this.tunnelId = options.tunnelId;
    this.token = options.token;
    this.browserChannel = options.browserChannel ?? "chrome";
    this.profileDir = options.profileDir
      ?? join(homedir(), ".devspace-browser-tunnel", this.tunnelId);
    this.proxy = options.proxy;
    this.approveSelector = options.approveSelector;
    this.ssoWaitMs = options.ssoWaitMs ?? 180_000;
    this.ssoProbeIntervalMs = options.ssoProbeIntervalMs ?? 2_000;
    this.instanceId = randomBytes(16).toString("hex");
    this.context = undefined;
    this.transportPage = undefined;
    this.ssoPage = undefined;
  }

  async start() {
    const launchOptions = {
      channel: this.browserChannel,
      headless: false,
      viewport: null,
    };
    if (this.proxy) launchOptions.proxy = { server: this.proxy };

    this.context = await chromium.launchPersistentContext(
      this.profileDir,
      launchOptions,
    );

    const bridgeUrl = new URL(
      "/__devspace_browser_tunnel__",
      this.baseUrl,
    ).href;

    await this.context.route(bridgeUrl, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: "<!doctype html><title>DevSpace Browser Tunnel</title>"
          + "<body>DevSpace browser transport is active.</body>",
      });
    });

    this.ssoPage = this.context.pages()[0] ?? await this.context.newPage();
    this.transportPage = await this.context.newPage();
    await this.transportPage.goto(bridgeUrl, { waitUntil: "domcontentloaded" });

    await this.ensureAuthorized();
  }

  async close() {
    await this.context?.close();
  }

  async metadata() {
    return this.request(
      `/v1/tunnels/${encodeURIComponent(this.tunnelId)}`,
    );
  }

  async poll(limit, timeoutMs) {
    return this.request(
      `/v1/tunnels/${encodeURIComponent(this.tunnelId)}/poll`
        + `?limit=${encodeURIComponent(limit)}`
        + `&timeout_ms=${encodeURIComponent(timeoutMs)}`,
    );
  }

  async postResponse(command, payload) {
    return this.request(
      `/v1/tunnels/${encodeURIComponent(this.tunnelId)}/response`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Tunnel-Shard-Token": command.shard_token,
        },
        body: JSON.stringify(payload),
      },
    );
  }

  async ensureAuthorized() {
    let probe = await this.metadata();
    if (isTunnelMetadata(probe, this.tunnelId)) {
      console.log(
        `control plane ready: ${this.baseUrl.origin} tunnel=${this.tunnelId}`,
      );
      return;
    }

    console.log("control-plane request is not authenticated through the browser.");
    printProbe(probe);

    await this.openSsoPage();

    if (this.approveSelector) {
      try {
        const button = this.ssoPage.locator(this.approveSelector).first();
        await button.waitFor({ state: "visible", timeout: 10_000 });
        console.log(`auto-clicking SSO selector: ${this.approveSelector}`);
        await button.click();
      } catch (error) {
        console.warn(
          `automatic SSO click did not complete: ${error instanceof Error ? error.message : error}`,
        );
      }
    }

    await this.ssoPage.bringToFront();
    console.log(
      "Complete the enterprise SSO/approval in the browser. "
        + "The client will detect success automatically.",
    );

    const deadline = Date.now() + this.ssoWaitMs;
    while (Date.now() < deadline) {
      await sleep(this.ssoProbeIntervalMs);
      probe = await this.metadata();
      if (isTunnelMetadata(probe, this.tunnelId)) {
        console.log("browser SSO accepted; control plane is ready.");
        return;
      }
    }

    printProbe(probe);
    throw new Error(
      `Browser SSO did not become valid within ${Math.ceil(this.ssoWaitMs / 1000)}s`,
    );
  }

  async recoverSso(result) {
    console.warn("control-plane browser session needs SSO approval again.");
    printProbe(result);
    await this.ensureAuthorized();
  }

  async openSsoPage() {
    try {
      await this.ssoPage.goto(this.baseUrl.origin + "/", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
    } catch (error) {
      console.warn(
        `SSO page navigation did not finish: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  async request(path, init = {}) {
    const url = new URL(path, this.baseUrl).href;
    const headers = {
      Authorization: `Bearer ${this.token}`,
      "X-Tunnel-Client-Name": CLIENT_NAME,
      "X-Tunnel-Client-Version": CLIENT_VERSION,
      "X-Tunnel-Client-Instance-Id": this.instanceId,
      "X-Tunnel-Mcp-Server-Info": JSON.stringify({
        version: 1,
        channels: [{ name: "main" }],
      }),
      ...(init.headers ?? {}),
    };

    const result = await this.transportPage.evaluate(
      async ({ url, method, headers, body }) => {
        try {
          const response = await fetch(url, {
            method,
            headers,
            body,
            credentials: "include",
            cache: "no-store",
            redirect: "follow",
          });
          const text = await response.text();
          return {
            networkError: null,
            status: response.status,
            url: response.url,
            redirected: response.redirected,
            contentType: response.headers.get("content-type") ?? "",
            text,
          };
        } catch (error) {
          return {
            networkError: String(error),
            status: 0,
            url,
            redirected: false,
            contentType: "",
            text: "",
          };
        }
      },
      {
        url,
        method: init.method ?? "GET",
        headers,
        body: init.body ?? null,
      },
    );

    result.json = parseJson(result.text);
    return result;
  }
}

export function isControlPlaneResponse(result) {
  if (result.networkError) return false;
  if (result.status === 204) return true;
  if (result.status < 200 || result.status >= 300) return false;
  return result.contentType.toLowerCase().includes("application/json");
}

function isTunnelMetadata(result, tunnelId) {
  return isControlPlaneResponse(result)
    && result.status === 200
    && result.json?.id === tunnelId;
}

function parseJson(text) {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printProbe(result) {
  const body = result.text
    ? result.text.replace(/\s+/g, " ").slice(0, 240)
    : "";
  console.warn(
    JSON.stringify({
      networkError: result.networkError,
      status: result.status,
      responseUrl: result.url,
      redirected: result.redirected,
      contentType: result.contentType,
      bodyPrefix: body,
    }),
  );
}

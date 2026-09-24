import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

const CLIENT_NAME = "devspace-browser-tunnel";
const CLIENT_VERSION = "0.1.0";
const ISOLATED_WORLD_NAME = "devspace-browser-tunnel";

export class BrowserControlPlane {
  constructor(options) {
    this.baseUrl = new URL(options.baseUrl);
    this.tunnelId = options.tunnelId;
    this.token = options.token;
    this.browserChannel = options.browserChannel ?? "chrome";
    this.profileDir = options.profileDir
      ?? join(homedir(), ".devspace-browser-tunnel", this.tunnelId);
    this.approveSelector = options.approveSelector;
    this.autoApprove = options.autoApprove ?? true;
    this.ssoWaitMs = options.ssoWaitMs ?? 180_000;
    this.ssoProbeIntervalMs = options.ssoProbeIntervalMs ?? 2_000;
    this.watchdogIntervalMs = options.watchdogIntervalMs ?? 15_000;
    this.browserRestartDelayMs = options.browserRestartDelayMs ?? 1_000;
    this.browserRestartAttempts = options.browserRestartAttempts ?? 5;
    this.instanceId = randomBytes(16).toString("hex");
    this.context = undefined;
    this.page = undefined;
    this.cdp = undefined;
    this.recoveryPromise = undefined;
    this.watchdogTimer = undefined;
    this.stopping = false;
    this.lastSsoCandidateLogAt = 0;
  }

  async start() {
    this.stopping = false;
    await this.launchBrowserContext();
    this.startWatchdog();
    await this.openSsoPage();
    await this.ensureAuthorized();
  }

  async launchBrowserContext() {
    const launchOptions = {
      channel: this.browserChannel,
      headless: false,
      viewport: null,
    };
    this.context = await chromium.launchPersistentContext(
      this.profileDir,
      launchOptions,
    );

    const pages = this.context.pages();
    this.page = pages[0] ?? await this.context.newPage();

    // Keep exactly one visible tab. The control-plane fetches execute in a
    // Chrome isolated world attached to this same page, so the bearer token is
    // not visible to the page's own JavaScript and no extra transport tab is
    // needed.
    for (const extraPage of pages.slice(1)) {
      await extraPage.close().catch(() => {});
    }

    this.cdp = await this.context.newCDPSession(this.page);
    await this.cdp.send("Page.enable");
    this.bindBrowserLifecycle(this.context, this.page);
  }

  bindBrowserLifecycle(context, page) {
    context.once("close", () => {
      if (this.context !== context) return;
      this.context = undefined;
      this.page = undefined;
      this.cdp = undefined;
      if (!this.stopping) {
        console.warn("browser context closed; scheduling automatic recovery.");
        this.scheduleRecovery("browser context closed");
      }
    });

    page.once("close", () => {
      if (this.page !== page) return;
      this.page = undefined;
      this.cdp = undefined;
      if (!this.stopping) {
        console.warn("browser transport tab closed; scheduling automatic recovery.");
        this.scheduleRecovery("browser transport tab closed");
      }
    });
  }

  isBrowserTransportReady() {
    return Boolean(
      this.context
      && this.page
      && !this.page.isClosed()
      && this.cdp,
    );
  }

  startWatchdog() {
    if (this.watchdogTimer || this.watchdogIntervalMs <= 0) return;
    this.watchdogTimer = setInterval(() => {
      if (this.stopping || this.isBrowserTransportReady()) return;
      console.warn("browser watchdog detected unavailable transport.");
      this.scheduleRecovery("browser watchdog");
    }, this.watchdogIntervalMs);
    this.watchdogTimer.unref?.();
  }

  scheduleRecovery(reason) {
    if (this.stopping) return;
    void this.restartBrowser(reason).catch((error) => {
      if (!this.stopping) {
        console.warn(
          `automatic browser recovery paused: ${errorMessage(error)}`,
        );
      }
    });
  }

  async restartBrowser(reason) {
    if (this.recoveryPromise) return this.recoveryPromise;

    this.recoveryPromise = this.doRestartBrowser(reason)
      .finally(() => {
        this.recoveryPromise = undefined;
      });
    return this.recoveryPromise;
  }

  async doRestartBrowser(reason) {
    console.warn(`restarting browser transport: ${reason}`);

    const oldContext = this.context;
    this.context = undefined;
    this.page = undefined;
    this.cdp = undefined;
    await oldContext?.close().catch(() => {});

    let lastError;
    for (let attempt = 1; attempt <= this.browserRestartAttempts; attempt += 1) {
      if (this.stopping) throw new Error("browser control plane is stopping");
      if (attempt > 1) {
        await sleep(this.browserRestartDelayMs * attempt);
      }

      try {
        console.log(
          `launching persistent browser profile attempt=${attempt}/${this.browserRestartAttempts}`,
        );
        await this.launchBrowserContext();
        if (this.stopping) {
          const stoppingContext = this.context;
          this.context = undefined;
          this.page = undefined;
          this.cdp = undefined;
          await stoppingContext?.close().catch(() => {});
          throw new Error("browser control plane is stopping");
        }
        await this.openSsoPage();
        await this.ensureAuthorized();
        console.log("browser transport recovered.");
        return;
      } catch (error) {
        lastError = error;
        const failedContext = this.context;
        this.context = undefined;
        this.page = undefined;
        this.cdp = undefined;
        await failedContext?.close().catch(() => {});
        console.warn(
          `browser recovery attempt=${attempt} failed: ${errorMessage(error)}`,
        );
      }
    }

    throw new Error(
      `browser could not be recovered after ${this.browserRestartAttempts} attempts: `
        + errorMessage(lastError),
    );
  }

  async close() {
    this.stopping = true;
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = undefined;
    }

    const context = this.context;
    this.context = undefined;
    this.page = undefined;
    this.cdp = undefined;
    await context?.close().catch(() => {});
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
    let probe = await this.probeIfSameOrigin();
    if (probe && isTunnelMetadata(probe, this.tunnelId)) {
      console.log(
        `control plane ready: ${this.baseUrl.origin} tunnel=${this.tunnelId}`,
      );
      return;
    }

    if (probe) {
      console.log("control-plane request is not authenticated through the browser.");
      printProbe(probe);
    }

    await this.page?.bringToFront().catch(() => {});

    console.log(
      "Complete the enterprise SSO/approval in the browser. "
        + "The client will detect success automatically.",
    );

    const deadline = Date.now() + this.ssoWaitMs;
    let lastClickAt = 0;
    while (Date.now() < deadline) {
      if (!this.isBrowserTransportReady()) {
        throw new Error("browser was closed while waiting for SSO approval");
      }

      if (
        (this.approveSelector || this.autoApprove)
        && Date.now() - lastClickAt >= 2_000
      ) {
        lastClickAt = Date.now();
        await this.tryApproveSso();
      }

      await sleep(this.ssoProbeIntervalMs);

      probe = await this.probeIfSameOrigin();
      if (probe && isTunnelMetadata(probe, this.tunnelId)) {
        console.log("browser SSO accepted; control plane is ready.");
        return;
      }
    }

    if (probe) printProbe(probe);
    throw new Error(
      `Browser SSO did not become valid within ${Math.ceil(this.ssoWaitMs / 1000)}s`,
    );
  }

  async tryApproveSso() {
    if (!this.page || this.page.isClosed()) return false;

    if (this.approveSelector) {
      try {
        const button = this.page.locator(this.approveSelector).first();
        if (await button.isVisible({ timeout: 500 }).catch(() => false)) {
          console.log(`auto-clicking SSO selector: ${this.approveSelector}`);
          await button.click({ timeout: 5_000 });
          return true;
        }
      } catch (error) {
        console.warn(
          `automatic SSO selector click did not complete: ${errorMessage(error)}`,
        );
      }
    }

    if (!this.autoApprove) return false;

    const candidates = await this.collectSsoActionCandidates();
    const action = selectSsoAction(candidates, {
      allowSingleFallback: !sameOrigin(this.page.url(), this.baseUrl.origin),
    });

    if (!action) {
      this.logSsoCandidates(candidates);
      return false;
    }

    console.log(
      `auto-clicking SSO action label=${JSON.stringify(action.label)} `
        + `kind=${action.kind} url=${action.frameUrl}`,
    );

    try {
      await action.locator.click({ timeout: 5_000 });
      return true;
    } catch (error) {
      console.warn(
        `automatic SSO action click did not complete: ${errorMessage(error)}`,
      );
      return false;
    }
  }

  async collectSsoActionCandidates() {
    const selector = [
      "button",
      'input[type="submit"]',
      'input[type="button"]',
      "a",
      '[role="button"]',
    ].join(",");

    const candidates = [];
    for (const frame of this.page.frames()) {
      const controls = frame.locator(selector);
      const count = Math.min(await controls.count().catch(() => 0), 30);

      for (let index = 0; index < count; index += 1) {
        const locator = controls.nth(index);
        const visible = await locator.isVisible({ timeout: 250 }).catch(() => false);
        if (!visible) continue;
        const enabled = await locator.isEnabled({ timeout: 250 }).catch(() => false);
        if (!enabled) continue;

        const details = await locator.evaluate((element) => {
          const tag = element.tagName.toLowerCase();
          const type = (element.getAttribute("type") ?? "").toLowerCase();
          const label = [
            element.innerText,
            element.getAttribute("value"),
            element.getAttribute("aria-label"),
            element.getAttribute("title"),
          ].find((value) => value && value.trim()) ?? "";
          return { tag, type, label: label.replace(/\s+/g, " ").trim() };
        }).catch(() => undefined);

        if (!details?.label) continue;
        candidates.push({
          ...details,
          kind: details.tag === "input"
            ? `input:${details.type || "button"}`
            : details.tag,
          frameUrl: frame.url(),
          locator,
        });
      }
    }

    return candidates;
  }

  logSsoCandidates(candidates) {
    if (Date.now() - this.lastSsoCandidateLogAt < 10_000) return;
    this.lastSsoCandidateLogAt = Date.now();

    console.log(
      "SSO_AUTO_APPROVE_WAITING "
        + JSON.stringify({
          pageUrl: this.page?.url(),
          candidates: candidates.slice(0, 12).map((candidate) => ({
            label: candidate.label,
            kind: candidate.kind,
            frameUrl: candidate.frameUrl,
          })),
        }),
    );
  }

  async recover(reason = "control-plane recovery", result) {
    console.warn(`control-plane recovery requested: ${reason}`);
    if (result) printProbe(result);

    if (!this.isBrowserTransportReady()) {
      await this.restartBrowser(reason);
      return;
    }

    await this.openSsoPage();
    await this.ensureAuthorized();
  }

  async recoverSso(result) {
    await this.recover("control-plane authentication expired", result);
  }

  async openSsoPage() {
    if (!this.isBrowserTransportReady()) {
      throw new Error("browser transport is unavailable");
    }

    try {
      await this.page.goto(this.baseUrl.origin + "/", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
    } catch (error) {
      console.warn(
        `SSO page navigation did not finish: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  async probeIfSameOrigin() {
    if (
      !this.isBrowserTransportReady()
      || !sameOrigin(this.page.url(), this.baseUrl.origin)
    ) {
      return undefined;
    }
    return this.metadata();
  }

  async request(path, init = {}) {
    const url = new URL(path, this.baseUrl).href;

    if (
      !this.isBrowserTransportReady()
      || !sameOrigin(this.page.url(), this.baseUrl.origin)
    ) {
      return {
        networkError: `browser page is not at control-plane origin: ${this.page?.url() ?? "unavailable"}`,
        status: 0,
        url,
        redirected: false,
        contentType: "",
        text: "",
        json: undefined,
      };
    }

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

    let result;
    try {
      result = await this.evaluateIsolatedFetch({
        url,
        method: init.method ?? "GET",
        headers,
        body: init.body ?? null,
      });
    } catch (error) {
      result = {
        networkError: String(error),
        status: 0,
        url,
        redirected: false,
        contentType: "",
        text: "",
      };
    }

    result.json = parseJson(result.text);
    return result;
  }

  async evaluateIsolatedFetch(args) {
    const frameTree = await this.cdp.send("Page.getFrameTree");
    const frameId = frameTree.frameTree.frame.id;
    const world = await this.cdp.send("Page.createIsolatedWorld", {
      frameId,
      worldName: ISOLATED_WORLD_NAME,
      grantUniveralAccess: false,
    });

    const serialized = JSON.stringify(args);
    const expression = `(async () => {
      const { url, method, headers, body } = ${serialized};
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
    })()`;

    const evaluated = await this.cdp.send("Runtime.evaluate", {
      expression,
      contextId: world.executionContextId,
      awaitPromise: true,
      returnByValue: true,
    });

    if (evaluated.exceptionDetails) {
      throw new Error(
        evaluated.exceptionDetails.exception?.description
          ?? evaluated.exceptionDetails.text
          ?? "isolated browser fetch failed",
      );
    }

    return evaluated.result.value;
  }
}

export function selectSsoAction(candidates, options = {}) {
  const ranked = candidates
    .map((candidate) => ({
      candidate,
      score: scoreSsoAction(candidate.label, candidate.kind),
    }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score);

  if (ranked.length > 0) {
    const best = ranked[0];
    const second = ranked[1];
    if (!second || best.score > second.score) return best.candidate;

    const tied = ranked.filter(({ score }) => score === best.score);
    if (tied.length === 1) return best.candidate;
  }

  if (!options.allowSingleFallback) return undefined;

  const fallback = candidates.filter((candidate) => {
    if (isNegativeSsoLabel(candidate.label)) return false;
    return candidate.kind === "button"
      || candidate.kind === "input:submit";
  });

  return fallback.length === 1 ? fallback[0] : undefined;
}

function scoreSsoAction(label, kind) {
  const text = normalizeSsoLabel(label);
  if (!text || isNegativeSsoLabel(text)) return 0;

  const strong = [
    /^(接受风险并访问)$/,
    /^(accept risk and (visit|continue|proceed))$/,
    /^(continue|proceed|approve|allow|authorize|confirm|verify|next)$/,
    /^(sign\s*in|log\s*in|login)$/,
    /^(继续|继续访问|确认|同意|允许|授权|登录|登入|验证|下一步)$/,
  ];
  const positive = [
    /\b(continue|proceed|approve|allow|authorize|confirm|verify|next)\b/,
    /\b(sign\s*in|log\s*in|login)\b/,
    /(继续|确认|同意|允许|授权|登录|登入|验证|下一步)/,
    /(click\s+here|点击此处|点击这里)/,
  ];

  let score = 0;
  if (strong.some((pattern) => pattern.test(text))) score = 100;
  else if (positive.some((pattern) => pattern.test(text))) score = 70;
  if (score === 0) return 0;

  if (kind === "button" || kind === "input:submit") score += 10;
  else if (kind === "input:button") score += 5;
  return score;
}

function isNegativeSsoLabel(label) {
  const text = normalizeSsoLabel(label);
  return /\b(cancel|deny|decline|reject|back|sign\s*out|log\s*out|logout)\b/.test(text)
    || /(取消|拒绝|不同意|返回|退出)/.test(text);
}

function normalizeSsoLabel(label) {
  return String(label ?? "").replace(/\s+/g, " ").trim().toLowerCase();
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

function sameOrigin(value, expectedOrigin) {
  try {
    return new URL(value).origin === expectedOrigin;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error ?? "unknown error");
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

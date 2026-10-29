import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { TunnelDiagnostics } from "./diagnostics.mjs";

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
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.pollTimeoutGraceMs = options.pollTimeoutGraceMs ?? 15_000;
    this.activeRequests = new Set();
    this.browserLaunchPromise = undefined;
    this.launchingContext = undefined;
    this.cancelLaunch = undefined;
    this.closePromise = undefined;
    this.instanceId = randomBytes(16).toString("hex");
    this.context = undefined;
    this.page = undefined;
    this.cdp = undefined;
    this.recoveryPromise = undefined;
    this.authorizationRecoveryPromise = undefined;
    this.watchdogTimer = undefined;
    this.stopping = false;
    this.lastSsoCandidateLogAt = 0;
    this.diagnostics = new TunnelDiagnostics({
      enabled: options.diagnosticsEnabled ?? true,
      runtime: () => ({
        ...options.diagnosticsRuntime?.(),
        browserReady: this.isBrowserTransportReady(),
      }),
    });
  }

  async start() {
    if (this.stopping) throw new Error("browser control plane is stopping");
    this.diagnostics.start();
    await this.launchBrowserContext();
    if (this.stopping) {
      await this.closeBrowserContext();
      throw new Error("browser control plane is stopping");
    }
    this.startWatchdog();
    const page = this.page;
    await this.openSsoPage(page);
    await this.ensureAuthorized(page);
  }

  async launchBrowserContext() {
    if (this.browserLaunchPromise) return this.browserLaunchPromise;
    if (this.stopping) throw new Error("browser control plane is stopping");
    this.browserLaunchPromise = this.doLaunchBrowserContext()
      .finally(() => { this.browserLaunchPromise = undefined; });
    return this.browserLaunchPromise;
  }

  async doLaunchBrowserContext() {
    const context = await chromium.launchPersistentContext(this.profileDir, {
      channel: this.browserChannel,
      headless: false,
      viewport: null,
    });
    this.launchingContext = context;
    let active = true;
    const check = () => {
      if (!active || this.stopping || this.launchingContext !== context) {
        throw new Error("browser setup was cancelled or control plane is stopping");
      }
    };
    const cancelled = new Promise((_, reject) => {
      this.cancelLaunch = (error) => {
        if (!active) return;
        active = false;
        reject(error);
      };
    });
    const timer = setTimeout(() => {
      this.cancelLaunch?.(new Error(`Browser setup timed out after ${this.requestTimeoutMs}ms`));
    }, this.requestTimeoutMs);
    try {
      const setup = (async () => {
        check();
        const pages = context.pages();
        const page = pages[0] ?? await context.newPage();
        check();
        // Fetches use an isolated world on one dedicated visible tab.
        for (const extraPage of pages.slice(1)) {
          await extraPage.close().catch(() => {});
          check();
        }
        const cdp = await context.newCDPSession(page);
        check();
        await cdp.send("Page.enable");
        check();
        return { page, cdp };
      })();
      const { page, cdp } = await Promise.race([setup, cancelled]);
      check();
      this.context = context;
      this.page = page;
      this.cdp = cdp;
      this.launchingContext = undefined;
      this.bindBrowserLifecycle(context, page);
      this.diagnostics.attachNetwork(cdp, this.baseUrl, this.tunnelId);
    } catch (error) {
      if (this.launchingContext === context) {
        this.launchingContext = undefined;
        await context.close().catch(() => {});
      }
      throw error;
    } finally {
      clearTimeout(timer);
      active = false;
      this.cancelLaunch = undefined;
    }
  }

  bindBrowserLifecycle(context, page) {
    context.once("close", () => {
      if (this.context !== context) return;
      this.diagnostics.detachNetwork();
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
      this.diagnostics.detachNetwork();
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
    this.diagnostics.detachNetwork();
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
          this.diagnostics.detachNetwork();
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
        this.diagnostics.detachNetwork();
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
    if (this.closePromise) return this.closePromise;
    this.stopping = true;
    this.diagnostics.stop();
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = undefined;
    }
    this.cancelRequests(undefined, new Error("browser control plane is stopping"));
    this.cancelLaunch?.(new Error("browser control plane is stopping"));
    this.closePromise = (async () => {
      await this.closeBrowserContext();
      await this.browserLaunchPromise?.catch(() => {});
      await this.closeBrowserContext();
    })();
    return this.closePromise;
  }

  async closeBrowserContext() {
    const contexts = new Set([this.context, this.launchingContext]);
    this.diagnostics.detachNetwork();
    this.context = undefined;
    this.launchingContext = undefined;
    this.page = undefined;
    this.cdp = undefined;
    await Promise.all([...contexts].map((context) => context?.close().catch(() => {})));
  }

  cancelRequests(cdp, error) {
    for (const request of this.activeRequests) {
      if (!cdp || request.cdp === cdp) request.cancel(error);
    }
  }

  expireRequest(request, timeoutMs) {
    const error = new Error(`Browser control request timed out after ${timeoutMs}ms`);
    if (this.cdp === request.cdp && this.page === request.page) {
      this.cdp = undefined;
      this.diagnostics.detachNetwork();
      // Detach releases CDP callbacks; never block timeout handling on it.
      void Promise.resolve().then(() => request.cdp.detach?.()).catch(() => {});
    }
    this.cancelRequests(request.cdp, error);
  }

  assertRequestCurrent(request) {
    if (!request.active || this.stopping
      || request.cdp !== this.cdp || request.page !== this.page) {
      throw new Error("browser control request was cancelled or transport changed");
    }
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
      {},
      timeoutMs + this.pollTimeoutGraceMs,
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

  assertSsoPage(page) {
    if (this.stopping || page !== this.page || !this.isBrowserTransportReady()) {
      throw new Error("browser transport changed while recovering authorization");
    }
    if (page.url().startsWith("chrome-error://")) {
      throw new Error("browser network error page; control-plane navigation must be retried");
    }
  }

  assertMetadataTransport(probe) {
    if (probe && (probe.networkError || probe.status === 0)) {
      throw new Error("control-plane metadata transport failed; navigation must be retried");
    }
  }

  async ensureAuthorized(page = this.page) {
    this.assertSsoPage(page);
    let probe = await this.probeIfSameOrigin();
    this.assertSsoPage(page);
    let metadataSsoClicked = false;
    let manualSsoWaiting = false;
    if (probe && (probe.networkError || probe.status === 0)) {
      // A protected API redirect can fail CORS while the login page stays
      // healthy. Try one explicit action, never an arbitrary single button.
      if (!this.autoApprove && !this.approveSelector) {
        const candidates = await this.collectSsoActionCandidates(page);
        this.assertSsoPage(page);
        manualSsoWaiting = Boolean(selectSsoAction(candidates, { allowSingleFallback: false }));
      } else {
        metadataSsoClicked = await this.tryApproveSso(page, { allowSingleFallback: false });
        this.assertSsoPage(page);
      }
      if (!metadataSsoClicked && !manualSsoWaiting) this.assertMetadataTransport(probe);
      if (metadataSsoClicked) {
        await sleep(this.ssoProbeIntervalMs);
        this.assertSsoPage(page);
        probe = await this.probeIfSameOrigin();
        this.assertSsoPage(page);
      }
    }
    if (!manualSsoWaiting) this.assertMetadataTransport(probe);
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

    await page.bringToFront().catch(() => {});
    this.assertSsoPage(page);

    console.log(
      "Complete the enterprise SSO/approval in the browser. "
        + "The client will detect success automatically.",
    );

    const deadline = Date.now() + this.ssoWaitMs;
    let lastClickAt = metadataSsoClicked ? Date.now() : 0;
    while (Date.now() < deadline) {
      this.assertSsoPage(page);

      if (
        (this.approveSelector || this.autoApprove)
        && Date.now() - lastClickAt >= 2_000
      ) {
        lastClickAt = Date.now();
        await this.tryApproveSso(page);
        this.assertSsoPage(page);
      }

      await sleep(this.ssoProbeIntervalMs);
      this.assertSsoPage(page);

      probe = await this.probeIfSameOrigin();
      this.assertSsoPage(page);
      if (!manualSsoWaiting) this.assertMetadataTransport(probe);
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

  async tryApproveSso(page = this.page, options = {}) {
    this.assertSsoPage(page);

    if (this.approveSelector) {
      try {
        const button = page.locator(this.approveSelector).first();
        if (await button.isVisible({ timeout: 500 }).catch(() => false)) {
          this.assertSsoPage(page);
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

    this.assertSsoPage(page);
    const candidates = await this.collectSsoActionCandidates(page);
    this.assertSsoPage(page);
    const action = selectSsoAction(candidates, {
      allowSingleFallback: options.allowSingleFallback ?? !sameOrigin(page.url(), this.baseUrl.origin),
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

  async collectSsoActionCandidates(page = this.page) {
    const selector = [
      "button",
      'input[type="submit"]',
      'input[type="button"]',
      "a",
      '[role="button"]',
    ].join(",");

    const candidates = [];
    for (const frame of page.frames()) {
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
    if (this.authorizationRecoveryPromise) return this.authorizationRecoveryPromise;

    // Browser replacement has its own promise: authorization recovery may join
    // it, but restarting a browser must never wait on this same operation.
    this.authorizationRecoveryPromise = this.doRecover(reason, result)
      .finally(() => {
        this.authorizationRecoveryPromise = undefined;
      });
    return this.authorizationRecoveryPromise;
  }

  async doRecover(reason, result) {
    console.warn(`control-plane recovery requested: ${reason}`);
    if (result) printProbe(result);

    if (this.recoveryPromise) return this.recoveryPromise;
    if (!this.isBrowserTransportReady()) {
      await this.restartBrowser(reason);
      return;
    }

    const page = this.page;
    try {
      await this.openSsoPage(page);
      this.assertSsoPage(page);
      await this.ensureAuthorized(page);
    } catch (error) {
      // A close event/watchdog can replace the browser during a navigation or
      // SSO probe. Join that replacement instead of touching its new page.
      if (page !== this.page && this.recoveryPromise) {
        await this.recoveryPromise;
        return;
      }
      throw error;
    }
  }

  async recoverSso(result) {
    await this.recover("control-plane authentication expired", result);
  }

  async openSsoPage(page = this.page) {
    // A Chrome error page is allowed here because this navigation repairs it.
    if (this.stopping || page !== this.page || !this.isBrowserTransportReady()) {
      throw new Error("browser transport is unavailable");
    }

    try {
      await page.goto(this.baseUrl.origin + "/", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
    } catch (error) {
      console.warn(
        `SSO page navigation did not finish: ${error instanceof Error ? error.message : error}`,
      );
      // ERR_ABORTED can be an ordinary SSO redirect; other Chrome network
      // failures must return to the retry loop instead of waiting for approval.
      if (/net::ERR_(?!ABORTED\b)/.test(errorMessage(error))) {
        throw new Error("SSO page network navigation failed; navigation must be retried", { cause: error });
      }
    }
    this.assertSsoPage(page);
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

  async request(path, init = {}, timeoutMs = this.requestTimeoutMs) {
    const url = new URL(path, this.baseUrl).href;

    if (
      this.stopping || !this.isBrowserTransportReady()
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

    const route = path.split("?")[0];
    const kind = route.endsWith("/poll") ? "poll"
      : route.endsWith("/response") ? "response" : "metadata";
    const operation = this.diagnostics.begin(kind);
    const request = { cdp: this.cdp, page: this.page, active: true };
    const cancelled = new Promise((_, reject) => {
      request.cancel = (error) => {
        if (!request.active) return;
        request.active = false;
        reject(error);
      };
    });
    this.activeRequests.add(request);
    const timer = setTimeout(() => this.expireRequest(request, timeoutMs), timeoutMs);
    timer.unref?.();
    let result;
    try {
      result = await Promise.race([
        this.evaluateIsolatedFetch({
          url,
          method: init.method ?? "GET",
          headers,
          body: init.body ?? null,
          timeoutMs,
        }, operation, request),
        cancelled,
      ]);
    } catch (error) {
      result = {
        networkError: String(error),
        status: 0,
        url,
        redirected: false,
        contentType: "",
        text: "",
      };
    } finally {
      clearTimeout(timer);
      request.active = false;
      this.activeRequests.delete(request);
    }

    this.diagnostics.end(operation, result ?? { status: 0, networkError: true });
    result.json = parseJson(result.text);
    return result;
  }

  async evaluateIsolatedFetch(args, operation, request) {
    this.assertRequestCurrent(request);
    this.diagnostics.stage(operation, "get_frame_tree");
    const cdp = request.cdp;
    const frameTree = await cdp.send("Page.getFrameTree");
    this.assertRequestCurrent(request);
    const frameId = frameTree.frameTree.frame.id;
    this.diagnostics.stage(operation, "create_world");
    const world = await cdp.send("Page.createIsolatedWorld", {
      frameId,
      worldName: ISOLATED_WORLD_NAME,
      grantUniveralAccess: false,
    });

    this.assertRequestCurrent(request);
    const serialized = JSON.stringify(args);
    const expression = `(async () => {
      const { url, method, headers, body, timeoutMs } = ${serialized};
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), timeoutMs);
      try {
        const response = await fetch(url, {
          method,
          headers,
          body,
          credentials: "include",
          cache: "no-store",
          redirect: "follow",
          signal: abort.signal,
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
      } finally {
        clearTimeout(timer);
      }
    })()`;

    this.diagnostics.stage(operation, "evaluate");
    const evaluated = await cdp.send("Runtime.evaluate", {
      expression,
      contextId: world.executionContextId,
      awaitPromise: true,
      returnByValue: true,
    });

    this.assertRequestCurrent(request);
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

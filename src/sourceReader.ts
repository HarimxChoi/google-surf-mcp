import { chromium, type BrowserContext } from 'playwright';
import { detectSystemChrome } from './browser.js';
import { fetchBrowserResource, extract, type ExtractMode, type ExtractResult } from './extract.js';
import type { Config } from './config.js';
import { createNetworkDenyProxy } from './networkDeny.js';

interface ReaderSession { context: BrowserContext; close: () => Promise<void> }
export class SourceReader {
  private session: Promise<ReaderSession> | undefined;
  private active = 0;
  private readonly waiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  private idle: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private resourceActive = 0;
  private readonly resourceWaiters: Array<() => void> = [];
  constructor(private readonly config: Config, private readonly create: () => Promise<ReaderSession> = async () => {
    const denyProxy = await createNetworkDenyProxy();
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
    browser = await chromium.launch({
      executablePath: config.chromePath ?? detectSystemChrome(), headless: true,
      chromiumSandbox: !config.noSandbox,
      proxy:{ server:denyProxy.url, bypass:'<-loopback>' },
      args: ['--disable-quic', '--disable-background-networking', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', ...(config.cloudMode ? ['--disable-dev-shm-usage'] : [])],
    });
      const context = await browser.newContext({ ignoreHTTPSErrors: config.insecureTls, locale: config.locale,
        timezoneId: config.timezone, serviceWorkers: 'block', acceptDownloads: false });
      await context.route('**/*', async (route) => {
        if (['image', 'media', 'font'].includes(route.request().resourceType())) return route.abort();
        if (this.resourceActive >= 4) await new Promise<void>(resolve => this.resourceWaiters.push(resolve));
        else this.resourceActive++;
        try {
          if (this.disposed) return await route.abort('blockedbyclient');
          const response = await fetchBrowserResource(route.request().url(), await route.request().allHeaders(), route.request().method());
          return await route.fulfill(response);
        } catch { return await route.abort('blockedbyclient'); }
        finally { const next = this.resourceWaiters.shift(); if (next) next(); else this.resourceActive--; }
      });
      await context.routeWebSocket('**/*', socket => socket.close());
      const ownedBrowser=browser;
      return { context, close: async () => { try { await ownedBrowser.close(); } finally { await denyProxy.close(); } } };
    } catch (error) { await browser?.close().catch(()=>{}); await denyProxy.close(); throw error; }
  }) {}
  private async context(): Promise<BrowserContext> {
    if (this.disposed) throw new Error('source reader closed');
    if (!this.session) {
      const pending = this.create();
      this.session = pending;
      pending.catch(() => { if (this.session === pending) this.session = undefined; });
    }
    return (await this.session).context;
  }
  async read(url: string, maxChars: number, mode: ExtractMode = 'full'): Promise<ExtractResult> {
    if (this.disposed) throw new Error('source reader closed');
    if (this.idle) { clearTimeout(this.idle); this.idle = undefined; }
    if (this.active >= 2) await new Promise<void>((resolve, reject) => this.waiters.push({ resolve, reject }));
    else this.active++;
    try {
      if (this.disposed) throw new Error('source reader closed');
      return await extract(() => this.context(), url, { maxChars, mode });
    } finally {
      const next = this.waiters.shift();
      if (next) next.resolve();
      else this.active--;
      if (!this.disposed && !this.active && this.config.idleCloseMs > 0) {
        this.idle = setTimeout(() => { this.idle = undefined; void this.close(); }, this.config.idleCloseMs);
        this.idle.unref();
      }
    }
  }
  private async close(): Promise<void> {
    const session = this.session;
    this.session = undefined;
    if (session) await (await session.catch(() => undefined))?.close().catch(() => {});
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.idle) clearTimeout(this.idle);
    for (const waiter of this.waiters.splice(0)) waiter.reject(new Error('source reader closed'));
    await this.close();
  }
  stats(): Record<string, unknown> {
    return { initialized: Boolean(this.session), active: this.active, queued: this.waiters.length, concurrency: 2, headless: true,
      network_policy:'pinned_get_head_with_unrouted_deny_proxy',resource_concurrency:4 };
  }
}

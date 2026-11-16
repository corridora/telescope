import playwright from 'playwright';
import {
  mkdirSync,
  rmSync,
  copyFileSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  renameSync,
  statSync,
  createReadStream,
} from 'fs';
import path from 'path';
import url from 'url';
import { execFile } from 'child_process';

function isDockerDesktop(): boolean {
  const inDocker = existsSync('/.dockerenv');
  if (!inDocker) return false;

  try {
    const kernel = readFileSync('/proc/version', 'utf8');
    return kernel.includes('linuxkit');
  } catch {
    return false;
  }
}

import {
  start as throttleStart,
  stop as throttleStop,
} from '@sitespeed.io/throttle';
import { networkTypes } from './connectivity.js';
import ejs from 'ejs';
import { log, logTimer, generateTestID } from './helpers.js';
import AdmZip from 'adm-zip';
import crypto from 'crypto';
import type {
  BrowserConfigOptions,
  SimplifiedBrowserConfigOptions,
  LaunchOptions,
  TestPaths,
  ResultAssets,
  Metrics,
  ConsoleMessage,
  RequestData,
  ResourceTiming,
  HarData,
  HarEntry,
  LCPEvent,
  LayoutShift,
  NavigationTiming,
  PriorityInfo,
  FilmstripFrame,
  ConnectionType,
  SavedConfig,
  RunPhase,
  RunStatus,
  ResultManifest,
} from './types.js';
import type { BrowserContext, Page, Route, Request } from 'playwright';
import { delayUsingFulfill, delayUsingContinue } from './delay.js';
import { runBaselinePipeline } from './baseline.js';
import { BrowserConfig } from './browsers.js';
import { acquireExecutionLease } from './executionLease.js';
import { DEFAULT_OPTIONS } from './defaultOptions.js';

const TELESCOPE_ID_HEADER = 'x-telescope-id';

class TestRunner {
  args: string[] = [];
  consoleMessages: ConsoleMessage[] = [];
  browserConfig: BrowserConfigOptions;
  metrics?: Metrics;
  newPriorities: Record<string, string> = {};
  resourceTimings: ResourceTiming[] = [];
  paths: TestPaths = {} as TestPaths;
  priorities: PriorityInfo = {} as PriorityInfo;
  requests: RequestData[] = [];
  telescopeIdToRequestId: Record<string, string> = {};
  resultAssets: ResultAssets = {
    filmstripFiles: [],
    videoFile: null,
  };
  options: LaunchOptions;
  testURL: string;
  selectedBrowser: BrowserConfigOptions;
  TESTID: string;
  videoRecordingFile: string = '';
  browserInstance: BrowserContext | null = null;
  page: Page | null = null;
  readonly resultsRoot: string;
  private readonly startedAt = new Date().toISOString();
  private closeContextPromise?: Promise<void>;
  private throttlingStarted = false;
  private releaseExecutionLease?: () => Promise<void>;

  constructor(options: LaunchOptions, browserConfig: BrowserConfigOptions) {
    this.options = options;
    this.testURL = options.url;
    this.selectedBrowser = browserConfig;
    this.browserConfig = browserConfig;
    this.resultsRoot = path.resolve(
      options.resultsDir ?? DEFAULT_OPTIONS.resultsDir,
    );
    this.TESTID = generateTestID();
    this.setupPaths(this.TESTID);
  }

  /** Creates absolute output paths and an isolated browser profile for this run. */
  setupPaths(testID: string): void {
    this.paths.temporaryContext = path.join(
      this.resultsRoot,
      '.telescope',
      'tmp',
      testID,
    );
    this.paths.results = path.join(this.resultsRoot, testID);
    this.paths.filmstrip = path.join(this.paths.results, 'filmstrip');
    mkdirSync(this.resultsRoot, { recursive: true });
    mkdirSync(this.paths.results, { recursive: false });

    this.selectedBrowser.recordHar.path =
      this.paths['results'] + '/pageload.har';
    this.selectedBrowser.recordVideo.dir = this.paths['results'];
  }

  /** Reports a lifecycle transition without allowing observers to fail capture. */
  reportProgress(phase: RunPhase): void {
    try {
      this.options.onProgress?.({
        testId: this.TESTID,
        resultsPath: this.paths.results,
        phase,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      log('Progress observer error: ' + (error as Error).message);
    }
  }

  /** Throws a consistent cancellation error when an execution was aborted. */
  throwIfAborted(): void {
    if (this.options.signal?.aborted) {
      const error = new Error('Test cancelled');
      error.name = 'AbortError';
      throw error;
    }
  }

  /** Applies an agent operator's hostname policy to every browser destination. */
  isAllowedURL(value: string): boolean {
    if (!this.options.allowedHosts) return true;
    let target: URL;
    try {
      target = new URL(value);
    } catch {
      return false;
    }
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(target.protocol))
      return false;
    const hostname = target.hostname.toLowerCase().replace(/\.$/, '');
    return this.options.allowedHosts.some(entry => {
      const allowed = entry.toLowerCase().replace(/\.$/, '');
      if (allowed.startsWith('*.')) {
        const suffix = allowed.slice(1);
        return hostname.endsWith(suffix) && hostname.length > suffix.length;
      }
      return hostname === allowed;
    });
  }

  /**
   * Set up any necessary request blocking, using the page.route handler
   */
  async setupBlocking(page: Page): Promise<void> {
    if (this.options.blockDomains && this.options.blockDomains.length > 0) {
      const domains: string[] = [];

      this.options.blockDomains.forEach(domain => {
        domains.push('//' + domain + '/'); /* Domain part of URL */
      });

      const domain_rx = new RegExp(domains.join('|'));

      await page.route(domain_rx, async (route: Route) => {
        route.abort();
      });
    }

    if (this.options.block && this.options.block.length > 0) {
      const blocks_rx = new RegExp(this.options.block.join('|'));

      await page.route(blocks_rx, async (route: Route) => {
        route.abort();
      });
    }

    return;
  }

  /**
   * Set up any hostname overrides that have been requested.
   *
   * Registers a `page.route()` handler only when there is at least one
   * override entry. Calling `page.route()` disables Playwright's HTTP
   * cache (see https://playwright.dev/docs/api/class-page#page-route),
   * so this must be a no-op for the common case where no overrides are
   * configured — otherwise features like Early Hints break silently.
   * See https://github.com/cloudflare/telescope/issues/327.
   */
  async setupHostOverrides(
    page: Page,
    overrides: Record<string, string>,
  ): Promise<void> {
    const rewrites = new Map(
      Object.entries(overrides).filter(([, target]) => !!target),
    );
    if (rewrites.size === 0) {
      return;
    }

    const matchHost = (url: URL): boolean => rewrites.has(url.host);

    await page.route(matchHost, async (route: Route, request: Request) => {
      const original_url = new URL(request.url());
      const original_domain = original_url.host;
      const override = rewrites.get(original_domain);
      if (!override) {
        return route.fallback();
      }

      const new_url = new URL(original_url.toString());
      new_url.host = override;
      if (!this.isAllowedURL(new_url.toString())) {
        await route.abort('blockedbyclient');
        return;
      }

      const all_headers = await request.allHeaders();
      const headers = {
        ...all_headers,
        'X-Host': original_domain,
      };

      return route.fallback({ headers, url: new_url.toString() });
    });

    return;
  }

  /**
   * Set up response delays using the page.route handler
   */
  async setupResponseDelays(page: Page): Promise<void[]> {
    if (!this.options.delay) {
      return [];
    }

    return Promise.all(
      Object.entries(this.options.delay).map(async ([regexString, delay]) => {
        log(
          `Adding a rule for delaying URLs matching '${regexString}' regex for ${delay} (using "${this.options.delayUsing}" method)`,
        );

        let regex: RegExp;
        try {
          regex = new RegExp(regexString, 'i');
        } catch (error) {
          const message =
            `Invalid delay rule regex '${regexString}': ` +
            (error instanceof Error ? error.message : String(error));
          throw new Error(message, { cause: error });
        }

        if (this.options.delayUsing === 'fulfill') {
          await page.route(regex, async (route: Route, request: Request) =>
            delayUsingFulfill(route, request, regexString, delay),
          );
        } else if (this.options.delayUsing === 'continue') {
          await page.route(regex, async (route: Route, request: Request) =>
            delayUsingContinue(route, request, regexString, delay),
          );
        }
      }),
    );
  }

  /**
   * Creates a browser instance using the browser config for the browser to be tested
   * Also merges in any browser-specific settings
   */
  async createBrowser(): Promise<BrowserContext> {
    this.throwIfAborted();
    const profile = new BrowserConfig();
    profile.createUserDataDir(
      this.selectedBrowser,
      this.paths.temporaryContext,
    );
    if (
      this.selectedBrowser.engine === 'firefox' &&
      this.options.firefoxPrefs
    ) {
      profile.addFirefoxPrefs(
        this.options.firefoxPrefs,
        this.paths.temporaryContext,
      );
    }
    //turn on logging
    this.selectedBrowser.logger = {
      isEnabled: (_name: string, _severity: string) => true,
      log: (name: string, severity: string, message: string) => {
        console.log(name + ' ' + severity + ' ' + message);
      },
    };
    if (this.options.disableJS) {
      this.selectedBrowser.javaScriptEnabled = false;
    }
    if (this.options.auth) {
      this.selectedBrowser.httpCredentials = this.options.auth;
    }

    const engine = this.selectedBrowser.engine;
    const browserType = playwright[engine];

    if (this.options.agentExtra) {
      const simpleOptions: SimplifiedBrowserConfigOptions = {
        args: this.selectedBrowser.args
          ? [...this.selectedBrowser.args]
          : undefined,
        channel: this.selectedBrowser.channel,
        engine: this.selectedBrowser.engine,
        firefoxUserPrefs: this.selectedBrowser.firefoxUserPrefs,
        headless: this.selectedBrowser.headless,
        ignoreDefaultArgs: this.selectedBrowser.ignoreDefaultArgs,
        viewport: { height: 1, width: 1 },
      };

      if (simpleOptions.args) {
        const idx = simpleOptions.args.indexOf('--metrics-recording-only');
        if (idx > -1) {
          simpleOptions.args.splice(idx, 1);
        }
      }

      const tmpbrowser = await browserType.launch({
        ...simpleOptions,
        timeout: this.options.timeout ?? DEFAULT_OPTIONS.timeout,
      } as Parameters<typeof browserType.launchPersistentContext>[1]);
      try {
        const tmpcontext = await tmpbrowser.newContext();
        const tmppage = await tmpcontext.newPage();
        const originalUserAgent = await tmppage.evaluate(
          () => navigator.userAgent,
        );
        this.selectedBrowser.userAgent = originalUserAgent.concat(
          ' ',
          this.options.agentExtra.trim(),
        );
      } finally {
        await tmpbrowser.close();
      }
    }

    this.throwIfAborted();
    const browser = await browserType.launchPersistentContext(
      this.paths['temporaryContext'],
      {
        ...this.selectedBrowser,
        timeout: this.options.timeout ?? DEFAULT_OPTIONS.timeout,
        ...(this.options.allowedHosts
          ? { serviceWorkers: 'block' as const }
          : {}),
      } as Parameters<typeof browserType.launchPersistentContext>[1],
    );
    this.browserInstance = browser;
    try {
      this.throwIfAborted();
      await this.prepareContext(browser);
      this.throwIfAborted();
      return browser;
    } catch (error) {
      await this.closeContext();
      throw error;
    }
  }

  /**
   * Given a browser instance, grab the page and then kick off anything that
   * needs to be attached at the page level
   */
  async createPage(browser: BrowserContext): Promise<Page> {
    const page = browser.pages()[0];
    await this.preparePage(page);
    return page;
  }

  setupConsoleMessages(page: Page): void {
    //collect console messages
    page.on('console', msg => {
      this.consoleMessages.push({
        type: msg.type(),
        text: msg.text(),
        location: msg.location(),
      });
    });
    return;
  }

  async preparePage(page: Page): Promise<void> {
    this.setupConsoleMessages(page);

    if (
      this.options.overrideHost &&
      Object.keys(this.options.overrideHost).length > 0
    ) {
      await this.setupHostOverrides(page, this.options.overrideHost);
    }

    // In Playwright, route handlers are executed in reverse order of registration (last registered handler runs first)
    // delays would be set up first, then blocking
    // blocking would happen first, then delays
    await this.setupResponseDelays(page);
    await this.setupBlocking(page);

    // Registered last so it runs first — injects a unique ID header into every
    // request, which Playwright records in the HAR.
    await page.route('**/*', async (route: Route, request: Request) => {
      if (!this.isAllowedURL(request.url())) {
        await route.abort('blockedbyclient');
        return;
      }
      const id = crypto.randomUUID();
      const original = await request.headersArray();
      const headers: Record<string, string> = {};
      for (const { name, value } of original) {
        if (headers[name]) {
          // Note: We need to flatten an array of headers to a Record<string, string>
          // If there are duplicates, we can join them with a comma
          // This is valid per RFC 9110, section 5.2 + 5.3
          headers[name] = `${headers[name]}, ${value}`;
        } else {
          headers[name] = value;
        }
      }
      headers[TELESCOPE_ID_HEADER] = id;
      await route.fallback({ headers });
    });

    page.on('requestfinished', data => {
      const telescopeId = data.headers()[TELESCOPE_ID_HEADER];
      if (!telescopeId) {
        console.warn(
          `[testRunner] requestfinished: missing ${TELESCOPE_ID_HEADER} header for ${data.url()}`,
        );
        return;
      }
      const reqData: RequestData = {
        timing: data.timing(),
        resourceType: data.resourceType(),
        telescopeId,
      };
      this.requests.push(reqData);
    });
  }

  /**
   * Prepares the context by kicking off anything that needs to be attached at the context level
   */
  async prepareContext(context: BrowserContext): Promise<void> {
    if (this.options.allowedHosts) {
      if (!this.isAllowedURL(this.testURL)) {
        throw new Error('Target hostname is not permitted by this agent');
      }
      await context.route('**/*', async route => {
        if (!this.isAllowedURL(route.request().url())) {
          await route.abort('blockedbyclient');
        } else {
          await route.fallback();
        }
      });
      await context.routeWebSocket('**/*', route => {
        if (this.isAllowedURL(route.url())) {
          route.connectToServer();
        } else {
          void route
            .close({ code: 1008, reason: 'Destination is not permitted' })
            .catch(() => undefined);
        }
      });
    }
    // add any custom headers
    if (this.options.headers) {
      await context.setExtraHTTPHeaders(this.options.headers);
    }

    //add any custom cookies
    if (this.options.cookies) {
      const cookies = (
        Array.isArray(this.options.cookies)
          ? this.options.cookies
          : [this.options.cookies]
      ).map(cookie => ({ ...cookie }));
      for (const cookie of cookies) {
        if (!cookie.url && (!cookie.domain || !cookie.path)) {
          //set the url to our test url
          cookie.url = this.testURL;
        }
      }
      log(cookies);
      await context.addCookies(cookies);
    }
  }

  /**
   * Navigates and captures one page without finalizing its browser session.
   */
  async doNavigation(): Promise<void> {
    if (!this.page) {
      throw new Error('Page not initialized');
    }
    this.throwIfAborted();
    this.reportProgress('running');

    try {
      await this.page.goto(this.testURL, { waitUntil: 'networkidle' });
    } catch (err) {
      this.throwIfAborted();
      // If navigation timed out, set the context offline and continue.
      if (
        err &&
        ((err as Error).name === 'TimeoutError' ||
          /Timeout/.test((err as Error).message))
      ) {
        await this.page.context().setOffline(true);
      } else {
        throw err;
      }
    }
    this.throwIfAborted();
    await this.capturePage();
  }

  /** Captures the current document before its context is closed or navigated. */
  async capturePage(): Promise<void> {
    if (!this.page || this.page.isClosed()) {
      throw new Error('Page not available for capture');
    }
    this.reportProgress('capturing');
    await this.page.screenshot({
      path: this.paths['results'] + '/screenshot.png',
      timeout: Math.min(this.options.timeout || DEFAULT_OPTIONS.timeout, 10000),
    });

    //grab the videoname
    const video = this.page.video();
    if (video) {
      this.videoRecordingFile = await video.path();
      this.resultAssets.videoFile = path.relative(
        this.paths['results'],
        this.videoRecordingFile,
      );
    }
    //collect metrics
    await this.collectMetrics();
  }

  /** Flushes HAR/video once; callers may safely await this more than once. */
  async closeContext(): Promise<void> {
    if (this.closeContextPromise) return this.closeContextPromise;
    const context = this.browserInstance;
    if (!context) return;
    this.closeContextPromise = context.close();
    try {
      await this.closeContextPromise;
      if (this.browserInstance === context) this.browserInstance = null;
    } catch (error) {
      this.closeContextPromise = undefined;
      throw error;
    }
  }

  /**
   * Collect all perf metrics
   */
  async collectMetrics(): Promise<void> {
    if (!this.page) {
      throw new Error('Page not initialized');
    }

    //resource timing
    this.resourceTimings = JSON.parse(
      await this.page.evaluate(() =>
        JSON.stringify(window.performance.getEntriesByType('resource')),
      ),
    ) as ResourceTiming[];

    // Collect all metrics and assign as single object
    this.metrics = {
      navigationTiming: await this.collectNavTiming(),
      paintTiming: JSON.parse(
        await this.page.evaluate(() =>
          JSON.stringify(window.performance.getEntriesByType('paint')),
        ),
      ),
      userTiming: JSON.parse(
        await this.page.evaluate(() =>
          JSON.stringify([
            ...window.performance.getEntriesByType('mark'),
            ...window.performance.getEntriesByType('measure'),
          ]),
        ),
      ),
      largestContentfulPaint: await this.collectLCP(),
      layoutShifts: await this.collectLayoutShifts(),
    };
  }

  async collectLayoutShifts(): Promise<LayoutShift[]> {
    if (!this.page) {
      throw new Error('Page not initialized');
    }

    // This code runs in the browser context - use string to avoid TypeScript DOM checking
    await this.page.evaluate(`
      window.layoutShifts = [];
      new PerformanceObserver((entryList) => {
        for (const entry of entryList.getEntries()) {
          try {
            let event = {
              name: entry.name,
              entryType: entry.entryType,
              startTime: entry['startTime'],
              value: entry['value'],
              hadRecentInput: entry['hadRecentInput'],
              lastInputTime: entry['lastInputTime'],
            };
            if (entry['sources']) {
              event['sources'] = [];
              for (const source of entry.sources) {
                let src = {
                  previousRect: source.previousRect,
                  currentRect: source.currentRect,
                };
                event.sources.push(src);
              }
            }
            window.layoutShifts.push(event);
          } catch (err) {}
        }
      }).observe({ type: 'layout-shift', buffered: true });
    `);
    const layoutShifts =
      await this.page.evaluate<LayoutShift[]>(`window.layoutShifts`);
    return layoutShifts || [];
  }

  async collectNavTiming(): Promise<NavigationTiming> {
    if (!this.page) {
      throw new Error('Page not initialized');
    }

    // This code runs in the browser context
    await this.page.evaluate(`
      window.navTimings = [];
      const observer = new PerformanceObserver((list) => {
        list.getEntries().forEach((entry) => {
          window.navTimings.push(entry);
        });
      });
      observer.observe({ type: 'navigation', buffered: true });
    `);
    const navTimings =
      await this.page.evaluate<NavigationTiming[]>(`window.navTimings`);
    return navTimings && navTimings.length > 0
      ? navTimings[0]
      : ({} as NavigationTiming);
  }

  async collectLCP(): Promise<LCPEvent[]> {
    if (!this.page) {
      throw new Error('Page not initialized');
    }

    // This code runs in the browser context
    await this.page.evaluate(`
      window.lcpEvents = [];
      new PerformanceObserver((entryList) => {
        for (const entry of entryList.getEntries()) {
          try {
            let event = {
              name: entry.name,
              entryType: entry.entryType,
              startTime: entry['startTime'],
              size: entry['size'],
              url: entry['url'],
              id: entry['id'],
              loadTime: entry['loadTime'],
              renderTime: entry['renderTime'],
            };
            if (entry['element']) {
              event['element'] = {
                nodeName: entry.element['nodeName'],
                boundingRect: entry.element.getBoundingClientRect(),
                outerHTML: entry.element.outerHTML,
              };
              if (entry.element['src']) {
                event.element['src'] = entry.element.src;
              }
              if (entry.element['currentSrc']) {
                event.element['currentSrc'] = entry.element.currentSrc;
              }
              try {
                let style = window.getComputedStyle(entry.element);
                if (style.backgroundImage && style.backgroundImage != 'none') {
                  event.element['background-image'] = style.backgroundImage;
                }
                if (style.content && style.content != 'none') {
                  event.element['content'] = style.content;
                }
              } catch (err) {}
            }
            window.lcpEvents.push(event);
          } catch (err) {}
        }
      }).observe({ type: 'largest-contentful-paint', buffered: true });
    `);
    const lcpEvents = await this.page.evaluate<LCPEvent[]>(`window.lcpEvents`);
    return lcpEvents || [];
  }

  async throttleNetwork(): Promise<void> {
    // Only apply throttling if connectionType is explicitly set
    if (!this.options.connectionType) {
      log('No network throttling applied');
      return;
    }

    // Check for Docker Desktop environment before attempting throttling
    if (isDockerDesktop()) {
      throw new Error(
        'Network throttling is not supported in Docker Desktop (Mac or Windows). ' +
          'The Docker Desktop Linux VM does not include the ifb kernel module required for traffic shaping. ' +
          'Run on a native Linux host, or run without --connectionType.',
      );
    }

    const start = performance.now();
    const networkType = this.options.connectionType as Exclude<
      ConnectionType,
      false
    >;

    try {
      // Startup can partially change interfaces before rejecting; cleanup owns it.
      this.throttlingStarted = true;
      await throttleStart({
        up: networkTypes[networkType].up,
        down: networkTypes[networkType].down,
        rtt: networkTypes[networkType].rtt,
      });
      log('Throttling successfully started');
    } catch (error) {
      throw new Error(
        'Network throttling failed: ' + (error as Error).message,
        {
          cause: error,
        },
      );
    }
    const end = performance.now();
    logTimer('Network Throttle', end, start);
    return;
  }

  /**
   * Setup our test: create the browser, context and page
   */
  async setupTest(): Promise<void> {
    this.throwIfAborted();
    this.reportProgress('launching');
    this.releaseExecutionLease = await acquireExecutionLease(
      !!this.options.connectionType,
    );
    this.throwIfAborted();
    const browser = await this.createBrowser();
    this.throwIfAborted();
    this.page = await this.createPage(browser);
    if (this.options.timeout && this.options.timeout > 0) {
      await this.page.setDefaultNavigationTimeout(this.options.timeout);
    }
    await this.throttleNetwork();
    this.throwIfAborted();
  }

  /** Restores traffic shaping only when this runner attempted to apply it. */
  private async stopThrottling(): Promise<void> {
    if (!this.throttlingStarted) return;
    await throttleStop();
    this.throttlingStarted = false;
    log('Throttling successfully stopped');
  }

  /** Extracts optional movie frames with a bounded, shell-free FFmpeg process. */
  async createFilmStrip(): Promise<void> {
    if (!this.videoRecordingFile || !existsSync(this.videoRecordingFile))
      return;
    const start = performance.now();
    let filmstripFiles: string[] = [];
    const frameRate = this.options.frameRate || DEFAULT_OPTIONS.frameRate;
    mkdirSync(this.paths.filmstrip, { recursive: true });

    try {
      await new Promise<void>((resolve, reject) => {
        execFile(
          'ffmpeg',
          [
            '-hide_banner',
            '-loglevel',
            'error',
            '-y',
            '-i',
            this.videoRecordingFile,
            '-vf',
            `fps=${frameRate}`,
            path.join(this.paths.filmstrip, 'frame_%08d.jpg'),
          ],
          { timeout: 30000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 },
          error => {
            if (error) reject(error);
            else resolve();
          },
        );
      });
      filmstripFiles = readdirSync(this.paths.filmstrip)
        .filter(filename => /^frame_\d+\.jpg$/.test(filename))
        .map(filename => path.join(this.paths.filmstrip, filename));
    } catch (error) {
      console.warn('Filmstrip unavailable: ' + (error as Error).message);
    }

    this.resultAssets.filmstrip = filmstripFiles
      .map((filePath): FilmstripFrame => {
        const filename = path.relative(this.paths['results'], filePath);

        const match = filename.match(/(?<num>\d+).jpg$/);
        const num = Number.parseInt(match?.groups?.num || '0');

        const ms = Math.floor((Math.max(0, num - 1) * 1000) / frameRate);

        return { num, filename, ms };
      })
      .sort((a, b) => {
        return a.num - b.num;
      });

    this.resultAssets.filmstripFiles = filmstripFiles;

    logTimer('Filmstrip', performance.now(), start);
  }

  /**
   * Save configuration file used to run the test
   */
  async saveConfig(): Promise<void> {
    const options = { ...this.options };
    delete options.signal;
    delete options.onProgress;
    const config: SavedConfig = {
      schemaVersion: 1,
      testId: this.TESTID,
      url: this.testURL,
      date: new Date().toUTCString(),
      options,
      browserConfig: this.selectedBrowser,
    };
    this.writeJSON('config.json', config);
  }

  /** Atomically writes one required JSON artifact or propagates the I/O error. */
  private writeJSON(filename: string, value: unknown): void {
    const destination = path.join(this.paths.results, filename);
    const temporary = destination + '.' + crypto.randomUUID() + '.tmp';
    try {
      writeFileSync(temporary, JSON.stringify(value), {
        flag: 'wx',
        mode: 0o600,
      });
      renameSync(temporary, destination);
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  /** Persists the available diagnostic snapshots, including partial captures. */
  async writeArtifacts(): Promise<void> {
    this.writeJSON('console.json', this.consoleMessages);
    this.writeJSON('resources.json', this.resourceTimings);
    if (this.metrics && !this.options.script)
      this.writeJSON('metrics.json', this.metrics);
  }

  /** Writes portable capture identity, status, and integrity metadata atomically. */
  async writeResultManifest(status: RunStatus, error?: string): Promise<void> {
    const manifest: ResultManifest = {
      schemaVersion: 1,
      testId: this.TESTID,
      status,
      startedAt: this.startedAt,
      ...(status !== 'running' ? { finishedAt: new Date().toISOString() } : {}),
      ...(error ? { error } : {}),
      artifacts: {},
    };
    const collect = async (directory: string): Promise<void> => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.name === 'result.json' || entry.name.endsWith('.tmp'))
          continue;
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await collect(absolute);
        } else if (entry.isFile()) {
          const digest = crypto.createHash('sha256');
          for await (const chunk of createReadStream(absolute))
            digest.update(chunk);
          const relative = path
            .relative(this.paths.results, absolute)
            .split(path.sep)
            .join('/');
          manifest.artifacts[relative] = {
            size: statSync(absolute).size,
            sha256: digest.digest('hex'),
          };
        }
      }
    };
    await collect(this.paths.results);
    this.writeJSON('result.json', manifest);
  }

  /** Preserves available failure diagnostics without replacing the original error. */
  async finalizeFailure(error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    if (this.page && !this.page.isClosed()) {
      try {
        await this.capturePage();
      } catch (captureError) {
        log('Partial capture error: ' + (captureError as Error).message);
      }
    }
    try {
      await this.postProcess(
        this.options.signal?.aborted ? 'cancelled' : 'failed',
        message,
      );
    } catch (finalizationError) {
      log(
        'Partial result finalization error: ' +
          (finalizationError as Error).message,
      );
      try {
        await this.writeArtifacts();
        await this.writeResultManifest(
          this.options.signal?.aborted ? 'cancelled' : 'failed',
          message,
        );
      } catch (writeError) {
        log(
          'Partial result persistence error: ' + (writeError as Error).message,
        );
      }
    }
  }

  /**
   * Run any post processing on test results
   */
  async postProcess(
    status: RunStatus = 'passed',
    error?: string,
  ): Promise<void> {
    if (status === 'passed') this.throwIfAborted();
    this.reportProgress('finalizing');
    await this.closeContext();
    await this.stopThrottling();
    if (
      !this.options.script &&
      existsSync(path.join(this.paths.results, 'pageload.har'))
    )
      this.fillOutHar();

    // Get the directory of the current file for resolving relative paths
    // When running from source (Jest/ts-node): lib/testRunner.ts -> lib/ -> project root is ../
    // When running compiled (node): dist/lib/testRunner.js -> dist/lib/ -> project root is ../../
    const currentDir = path.dirname(url.fileURLToPath(import.meta.url));
    const isCompiledDist = currentDir.includes('/dist/');
    const projectRoot = isCompiledDist
      ? path.resolve(currentDir, '../..')
      : path.resolve(currentDir, '..');

    await this.writeArtifacts();

    if (this.options.baseline && status === 'passed') {
      try {
        await runBaselinePipeline({
          resultsPath: this.paths['results'],
          url: this.testURL,
        });
      } catch (err) {
        console.error('Baseline pipeline error: ' + err);
      }
    }

    //create our filmstrip
    await this.createFilmStrip();

    if (this.options.html && this.metrics && !this.options.script) {
      try {
        copyFileSync(
          path.resolve(
            projectRoot,
            `img/${
              this.selectedBrowser.channel === 'chromium'
                ? 'chrome'
                : this.selectedBrowser.channel || this.selectedBrowser.engine
            }.png`,
          ),
          this.paths['results'] + '/engine.png',
        );
        const testTemplate = readFileSync(
          path.resolve(currentDir, './templates/test.ejs'),
          'utf8',
        ).toString();
        const testHTML = ejs.render(testTemplate, this);

        const htmlPath = this.paths['results'] + '/index.html';
        writeFileSync(htmlPath, testHTML, 'utf8');

        // Open the HTML report in the browser if --openHtml is set
        if (this.options.openHtml) {
          if (process.env.CI || process.env.RUNNING_IN_DOCKER) {
            console.log(
              'Skipping --openHtml: cannot open browser in CI or Docker environment',
            );
            console.log('HTML report available at:', path.resolve(htmlPath));
          } else {
            this.openInBrowser(path.resolve(htmlPath));
          }
        }
      } catch (err) {
        console.error('Error writing html file ' + err);
      }
    }

    if (this.options.list) {
      const files = readdirSync(this.resultsRoot, { withFileTypes: true });
      const tests = files
        .filter(file => file.isDirectory() && file.name !== '.telescope')
        .map(folder => {
          const configFileName = path.join(
            this.resultsRoot,
            folder.name,
            'config.json',
          );
          try {
            const config = readFileSync(configFileName, 'utf8').toString();
            return { folder: folder.name, config: JSON.parse(config) };
          } catch (_err) {
            return null;
          }
        })
        .filter((test): test is NonNullable<typeof test> => test !== null)
        .sort(
          (a, b) =>
            new Date(b.config.date).getTime() -
            new Date(a.config.date).getTime(),
        );

      const listTemplate = readFileSync(
        path.resolve(currentDir, './templates/list.ejs'),
        'utf8',
      ).toString();
      const listHTML = ejs.render(listTemplate, { tests });

      try {
        writeFileSync(
          path.join(this.resultsRoot, 'index.html'),
          listHTML,
          'utf8',
        );
      } catch (err) {
        console.error('Error writing html file ' + err);
      }
    }

    if (status === 'passed') this.throwIfAborted();
    // Include the terminal capture state and every completed artifact in archives.
    await this.writeResultManifest(status, error);

    // handle the zipping
    if (this.options.zip) {
      const outputZip = path.join(this.resultsRoot, `${this.TESTID}.zip`);
      const zip = new AdmZip();
      zip.addLocalFolder(this.paths['results']);
      zip.writeZip(outputZip);
    }

    // handle uploading
    if (this.options.uploadUrl) {
      const tempZip = !this.options.zip;
      const outputZip = tempZip
        ? path.join(this.resultsRoot, '.telescope', 'tmp', `${this.TESTID}.zip`)
        : path.join(this.resultsRoot, `${this.TESTID}.zip`);

      try {
        if (tempZip) {
          mkdirSync(path.dirname(outputZip), { recursive: true });
          const zip = new AdmZip();
          zip.addLocalFolder(this.paths['results']);
          zip.writeZip(outputZip);
        }

        const form = new FormData();
        form.append('source', 'cli');
        form.append(
          'file',
          new Blob([readFileSync(outputZip)], { type: 'application/zip' }),
          `${this.TESTID}.zip`,
        );

        const response = await fetch(this.options.uploadUrl, {
          method: 'POST',
          body: form,
          signal: AbortSignal.timeout(
            Math.min(this.options.timeout || DEFAULT_OPTIONS.timeout, 30000),
          ),
        });

        if (!response.ok) {
          throw new Error(
            `Error uploading zip file: ${response.status} ${response.statusText}`,
          );
        }

        if (tempZip) {
          unlinkSync(outputZip);
        }
      } catch (err) {
        if (tempZip && existsSync(outputZip)) {
          unlinkSync(outputZip);
        }
        throw err;
      }
    }

    //run cleanup
    await this.cleanup();
    this.reportProgress('complete');
  }

  mergeEntries(harEntries: HarEntry[], lcpURL: string | null): HarEntry[] {
    const harIndexByTelescopeId = new Map<string, number>();
    for (let i = 0; i < harEntries.length; i++) {
      const id = harEntries[i].request.headers.find(
        h => h.name.toLowerCase() === TELESCOPE_ID_HEADER,
      )?.value;
      if (id) {
        harIndexByTelescopeId.set(id, i);
      }
    }

    for (const request of this.requests) {
      const indexToUpdate =
        harIndexByTelescopeId.get(request.telescopeId) ?? -1;
      if (indexToUpdate !== -1) {
        //we'll do our calculations now
        const connectEnd =
          request.timing.secureConnectionStart > 0
            ? request.timing.secureConnectionStart
            : request.timing.connectEnd;
        const secureStart = request.timing.secureConnectionStart
          ? request.timing.secureConnectionStart
          : -1;
        const secureEnd = request.timing.secureConnectionStart
          ? request.timing.connectEnd
          : -1;

        // create a new object with the updated values
        const updatedObject: HarEntry = {
          ...harEntries[indexToUpdate],
          _dns_start: request.timing.domainLookupStart,
          _dns_end: request.timing.domainLookupEnd,
          _connect_start: request.timing.connectStart,
          _connect_end: connectEnd,
          _secure_start: secureStart,
          _secure_end: secureEnd,
          _request_start: request.timing.requestStart,
          _request_end: request.timing.responseStart,
          _response_start: request.timing.responseStart,
          _response_end: request.timing.responseEnd,
          _resourceType: request.resourceType,
        };
        if (harEntries[indexToUpdate].request.url === lcpURL) {
          updatedObject._is_lcp = true;
        }

        if (this.telescopeIdToRequestId) {
          const requestId = this.telescopeIdToRequestId[request.telescopeId];

          if (requestId && this.priorities && this.priorities[requestId]) {
            const priority_obj = this.priorities[requestId];
            if (priority_obj) {
              updatedObject._initialPriority = priority_obj.initialPriority;

              if (this.newPriorities && this.newPriorities[requestId]) {
                updatedObject._priority = this.newPriorities[requestId];
              } else {
                updatedObject._priority = updatedObject._initialPriority;
              }
            }
          }
        }

        // replace the object at the specified index with the updated object
        harEntries.splice(indexToUpdate, 1, updatedObject);
      }
    }

    return harEntries;
  }

  fillOutHar(): void {
    const start = performance.now();
    //grab our har file
    const harData: HarData = JSON.parse(
      readFileSync(this.paths['results'] + '/pageload.har', 'utf8'),
    );

    //first, TTFB
    const navTiming = this.metrics?.navigationTiming;
    const firstPage = harData.log.pages?.[0];
    if (navTiming && firstPage && Number.isFinite(navTiming.responseStart)) {
      const TTFB = navTiming.responseStart - (navTiming.navigationStart ?? 0);
      firstPage.pageTimings._TTFB = TTFB;
    }

    // now our LCP
    const lcpEvents = this.metrics?.largestContentfulPaint;
    let lcpURL: string | null = null;
    if (lcpEvents && lcpEvents.length > 0) {
      const lcp = lcpEvents[lcpEvents.length - 1];
      if (lcp && firstPage) {
        firstPage.pageTimings._LCP = lcp.startTime;
        if (lcp.url) {
          //let's see if we can find it in our resources
          lcpURL = lcp.url;
        }
      }
    }

    //now lets add the raw timings we collected
    const mergedEntries = this.mergeEntries(harData.log.entries, lcpURL);
    harData.log.entries = mergedEntries;
    this.writeJSON('pageload.har', harData);
    logTimer('Har Edit', performance.now(), start);
  }

  /**
   * Opens a file in the default browser
   */
  openInBrowser(filePath: string): void {
    const command =
      process.platform === 'darwin'
        ? 'open'
        : process.platform === 'win32'
          ? 'explorer.exe'
          : 'xdg-open';
    execFile(command, [filePath], err => {
      if (err) {
        console.error('Error opening HTML report:', err);
      }
    });
  }

  /**
   * Cleans up after our test - closes browser and removes temp files
   */
  async cleanup(): Promise<void> {
    log('Cleanup started');
    let cleanupError: unknown;
    try {
      await this.closeContext();
    } catch (error) {
      cleanupError = error;
    }
    try {
      await this.stopThrottling();
    } catch (error) {
      cleanupError ??= error;
    }
    // Retain the lease if traffic shaping could not be restored; fail closed.
    if (!this.throttlingStarted && this.releaseExecutionLease) {
      try {
        await this.releaseExecutionLease();
        this.releaseExecutionLease = undefined;
      } catch (error) {
        cleanupError ??= error;
      }
    }
    rmSync(this.paths['temporaryContext'], { recursive: true, force: true });
    log('Cleanup ended');
    console.log('Test ID:' + this.TESTID);
    if (cleanupError) throw cleanupError;
  }
}

export { TestRunner };

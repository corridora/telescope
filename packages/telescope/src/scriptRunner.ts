import crypto from 'crypto';
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import ejs from 'ejs';

import { ScenarioManifestSchema } from './contracts.js';
import { DEFAULT_OPTIONS } from './defaultOptions.js';
import { calibrateStepMedia, generateStepMedia } from './stepMedia.js';
import type { StepMediaCalibration } from './stepMedia.js';
import type { TestRunner } from './testRunner.js';
import type {
  ArtifactDescriptor,
  ConsoleMessage,
  HarData,
  HarEntry,
  LayoutShift,
  LCPEvent,
  NavigationTiming,
  PaintTiming,
  ResourceTiming,
  ScenarioManifest,
  ScenarioStepResult,
  ScriptContext,
  TestScript,
  UserTiming,
} from './types.js';
import type {
  ConsoleMessage as PlaywrightConsoleMessage,
  Page,
  Request,
} from 'playwright';

interface DocumentSnapshot {
  timeOrigin: number;
  now: number;
  navigationTiming: NavigationTiming | null;
  paintTiming: PaintTiming[];
  largestContentfulPaint: LCPEvent[];
  layoutShifts: LayoutShift[];
  userTiming: UserTiming[];
  resources: ResourceTiming[];
  supported: string[];
  droppedEntries: number;
}

interface StepCapture {
  result: ScenarioStepResult;
  startedEpoch: number;
  console: ConsoleMessage[];
  snapshot?: DocumentSnapshot;
  intervalStart?: number;
  initialTimeOrigin: number;
  metrics?: Record<string, unknown>;
}

/** Loads and validates a trusted local module without running its step callbacks. */
export async function loadTestScript(
  input: string | TestScript,
): Promise<TestScript> {
  let value: unknown = input;
  if (typeof input === 'string') {
    const filename = path.resolve(input);
    if (!/\.(?:mjs|js)$/i.test(filename) || !statSync(filename).isFile()) {
      throw new Error('Scripts must be local ESM .mjs or .js files');
    }
    const moduleURL = pathToFileURL(filename);
    // Reload edited entry modules in long-lived programmatic callers.
    moduleURL.searchParams.set(
      'telescope',
      crypto.createHash('sha256').update(readFileSync(filename)).digest('hex'),
    );
    value = await import(moduleURL.href);
  }
  if (
    value === null ||
    typeof value !== 'object' ||
    !('steps' in value) ||
    !Array.isArray(value.steps)
  ) {
    throw new Error('A script must export a nonempty steps array');
  }
  if (value.steps.length === 0 || value.steps.length > 9999) {
    throw new Error('Scripts must contain between 1 and 9999 steps');
  }
  if (
    'name' in value &&
    value.name !== undefined &&
    (typeof value.name !== 'string' || value.name.length > 256)
  ) {
    throw new Error('Script name must be a string of at most 256 characters');
  }
  if (
    'setup' in value &&
    value.setup !== undefined &&
    typeof value.setup !== 'function'
  ) {
    throw new Error('Script setup must be a function');
  }
  for (const [index, step] of value.steps.entries()) {
    if (
      step === null ||
      typeof step !== 'object' ||
      !('name' in step) ||
      typeof step.name !== 'string' ||
      !step.name.trim() ||
      step.name.length > 256 ||
      !('kind' in step) ||
      typeof step.kind !== 'string' ||
      !['navigation', 'interaction'].includes(step.kind) ||
      !('run' in step) ||
      typeof step.run !== 'function'
    ) {
      throw new Error(
        `Step ${index + 1} needs a name, navigation/interaction kind, and run callback`,
      );
    }
    if (
      'timeout' in step &&
      step.timeout !== undefined &&
      (typeof step.timeout !== 'number' ||
        !Number.isSafeInteger(step.timeout) ||
        step.timeout <= 0)
    ) {
      throw new Error(`Step ${index + 1} timeout must be a positive integer`);
    }
  }
  return value as TestScript;
}

function atomicJSON(filename: string, value: unknown): void {
  mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = filename + '.' + crypto.randomUUID() + '.tmp';
  try {
    writeFileSync(temporary, JSON.stringify(value), {
      flag: 'wx',
      mode: 0o600,
    });
    renameSync(temporary, filename);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function observerScript(
  documentBinding: string,
  resourceBinding: string,
): string {
  return `(() => {
    if (window !== window.top || window.__telescopeScriptCapture) return;
    const capture = window.__telescopeScriptCapture = {
      timeOrigin: performance.timeOrigin, observers: [], paint: [], lcp: [], shifts: [], user: [], resources: [],
      supported: [], droppedEntries: 0,
    };
    const push = (array, entry) => {
      if (array.length < 20000) array.push(entry); else capture.droppedEntries++;
    };
    const serialize = entry => {
      const result = entry.toJSON ? entry.toJSON() : { name: entry.name, entryType: entry.entryType, startTime: entry.startTime, duration: entry.duration };
      if (entry.entryType === 'largest-contentful-paint') {
        result.size = entry.size; result.url = entry.url; result.id = entry.id;
        result.loadTime = entry.loadTime; result.renderTime = entry.renderTime;
        if (entry.element) result.element = { nodeName: entry.element.nodeName, outerHTML: entry.element.outerHTML.slice(0, 16384), boundingRect: entry.element.getBoundingClientRect().toJSON() };
      }
      if (entry.entryType === 'layout-shift') {
        result.value = entry.value; result.hadRecentInput = entry.hadRecentInput; result.lastInputTime = entry.lastInputTime;
        result.sources = (entry.sources || []).map(source => ({ previousRect: source.previousRect.toJSON(), currentRect: source.currentRect.toJSON() }));
      }
      return result;
    };
    const consume = entries => {
      const resources = [];
      for (const entry of entries) {
        try {
          const item = serialize(entry);
          if (entry.entryType === 'paint') push(capture.paint, item);
          else if (entry.entryType === 'largest-contentful-paint') push(capture.lcp, item);
          else if (entry.entryType === 'layout-shift') push(capture.shifts, item);
          else if (entry.entryType === 'mark' || entry.entryType === 'measure') push(capture.user, item);
          else if (entry.entryType === 'resource') { push(capture.resources, item); resources.push(item); }
        } catch (_) { capture.droppedEntries++; }
      }
      if (resources.length && window[${JSON.stringify(resourceBinding)}]) {
        window[${JSON.stringify(resourceBinding)}]({ timeOrigin: capture.timeOrigin, resources }).catch(() => {});
      }
    };
    capture.consume = consume;
    try { performance.setResourceTimingBufferSize(20000); } catch (_) {}
    performance.addEventListener('resourcetimingbufferfull', () => performance.clearResourceTimings());
    for (const type of ['paint', 'largest-contentful-paint', 'layout-shift', 'mark', 'measure', 'resource']) {
      try {
        if (!PerformanceObserver.supportedEntryTypes.includes(type)) continue;
        const observer = new PerformanceObserver(list => consume(list.getEntries()));
        observer.observe({ type, buffered: true }); capture.observers.push(observer); capture.supported.push(type);
      } catch (_) {}
    }
    if (window[${JSON.stringify(documentBinding)}]) window[${JSON.stringify(documentBinding)}]({ timeOrigin: capture.timeOrigin }).catch(() => {});
    window.addEventListener('pageshow', event => {
      if (event.persisted && window[${JSON.stringify(documentBinding)}]) {
        window[${JSON.stringify(documentBinding)}]({ timeOrigin: performance.timeOrigin, restored: true, activationTime: performance.now() }).catch(() => {});
      }
    });
  })();`;
}

async function snapshot(page: Page): Promise<DocumentSnapshot> {
  return page.evaluate(`(() => {
    const capture = window.__telescopeScriptCapture;
    if (!capture) throw new Error('Script capture observers are unavailable');
    for (const observer of capture.observers) capture.consume(observer.takeRecords());
    const navigation = performance.getEntriesByType('navigation')[0];
    return {
      timeOrigin: performance.timeOrigin, now: performance.now(),
      navigationTiming: navigation ? { ...navigation.toJSON(), navigationStart: 0 } : null,
      paintTiming: capture.paint, largestContentfulPaint: capture.lcp, layoutShifts: capture.shifts,
      userTiming: capture.user, resources: capture.resources, supported: capture.supported, droppedEntries: capture.droppedEntries,
    };
  })()`);
}

async function boundedAction(
  action: () => Promise<void>,
  timeout: number,
  label: string,
  runner: TestRunner,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(action),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`${label} exceeded ${timeout}ms`);
          error.name = 'TimeoutError';
          reject(error);
          void runner.closeContext().catch(() => undefined);
        }, timeout);
      }),
    ]);
    runner.throwIfAborted();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function stepMetrics(capture: StepCapture): Record<string, unknown> {
  const current = capture.snapshot;
  const interval = capture.result.kind === 'interaction';
  const navigationAvailable =
    !interval &&
    !!current?.navigationTiming &&
    current.timeOrigin !== capture.initialTimeOrigin;
  const from = capture.intervalStart ?? 0;
  const until = current?.now ?? from;
  const within = (entry: { startTime: number }): boolean =>
    entry.startTime >= from && entry.startTime <= until;
  return {
    scope: interval ? 'interval' : 'navigation',
    actionDurationMs: capture.result.durationMs,
    documentTimeOrigin: current?.timeOrigin,
    ...(navigationAvailable
      ? { navigationTiming: current?.navigationTiming }
      : {}),
    paintTiming: navigationAvailable ? (current?.paintTiming ?? []) : [],
    largestContentfulPaint: navigationAvailable
      ? (current?.largestContentfulPaint ?? [])
      : [],
    layoutShifts: navigationAvailable
      ? (current?.layoutShifts ?? [])
      : (current?.layoutShifts.filter(within) ?? []),
    userTiming: navigationAvailable
      ? (current?.userTiming ?? [])
      : (current?.userTiming.filter(within) ?? []),
    capture: {
      supportedEntryTypes: current?.supported ?? [],
      droppedEntries: current?.droppedEntries ?? 0,
      metricBoundary: 'step-capture',
      videoAlignment: 'unavailable',
      navigationAvailable,
      partial: capture.result.status !== 'passed',
    },
  };
}

async function descriptors(
  directory: string,
): Promise<Record<string, ArtifactDescriptor>> {
  const result: Record<string, ArtifactDescriptor> = {};
  for (const file of readdirSync(directory, { withFileTypes: true })) {
    if (file.isDirectory() && file.name === 'filmstrip') {
      const frames = await descriptors(path.join(directory, file.name));
      for (const [name, descriptor] of Object.entries(frames))
        result[`filmstrip/${name}`] = descriptor;
      continue;
    }
    if (
      !file.isFile() ||
      file.name.startsWith('.') ||
      file.name.endsWith('.tmp')
    )
      continue;
    const absolute = path.join(directory, file.name);
    const digest = crypto.createHash('sha256');
    for await (const chunk of createReadStream(absolute)) digest.update(chunk);
    result[file.name] = {
      size: statSync(absolute).size,
      sha256: digest.digest('hex'),
    };
  }
  return result;
}

/**
 * Executes sequential named steps in the runner's existing browser session.
 * Preserves failed/skipped descriptors and partial files before propagating errors.
 */
export async function executeScript(
  runner: TestRunner,
  script: TestScript,
): Promise<void> {
  if (runner.options.baseline)
    throw new Error('Baseline analysis is not supported for scripted tests');
  const page = runner.page;
  const context = runner.browserInstance;
  if (!page || !context)
    throw new Error('Script requires an initialized browser session');
  const started = performance.now();
  const defaultTimeout = runner.options.timeout ?? DEFAULT_OPTIONS.timeout;
  const totalTimeout = runner.options.scriptTimeout;
  if (
    totalTimeout !== undefined &&
    (!Number.isSafeInteger(totalTimeout) || totalTimeout <= 0)
  ) {
    throw new Error('scriptTimeout must be a positive integer');
  }
  const scenario: ScenarioManifest = {
    schemaVersion: 1,
    ...(script.name ? { name: script.name } : {}),
    status: 'running',
    startedAt: new Date().toISOString(),
    durationMs: 0,
    steps: script.steps.map((step, index) => ({
      id: String(index + 1).padStart(4, '0'),
      order: index,
      name: step.name,
      kind: step.kind,
      status: 'pending',
      artifactBase: `steps/${String(index + 1).padStart(4, '0')}`,
      metricScope: step.kind === 'navigation' ? 'navigation' : 'interval',
    })),
  };
  const scenarioPath = path.join(runner.paths.results, 'scenario.json');
  const captures = new Map<string, StepCapture>();
  const requestOwners = new Map<Request, string | undefined>();
  const headerOwners = new Map<string, string>();
  const headerTasks = new Set<Promise<void>>();
  const resourceEntries = new Map<
    string,
    { timeOrigin: number; resource: ResourceTiming }
  >();
  const knownDocuments = new Set<number>();
  let active: StepCapture | undefined;
  let committedDocuments = new Set<string>();
  let mainDocumentRequests = 0;
  let invariantError: Error | undefined;
  let failure: unknown;
  let calibration: StepMediaCalibration = {
    transitions: [],
    reason: 'Recording calibration was not completed.',
  };
  let scriptBudgetStarted = started;
  let coverId: string | undefined;
  const suffix = crypto.randomUUID().replaceAll('-', '');
  const documentBinding = '__telescopeDocument' + suffix;
  const resourceBinding = '__telescopeResources' + suffix;
  const persist = (): void => {
    scenario.durationMs = performance.now() - started;
    atomicJSON(scenarioPath, scenario);
  };
  const addResources = (origin: number, values: ResourceTiming[]): void => {
    for (const resource of values) {
      if (
        !resource ||
        typeof resource.name !== 'string' ||
        !Number.isFinite(resource.startTime)
      )
        continue;
      const key = `${origin}:${resource.name}:${resource.startTime}:${resource.duration}:${resource.initiatorType}`;
      if (resourceEntries.size >= 100000 && !resourceEntries.has(key)) {
        invariantError = new Error('Script resource capture limit exceeded');
        void runner.closeContext().catch(() => undefined);
        break;
      }
      resourceEntries.set(key, { timeOrigin: origin, resource });
    }
  };
  const requestStarted = (request: Request): void => {
    if (requestOwners.size >= 100000) {
      invariantError = new Error('Script request capture limit exceeded');
      void runner.closeContext().catch(() => undefined);
      return;
    }
    requestOwners.set(request, active?.result.id);
    if (active && request.isNavigationRequest() && !request.redirectedFrom()) {
      try {
        if (request.frame() === page.mainFrame()) mainDocumentRequests++;
      } catch {
        /* Service worker requests do not always expose a frame. */
      }
    }
  };
  const requestFinished = (request: Request): void => {
    const owner = requestOwners.get(request);
    if (!owner) return;
    const task = request
      .allHeaders()
      .then(headers => {
        const id = headers['x-telescope-id'];
        if (id) headerOwners.set(id, owner);
      })
      .catch(() => undefined);
    headerTasks.add(task);
    void task.finally(() => headerTasks.delete(task));
  };
  const extraPage = (newPage: Page): void => {
    if (newPage === page) return;
    invariantError = new Error(
      'Scripts support one measured page; popups/new pages are not supported',
    );
    void newPage.close().catch(() => undefined);
  };
  const remaining = (timeout: number): number => {
    if (totalTimeout === undefined) return timeout;
    const available = totalTimeout - (performance.now() - scriptBudgetStarted);
    if (available <= 0) throw new Error('Script total timeout exceeded');
    return Math.max(1, Math.min(timeout, Math.ceil(available)));
  };
  const scriptContext: ScriptContext = {
    page,
    context,
    url: runner.options.url,
  };
  const onConsole = (message: PlaywrightConsoleMessage): void => {
    if (active && active.console.length < 20000) {
      active.console.push({
        type: message.type(),
        text: message.text(),
        location: message.location(),
      });
    }
  };

  page.on('request', requestStarted);
  page.on('requestfinished', requestFinished);
  page.on('requestfailed', requestFinished);
  page.on('console', onConsole);
  context.on('page', extraPage);
  persist();
  try {
    calibration = await calibrateStepMedia(
      page,
      started,
      runner.options.signal,
    );
    if (calibration.cleanupFailed) {
      await runner.closeContext();
      throw new Error(
        'Recording calibration cleanup failed before script setup.',
      );
    }
    runner.throwIfAborted();
    scriptBudgetStarted = performance.now();
    await context.exposeBinding(documentBinding, (source, value: unknown) => {
      if (
        source.page !== page ||
        source.frame !== page.mainFrame() ||
        value === null ||
        typeof value !== 'object' ||
        !('timeOrigin' in value) ||
        typeof value.timeOrigin !== 'number'
      )
        return;
      if (!knownDocuments.has(value.timeOrigin)) {
        knownDocuments.add(value.timeOrigin);
        if (active) committedDocuments.add(`${value.timeOrigin}:initial`);
      } else if (
        active &&
        'restored' in value &&
        value.restored === true &&
        'activationTime' in value &&
        typeof value.activationTime === 'number'
      ) {
        committedDocuments.add(
          `${value.timeOrigin}:restore:${value.activationTime}`,
        );
      }
    });
    await context.exposeBinding(resourceBinding, (source, value: unknown) => {
      if (
        source.page !== page ||
        source.frame !== page.mainFrame() ||
        value === null ||
        typeof value !== 'object' ||
        !('timeOrigin' in value) ||
        typeof value.timeOrigin !== 'number' ||
        !('resources' in value) ||
        !Array.isArray(value.resources)
      )
        return;
      addResources(
        value.timeOrigin,
        value.resources.slice(0, 20000) as ResourceTiming[],
      );
    });
    const initialize = observerScript(documentBinding, resourceBinding);
    await page.addInitScript({ content: initialize });
    await page.evaluate(initialize);
    if (script.setup) {
      await boundedAction(
        () => script.setup!(scriptContext),
        remaining(defaultTimeout),
        'Script setup',
        runner,
      );
      if (invariantError) throw invariantError;
    }
    for (const [index, step] of script.steps.entries()) {
      runner.throwIfAborted();
      const result = scenario.steps[index];
      const before = await snapshot(page);
      knownDocuments.add(before.timeOrigin);
      addResources(before.timeOrigin, before.resources);
      committedDocuments = new Set<string>();
      mainDocumentRequests = 0;
      result.status = 'running';
      result.startingUrl = page.url();
      mkdirSync(path.join(runner.paths.results, result.artifactBase), {
        recursive: true,
      });
      persist();
      runner.reportProgress('running');
      const intervalStart = await page.evaluate<number>(`(() => {
        const capture = window.__telescopeScriptCapture;
        capture.user = []; capture.shifts = []; capture.resources = []; capture.droppedEntries = 0;
        return performance.now();
      })()`);
      const start = performance.now();
      const capture: StepCapture = {
        result,
        startedEpoch: Date.now(),
        console: [],
        intervalStart,
        initialTimeOrigin: before.timeOrigin,
      };
      active = capture;
      captures.set(result.id, capture);
      result.startOffsetMs = start - started;
      result.media = {
        status: 'unavailable',
        reason: 'Step media finalization was not completed.',
      };
      let actionFinished: number | undefined;
      try {
        await boundedAction(
          () => step.run(scriptContext),
          remaining(step.timeout || defaultTimeout),
          `Step ${index + 1} (${step.name})`,
          runner,
        );
        actionFinished = performance.now();
        active = undefined;
        if (invariantError) throw invariantError;
        capture.snapshot = await snapshot(page);
        addResources(capture.snapshot.timeOrigin, capture.snapshot.resources);
        result.documentTimeOrigin = capture.snapshot.timeOrigin;
        if (
          capture.snapshot.timeOrigin !== before.timeOrigin &&
          committedDocuments.size === 0
        ) {
          committedDocuments.add(`${capture.snapshot.timeOrigin}:initial`);
        }
        if (
          step.kind === 'navigation' &&
          (mainDocumentRequests > 1 ||
            committedDocuments.size !== 1 ||
            capture.snapshot.timeOrigin === before.timeOrigin)
        ) {
          throw new Error(
            'A navigation step must commit exactly one main-frame document navigation',
          );
        }
        if (
          step.kind === 'interaction' &&
          (mainDocumentRequests > 0 ||
            committedDocuments.size > 0 ||
            capture.snapshot.timeOrigin !== before.timeOrigin)
        ) {
          throw new Error(
            'An interaction step must remain in the same document',
          );
        }
        result.status = 'passed';
      } catch (error) {
        failure ??= error;
        active = undefined;
        result.status = runner.options.signal?.aborted ? 'cancelled' : 'failed';
        result.error = errorMessage(error);
        throw error;
      } finally {
        result.durationMs = (actionFinished ?? performance.now()) - start;
        result.endingUrl = page.url();
        if (!page.isClosed()) {
          if (!capture.snapshot) {
            try {
              capture.snapshot = await snapshot(page);
              addResources(
                capture.snapshot.timeOrigin,
                capture.snapshot.resources,
              );
              result.documentTimeOrigin = capture.snapshot.timeOrigin;
            } catch {
              /* Available console/network data still belongs to the failed step. */
            }
          }
          try {
            await page.screenshot({
              path: path.join(
                runner.paths.results,
                result.artifactBase,
                'screenshot.png',
              ),
              timeout: 5000,
            });
          } catch {
            /* Optional screenshots must not discard JSON diagnostics. */
          }
        }
        capture.metrics = stepMetrics(capture);
        atomicJSON(
          path.join(runner.paths.results, result.artifactBase, 'metrics.json'),
          capture.metrics,
        );
        atomicJSON(
          path.join(runner.paths.results, result.artifactBase, 'console.json'),
          capture.console,
        );
        atomicJSON(
          path.join(
            runner.paths.results,
            result.artifactBase,
            'resources.json',
          ),
          [],
        );
        const screenshot = path.join(
          runner.paths.results,
          result.artifactBase,
          'screenshot.png',
        );
        if (
          existsSync(screenshot) &&
          (!coverId ||
            (step.kind === 'navigation' &&
              result.status === 'passed' &&
              scenario.steps.find(value => value.id === coverId)?.kind !==
                'navigation'))
        ) {
          coverId = result.id;
          scenario.coverStepId = coverId;
          copyFileSync(
            screenshot,
            path.join(runner.paths.results, 'screenshot.png'),
          );
        }
        active = undefined;
        persist();
      }
    }
    if (invariantError) throw invariantError;
    scenario.status = 'passed';
  } catch (error) {
    failure ??= error;
    scenario.status = runner.options.signal?.aborted ? 'cancelled' : 'failed';
    scenario.error = errorMessage(failure);
    for (const step of scenario.steps) {
      if (step.status === 'pending') step.status = 'skipped';
      else if (step.status === 'running') {
        step.status = runner.options.signal?.aborted ? 'cancelled' : 'failed';
        step.error ??= scenario.error;
      }
    }
  } finally {
    active = undefined;
    try {
      const video = page.video();
      await runner.closeContext();
      if (video) {
        runner.videoRecordingFile = await video.path();
        runner.resultAssets.videoFile = path
          .relative(runner.paths.results, runner.videoRecordingFile)
          .split(path.sep)
          .join('/');
        scenario.video = { path: runner.resultAssets.videoFile };
      }
      await Promise.all([...headerTasks]);
      finalizeStepArtifacts(
        runner,
        scenario,
        captures,
        requestOwners,
        headerOwners,
        resourceEntries,
      );
      try {
        await generateStepMedia(
          runner.paths.results,
          runner.videoRecordingFile,
          scenario.steps,
          calibration,
          runner.options.frameRate ?? DEFAULT_OPTIONS.frameRate,
          runner.options.signal,
        );
      } catch {
        for (const capture of captures.values())
          capture.result.media = {
            status: 'unavailable',
            reason:
              'Step media finalization failed; the full session recording is retained.',
          };
      }
      for (const capture of captures.values()) {
        const diagnostics = capture.metrics?.capture;
        if (diagnostics && typeof diagnostics === 'object') {
          Object.assign(diagnostics, {
            videoAlignment:
              capture.result.media?.status === 'available'
                ? 'color-calibration'
                : 'unavailable',
            ...(capture.result.media?.alignment
              ? {
                  videoAlignmentUncertaintyMs:
                    capture.result.media.alignment.uncertaintyMs,
                }
              : {}),
          });
          atomicJSON(
            path.join(
              runner.paths.results,
              capture.result.artifactBase,
              'metrics.json',
            ),
            capture.metrics,
          );
        }
        capture.result.artifacts = await descriptors(
          path.join(runner.paths.results, capture.result.artifactBase),
        );
      }
    } catch (error) {
      failure ??= error;
      scenario.status = runner.options.signal?.aborted ? 'cancelled' : 'failed';
      scenario.error ??= errorMessage(error);
    }
    page.off('request', requestStarted);
    page.off('requestfinished', requestFinished);
    page.off('requestfailed', requestFinished);
    page.off('console', onConsole);
    context.off('page', extraPage);
    scenario.finishedAt = new Date().toISOString();
    try {
      persist();
    } catch (error) {
      failure ??= error;
    }
    if (runner.options.html) {
      try {
        renderScenarioReport(runner.paths.results);
      } catch (error) {
        console.warn('Scenario HTML unavailable: ' + errorMessage(error));
      }
    }
  }
  if (failure) throw failure;
}

function finalizeStepArtifacts(
  runner: TestRunner,
  scenario: ScenarioManifest,
  captures: Map<string, StepCapture>,
  requests: Map<Request, string | undefined>,
  headerOwners: Map<string, string>,
  resourceEntries: Map<
    string,
    { timeOrigin: number; resource: ResourceTiming }
  >,
): void {
  const filename = path.join(runner.paths.results, 'pageload.har');
  if (!existsSync(filename)) throw new Error('Session HAR was not finalized');
  const har = JSON.parse(readFileSync(filename, 'utf8')) as HarData;
  har.log.entries = runner.mergeEntries(har.log.entries, null);
  const ownerFor = (entry: HarEntry): string | undefined => {
    const id = entry.request.headers.find(
      header => header.name.toLowerCase() === 'x-telescope-id',
    )?.value;
    return id ? headerOwners.get(id) : undefined;
  };
  const scopedResources = new Map<string, ResourceTiming[]>();
  const unmatched: ResourceTiming[] = [];
  const requestsByURL = new Map<string, { start: number; owner?: string }[]>();
  for (const [request, owner] of requests) {
    const values = requestsByURL.get(request.url()) ?? [];
    values.push({ start: request.timing().startTime, owner });
    requestsByURL.set(request.url(), values);
  }
  for (const values of requestsByURL.values())
    values.sort((left, right) => left.start - right.start);
  for (const { resource, timeOrigin } of resourceEntries.values()) {
    const timestamp = timeOrigin + resource.startTime;
    const values = requestsByURL.get(resource.name) ?? [];
    let low = 0;
    let high = values.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (values[middle].start < timestamp - 50) low = middle + 1;
      else high = middle;
    }
    const first = values[low];
    const second = values[low + 1];
    const owner =
      first &&
      first.start <= timestamp + 50 &&
      (!second || second.start > timestamp + 50)
        ? first.owner
        : undefined;
    if (owner) {
      const values = scopedResources.get(owner) ?? [];
      values.push(resource);
      scopedResources.set(owner, values);
    } else unmatched.push(resource);
  }
  // Session resources retain unmatched/setup entries without guessing across duplicate URLs.
  runner.resourceTimings = [...resourceEntries.values()].map(
    value => value.resource,
  );
  for (const step of scenario.steps) {
    const capture = captures.get(step.id);
    if (!capture) continue;
    const entries = har.log.entries
      .filter(entry => ownerFor(entry) === step.id)
      .map(entry => ({
        ...entry,
        _stepId: step.id,
        _stepStartOffsetMs:
          Date.parse(entry.startedDateTime) - capture.startedEpoch,
      }));
    const references = new Set(
      entries.map(entry => entry.pageref).filter(Boolean),
    );
    const pages: HarData['log']['pages'] = har.log.pages
      .filter(page => page.id && references.has(page.id))
      .map(page => ({
        ...page,
        pageTimings: step.kind === 'interaction' ? {} : { ...page.pageTimings },
      }));
    const metrics = capture.metrics ?? stepMetrics(capture);
    if (step.kind === 'navigation' && pages.length) {
      const navigation = capture.snapshot?.navigationTiming;
      const lcp = capture.snapshot?.largestContentfulPaint.at(-1);
      if (navigation)
        pages[0].pageTimings._TTFB =
          navigation.responseStart - navigation.fetchStart;
      if (lcp) pages[0].pageTimings._LCP = lcp.renderTime || lcp.startTime;
      if (lcp?.url) {
        for (const entry of entries)
          if (entry.request.url === lcp.url)
            Object.assign(entry, { _is_lcp: true });
      }
    }
    const sizes = entries.map(
      entry => entry.response._transferSize ?? entry.response.content.size,
    );
    metrics.requests = {
      count: entries.length,
      ...(sizes.every(size => Number.isFinite(size) && size >= 0)
        ? { transferBytes: sizes.reduce((total, size) => total + size, 0) }
        : {}),
      attribution: 'request-start',
      resourceTimingCoverage: (scopedResources.get(step.id) ?? []).length,
      unmatchedSessionResourceCount: unmatched.length,
    };
    const base = path.join(runner.paths.results, step.artifactBase);
    atomicJSON(path.join(base, 'metrics.json'), metrics);
    atomicJSON(
      path.join(base, 'resources.json'),
      scopedResources.get(step.id) ?? [],
    );
    atomicJSON(path.join(base, 'console.json'), capture.console);
    atomicJSON(path.join(base, 'pageload.har'), {
      ...har,
      log: { ...har.log, pages, entries },
    });
  }
  atomicJSON(filename, har);
}

/** Generates an escaped, self-contained journey report that opens from disk. */
export function renderScenarioReport(resultsPath: string): void {
  const scenario = ScenarioManifestSchema.parse(
    JSON.parse(readFileSync(path.join(resultsPath, 'scenario.json'), 'utf8')),
  );
  const load = (base: string, filename: string): unknown => {
    const absolute = path.join(resultsPath, base, filename);
    if (!existsSync(absolute)) return null;
    try {
      return JSON.parse(readFileSync(absolute, 'utf8'));
    } catch {
      return null;
    }
  };
  const data = {
    scenario,
    sessionVideo: readdirSync(resultsPath, { withFileTypes: true }).find(
      file => file.isFile() && file.name.endsWith('.webm'),
    )?.name,
    steps: scenario.steps.map(step => ({
      ...step,
      metrics: load(step.artifactBase, 'metrics.json'),
      resources: load(step.artifactBase, 'resources.json'),
      console: load(step.artifactBase, 'console.json'),
      har: load(step.artifactBase, 'pageload.har'),
      screenshot: existsSync(
        path.join(resultsPath, step.artifactBase, 'screenshot.png'),
      )
        ? `${step.artifactBase}/screenshot.png`
        : null,
    })),
  };
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const payload = JSON.stringify(data).replace(
    /[<>&\u2028\u2029]/g,
    character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
  const html = ejs.render(
    readFileSync(path.join(currentDir, 'templates/scenario.ejs'), 'utf8'),
    { scenario, payload },
  );
  writeFileSync(path.join(resultsPath, 'index.html'), html, 'utf8');
}

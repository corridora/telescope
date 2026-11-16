import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { BrowserConfig } from '../src/browsers.js';
import { ScenarioManifestSchema } from '../src/contracts.js';
import { launchTest } from '../src/index.js';
import type {
  ConsoleMessage,
  HarData,
  HarEntry,
  ResultManifest,
  ScenarioManifest,
  ScenarioStepResult,
  SuccessfulTestResult,
} from '../src/types.js';

const browsers = BrowserConfig.getBrowsers();

interface StepHarEntry extends HarEntry {
  _stepId: string;
  _stepStartOffsetMs: number;
}

interface StepHarData extends HarData {
  log: Omit<HarData['log'], 'entries'> & { entries: StepHarEntry[] };
}

function json<T>(directory: string, filename: string): T {
  return JSON.parse(readFileSync(path.join(directory, filename), 'utf8')) as T;
}

function scenarioAt(directory: string): ScenarioManifest {
  return ScenarioManifestSchema.parse(
    json<unknown>(directory, 'scenario.json'),
  );
}

function harAt(directory: string, step: ScenarioStepResult): StepHarData {
  return json(directory, `${step.artifactBase}/pageload.har`);
}

function urls(har: HarData): string[] {
  return har.log.entries.map(entry => new URL(entry.request.url).pathname);
}

async function samplePixel(filename: string): Promise<number[]> {
  const pixel = await new Promise<Buffer>((resolve, reject) => {
    execFile(
      'ffmpeg',
      [
        '-hide_banner',
        '-nostdin',
        '-loglevel',
        'error',
        '-threads',
        '1',
        '-filter_threads',
        '1',
        '-i',
        filename,
        '-vf',
        'format=rgb24,crop=1:1:iw-20:ih/2',
        '-frames:v',
        '1',
        '-pix_fmt',
        'rgb24',
        '-f',
        'rawvideo',
        'pipe:1',
      ],
      { encoding: 'buffer', timeout: 5000, maxBuffer: 65536 },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
  expect(pixel.length).toBe(3);
  return [...pixel];
}

describe('Scripted browser journeys', () => {
  let directory: string;
  let baseURL: string;
  let ffmpegAvailable: boolean;
  const server = createServer((request, response) => {
    const pathname = new URL(request.url || '/', 'http://localhost').pathname;
    if (pathname === '/first' || pathname === '/second') {
      const color = pathname === '/first' ? '#8a1834' : '#204e2e';
      response.writeHead(200, {
        'Content-Type': 'text/html',
        'Cache-Control': 'no-store',
      });
      response.end(`<!doctype html><html><head><title>Journey fixture</title>
        <link rel="stylesheet" href="/style.css"></head>
        <body style="background:${color}"><button id="change">Change state</button>
        <script>
          document.querySelector('#change').addEventListener('click', async () => {
            await fetch('/interaction');
            await fetch('/shared');
            localStorage.setItem('journey', 'changed');
            document.body.style.background = '#174e81';
            performance.mark('interaction-complete');
            console.log('interaction diagnostic');
            document.body.dataset.changed = 'true';
          });
        </script></body></html>`);
      return;
    }
    if (pathname === '/style.css') {
      response.writeHead(200, {
        'Content-Type': 'text/css',
        'Cache-Control': 'no-store',
      });
      response.end(
        'html,body{margin:0;min-height:100vh}button{margin:20px;padding:12px}',
      );
      return;
    }
    if (pathname === '/late') {
      setTimeout(() => {
        if (!response.destroyed) {
          response.writeHead(200, {
            'Content-Type': 'text/plain',
            'Cache-Control': 'no-store',
          });
          response.end(
            'A first-step request completing during the second step',
          );
        }
      }, 450);
      return;
    }
    if (['/shared', '/interaction', '/failure'].includes(pathname)) {
      response.writeHead(200, {
        'Content-Type': 'text/plain',
        'Cache-Control': 'no-store',
      });
      response.end(pathname);
      return;
    }
    response.writeHead(404);
    response.end('Not found');
  });

  beforeAll(async () => {
    directory = mkdtempSync(path.join(tmpdir(), 'telescope-scripting-'));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Fixture server did not start');
    baseURL = `http://127.0.0.1:${address.port}`;
    ffmpegAvailable =
      spawnSync('ffmpeg', ['-version'], { timeout: 5000, stdio: 'ignore' })
        .status === 0;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  });

  describe.each(browsers)('%s', browser => {
    let result: SuccessfulTestResult;
    let scenario: ScenarioManifest;
    let persistentState: {
      cookie: string;
      local: string | null;
      session: string | null;
    };

    beforeAll(async () => {
      const completed = await launchTest({
        url: `${baseURL}/first`,
        browser,
        headless: true,
        width: 640,
        height: 360,
        resultsDir: directory,
        html: true,
        frameRate: 5,
        script: {
          name: 'Stateful <journey> </script><script>injected()</script>',
          setup: async ({ page, context }) => {
            if (page.url() !== 'about:blank')
              throw new Error('Setup did not start on the initial blank page');
            if (await page.locator('[id^="telescope-calibration-"]').count())
              throw new Error('Calibration marker leaked into setup');
            await context.addCookies([
              { name: 'journey-cookie', value: 'kept', url: baseURL },
            ]);
          },
          steps: [
            {
              name: 'First navigation',
              kind: 'navigation',
              run: async ({ page }) => {
                await page.goto(`${baseURL}/first`);
                await page.evaluate(async () => {
                  localStorage.setItem('journey', 'initial');
                  sessionStorage.setItem('journey-session', 'kept');
                  await fetch('/shared');
                  console.log('navigation diagnostic');
                });
                await page.waitForTimeout(600);
                const lateStarted = page.waitForRequest(
                  request => new URL(request.url()).pathname === '/late',
                );
                await page.evaluate(() => {
                  void fetch('/late');
                });
                await lateStarted;
              },
            },
            {
              name: 'Change state without navigation',
              kind: 'interaction',
              run: async ({ page }) => {
                await page.click('#change');
                await page.waitForFunction(
                  () => document.body.dataset.changed === 'true',
                );
                await page.waitForTimeout(650);
              },
            },
            {
              name: 'Second navigation preserves state',
              kind: 'navigation',
              run: async ({ page }) => {
                await page.goto(`${baseURL}/second`);
                persistentState = await page.evaluate(() => ({
                  cookie: document.cookie,
                  local: localStorage.getItem('journey'),
                  session: sessionStorage.getItem('journey-session'),
                }));
                await page.waitForTimeout(650);
              },
            },
          ],
        },
      });
      if (!completed.success) throw new Error(completed.error);
      result = completed;
      scenario = scenarioAt(result.resultsPath);
    }, 120000);

    test('preserves one browser session and distinguishes navigation and interval metrics', () => {
      expect(scenario.status).toBe('passed');
      expect(scenario.steps.map(step => step.status)).toEqual([
        'passed',
        'passed',
        'passed',
      ]);
      expect(persistentState).toEqual({
        cookie: 'journey-cookie=kept',
        local: 'changed',
        session: 'kept',
      });
      expect(scenario.steps.map(step => step.metricScope)).toEqual([
        'navigation',
        'interval',
        'navigation',
      ]);
      for (const [index, step] of scenario.steps.entries()) {
        const metrics = json<Record<string, unknown>>(
          result.resultsPath,
          `${step.artifactBase}/metrics.json`,
        );
        expect(metrics.scope).toBe(index === 1 ? 'interval' : 'navigation');
        if (index === 1) {
          expect(metrics.navigationTiming).toBeUndefined();
          expect(metrics.paintTiming).toEqual([]);
          expect(metrics.largestContentfulPaint).toEqual([]);
        } else expect(metrics.navigationTiming).toBeDefined();
        expect(step.startOffsetMs).toBeGreaterThan(0);
        expect(step.durationMs).toBeGreaterThanOrEqual(600);
        expect(
          existsSync(
            path.join(result.resultsPath, step.artifactBase, 'screenshot.png'),
          ),
        ).toBe(true);
      }
      expect(
        json<ResultManifest>(result.resultsPath, 'result.json').status,
      ).toBe('passed');
    });

    test('attributes duplicate URLs and late completions to the request-starting step', () => {
      const [first, interaction, second] = scenario.steps;
      const firstHAR = harAt(result.resultsPath, first);
      const interactionHAR = harAt(result.resultsPath, interaction);
      expect(urls(firstHAR)).toEqual(
        expect.arrayContaining(['/first', '/style.css', '/shared', '/late']),
      );
      expect(
        urls(interactionHAR).filter(url => url === '/shared'),
      ).toHaveLength(1);
      expect(urls(firstHAR).filter(url => url === '/shared')).toHaveLength(1);
      expect(urls(interactionHAR)).toContain('/interaction');
      expect(urls(interactionHAR)).not.toContain('/late');
      expect(urls(harAt(result.resultsPath, second))).toContain('/second');
      for (const step of scenario.steps)
        for (const entry of harAt(result.resultsPath, step).log.entries)
          expect(entry._stepId).toBe(step.id);
      const late = firstHAR.log.entries.find(
        entry => new URL(entry.request.url).pathname === '/late',
      );
      expect(late).toBeDefined();
      expect((late!._stepStartOffsetMs || 0) + late!.time).toBeGreaterThan(
        first.durationMs! + 100,
      );
      const consoleMessages = json<ConsoleMessage[]>(
        result.resultsPath,
        `${interaction.artifactBase}/console.json`,
      );
      expect(
        consoleMessages.some(
          message => message.text === 'interaction diagnostic',
        ),
      ).toBe(true);
      expect(
        consoleMessages.some(
          message => message.text === 'navigation diagnostic',
        ),
      ).toBe(false);
      const metrics = json<{
        requests: { count: number };
        userTiming: Array<{ name: string }>;
      }>(result.resultsPath, `${interaction.artifactBase}/metrics.json`);
      expect(metrics.requests.count).toBe(interactionHAR.log.entries.length);
      expect(
        metrics.userTiming.some(entry => entry.name === 'interaction-complete'),
      ).toBe(true);
    });

    test('escapes script names in the report and preserves a full-session recording reference', () => {
      const html = readFileSync(
        path.join(result.resultsPath, 'index.html'),
        'utf8',
      );
      expect(html).not.toContain('</script><script>injected()</script>');
      expect(html).toContain('Stateful &lt;journey&gt;');
      expect(html).toContain('Step filmstrip');
      expect(scenario.video?.path).toMatch(/\.webm$/);
      expect(
        existsSync(path.join(result.resultsPath, scenario.video!.path)),
      ).toBe(true);
    });

    test('extracts calibrated step recordings and correctly colored filmstrip samples with verifiable descriptors', async context => {
      if (!ffmpegAvailable) {
        context.skip();
        return;
      }
      const expectedColors = [
        [138, 24, 52],
        [23, 78, 129],
        [32, 78, 46],
      ];
      for (const [index, step] of scenario.steps.entries()) {
        expect(step.media, step.media?.reason).toMatchObject({
          status: 'available',
          alignment: { method: 'color-calibration' },
        });
        const media = step.media!;
        expect(media.alignment!.uncertaintyMs).toBeLessThanOrEqual(250);
        expect(media.alignment!.videoStartMs).toBeGreaterThan(0);
        expect(media.frames!.length).toBeGreaterThan(1);
        expect(media.frameRate).toBe(5);
        const video = readFileSync(
          path.join(result.resultsPath, media.videoPath!),
        );
        expect([...video.subarray(0, 4)]).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
        for (const frame of media.frames!) {
          expect(frame.ms).toBeGreaterThanOrEqual(0);
          expect(frame.ms).toBeLessThanOrEqual(step.durationMs!);
          const descriptor =
            step.artifacts![frame.path.slice(step.artifactBase.length + 1)];
          const bytes = readFileSync(path.join(result.resultsPath, frame.path));
          expect(descriptor).toEqual({
            size: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          });
        }
        const lastFrame = media.frames!.at(-1)!;
        const actual = await samplePixel(
          path.join(result.resultsPath, lastFrame.path),
        );
        actual.forEach((channel, channelIndex) =>
          expect(
            Math.abs(channel - expectedColors[index][channelIndex]),
            JSON.stringify({
              step: step.name,
              sample: lastFrame,
              actual,
              expected: expectedColors[index],
              media: media.alignment,
            }),
          ).toBeLessThan(30),
        );
      }
    }, 30000);

    test('retains partial diagnostics after failure and never executes remaining steps', async () => {
      let skippedCalled = false;
      const failed = await launchTest({
        url: `${baseURL}/first`,
        browser,
        headless: true,
        width: 640,
        height: 360,
        resultsDir: directory,
        script: {
          steps: [
            {
              name: 'Load document',
              kind: 'navigation',
              run: async ({ page }) => {
                await page.goto(`${baseURL}/first`);
              },
            },
            {
              name: 'Fail after diagnostics',
              kind: 'interaction',
              run: async ({ page }) => {
                await page.evaluate(async () => {
                  console.error('failure diagnostic');
                  performance.mark('before-failure');
                  await fetch('/failure');
                });
                throw new Error('intentional scripted failure');
              },
            },
            {
              name: 'Must be skipped',
              kind: 'interaction',
              run: async () => {
                skippedCalled = true;
              },
            },
          ],
        },
      });
      expect(failed.success).toBe(false);
      if (failed.success) throw new Error('Expected the scripted failure');
      expect(failed.error).toContain('intentional scripted failure');
      expect(failed.resultsPath).toBeDefined();
      const failedScenario = scenarioAt(failed.resultsPath!);
      expect(failedScenario.steps.map(step => step.status)).toEqual([
        'passed',
        'failed',
        'skipped',
      ]);
      expect(skippedCalled).toBe(false);
      const failedStep = failedScenario.steps[1];
      expect(failedStep.error).toContain('intentional scripted failure');
      expect(urls(harAt(failed.resultsPath!, failedStep))).toContain(
        '/failure',
      );
      expect(
        json<ConsoleMessage[]>(
          failed.resultsPath!,
          `${failedStep.artifactBase}/console.json`,
        ).some(message => message.text === 'failure diagnostic'),
      ).toBe(true);
      expect(
        json<{ capture: { partial: boolean } }>(
          failed.resultsPath!,
          `${failedStep.artifactBase}/metrics.json`,
        ).capture.partial,
      ).toBe(true);
      expect(
        existsSync(
          path.join(
            failed.resultsPath!,
            failedStep.artifactBase,
            'screenshot.png',
          ),
        ),
      ).toBe(true);
      expect(
        existsSync(
          path.join(failed.resultsPath!, failedScenario.steps[2].artifactBase),
        ),
      ).toBe(false);
      expect(
        json<ResultManifest>(failed.resultsPath!, 'result.json').status,
      ).toBe('failed');
    }, 120000);
  });
});

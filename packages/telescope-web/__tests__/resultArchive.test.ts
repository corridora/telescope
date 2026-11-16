import { createHash } from 'node:crypto';
import { zipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';

import type {
  ResultManifest,
  ScenarioManifest,
} from '@cloudflare/telescope/contracts';

vi.mock('cloudflare:workers', () => ({ env: {} }));

import { parseResultArchive } from '@/lib/storage/resultStore';

const testId = '2026_11_16_12_00_00_01234567-89ab-4def-8123-456789abcdef';
const encode = (value: string): Uint8Array => new TextEncoder().encode(value);
const json = (value: unknown): Uint8Array => encode(JSON.stringify(value));
const descriptor = (bytes: Uint8Array) => ({
  size: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
});

function capture() {
  const files: Record<string, Uint8Array> = {
    'config.json': json({
      url: 'https://fixture.test/',
      date: '2026-11-16T12:00:00.000Z',
      options: { url: 'https://fixture.test/', browser: 'firefox' },
      browserConfig: { engine: 'firefox' },
    }),
    'steps/0001/metrics.json': json({
      scope: 'interval',
      paintTiming: [],
      largestContentfulPaint: [],
    }),
    'steps/0001/video.webm': encode('captured step video'),
  };
  const scenario: ScenarioManifest = {
    schemaVersion: 1,
    status: 'failed',
    startedAt: '2026-11-16T12:00:00.000Z',
    durationMs: 100,
    steps: [
      {
        id: '0001',
        order: 0,
        name: 'Update cart',
        kind: 'interaction',
        status: 'failed',
        artifactBase: 'steps/0001',
        metricScope: 'interval',
        startOffsetMs: 0,
        durationMs: 100,
        artifacts: {
          'metrics.json': descriptor(files['steps/0001/metrics.json']),
          'video.webm': descriptor(files['steps/0001/video.webm']),
        },
        media: {
          status: 'available',
          videoPath: 'steps/0001/video.webm',
          alignment: {
            method: 'color-calibration',
            uncertaintyMs: 20,
            videoStartMs: 0,
          },
        },
      },
    ],
  };
  const manifest: ResultManifest = {
    schemaVersion: 1,
    testId,
    status: 'failed',
    startedAt: '2026-11-16T12:00:00.000Z',
    // Step descriptors must be checked even when the root manifest omits them.
    artifacts: { 'config.json': descriptor(files['config.json']) },
  };
  return {
    files,
    scenario,
    manifest,
    zip() {
      return zipSync({
        ...files,
        'scenario.json': json(scenario),
        'result.json': json(manifest),
      });
    },
  };
}

describe('validated result archives', () => {
  it('accepts a legacy flat or single-wrapper archive', async () => {
    const config = capture().files['config.json'];
    expect(
      (await parseResultArchive(zipSync({ 'config.json': config }))).config.url,
    ).toBe('https://fixture.test/');
    expect(
      (await parseResultArchive(zipSync({ 'legacy/config.json': config })))
        .config.url,
    ).toBe('https://fixture.test/');
  });

  it('rejects ambiguous wrapper directories', async () => {
    const config = capture().files['config.json'];
    await expect(
      parseResultArchive(
        zipSync({ 'one/config.json': config, 'two/config.json': config }),
      ),
    ).rejects.toThrow('one root config.json');
  });

  it('accepts failed-step media validated independently from the root manifest', async () => {
    const fixture = capture();
    const parsed = await parseResultArchive(fixture.zip());
    expect(parsed.scenario?.steps[0].media?.videoPath).toBe(
      'steps/0001/video.webm',
    );
    expect(parsed.descriptors['steps/0001/video.webm']).toEqual(
      fixture.scenario.steps[0].artifacts?.['video.webm'],
    );
  });

  it('rejects a corrupt step recording omitted from root descriptors', async () => {
    const fixture = capture();
    fixture.files['steps/0001/video.webm'] = encode('tampered recording');
    await expect(parseResultArchive(fixture.zip())).rejects.toThrow(
      'Missing or corrupt declared artifact: steps/0001/video.webm',
    );
  });

  it('rejects a missing step recording even on a failed step', async () => {
    const fixture = capture();
    delete fixture.files['steps/0001/video.webm'];
    await expect(parseResultArchive(fixture.zip())).rejects.toThrow(
      'Missing declared artifact: steps/0001/video.webm',
    );
  });

  it('rejects media references that escape their own step', async () => {
    const fixture = capture();
    fixture.scenario.steps[0].media!.videoPath = 'steps/0002/video.webm';
    await expect(parseResultArchive(fixture.zip())).rejects.toThrow(
      'Invalid scenario.json',
    );
  });

  it('rejects artifacts for an undeclared step', async () => {
    const fixture = capture();
    fixture.files['steps/0002/metrics.json'] = json({});
    await expect(parseResultArchive(fixture.zip())).rejects.toThrow(
      'undeclared scenario step',
    );
  });

  it('rejects step artifacts without a scenario manifest', async () => {
    const fixture = capture();
    await expect(parseResultArchive(zipSync(fixture.files))).rejects.toThrow(
      'Step artifacts require a scenario manifest',
    );
  });

  it('rejects a scenario still being captured', async () => {
    const fixture = capture();
    fixture.scenario.status = 'running';
    await expect(parseResultArchive(fixture.zip())).rejects.toThrow(
      'running capture',
    );
  });

  it('requires diagnostics for passed steps', async () => {
    const fixture = capture();
    fixture.scenario.steps[0].status = 'passed';
    await expect(parseResultArchive(fixture.zip())).rejects.toThrow(
      'Passed step 0001 is missing resources.json',
    );
  });

  it('keeps declared HTML as an inert export artifact', async () => {
    const fixture = capture();
    fixture.files['index.html'] = encode(
      '<html><script>untrusted()</script></html>',
    );
    fixture.manifest.artifacts = {
      ...fixture.manifest.artifacts,
      'index.html': descriptor(fixture.files['index.html']),
    };
    expect(
      (await parseResultArchive(fixture.zip())).files['index.html'],
    ).toEqual(fixture.files['index.html']);
  });

  it('rejects inherited navigation metrics on partial interactions', async () => {
    const fixture = capture();
    fixture.files['steps/0001/metrics.json'] = json({
      navigationTiming: { duration: 123 },
    });
    fixture.scenario.steps[0].artifacts!['metrics.json'] = descriptor(
      fixture.files['steps/0001/metrics.json'],
    );
    await expect(parseResultArchive(fixture.zip())).rejects.toThrow(
      'Interaction metrics must not contain inherited navigation timing',
    );
  });

  it('rejects a step kind whose metric scope disagrees', async () => {
    const fixture = capture();
    fixture.scenario.steps[0].metricScope = 'navigation';
    await expect(parseResultArchive(fixture.zip())).rejects.toThrow(
      'Invalid scenario.json',
    );
  });
});

import { execFile } from 'child_process';
import crypto from 'crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'fs';
import path from 'path';

import type { Page } from 'playwright';
import type { ScenarioStepResult } from './types.js';

const CALIBRATION_COLORS = [
  [16, 224, 64],
  [32, 64, 224],
  [224, 32, 192],
  [224, 208, 32],
];
const CALIBRATION_FRAME_RATE = 25;
const CALIBRATION_SECONDS = 20;
const MAX_STEP_DURATION_MS = 300000;
const MAX_STEP_FRAMES = 200;
const MAX_TOTAL_FRAMES = 2000;
const MAX_MEDIA_STEPS = 200;
const MAX_PROCESSING_MS = 120000;

interface CalibrationTransition {
  sessionOffsetMs: number;
  uncertaintyMs: number;
}

/** Internal recording calibration, measured before script setup on about:blank. */
export interface StepMediaCalibration {
  transitions: CalibrationTransition[];
  reason?: string;
  cleanupFailed?: boolean;
}

interface FFmpegOutput {
  stdout: Buffer;
  stderr: string;
}

interface VideoAlignment {
  offsetMs: number;
  uncertaintyMs: number;
}

async function bounded<T>(action: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      action,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Calibration timed out')),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Records a temporary color sequence on the initial blank page, before user code.
 * Node clock brackets include the browser paint acknowledgement; no timestamp
 * correspondence is assumed until the sequence is found in the finalized video.
 */
export async function calibrateStepMedia(
  page: Page,
  sessionStartedMs: number,
  signal?: AbortSignal,
): Promise<StepMediaCalibration> {
  const calibration: StepMediaCalibration = { transitions: [] };
  if (!page.video())
    return { ...calibration, reason: 'Session recording is unavailable.' };
  if (page.url() !== 'about:blank') {
    return {
      ...calibration,
      reason: 'Recording calibration requires the initial blank page.',
    };
  }
  const id = 'telescope-calibration-' + crypto.randomUUID();
  try {
    await bounded(
      page.evaluate(markerId => {
        const marker = document.createElement('div');
        marker.id = markerId;
        marker.setAttribute('aria-hidden', 'true');
        marker.style.cssText =
          'position:fixed;inset:0;z-index:2147483647;pointer-events:none;background:#000';
        document.documentElement.append(marker);
      }, id),
      1000,
    );
    for (const color of CALIBRATION_COLORS) {
      if (signal?.aborted) throw new Error('Calibration cancelled');
      const before = performance.now();
      await bounded(
        page.evaluate(
          ({ markerId, rgb }) =>
            new Promise<void>((resolve, reject) => {
              requestAnimationFrame(() => {
                const marker = document.getElementById(markerId);
                if (!marker)
                  return reject(new Error('Calibration marker is unavailable'));
                marker.style.backgroundColor = `rgb(${rgb.join(',')})`;
                // The next frame runs after the changed color had a paint opportunity.
                requestAnimationFrame(() => resolve());
              });
            }),
          { markerId: id, rgb: color },
        ),
        1000,
      );
      const after = performance.now();
      calibration.transitions.push({
        sessionOffsetMs: (before + after) / 2 - sessionStartedMs,
        uncertaintyMs: (after - before) / 2,
      });
      await new Promise<void>(resolve => setTimeout(resolve, 350));
    }
  } catch {
    calibration.reason = signal?.aborted
      ? 'Recording calibration was cancelled.'
      : 'The browser could not complete recording calibration.';
  } finally {
    try {
      await bounded(
        page.evaluate(markerId => {
          document.getElementById(markerId)?.remove();
        }, id),
        1000,
      );
    } catch {
      calibration.reason =
        'The calibration marker could not be removed; recording alignment is unavailable.';
      calibration.cleanupFailed = true;
    }
  }
  return calibration;
}

function ffmpeg(args: string[], timeoutMs: number): Promise<FFmpegOutput> {
  return new Promise((resolve, reject) => {
    execFile(
      'ffmpeg',
      ['-hide_banner', '-nostdin', '-nostats', '-filter_threads', '1', ...args],
      {
        encoding: 'buffer',
        maxBuffer: 1024 * 1024,
        timeout: Math.max(1, timeoutMs),
        killSignal: 'SIGKILL',
      },
      (error, stdout, stderr) => {
        if (error) reject(error);
        else resolve({ stdout, stderr: stderr.toString('utf8') });
      },
    );
  });
}

function colorAt(buffer: Buffer, frame: number): number {
  // Four pixels from the central half of the recording avoid letterbox edges.
  const start = frame * 12;
  const colors: number[] = [];
  for (let pixel = 0; pixel < 4; pixel++) {
    const red = buffer[start + pixel * 3];
    const green = buffer[start + pixel * 3 + 1];
    const blue = buffer[start + pixel * 3 + 2];
    // Browser recording color profiles can change absolute RGB values (notably
    // WebKit green). Require the same distinct chromatic signature at every
    // pixel instead of confusing color conversion with a missing marker.
    let color = -1;
    if (Math.max(red, green, blue) >= 180) {
      if (green - red >= 60 && green - blue >= 60) color = 0;
      else if (blue - red >= 60 && blue - green >= 60) color = 1;
      else if (
        red - green >= 60 &&
        blue - green >= 60 &&
        Math.abs(red - blue) <= 80
      )
        color = 2;
      else if (
        red - blue >= 60 &&
        green - blue >= 60 &&
        Math.abs(red - green) <= 80
      )
        color = 3;
    }
    colors.push(color);
  }
  return colors.every(color => color === colors[0]) ? colors[0] : -1;
}

async function locateCalibration(
  videoPath: string,
  calibration: StepMediaCalibration,
): Promise<VideoAlignment> {
  if (
    calibration.reason ||
    calibration.transitions.length !== CALIBRATION_COLORS.length
  ) {
    throw new Error(
      calibration.reason || 'The recording calibration is incomplete.',
    );
  }
  // showinfo observes source PTS before resampling, allowing sparse recording
  // cadence to increase the uncertainty rather than claiming 25fps precision.
  const output = await ffmpeg(
    [
      '-loglevel',
      'info',
      '-threads',
      '1',
      '-i',
      videoPath,
      '-map',
      '0:v:0',
      '-an',
      '-t',
      String(CALIBRATION_SECONDS),
      '-vf',
      `setpts=PTS-STARTPTS,showinfo,fps=${CALIBRATION_FRAME_RATE}:start_time=0:round=near,crop=iw/2:ih/2:iw/4:ih/4,scale=2:2:flags=neighbor,format=rgb24`,
      '-frames:v',
      String(CALIBRATION_SECONDS * CALIBRATION_FRAME_RATE),
      '-pix_fmt',
      'rgb24',
      '-f',
      'rawvideo',
      'pipe:1',
    ],
    15000,
  );
  if (output.stdout.length % 12 !== 0)
    throw new Error('Recording calibration pixels are incomplete.');
  const runs: Array<{ color: number; start: number; end: number }> = [];
  for (let frame = 0; frame < output.stdout.length / 12; frame++) {
    const color = colorAt(output.stdout, frame);
    const previous = runs.at(-1);
    if (previous?.color === color) previous.end = frame;
    else runs.push({ color, start: frame, end: frame });
  }
  const periodMs = 1000 / CALIBRATION_FRAME_RATE;
  const matches = runs.flatMap((run, index) => {
    if (run.color !== 0) return [];
    const candidate = runs.slice(index, index + CALIBRATION_COLORS.length);
    return candidate.length === CALIBRATION_COLORS.length &&
      candidate.every(
        (value, color) => value.color === color && value.end - value.start >= 2,
      )
      ? [candidate]
      : [];
  });
  if (matches.length !== 1)
    throw new Error(
      'The recorded calibration color sequence could not be identified confidently.',
    );
  const match = matches[0];
  // The first recording frame may begin during the first color. Later color
  // transitions have both a visible predecessor and a bracketed Node clock.
  const offsets = match
    .slice(1)
    .map(
      (run, index) =>
        run.start * periodMs -
        calibration.transitions[index + 1].sessionOffsetMs,
    );
  const spread = Math.max(...offsets) - Math.min(...offsets);
  if (spread > 120)
    throw new Error('Recording calibration transitions disagree.');
  const sourceTimes = [...output.stderr.matchAll(/\bpts_time:([\d.e+-]+)/g)]
    .map(value => Number(value[1]) * 1000)
    .filter(
      value =>
        Number.isFinite(value) &&
        value >= match[0].start * periodMs - periodMs &&
        value <= match[3].end * periodMs + periodMs,
    );
  const gaps = sourceTimes
    .slice(1)
    .map((value, index) => value - sourceTimes[index]);
  const sourceIntervalMs = Math.max(...gaps);
  if (!gaps.length || sourceIntervalMs <= 0 || sourceIntervalMs > 200) {
    throw new Error(
      'The recording cadence is insufficient for bounded step alignment.',
    );
  }
  const uncertaintyMs = Math.ceil(
    periodMs +
      sourceIntervalMs +
      spread / 2 +
      Math.max(...calibration.transitions.map(value => value.uncertaintyMs)),
  );
  if (uncertaintyMs > 250)
    throw new Error('Recording calibration uncertainty exceeds 250ms.');
  return {
    offsetMs: offsets.sort((left, right) => left - right)[1],
    uncertaintyMs,
  };
}

function relativePath(root: string, filename: string): string {
  return path.relative(root, filename).split(path.sep).join('/');
}

function removeMedia(filename: string): void {
  try {
    rmSync(filename, { recursive: true, force: true });
  } catch {
    // Optional media cleanup must not replace the browser/script failure.
    // Temporary folders live outside the capture and its portable descriptors.
  }
}

function failureReason(error: unknown): string {
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'ENOENT' &&
    'syscall' in error &&
    error.syscall === 'spawn ffmpeg'
  ) {
    return 'FFmpeg is unavailable; the full session recording is retained.';
  }
  // Process errors can include command lines and machine paths. Keep those out
  // of portable manifests; calibration errors are controlled strings above.
  if (error instanceof Error && !('cmd' in error) && !('code' in error))
    return error.message;
  return 'Step media processing failed or exceeded its resource limit; the full session recording is retained.';
}

/**
 * Creates bounded, re-encoded step clips and sampled filmstrips after video close.
 * Optional media failures are persisted on measured steps without failing the run.
 * The original session video is retained, including its calibration preface.
 */
export async function generateStepMedia(
  resultsPath: string,
  videoPath: string,
  steps: ScenarioStepResult[],
  calibration: StepMediaCalibration,
  requestedFrameRate: number,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = performance.now() + MAX_PROCESSING_MS;
  const measured = steps.filter(
    step => step.startOffsetMs !== undefined && step.durationMs !== undefined,
  );
  for (const step of measured)
    step.media = {
      status: 'unavailable',
      reason: 'Step media was not generated.',
    };
  let alignment: VideoAlignment;
  try {
    if (signal?.aborted)
      throw new Error(
        'Step media processing was cancelled; the full session recording is retained.',
      );
    if (!videoPath || !existsSync(videoPath))
      throw new Error('Session recording is unavailable.');
    if (!measured.length) return;
    alignment = await locateCalibration(videoPath, calibration);
  } catch (error) {
    for (const step of measured)
      step.media = { status: 'unavailable', reason: failureReason(error) };
    return;
  }
  let framesRemaining = MAX_TOTAL_FRAMES;
  let processed = 0;
  for (const step of measured) {
    const durationMs = step.durationMs!;
    const videoStartMs = step.startOffsetMs! + alignment.offsetMs;
    const timeout = (): number =>
      Math.max(1, Math.min(20000, deadline - performance.now()));
    const stepDirectory = path.join(resultsPath, step.artifactBase);
    const temporary = path.join(
      path.dirname(resultsPath),
      '.telescope',
      'tmp',
      path.basename(resultsPath),
      'media-' + crypto.randomUUID(),
    );
    const videoOutput = path.join(stepDirectory, 'video.webm');
    const framesOutput = path.join(stepDirectory, 'filmstrip');
    try {
      if (signal?.aborted)
        throw new Error(
          'Step media processing was cancelled; the full session recording is retained.',
        );
      if (
        performance.now() >= deadline ||
        processed >= MAX_MEDIA_STEPS ||
        framesRemaining <= 0
      ) {
        throw new Error(
          'The session step media processing budget was exhausted; the full session recording is retained.',
        );
      }
      if (
        !Number.isFinite(durationMs) ||
        durationMs <= 0 ||
        durationMs > MAX_STEP_DURATION_MS ||
        !Number.isFinite(videoStartMs) ||
        videoStartMs < 0
      ) {
        throw new Error(
          'This step falls outside the supported recording duration or alignment bounds.',
        );
      }
      processed++;
      mkdirSync(temporary, { recursive: true });
      const temporaryVideo = path.join(temporary, 'video.webm');
      // Input accurate seeking plus transcoding discards pre-boundary keyframe
      // material. Stream-copy seeking would retain frames from preceding steps.
      const encoded = await ffmpeg(
        [
          '-loglevel',
          'error',
          '-progress',
          'pipe:2',
          '-threads',
          '1',
          '-ss',
          (videoStartMs / 1000).toFixed(6),
          '-i',
          videoPath,
          '-map',
          '0:v:0',
          '-an',
          '-t',
          (durationMs / 1000).toFixed(6),
          '-vf',
          "setpts=PTS-STARTPTS,scale=w='min(1280,trunc(iw/2)*2)':h=-2",
          '-c:v',
          'libvpx',
          '-deadline',
          'realtime',
          '-cpu-used',
          '8',
          '-threads',
          '1',
          '-b:v',
          '1200k',
          '-fs',
          String(20 * 1024 * 1024),
          '-y',
          temporaryVideo,
        ],
        timeout(),
      );
      const times = [...encoded.stderr.matchAll(/^out_time_us=(\d+)$/gm)].map(
        value => Number(value[1]) / 1000,
      );
      const encodedDurationMs = times.at(-1);
      if (
        !existsSync(temporaryVideo) ||
        !statSync(temporaryVideo).size ||
        encodedDurationMs === undefined ||
        encodedDurationMs + Math.max(150, alignment.uncertaintyMs) < durationMs
      ) {
        throw new Error(
          'The step recording is incomplete or exceeded its size limit.',
        );
      }
      const frameLimit = Math.min(MAX_STEP_FRAMES, framesRemaining);
      const targetFrameRate = Math.min(
        Number.isFinite(requestedFrameRate) && requestedFrameRate > 0
          ? requestedFrameRate
          : 1,
        10,
        (frameLimit * 1000) / durationMs,
      );
      // Pass the same explicit rational to FFmpeg and the result metadata.
      const frameRateNumerator = Math.max(
        1,
        Math.floor(targetFrameRate * 1000000),
      );
      const frameRate = frameRateNumerator / 1000000;
      const sampleCount = Math.min(
        frameLimit,
        Math.max(1, Math.ceil((durationMs * frameRate) / 1000)),
      );
      const temporaryFrames = path.join(temporary, 'filmstrip');
      mkdirSync(temporaryFrames);
      const sampled = await ffmpeg(
        [
          '-loglevel',
          'info',
          '-threads',
          '1',
          '-i',
          temporaryVideo,
          '-map',
          '0:v:0',
          '-an',
          '-vf',
          `fps=${frameRateNumerator}/1000000:start_time=0:round=near:eof_action=pass,showinfo,scale=w='min(640,iw)':h=-2`,
          '-frames:v',
          String(sampleCount),
          '-q:v',
          '5',
          '-threads',
          '1',
          path.join(temporaryFrames, 'frame_%06d.jpg'),
        ],
        timeout(),
      );
      const filenames = readdirSync(temporaryFrames)
        .filter(value => /^frame_\d{6}\.jpg$/.test(value))
        .sort();
      if (!filenames.length)
        throw new Error('No filmstrip frames were produced for this step.');
      const sampleTimes = [
        ...sampled.stderr.matchAll(
          /\bn:\s*(\d+)\s+pts:\s*-?\d+\s+pts_time:([\d.e+-]+)/g,
        ),
      ].map(value => ({
        index: Number(value[1]),
        ms: Number(value[2]) * 1000,
      }));
      const frames = filenames.map(filename => ({
        path: relativePath(resultsPath, path.join(framesOutput, filename)),
        ms:
          sampleTimes.find(
            value => value.index === Number(filename.match(/\d+/)![0]) - 1,
          )?.ms ?? NaN,
      }));
      if (
        frames.some(
          frame =>
            !Number.isFinite(frame.ms) || frame.ms < 0 || frame.ms > durationMs,
        )
      ) {
        throw new Error(
          'Filmstrip frame timestamps are unavailable or outside the step interval.',
        );
      }
      renameSync(temporaryVideo, videoOutput);
      renameSync(temporaryFrames, framesOutput);
      framesRemaining -= filenames.length;
      step.media = {
        status: 'available',
        videoPath: relativePath(resultsPath, videoOutput),
        frameRate,
        frames,
        alignment: {
          method: 'color-calibration',
          uncertaintyMs: alignment.uncertaintyMs,
          videoStartMs,
        },
      };
    } catch (error) {
      removeMedia(videoOutput);
      removeMedia(framesOutput);
      step.media = { status: 'unavailable', reason: failureReason(error) };
    } finally {
      removeMedia(temporary);
    }
  }
}

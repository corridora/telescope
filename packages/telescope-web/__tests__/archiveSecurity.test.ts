import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import {
  inspectZipArchive,
  isExpectedTelescopeFile,
  isSafeArtifactPath,
  isStorableArtifactPath,
  MAX_ARCHIVE_BYTES,
  MAX_EXPANDED_BYTES,
  normalizeAndFilterZipFiles,
} from '@/lib/utils/security';

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);

function archive(
  files: Record<string, Uint8Array> = { 'config.json': encode('{}') },
) {
  return zipSync(files, { level: 0 });
}

function rewriteHeader(
  change: (view: DataView, central: number, end: number) => void,
) {
  const bytes = archive();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 22;
  change(view, view.getUint32(end + 16, true), end);
  return bytes;
}

describe('portable artifact boundaries', () => {
  it.each([
    '../config.json',
    '/config.json',
    'C:\\config.json',
    'steps/0001/../0002/video.webm',
    'metrics.json:alternate',
    'filmstrip//frame.jpg',
    'filmstrip/./frame.jpg',
    'bad\u0000name',
  ])('rejects unsafe path %j', filename => {
    expect(isSafeArtifactPath(filename)).toBe(false);
    expect(isExpectedTelescopeFile(filename)).toBe(false);
    expect(isStorableArtifactPath(filename)).toBe(false);
  });

  it.each([
    'scenario.json',
    'result.json',
    'identity.json',
    'steps/0001/video.webm',
    'steps/0001/filmstrip/frame_001.jpg',
    'steps/0002/filmstrip/frame_002.png',
    'steps/0001/metrics.json',
    'baseline/meta.json',
  ])('serves declared capture format %s', filename => {
    expect(isExpectedTelescopeFile(filename)).toBe(true);
  });

  it('keeps generated HTML exportable while denying direct browser serving', () => {
    for (const filename of ['index.html', 'steps/0001/index.html']) {
      expect(isStorableArtifactPath(filename)).toBe(true);
      expect(isExpectedTelescopeFile(filename)).toBe(false);
    }
  });

  it.each([
    'steps/not-an-id/video.webm',
    'steps/0001/secret.txt',
    'script.mjs',
  ])('does not serve %s', filename => {
    expect(isExpectedTelescopeFile(filename)).toBe(false);
  });

  it('rejects normalization collisions instead of overwriting extracted bytes', () => {
    expect(() =>
      normalizeAndFilterZipFiles(
        {
          'filmstrip/frame.jpg': encode('one'),
          'filmstrip\\frame.jpg': encode('two'),
        },
        '',
      ),
    ).toThrow('Duplicate normalized archive path');
  });
});

describe('ZIP pre-inflation inspection', () => {
  it('accepts an ordinary compressed capture including scoped media', () => {
    const bytes = zipSync({
      'config.json': encode('{}'),
      'steps/0001/video.webm': encode('recording'),
      'steps/0001/filmstrip/frame.jpg': encode('frame'),
    });
    expect(() => inspectZipArchive(bytes)).not.toThrow();
  });

  it('honors the byte offset when reading a ZIP view', () => {
    const bytes = archive();
    const padded = new Uint8Array(bytes.length + 20);
    padded.set(bytes, 10);
    expect(() =>
      inspectZipArchive(padded.subarray(10, 10 + bytes.length)),
    ).not.toThrow();
  });

  it.each([
    { '../config.json': encode('{}') },
    { 'C:\\config.json': encode('{}') },
    {
      'filmstrip/frame.jpg': encode('one'),
      'filmstrip\\frame.jpg': encode('two'),
    },
    { 'config.json': encode('{}'), 'CONFIG.JSON': encode('{}') },
  ])('rejects unsafe or colliding paths before extracting them', files => {
    expect(() => inspectZipArchive(archive(files))).toThrow(
      /Unsafe archive path|Duplicate normalized archive path/,
    );
  });

  it('rejects an encrypted member', () => {
    expect(() =>
      inspectZipArchive(
        rewriteHeader((view, central) => {
          view.setUint16(central + 8, 1, true);
        }),
      ),
    ).toThrow('Encrypted or unsupported ZIP entry');
  });

  it('rejects symbolic links declared by Unix file mode', () => {
    expect(() =>
      inspectZipArchive(
        rewriteHeader((view, central) => {
          view.setUint32(central + 38, (0xa1ff << 16) >>> 0, true);
        }),
      ),
    ).toThrow('ZIP symlinks are unsupported');
  });

  it('rejects unsupported compression methods', () => {
    expect(() =>
      inspectZipArchive(
        rewriteHeader((view, central) => {
          view.setUint16(central + 10, 99, true);
        }),
      ),
    ).toThrow('Encrypted or unsupported ZIP entry');
  });

  it('rejects ZIP64 and multi-disk formats explicitly', () => {
    expect(() =>
      inspectZipArchive(
        rewriteHeader((view, _central, end) => {
          view.setUint16(end + 8, 0xffff, true);
          view.setUint16(end + 10, 0xffff, true);
        }),
      ),
    ).toThrow('ZIP64');
    expect(() =>
      inspectZipArchive(
        rewriteHeader((view, _central, end) => {
          view.setUint16(end + 4, 1, true);
        }),
      ),
    ).toThrow('Multi-disk');
  });

  it('rejects an expanded-size bomb using the directory size before inflation', () => {
    expect(() =>
      inspectZipArchive(
        rewriteHeader((view, central) => {
          view.setUint32(central + 24, MAX_EXPANDED_BYTES + 1, true);
        }),
      ),
    ).toThrow('ZIP expanded-size limit exceeded');
  });

  it('rejects mismatched local and central names', () => {
    expect(() =>
      inspectZipArchive(
        rewriteHeader((view, central) => {
          const local = view.getUint32(central + 42, true);
          view.setUint8(local + 30, 'x'.charCodeAt(0));
        }),
      ),
    ).toThrow('Inconsistent ZIP entry names');
  });

  it('rejects entry data extending into the directory', () => {
    expect(() =>
      inspectZipArchive(
        rewriteHeader((view, central) => {
          view.setUint32(central + 20, central, true);
        }),
      ),
    ).toThrow('Invalid ZIP entry bounds');
  });

  it('rejects oversized and malformed input before parsing entry data', () => {
    expect(() =>
      inspectZipArchive(new Uint8Array(MAX_ARCHIVE_BYTES + 1)),
    ).toThrow('ZIP must be between');
    expect(() => inspectZipArchive(new Uint8Array([1, 2, 3]))).toThrow(
      'Invalid ZIP end directory',
    );
  });
});

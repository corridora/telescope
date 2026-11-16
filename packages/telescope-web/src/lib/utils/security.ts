import path from 'node:path';
import type { Unzipped } from 'fflate';

export const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;
export const MAX_EXPANDED_BYTES = 24 * 1024 * 1024;
export const MAX_ARCHIVE_FILES = 10_000;
export const MAX_MANIFEST_BYTES = 1024 * 1024;

export const EXPECTED_TELESCOPE_FILES = new Set([
  'config.json',
  'result.json',
  'identity.json',
  'scenario.json',
  'metrics.json',
  'resources.json',
  'console.json',
  'pageload.har',
  'screenshot.png',
  'engine.png',
]);

/** Validate a capture/result identifier used in an artifact storage prefix. */
export function isValidTestId(testId: string): boolean {
  return /^\d{4}_\d{2}_\d{2}_\d{2}_\d{2}_\d{2}_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
    testId,
  );
}

/** Normalize separators from ZIP files made on Windows. */
export function toPosixPath(filepath: string): string {
  return filepath.split('\\').join('/');
}

/** Reject path traversal before filtering, storing, or resolving archive members. */
export function isSafeArtifactPath(filename: string): boolean {
  const normalized = toPosixPath(filename);
  return (
    normalized.length > 0 &&
    normalized.length <= 1024 &&
    !normalized.startsWith('/') &&
    !normalized.includes(':') &&
    !/[\u0000-\u001f\u007f]/.test(normalized) &&
    normalized
      .split('/')
      .every(part => part !== '' && part !== '.' && part !== '..')
  );
}

/** Allow only result formats served by the viewer, including scoped step artifacts. */
export function isExpectedTelescopeFile(filename: string): boolean {
  if (!isSafeArtifactPath(filename)) return false;
  const normalized = toPosixPath(filename);
  const step = /^steps\/\d{4}\/(.+)$/.exec(normalized);
  if (step) {
    return (
      /^(metrics\.json|resources\.json|console\.json|pageload\.har|screenshot\.png|video\.webm)$/.test(
        step[1],
      ) || /^filmstrip\/[a-zA-Z0-9_.-]+\.(jpg|png)$/.test(step[1])
    );
  }
  if (EXPECTED_TELESCOPE_FILES.has(normalized)) return true;
  if (/^baseline\/[a-zA-Z0-9_./-]+\.json$/.test(normalized)) return true;
  if (
    path.posix.dirname(normalized) === '.' &&
    /^[a-zA-Z0-9_.-]+\.webm$/.test(normalized)
  )
    return true;
  return /^filmstrip\/[a-zA-Z0-9_.-]+\.(jpg|png)$/.test(normalized);
}

/** Permit inert generated reports in exports without serving HTML as this origin. */
export function isStorableArtifactPath(filename: string): boolean {
  return (
    isExpectedTelescopeFile(filename) ||
    filename === 'index.html' ||
    /^steps\/\d{4}\/index\.html$/.test(filename)
  );
}

/** Strip a known wrapper and retain viewer-compatible files without executing them. */
export function normalizeAndFilterZipFiles(
  unzipped: Unzipped,
  prefixToStrip: string,
): Unzipped {
  const result: Unzipped = Object.create(null);
  for (const [original, bytes] of Object.entries(unzipped)) {
    if (!original.startsWith(prefixToStrip)) continue;
    const normalized = toPosixPath(original.slice(prefixToStrip.length));
    if (!isSafeArtifactPath(normalized)) throw new Error('Unsafe archive path');
    if (isExpectedTelescopeFile(normalized)) {
      if (Object.hasOwn(result, normalized))
        throw new Error('Duplicate normalized archive path');
      result[normalized] = bytes;
    }
  }
  return result;
}

/**
 * Inspect ZIP central/local headers before inflation. This catches duplicate names
 * (which unzip maps would overwrite), symlinks, encrypted/ZIP64 archives, and bombs.
 */
export function inspectZipArchive(bytes: Uint8Array): void {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error(`ZIP must be between 1 and ${MAX_ARCHIVE_BYTES} bytes`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (
    let offset = bytes.length - 22;
    offset >= Math.max(0, bytes.length - 65_557);
    offset--
  ) {
    if (
      view.getUint32(offset, true) === 0x06054b50 &&
      offset + 22 + view.getUint16(offset + 20, true) === bytes.length
    ) {
      end = offset;
      break;
    }
  }
  if (end < 0) throw new Error('Invalid ZIP end directory');
  const count = view.getUint16(end + 10, true);
  const directorySize = view.getUint32(end + 12, true);
  const directoryOffset = view.getUint32(end + 16, true);
  if (
    view.getUint16(end + 4, true) !== 0 ||
    view.getUint16(end + 6, true) !== 0 ||
    view.getUint16(end + 8, true) !== count
  ) {
    throw new Error('Multi-disk ZIP archives are unsupported');
  }
  if (
    count === 0xffff ||
    directorySize === 0xffffffff ||
    directoryOffset === 0xffffffff
  ) {
    throw new Error(
      'ZIP64 archives require the chunked artifact upload protocol',
    );
  }
  if (
    count < 1 ||
    count > MAX_ARCHIVE_FILES ||
    directoryOffset + directorySize !== end
  ) {
    throw new Error('Invalid ZIP directory or file-count limit exceeded');
  }
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const names = new Set<string>();
  let expanded = 0;
  let offset = directoryOffset;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50)
      throw new Error('Invalid ZIP central header');
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compressed = view.getUint32(offset + 20, true);
    const original = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const external = view.getUint32(offset + 38, true);
    const localOffset = view.getUint32(offset + 42, true);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (next > end || flags & 1 || ![0, 8].includes(method))
      throw new Error('Encrypted or unsupported ZIP entry');
    if (((external >>> 16) & 0xf000) === 0xa000)
      throw new Error('ZIP symlinks are unsupported');
    const name = toPosixPath(
      decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength)),
    );
    const isDirectory = name.endsWith('/');
    const safeName = isDirectory ? name.slice(0, -1) : name;
    if (!isSafeArtifactPath(safeName)) throw new Error('Unsafe archive path');
    const collisionName = safeName.toLowerCase();
    if (names.has(collisionName))
      throw new Error('Duplicate normalized archive path');
    names.add(collisionName);
    expanded += original;
    if (
      expanded > MAX_EXPANDED_BYTES ||
      original === 0xffffffff ||
      compressed === 0xffffffff
    ) {
      throw new Error('ZIP expanded-size limit exceeded');
    }
    if (
      localOffset + 30 > directoryOffset ||
      view.getUint32(localOffset, true) !== 0x04034b50
    )
      throw new Error('Invalid ZIP local header');
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    if (dataOffset + compressed > directoryOffset)
      throw new Error('Invalid ZIP entry bounds');
    const localName = toPosixPath(
      decoder.decode(
        bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength),
      ),
    );
    if (localName !== name) throw new Error('Inconsistent ZIP entry names');
    offset = next;
  }
  if (offset !== end) throw new Error('Invalid ZIP directory size');
}

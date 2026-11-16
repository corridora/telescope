import { z } from 'zod';

import { normalizeCLIConfig } from './config.js';
import { normalizeUrlScheme } from './helpers.js';
import {
  AuthSchema,
  CookiesSchema,
  DelaySchema,
  FirefoxPrefsSchema,
  HeadersSchema,
  OverrideHostSchema,
} from './schemas.js';
import type { CustomDeviceDescriptor, LaunchOptions } from './types.js';

const deviceDescriptorSchema: z.ZodType<CustomDeviceDescriptor> = z.object({
  viewport: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  userAgent: z.string(),
  deviceScaleFactor: z.number().positive(),
  isMobile: z.boolean(),
  hasTouch: z.boolean(),
  defaultBrowserType: z.enum(['chromium', 'firefox', 'webkit']),
});

const localOptionsSchema = z
  .object({
    url: z.string().trim().min(1).max(8192),
    browser: z
      .enum([
        'chrome',
        'chrome-beta',
        'canary',
        'edge',
        'chromium',
        'safari',
        'firefox',
      ])
      .optional(),
    device: z
      .union([z.string().min(1).max(200), deviceDescriptorSchema])
      .optional(),
    deviceName: z.string().min(1).max(200).optional(),
    width: z.number().int().positive().max(8192).optional(),
    height: z.number().int().positive().max(8192).optional(),
    timeout: z.number().int().positive().max(600_000).optional(),
    scriptTimeout: z.number().int().positive().max(3_600_000).optional(),
    frameRate: z.number().int().positive().max(60).optional(),
    connectionType: z
      .union([
        z.literal(false),
        z.enum(['cable', 'dsl', '4g', '3g', '3gfast', '3gslow', '2g', 'fios']),
      ])
      .optional(),
    cpuThrottle: z.number().positive().max(100).optional(),
    headers: HeadersSchema.optional(),
    cookies: CookiesSchema.optional(),
    auth: z.union([AuthSchema, z.literal(false)]).optional(),
    firefoxPrefs: FirefoxPrefsSchema.optional(),
    overrideHost: OverrideHostSchema.optional(),
    delay: DelaySchema.optional(),
    delayUsing: z.enum(['continue', 'fulfill']).optional(),
    block: z.array(z.string().max(2048)).max(100).optional(),
    blockDomains: z.array(z.string().max(253)).max(100).optional(),
    args: z.array(z.string().max(2048)).max(100).optional(),
    disableJS: z.boolean().optional(),
    baseline: z.boolean().optional(),
    userAgent: z.string().max(2048).optional(),
    agentExtra: z.string().max(2048).optional(),
  })
  .strict();

/** Validates browser-facing local options while retaining canonical CLI defaults. */
export function parseLocalOptions(input: unknown): LaunchOptions {
  const parsed = localOptionsSchema.parse(input);
  const normalizedUrl = normalizeUrlScheme(parsed.url);
  const url = new URL(normalizedUrl);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('The target must use HTTP or HTTPS');
  }
  const { args, device, deviceName, ...options } = parsed;
  const config = normalizeCLIConfig({
    ...options,
    url: normalizedUrl,
    flags: args,
    device: typeof device === 'string' ? device : deviceName,
  });
  if (device && typeof device !== 'string') {
    config.device = device;
    if (!parsed.browser)
      config.browser =
        device.defaultBrowserType === 'webkit'
          ? 'safari'
          : device.defaultBrowserType === 'firefox'
            ? 'firefox'
            : 'chrome';
  }
  return config;
}

/** Removes process controls and secrets from reusable definitions and UI snapshots. */
export function reusableLocalOptions(options: LaunchOptions): LaunchOptions {
  const target = new URL(options.url);
  target.username = '';
  target.password = '';
  for (const key of [...target.searchParams.keys()]) {
    if (/(token|secret|password|api[-_]?key)/i.test(key))
      target.searchParams.delete(key);
  }
  const safe: LaunchOptions = { url: target.href };
  const keys = [
    'browser',
    'width',
    'height',
    'timeout',
    'scriptTimeout',
    'frameRate',
    'connectionType',
    'cpuThrottle',
    'firefoxPrefs',
    'overrideHost',
    'delay',
    'delayUsing',
    'block',
    'blockDomains',
    'args',
    'disableJS',
    'baseline',
    'userAgent',
    'agentExtra',
  ] as const;
  for (const key of keys) {
    const value = options[key];
    if (value !== undefined) Object.assign(safe, { [key]: value });
  }
  if (options.headers) {
    safe.headers = Object.fromEntries(
      Object.entries(options.headers).filter(
        ([key]) =>
          !/(authorization|cookie|token|secret|api[-_]?key)/i.test(key),
      ),
    );
  }
  if (options.device) safe.device = options.device;
  if (options.deviceName) safe.deviceName = options.deviceName;
  return safe;
}

/** Masks credentials in captured configuration before returning it to the local UI. */
export function redactLocalConfig(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactLocalConfig);
  if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
    try {
      const target = new URL(value);
      target.username = '';
      target.password = '';
      for (const key of target.searchParams.keys()) {
        if (/(token|secret|password|api[-_]?key)/i.test(key))
          target.searchParams.set(key, '[redacted]');
      }
      return target.href;
    } catch {
      return value;
    }
  }
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      /^(auth|httpCredentials|cookies|env|command|signal|onProgress)$/i.test(
        key,
      ) || /(authorization|cookie|token|secret|password|api[-_]?key)/i.test(key)
        ? '[redacted]'
        : redactLocalConfig(item),
    ]),
  );
}

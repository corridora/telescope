import { Command, Option, InvalidArgumentError } from 'commander';
const program = new Command();
import { BrowserConfig } from './browsers.js';
import { TestRunner } from './testRunner.js';
import { ChromeRunner } from './chromeRunner.js';
import { log, normalizeUrlScheme, isHttpUrl } from './helpers.js';
import { normalizeCLIConfig } from './config.js';
import { DEFAULT_OPTIONS } from './defaultOptions.js';
import {
  PositiveIntSchema,
  PositiveFloatSchema,
  CookiesSchema,
  HeadersSchema,
  AuthSchema,
  FirefoxPrefsSchema,
  OverrideHostSchema,
  DelaySchema,
} from './schemas.js';
import { parseWithSchema, parseCLIOption } from './validation.js';
import { getPackageVersion } from './packageVersion.js';
import type { ZodSchema } from 'zod';

function parseNumeric<T>(schema: ZodSchema<T>, value: string, flag: string): T {
  try {
    return parseWithSchema(schema, value, flag);
  } catch (err) {
    throw new InvalidArgumentError((err as Error).message);
  }
}

function parseJSON<T>(flag: string, value: string, schema: ZodSchema<T>): T {
  try {
    return parseCLIOption(flag, value, schema);
  } catch (err) {
    throw new InvalidArgumentError((err as Error).message);
  }
}

import type {
  LaunchOptions,
  BrowserConfigOptions,
  SuccessfulTestResult,
  FailedTestResult,
  TestResult,
  CLIOptions,
  Cookie,
} from './types.js';

// Re-export types for library consumers
export type {
  LaunchOptions,
  TestResult,
  SuccessfulTestResult,
  FailedTestResult,
  Cookie,
};

export type {
  AgentOptions,
  ArtifactDescriptor,
  ForwardMetadata,
  ForwardingDelivery,
  ForwardingReceipt,
  ForwardingState,
  IdentityManifest,
  LocalDefinition,
  LocalJob,
  LocalJobStatus,
  LocalResultSummary,
  LocalScriptReference,
  LocalServerOptions,
  ResultManifest,
  RunPhase,
  RunProgress,
  RunStatus,
  ScenarioManifest,
  ScenarioStepMedia,
  ScenarioStepResult,
  ScenarioStepStatus,
  ScriptContext,
  ScriptStep,
  ScriptStepKind,
  TestScript,
} from './types.js';

/**
 * Telescope class for programmatic usage.
 * Provides an object-oriented interface to the testing functionality.
 *
 * @example
 * const telescope = new Telescope({ url: 'https://example.com', browser: 'chrome' });
 * const result = await telescope.run();
 */
export class Telescope {
  private options: LaunchOptions;

  constructor(options: LaunchOptions) {
    this.options = options;
  }

  /**
   * Run the test with the configured options.
   * @returns Test result with ID and results path, or error information
   */
  async run(): Promise<TestResult> {
    return launchTest(this.options);
  }
}

/**
 * Get the appropriate runner based on the browser engine
 */
function getRunner(
  options: LaunchOptions,
  browserConfig: BrowserConfigOptions,
): TestRunner {
  if (browserConfig.engine === 'chromium') {
    return new ChromeRunner(options, browserConfig);
  } else {
    return new TestRunner(options, browserConfig);
  }
}

/**
 * Execute a test with raw options.
 * Internal function that handles the core test execution flow.
 * Normalizes options, creates browser instance, runs test, and ensures cleanup.
 *
 * @param options - Test options (raw from CLI or programmatic use)
 * @returns Test result with ID and results path
 * @throws If the test fails
 * @private
 */
async function executeTest(options: LaunchOptions): Promise<TestResult> {
  // Enforce the http(s)-only contract here so it applies to both the CLI
  // and programmatic callers. The CLI normalizes scheme-less inputs to
  // either http:// or https:// (see normalizeUrlScheme; localhost-equivalent
  // hosts default to http://) before reaching this point; programmatic
  // callers must pass a well-formed http(s) URL.
  if (!isHttpUrl(options.url)) {
    throw new Error(
      `Only http:// and https:// URLs are supported (got "${options.url}")`,
    );
  }
  options.signal?.throwIfAborted();
  if (
    options.resultsDir !== undefined &&
    (typeof options.resultsDir !== 'string' || !options.resultsDir.trim())
  ) {
    throw new Error('resultsDir must be a nonempty directory path');
  }
  const config: LaunchOptions = {
    ...DEFAULT_OPTIONS,
    ...options,
    baseline: options.baseline ?? DEFAULT_OPTIONS.baseline,
  };
  if (config.script && config.baseline) {
    throw new Error(
      'Baseline analysis cannot reproduce a scripted session; run it as a separate single-page test',
    );
  }
  if (
    config.scriptTimeout !== undefined &&
    (!Number.isSafeInteger(config.scriptTimeout) || config.scriptTimeout <= 0)
  ) {
    throw new Error('scriptTimeout must be a positive integer');
  }
  const script = config.script
    ? await (await import('./scriptRunner.js')).loadTestScript(config.script)
    : undefined;
  const browserConfig = new BrowserConfig().getBrowserConfig(
    config.browser || 'chrome',
    config,
  );

  if (config.debug) {
    process.env.DEBUG_MODE = 'true';
  }

  log(config);

  const Runner = getRunner(config, browserConfig);
  const abort = (): void => {
    void Runner.closeContext().catch(() => undefined);
  };
  config.signal?.addEventListener('abort', abort, { once: true });
  let executionFailed = false;

  try {
    Runner.reportProgress('validating');
    await Runner.saveConfig();
    await Runner.writeResultManifest('running');

    // Bail out early if we're just doing a dry run
    if (config.dry) {
      await Runner.writeResultManifest('dry');
      await Runner.cleanup();
      Runner.reportProgress('complete');

      return {
        success: true,
        dry: true,
        testId: Runner.TESTID,
        resultsPath: Runner.paths.results,
      };
    }

    config.signal?.throwIfAborted();
    Runner.reportProgress('launching');
    await Runner.setupTest();
    config.signal?.throwIfAborted();
    Runner.reportProgress('running');
    if (script) {
      await (await import('./scriptRunner.js')).executeScript(Runner, script);
    } else {
      await Runner.doNavigation();
    }
    config.signal?.throwIfAborted();
    Runner.reportProgress('finalizing');
    await Runner.postProcess();
    Runner.reportProgress('complete');

    return {
      success: true,
      testId: Runner.TESTID,
      resultsPath: Runner.paths.results,
    };
  } catch (error) {
    executionFailed = true;
    try {
      await Runner.finalizeFailure(error);
    } catch (_finalizationError) {
      // Preserve the original execution error and its capture location.
    }
    return {
      success: false,
      error: config.signal?.aborted
        ? 'Test cancelled'
        : (error as Error).message,
      testId: Runner.TESTID,
      resultsPath: Runner.paths.results,
    };
  } finally {
    config.signal?.removeEventListener('abort', abort);
    try {
      await Runner.cleanup();
    } catch (error) {
      if (!executionFailed) {
        const message = `Capture cleanup failed: ${(error as Error).message}`;
        await Runner.writeResultManifest('failed', message).catch(
          () => undefined,
        );
        return {
          success: false,
          error: message,
          testId: Runner.TESTID,
          resultsPath: Runner.paths.results,
        };
      }
      log('Cleanup failed after execution error: ' + (error as Error).message);
    }
  }
}

/**
 * Run a browser performance test.
 * Public programmatic API that wraps executeTest with error handling.
 * Always returns a result object (never throws).
 *
 * Note: Every outgoing request is tagged with an `x-telescope-id` header so
 * that timing data can be correlated with the correct HAR entry. This header
 * is sent to the target server and is present in the saved HAR file.
 *
 * @param options - Test configuration (see CLI --help for available options)
 * @returns Result object: {success, testId, resultsPath} or {success, error}
 *
 * @example
 * const result = await launchTest({ url: 'https://example.com', browser: 'chrome' });
 * if (result.success) console.log(`Test: ${result.testId}`);
 * else console.error(`Failed: ${result.error}`);
 */
export async function launchTest(options: LaunchOptions): Promise<TestResult> {
  try {
    return await executeTest(options);
  } catch (error) {
    return {
      success: false,
      error: (error as Error).message,
    };
  }
}

export default function browserAgent(): void {
  if (process.argv[2] === 'local' || process.argv[2] === 'agent') {
    void serviceCommand(process.argv[2]).catch(error => {
      console.error((error as Error).message);
      process.exitCode = 1;
    });
    return;
  }
  const pkgVersion = getPackageVersion();

  program
    .name('telescope')
    .description('Cross-browser synthetic testing agent')
    .addHelpText(
      'after',
      '\nServices:\n  telescope local [options]  Run and save tests through a local web UI\n  telescope agent [options]  Connect an outbound execution agent\n\nUse telescope local --help or telescope agent --help for service options.',
    )
    .argument(
      '[url]',
      'URL to run tests against. Can also be provided via -u/--url.',
    )
    .addOption(new Option('-u, --url <url>', 'URL to run tests against'))
    .addOption(
      new Option(
        '--resultsDir <directory>',
        'Persistent results directory',
      ).default(DEFAULT_OPTIONS.resultsDir),
    )
    .addOption(
      new Option('--script <path>', 'Trusted local ESM multi-step script'),
    )
    .addOption(
      new Option(
        '--scriptTimeout <int>',
        'Maximum script execution time in milliseconds',
      ).argParser(value =>
        parseNumeric(PositiveIntSchema, value, '--scriptTimeout'),
      ),
    )
    .version(pkgVersion, '-v, --version', 'Output the package version number')
    .addOption(
      new Option(
        '-b, --browser <browser_name>',
        'Browser to run tests with. Defaults to chrome, or to the device default browser engine if --device is provided.',
      ).choices([
        'chrome',
        'chrome-beta',
        'canary',
        'edge',
        'chromium',
        'safari',
        'firefox',
      ]),
    )
    .addOption(
      new Option(
        '-h, --headers <object>',
        'Any custom headers to apply to requests',
      ).argParser(v => parseJSON('--headers', v, HeadersSchema)),
    )
    .addOption(
      new Option(
        '-c, --cookies <object>',
        'Any custom cookies to apply',
      ).argParser(v => parseJSON('--cookies', v, CookiesSchema)),
    )
    .addOption(
      new Option(
        '-f, --flags <string>',
        'A comma separated list of Chromium flags to launch Chrome with. See: https://peter.sh/experiments/chromium-command-line-switches/',
      ).argParser(v =>
        v.length === 0
          ? []
          : v
              .split(',')
              .map(flag => flag.trim())
              .filter(Boolean),
      ),
    )
    .addOption(
      new Option(
        '--blockDomains <domains...>',
        'A comma separated list of domains to block',
      ),
    )
    .addOption(
      new Option(
        '--block <substrings...>',
        'A comma-delimited list of urls to block (based on a substring match)',
      ),
    )
    .addOption(
      new Option(
        '--delay <object>',
        'An object mapping request regexes to response delays. Example: \'{".css$": 2000, ".js$": 5000}\'',
      ).argParser(v => parseJSON('--delay', v, DelaySchema)),
    )
    .addOption(
      new Option('--delayUsing <string>', 'Method to use to delay responses')
        .default(DEFAULT_OPTIONS.delayUsing)
        .choices(['continue', 'fulfill']),
    )
    .addOption(
      new Option(
        '--firefoxPrefs <object>',
        'Any Firefox User Preferences to apply (Firefox only). Example: \'{"network.trr.mode": 2}\'',
      ).argParser(v => parseJSON('--firefoxPrefs', v, FirefoxPrefsSchema)),
    )
    .addOption(
      new Option('--cpuThrottle <number>', 'CPU throttling factor').argParser(
        v => parseNumeric(PositiveFloatSchema, v, '--cpuThrottle'),
      ),
    )
    .addOption(
      new Option(
        '--connectionType <string>',
        'Network connection type. By default, no throttling is applied.',
      )
        .default(DEFAULT_OPTIONS.connectionType)
        .choices([
          'cable',
          'dsl',
          '4g',
          '3g',
          '3gfast',
          '3gslow',
          '2g',
          'fios',
        ]),
    )
    .addOption(
      new Option(
        '--width <int>',
        'Viewport width, in pixels. If both width and device are provided, the width value will override device emulation viewport width.',
      ).argParser(v => parseNumeric(PositiveIntSchema, v, '--width')),
    )
    .addOption(
      new Option(
        '--height <int>',
        'Viewport height, in pixels. If both height and device are provided, the height value will override device emulation viewport height.',
      ).argParser(v => parseNumeric(PositiveIntSchema, v, '--height')),
    )
    .addOption(
      new Option(
        '--frameRate <int>',
        'Filmstrip frame rate, in frames per second',
      )
        .default(DEFAULT_OPTIONS.frameRate)
        .argParser(v => parseNumeric(PositiveIntSchema, v, '--frameRate')),
    )
    .addOption(
      new Option(
        '--baseline',
        'Run Baseline web platform compatibility analysis',
      ).default(DEFAULT_OPTIONS.baseline),
    )
    .addOption(
      new Option('--disableJS', 'Disable JavaScript').default(
        DEFAULT_OPTIONS.disableJS,
      ),
    )
    .addOption(
      new Option('--debug', 'Output debug lines').default(
        DEFAULT_OPTIONS.debug,
      ),
    )
    .addOption(
      new Option(
        '--auth <object>',
        'Basic HTTP authentication (Expects: {"username": "", "password": ""})',
      )
        .argParser(v => parseJSON('--auth', v, AuthSchema))
        .default(DEFAULT_OPTIONS.auth),
    )
    .addOption(
      new Option(
        '--timeout <int>',
        'Maximum time (in milliseconds) to wait for test to complete',
      )
        .default(DEFAULT_OPTIONS.timeout)
        .argParser(v => parseNumeric(PositiveIntSchema, v, '--timeout')),
    )
    .addOption(
      new Option('--html', 'Generate HTML report').default(
        DEFAULT_OPTIONS.html,
      ),
    )
    .addOption(
      new Option(
        '--openHtml',
        'Open HTML report in browser (requires --html)',
      ).default(DEFAULT_OPTIONS.openHtml),
    )
    .addOption(
      new Option('--list', 'Generate list of results in HTML').default(
        DEFAULT_OPTIONS.list,
      ),
    )
    .addOption(
      new Option(
        '--overrideHost <object>',
        'Override the hostname of a URI with another host (Expects: {"example.com": "example.org"})',
      ).argParser(v => parseJSON('--overrideHost', v, OverrideHostSchema)),
    )
    .addOption(
      new Option(
        '--zip',
        'Zip the results of the test into the results directory.',
      ).default(DEFAULT_OPTIONS.zip),
    )
    .addOption(
      new Option(
        '--uploadUrl <string>',
        'Upload zipped results to URL. Must be a valid URL if provided.',
      ).default(DEFAULT_OPTIONS.uploadUrl),
    )
    .addOption(
      new Option(
        '--dry',
        'Dry run (do not run test, just save config and cleanup)',
      ).default(DEFAULT_OPTIONS.dry),
    )
    .addOption(new Option('--userAgent <string>', 'Set the browser User Agent'))
    .addOption(
      new Option(
        '--agentExtra <string>',
        'Append to the browser User Agent. Takes precedence over --userAgent',
      ),
    )
    .addOption(
      new Option(
        '--device <string>',
        'Device to use for device emulation (viewport size, DPR, touch events). Also sets the default browser engine unless overridden with -b. Devices are based on the Playwright device list (see https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/server/deviceDescriptorsSource.json)',
      ),
    );

  program.parse(process.argv);

  // Show help and exit when invoked with no arguments at all
  // (e.g. `npx @cloudflare/telescope` or bare `telescope`)
  if (process.argv.length <= 2) {
    program.outputHelp();
    process.exit(0);
  }

  const cliOptions = program.opts() as CLIOptions;
  const positionalUrl = program.args[0];

  // Reject duplicate URLs: providing the URL both as a positional argument
  // and via -u/--url is always an error, even if the values are textually
  // identical or normalize to the same URL. There is no good reason to
  // specify it twice, so treat it as a user mistake.
  if (positionalUrl && cliOptions.url) {
    console.error(
      `error: URL provided both as a positional argument ("${positionalUrl}") and via --url ("${cliOptions.url}"). Provide it only once.`,
    );
    process.exit(1);
  }
  const resolvedUrl = positionalUrl ?? cliOptions.url;
  if (!resolvedUrl) {
    console.error(
      "error: missing required URL argument. Use 'telescope --help' for usage.",
    );
    process.exit(1);
  }
  // Auto-prepend a scheme when the URL was provided without one
  // (e.g. `telescope example.com` -> `https://example.com`, or
  // `telescope localhost:3000` -> `http://localhost:3000`; see
  // normalizeUrlScheme for the rules). Reject non-http(s) URLs up front so
  // the user gets a clearer error than the deeper validation in executeTest
  // would produce. CLI-only convenience; programmatic callers (launchTest,
  // Telescope) must provide a well-formed http(s) URL.
  try {
    cliOptions.url = normalizeUrlScheme(resolvedUrl);
  } catch (err) {
    console.error(`error: ${(err as Error).message}`);
    process.exit(1);
  }

  let options: LaunchOptions;

  try {
    options = normalizeCLIConfig(cliOptions);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }

  // Capture the CLI command for repeatability
  if (process.argv.length > 2) {
    options.command = process.argv.slice(2);
  }

  (async () => {
    const result = await launchTest(options);
    if (!result.success) {
      console.error('Test failed:', result.error);
      if (result.resultsPath)
        console.error('Partial results:', result.resultsPath);
      process.exit(1);
    }
  })();
}

/** Starts an installed local workspace or outbound agent without a target URL. */
async function serviceCommand(mode: 'local' | 'agent'): Promise<void> {
  const command = new Command(`telescope ${mode}`);
  if (mode === 'local') {
    command
      .description('Run and save Telescope tests through a local web workspace')
      .option(
        '--host <host>',
        'Listen address (non-loopback requires explicit opt-in)',
        '127.0.0.1',
      )
      .option(
        '--port <number>',
        'Web UI port',
        value => parseNumeric(PositiveIntSchema, value, '--port'),
        4321,
      )
      .option(
        '--resultsDir <directory>',
        'Persistent result library',
        DEFAULT_OPTIONS.resultsDir,
      )
      .option('--no-open', 'Print the UI address without opening a browser');
    command.parse(process.argv.slice(3), { from: 'user' });
    const { startLocalServer } = await import('./localServer.js');
    await startLocalServer(command.opts());
    return;
  }
  command
    .description(
      'Connect an outbound Telescope execution agent to a web instance',
    )
    .requiredOption('--controller <url>', 'Controller URL')
    .requiredOption(
      '--tokenFile <path>',
      'File containing the scoped agent credential',
    )
    .requiredOption(
      '--allowHosts <hosts>',
      'Comma-separated allowed target hostnames',
      value =>
        value
          .split(',')
          .map((host: string) => host.trim())
          .filter(Boolean),
    )
    .option(
      '--spoolDir <directory>',
      'Private pending-delivery storage directory',
    )
    .option('--name <name>', 'Agent display name')
    .option(
      '--allowInsecureHttp',
      'Explicitly allow a private development controller over HTTP',
    )
    .option(
      '--pollInterval <milliseconds>',
      'Polling interval',
      value => parseNumeric(PositiveIntSchema, value, '--pollInterval'),
      3000,
    );
  command.parse(process.argv.slice(3), { from: 'user' });
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    const { startAgent } = await import('./agent.js');
    const opts = command.opts<import('./types.js').AgentOptions>();
    await startAgent({ ...opts, signal: controller.signal });
  } finally {
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
  }
}

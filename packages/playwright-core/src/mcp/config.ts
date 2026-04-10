/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import fs from 'fs';
import os from 'os';

import { dotenv } from '../utilsBundle';

import { configFromIniFile } from './configIni';

import type * as playwright from '../..';
import type { Config, ToolCapability } from './config.d';

async function fileExistsAsync(resolved: string) {
  try { return (await fs.promises.stat(resolved)).isFile(); } catch { return false; }
}

type ViewportSize = { width: number; height: number };

export type CLIOptions = {
  allowedHosts?: string[];
  allowedOrigins?: string[];
  allowUnrestrictedFileAccess?: boolean;
  blockedOrigins?: string[];
  blockServiceWorkers?: boolean;
  browser?: string;
  caps?: string[];
  cdpEndpoint?: string;
  cdpHeader?: Record<string, string>;
  cdpTimeout?: number;
  codegen?: 'typescript' | 'none';
  config?: string;
  consoleLevel?: 'error' | 'warning' | 'info' | 'debug';
  consoleExcludePatterns?: string[];
  consoleMaxEvents?: number;
  extension?: boolean;
  executablePath?: string;
  grantPermissions?: string[];
  headless?: boolean;
  host?: string;
  ignoreHttpsErrors?: boolean;
  initScript?: string[];
  initPage?: string[];
  isolated?: boolean;
  imageResponses?: 'allow' | 'omit';
  sandbox?: boolean;
  outputDir?: string;
  downloadsPath?: string;
  outputMode?: 'file' | 'stdout';
  port?: number;
  proxyBypass?: string;
  proxyServer?: string;
  saveSession?: boolean;
  secrets?: Record<string, string>;
  sharedBrowserContext?: boolean;
  snapshotMode?: 'incremental' | 'full' | 'none';
  storageState?: string;
  testIdAttribute?: string;
  timeoutAction?: number;
  timeoutNavigation?: number;
  userAgent?: string;
  userDataDir?: string;
  viewportSize?: ViewportSize;
};

export const defaultConfig: FullConfig = {
  browser: {
    browserName: 'chromium',
    launchOptions: {
      channel: 'chrome',
      headless: os.platform() === 'linux' && !process.env.DISPLAY,
    },
    contextOptions: {
      viewport: null,
    },
    isolated: false,
  },
  server: {},
  timeouts: {
    budget: { default: 5000, navigate: 15000, runCode: 30000 },
    playwright: { action: 5000, navigation: 30000, expect: 5000 },
    infrastructure: { bridgeBuffer: 5000 },
  },
  performance: {
    postActionDelay: 30,
    postSettlementDelay: 10,
    networkRaceTimeout: 3000,
    navigationLoadState: 'domcontentloaded' as const,
    navigationLoadTimeout: 5000,
    postNavigateLoadState: 'domcontentloaded' as const,
    postNavigateLoadTimeout: 3000,
    waitFastPollInterval: 200,
    waitFastPollRetries: 5,
    waitDefaultTimeout: 3000,
    waitMaxTimeout: 30000,
  },
  snapshot: {
    settleMode: 'quick' as const,
    settleQuietMs: 150,
    gatesEnabled: true,
    gateTimeoutMs: 2000,
    waitForTimeout: 3000,
  },
};

type BrowserUserConfig = NonNullable<Config['browser']>;

export type FullConfig = Config & {
  browser: Omit<BrowserUserConfig, 'browserName' | 'launchOptions' | 'contextOptions'> & {
    browserName: 'chromium';
    launchOptions: NonNullable<BrowserUserConfig['launchOptions']>;
    contextOptions: NonNullable<BrowserUserConfig['contextOptions']>;
  },
  server?: Config['server'],
  skillMode?: boolean;
  configFile?: string;
};

export async function resolveConfig(config: Config): Promise<FullConfig> {
  const result = mergeConfig(defaultConfig, config);
  await validateConfig(result);
  return result;
}

export async function resolveCLIConfig(cliOptions: CLIOptions): Promise<FullConfig> {
  const envOverrides = configFromEnv();
  const cliOverrides = configFromCLIOptions(cliOptions);
  const configFile = cliOverrides.configFile ?? envOverrides.configFile;
  const configInFile = await loadConfig(configFile);

  let result = defaultConfig;
  result = mergeConfig(result, configInFile);
  result = mergeConfig(result, envOverrides);
  result = mergeConfig(result, cliOverrides);
  result.configFile = configFile;
  await validateConfig(result);
  return result;
}

export async function validateConfig(config: FullConfig): Promise<void> {
  if (config.browser.browserName === 'chromium' && config.browser.launchOptions.chromiumSandbox === undefined) {
    if (process.platform === 'linux')
      config.browser.launchOptions.chromiumSandbox = config.browser.launchOptions.channel !== 'chromium' && config.browser.launchOptions.channel !== 'chrome-for-testing';
    else
      config.browser.launchOptions.chromiumSandbox = true;
  }

  if (config.browser.initScript) {
    for (const script of config.browser.initScript) {
      if (!await fileExistsAsync(script))
        throw new Error(`Init script file does not exist: ${script}`);
    }
  }
  if (config.browser.initPage) {
    for (const page of config.browser.initPage) {
      if (!await fileExistsAsync(page))
        throw new Error(`Init page file does not exist: ${page}`);
    }
  }

  if (config.relay) {
    const missing: string[] = [];
    if (config.relay.maxConcurrentClients == null) missing.push('relay.maxConcurrentClients');
    if (config.relay.sessionGraceTTL == null) missing.push('relay.sessionGraceTTL');
    if (config.relay.backendDisposalTTL == null) missing.push('relay.backendDisposalTTL');
    if (missing.length > 0)
      throw new Error(`Missing required relay config: ${missing.join(', ')}. All relay fields are required in playwright-mcp.json.`);
  }

  // Timeout cascade validation — budget must accommodate inner timeouts
  const b = config.timeouts?.budget;
  const p = config.timeouts?.playwright;
  if (b && p) {
    const violations: string[] = [];
    if (b.default != null && b.default <= 0)
      violations.push(`budget.default must be positive, got ${b.default}ms.`);
    if (b.default != null && b.navigate != null && b.navigate < b.default)
      violations.push(`budget.navigate (${b.navigate}ms) < budget.default (${b.default}ms).`);
    if (b.default != null && b.runCode != null && b.runCode < b.default)
      violations.push(`budget.runCode (${b.runCode}ms) < budget.default (${b.default}ms).`);
    if (p.action != null && b.default != null && p.action > b.default * 2)
      violations.push(`playwright.action (${p.action}ms) > 2x budget.default (${b.default}ms).`);
    if (p.navigation != null && b.navigate != null && p.navigation > b.navigate * 2)
      violations.push(`playwright.navigation (${p.navigation}ms) > 2x budget.navigate (${b.navigate}ms).`);
    if (config.timeouts?.infrastructure?.bridgeBuffer != null && config.timeouts.infrastructure.bridgeBuffer < 3000)
      violations.push(`infrastructure.bridgeBuffer (${config.timeouts.infrastructure.bridgeBuffer}ms) < 3000ms minimum.`);
    if (violations.length > 0)
      throw new Error(`Timeout cascade violation:\n${violations.join('\n')}`);
  }
}

export function configFromCLIOptions(cliOptions: CLIOptions): Config & { configFile?: string } {
  let browserName: 'chromium' | undefined;
  let channel: string | undefined;
  switch (cliOptions.browser) {
    case 'chrome':
    case 'chrome-beta':
    case 'chrome-canary':
    case 'chrome-dev':
    case 'msedge':
    case 'msedge-beta':
    case 'msedge-canary':
    case 'msedge-dev':
      browserName = 'chromium';
      channel = cliOptions.browser;
      break;
    case 'chromium':
      // Never use old headless.
      browserName = 'chromium';
      channel = 'chrome-for-testing';
      break;
  }

  // Launch options
  const launchOptions: playwright.LaunchOptions = {
    channel,
    executablePath: cliOptions.executablePath,
    headless: cliOptions.headless,
  };

  // --sandbox was passed, enable the sandbox
  // --no-sandbox was passed, disable the sandbox
  if (cliOptions.sandbox !== undefined)
    launchOptions.chromiumSandbox = cliOptions.sandbox;

  if (cliOptions.proxyServer) {
    launchOptions.proxy = {
      server: cliOptions.proxyServer
    };
    if (cliOptions.proxyBypass)
      launchOptions.proxy.bypass = cliOptions.proxyBypass;
  }

  // Context options
  const contextOptions: playwright.BrowserContextOptions = {};
  if (cliOptions.storageState)
    contextOptions.storageState = cliOptions.storageState;

  if (cliOptions.userAgent)
    contextOptions.userAgent = cliOptions.userAgent;

  if (cliOptions.viewportSize)
    contextOptions.viewport = cliOptions.viewportSize;

  if (cliOptions.ignoreHttpsErrors)
    contextOptions.ignoreHTTPSErrors = true;

  if (cliOptions.blockServiceWorkers)
    contextOptions.serviceWorkers = 'block';

  if (cliOptions.grantPermissions)
    contextOptions.permissions = cliOptions.grantPermissions;

  const config: Config = {
    browser: {
      browserName,
      isolated: cliOptions.isolated,
      userDataDir: cliOptions.userDataDir,
      launchOptions,
      contextOptions,
      cdpEndpoint: cliOptions.cdpEndpoint,
      cdpHeaders: cliOptions.cdpHeader,
      cdpTimeout: cliOptions.cdpTimeout,
      initPage: cliOptions.initPage,
      initScript: cliOptions.initScript,
    },
    extension: cliOptions.extension,
    server: {
      port: cliOptions.port,
      host: cliOptions.host,
      allowedHosts: cliOptions.allowedHosts,
    },
    capabilities: cliOptions.caps as ToolCapability[],
    console: {
      level: cliOptions.consoleLevel,
      excludePatterns: cliOptions.consoleExcludePatterns,
      maxEvents: cliOptions.consoleMaxEvents,
    },
    network: {
      allowedOrigins: cliOptions.allowedOrigins,
      blockedOrigins: cliOptions.blockedOrigins,
    },
    allowUnrestrictedFileAccess: cliOptions.allowUnrestrictedFileAccess,
    codegen: cliOptions.codegen,
    saveSession: cliOptions.saveSession,
    secrets: cliOptions.secrets,
    sharedBrowserContext: cliOptions.sharedBrowserContext,
    snapshot: cliOptions.snapshotMode ? { mode: cliOptions.snapshotMode } : undefined,
    outputMode: cliOptions.outputMode,
    outputDir: cliOptions.outputDir,
    downloadsPath: cliOptions.downloadsPath,
    imageResponses: cliOptions.imageResponses,
    testIdAttribute: cliOptions.testIdAttribute,
    timeouts: {
      playwright: {
        action: cliOptions.timeoutAction,
        navigation: cliOptions.timeoutNavigation,
      },
    },
  };

  return { ...config, configFile: cliOptions.config };
}

export function configFromEnv(): Config & { configFile?: string } {
  const options: CLIOptions = {};
  options.allowedHosts = commaSeparatedList(process.env.PLAYWRIGHT_MCP_ALLOWED_HOSTS);
  options.allowedOrigins = semicolonSeparatedList(process.env.PLAYWRIGHT_MCP_ALLOWED_ORIGINS);
  options.allowUnrestrictedFileAccess = envToBoolean(process.env.PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS);
  options.blockedOrigins = semicolonSeparatedList(process.env.PLAYWRIGHT_MCP_BLOCKED_ORIGINS);
  options.blockServiceWorkers = envToBoolean(process.env.PLAYWRIGHT_MCP_BLOCK_SERVICE_WORKERS);
  options.browser = envToString(process.env.PLAYWRIGHT_MCP_BROWSER);
  options.caps = commaSeparatedList(process.env.PLAYWRIGHT_MCP_CAPS);
  options.cdpEndpoint = envToString(process.env.PLAYWRIGHT_MCP_CDP_ENDPOINT);
  options.cdpHeader = headerParser(process.env.PLAYWRIGHT_MCP_CDP_HEADERS, {});
  options.cdpTimeout = numberParser(process.env.PLAYWRIGHT_MCP_CDP_TIMEOUT);
  options.config = envToString(process.env.PLAYWRIGHT_MCP_CONFIG);
  if (process.env.PLAYWRIGHT_MCP_CONSOLE_LEVEL)
    options.consoleLevel = enumParser<'error' | 'warning' | 'info' | 'debug'>('--console-level', ['error', 'warning', 'info', 'debug'], process.env.PLAYWRIGHT_MCP_CONSOLE_LEVEL);
  options.consoleExcludePatterns = commaSeparatedList(process.env.PLAYWRIGHT_MCP_CONSOLE_EXCLUDE_PATTERNS);
  options.consoleMaxEvents = numberParser(process.env.PLAYWRIGHT_MCP_CONSOLE_MAX_EVENTS);
  options.executablePath = envToString(process.env.PLAYWRIGHT_MCP_EXECUTABLE_PATH);
  options.extension = envToBoolean(process.env.PLAYWRIGHT_MCP_EXTENSION);
  options.grantPermissions = commaSeparatedList(process.env.PLAYWRIGHT_MCP_GRANT_PERMISSIONS);
  options.headless = envToBoolean(process.env.PLAYWRIGHT_MCP_HEADLESS);
  options.host = envToString(process.env.PLAYWRIGHT_MCP_HOST);
  options.ignoreHttpsErrors = envToBoolean(process.env.PLAYWRIGHT_MCP_IGNORE_HTTPS_ERRORS);
  const initPage = envToString(process.env.PLAYWRIGHT_MCP_INIT_PAGE);
  if (initPage)
    options.initPage = [initPage];
  const initScript = envToString(process.env.PLAYWRIGHT_MCP_INIT_SCRIPT);
  if (initScript)
    options.initScript = [initScript];
  options.isolated = envToBoolean(process.env.PLAYWRIGHT_MCP_ISOLATED);
  if (process.env.PLAYWRIGHT_MCP_IMAGE_RESPONSES)
    options.imageResponses = enumParser<'allow' | 'omit'>('--image-responses', ['allow', 'omit'], process.env.PLAYWRIGHT_MCP_IMAGE_RESPONSES);
  options.sandbox = envToBoolean(process.env.PLAYWRIGHT_MCP_SANDBOX);
  options.outputDir = envToString(process.env.PLAYWRIGHT_MCP_OUTPUT_DIR);
  options.downloadsPath = envToString(process.env.PLAYWRIGHT_MCP_DOWNLOADS_PATH);
  options.port = numberParser(process.env.PLAYWRIGHT_MCP_PORT);
  options.proxyBypass = envToString(process.env.PLAYWRIGHT_MCP_PROXY_BYPASS);
  options.proxyServer = envToString(process.env.PLAYWRIGHT_MCP_PROXY_SERVER);
  options.secrets = dotenvFileLoader(process.env.PLAYWRIGHT_MCP_SECRETS_FILE);
  options.storageState = envToString(process.env.PLAYWRIGHT_MCP_STORAGE_STATE);
  options.testIdAttribute = envToString(process.env.PLAYWRIGHT_MCP_TEST_ID_ATTRIBUTE);
  options.timeoutAction = numberParser(process.env.PLAYWRIGHT_MCP_TIMEOUT_ACTION);
  options.timeoutNavigation = numberParser(process.env.PLAYWRIGHT_MCP_TIMEOUT_NAVIGATION);
  options.userAgent = envToString(process.env.PLAYWRIGHT_MCP_USER_AGENT);
  options.userDataDir = envToString(process.env.PLAYWRIGHT_MCP_USER_DATA_DIR);
  options.viewportSize = resolutionParser('--viewport-size', process.env.PLAYWRIGHT_MCP_VIEWPORT_SIZE);
  const config = configFromCLIOptions(options);

  // Snapshot env var overrides (not routed through CLIOptions)
  const snapshotMaxChars = numberParser(process.env.PLAYWRIGHT_MCP_SNAPSHOT_MAX_CHARS);
  if (snapshotMaxChars !== undefined)
    config.snapshot = { ...config.snapshot, maxChars: snapshotMaxChars };
  const snapshotInteractableOnly = envToBoolean(process.env.PLAYWRIGHT_MCP_SNAPSHOT_INTERACTABLE_ONLY);
  if (snapshotInteractableOnly !== undefined)
    config.snapshot = { ...config.snapshot, interactableOnly: snapshotInteractableOnly };
  const snapshotSettleMode = process.env.PLAYWRIGHT_MCP_SNAPSHOT_SETTLE_MODE;
  if (snapshotSettleMode !== undefined)
    config.snapshot = { ...config.snapshot, settleMode: enumParser<'none' | 'quick' | 'thorough'>('--snapshot-settle-mode', ['none', 'quick', 'thorough'], snapshotSettleMode) };
  const snapshotSettleQuietMs = numberParser(process.env.PLAYWRIGHT_MCP_SNAPSHOT_SETTLE_QUIET_MS);
  if (snapshotSettleQuietMs !== undefined)
    config.snapshot = { ...config.snapshot, settleQuietMs: snapshotSettleQuietMs };
  const snapshotGatesEnabled = envToBoolean(process.env.PLAYWRIGHT_MCP_SNAPSHOT_GATES_ENABLED);
  if (snapshotGatesEnabled !== undefined)
    config.snapshot = { ...config.snapshot, gatesEnabled: snapshotGatesEnabled };
  const snapshotGateTimeoutMs = numberParser(process.env.PLAYWRIGHT_MCP_SNAPSHOT_GATE_TIMEOUT_MS);
  if (snapshotGateTimeoutMs !== undefined)
    config.snapshot = { ...config.snapshot, gateTimeoutMs: snapshotGateTimeoutMs };
  const snapshotWaitForTimeout = numberParser(process.env.PLAYWRIGHT_MCP_SNAPSHOT_WAIT_FOR_TIMEOUT);
  if (snapshotWaitForTimeout !== undefined)
    config.snapshot = { ...config.snapshot, waitForTimeout: snapshotWaitForTimeout };
  const snapshotIncludeUrls = envToBoolean(process.env.PLAYWRIGHT_MCP_SNAPSHOT_INCLUDE_URLS);
  if (snapshotIncludeUrls !== undefined)
    config.snapshot = { ...config.snapshot, includeUrls: snapshotIncludeUrls };

  // Evaluate env var overrides
  const evalMaxResultLength = numberParser(process.env.PLAYWRIGHT_MCP_EVAL_MAX_RESULT_LENGTH);
  if (evalMaxResultLength !== undefined)
    config.evaluate = { ...config.evaluate, maxResultLength: evalMaxResultLength };

  // maxResponseChars env var override
  const maxResponseChars = numberParser(process.env.PLAYWRIGHT_MCP_MAX_RESPONSE_CHARS);
  if (maxResponseChars !== undefined)
    config.maxResponseChars = maxResponseChars;

  // Performance env var overrides (not routed through CLIOptions)
  const perfOverrides: NonNullable<Config['performance']> = {};
  const perfPostAction = numberParser(process.env.PLAYWRIGHT_MCP_PERF_POST_ACTION_DELAY);
  if (perfPostAction !== undefined) perfOverrides.postActionDelay = perfPostAction;
  const perfPostSettlement = numberParser(process.env.PLAYWRIGHT_MCP_PERF_POST_SETTLEMENT_DELAY);
  if (perfPostSettlement !== undefined) perfOverrides.postSettlementDelay = perfPostSettlement;
  const perfNetworkRace = numberParser(process.env.PLAYWRIGHT_MCP_PERF_NETWORK_RACE_TIMEOUT);
  if (perfNetworkRace !== undefined) perfOverrides.networkRaceTimeout = perfNetworkRace;
  const perfNavLoadState = envToString(process.env.PLAYWRIGHT_MCP_PERF_NAV_LOAD_STATE);
  if (perfNavLoadState === 'load' || perfNavLoadState === 'domcontentloaded')
    perfOverrides.navigationLoadState = perfNavLoadState;
  const perfNavLoadTimeout = numberParser(process.env.PLAYWRIGHT_MCP_PERF_NAV_LOAD_TIMEOUT);
  if (perfNavLoadTimeout !== undefined) perfOverrides.navigationLoadTimeout = perfNavLoadTimeout;
  const perfPostNavLoadState = envToString(process.env.PLAYWRIGHT_MCP_PERF_POST_NAV_LOAD_STATE);
  if (perfPostNavLoadState === 'load' || perfPostNavLoadState === 'domcontentloaded')
    perfOverrides.postNavigateLoadState = perfPostNavLoadState;
  const perfPostNavLoadTimeout = numberParser(process.env.PLAYWRIGHT_MCP_PERF_POST_NAV_LOAD_TIMEOUT);
  if (perfPostNavLoadTimeout !== undefined) perfOverrides.postNavigateLoadTimeout = perfPostNavLoadTimeout;
  const perfWaitFastPollInterval = numberParser(process.env.PLAYWRIGHT_MCP_PERF_WAIT_FAST_POLL_INTERVAL);
  if (perfWaitFastPollInterval !== undefined) perfOverrides.waitFastPollInterval = perfWaitFastPollInterval;
  const perfWaitFastPollRetries = numberParser(process.env.PLAYWRIGHT_MCP_PERF_WAIT_FAST_POLL_RETRIES);
  if (perfWaitFastPollRetries !== undefined) perfOverrides.waitFastPollRetries = perfWaitFastPollRetries;
  const perfWaitDefaultTimeout = numberParser(process.env.PLAYWRIGHT_MCP_PERF_WAIT_DEFAULT_TIMEOUT);
  if (perfWaitDefaultTimeout !== undefined) perfOverrides.waitDefaultTimeout = perfWaitDefaultTimeout;
  const perfWaitMaxTimeout = numberParser(process.env.PLAYWRIGHT_MCP_PERF_WAIT_MAX_TIMEOUT);
  if (perfWaitMaxTimeout !== undefined) perfOverrides.waitMaxTimeout = perfWaitMaxTimeout;
  if (Object.keys(perfOverrides).length > 0)
    config.performance = { ...config.performance, ...perfOverrides };

  return config;
}

export async function loadConfig(configFile: string | undefined): Promise<Config> {
  if (!configFile)
    return {};

  if (configFile.endsWith('.ini'))
    return configFromIniFile(configFile);

  try {
    const data = await fs.promises.readFile(configFile, 'utf8');
    return JSON.parse(data.charCodeAt(0) === 0xFEFF ? data.slice(1) : data);
  } catch {
    return configFromIniFile(configFile);
  }
}

function pickDefined<T extends object>(obj: T | undefined): Partial<T> {
  return Object.fromEntries(
      Object.entries(obj ?? {}).filter(([_, v]) => v !== undefined)
  ) as Partial<T>;
}

export function mergeConfig(base: FullConfig, overrides: Config): FullConfig {
  const browser: FullConfig['browser'] = {
    ...pickDefined(base.browser),
    ...pickDefined(overrides.browser),
    browserName: overrides.browser?.browserName ?? base.browser?.browserName ?? 'chromium',
    isolated: overrides.browser?.isolated ?? base.browser?.isolated ?? false,
    launchOptions: {
      ...pickDefined(base.browser?.launchOptions),
      ...pickDefined(overrides.browser?.launchOptions),
      ...{ assistantMode: true },
    },
    contextOptions: {
      ...pickDefined(base.browser?.contextOptions),
      ...pickDefined(overrides.browser?.contextOptions),
    },
  };

  return {
    ...pickDefined(base),
    ...pickDefined(overrides),
    browser,
    console: {
      ...pickDefined(base.console),
      ...pickDefined(overrides.console),
    },
    evaluate: {
      ...pickDefined(base.evaluate),
      ...pickDefined(overrides.evaluate),
    },
    network: {
      ...pickDefined(base.network),
      ...pickDefined(overrides.network),
    },
    server: {
      ...pickDefined(base.server),
      ...pickDefined(overrides.server),
    },
    snapshot: {
      ...pickDefined(base.snapshot),
      ...pickDefined(overrides.snapshot),
    },
    timeouts: {
      budget: {
        ...pickDefined(base.timeouts?.budget),
        ...pickDefined(overrides.timeouts?.budget),
      },
      playwright: {
        ...pickDefined(base.timeouts?.playwright),
        ...pickDefined(overrides.timeouts?.playwright),
      },
      infrastructure: {
        ...pickDefined(base.timeouts?.infrastructure),
        ...pickDefined(overrides.timeouts?.infrastructure),
      },
    },
    performance: {
      ...pickDefined(base.performance),
      ...pickDefined(overrides.performance),
    },
    logging: {
      ...pickDefined(base.logging),
      ...pickDefined(overrides.logging),
    },
    relay: {
      ...pickDefined(base.relay),
      ...pickDefined(overrides.relay),
    },
  } as FullConfig;
}

export function semicolonSeparatedList(value: string | undefined): string[] | undefined {
  if (!value)
    return undefined;
  return value.split(';').map(v => v.trim());
}

export function commaSeparatedList(value: string | undefined): string[] | undefined {
  if (!value)
    return undefined;
  return value.split(',').map(v => v.trim());
}

export function dotenvFileLoader(value: string | undefined): Record<string, string> | undefined {
  if (!value)
    return undefined;
  return dotenv.parse(fs.readFileSync(value, 'utf8'));
}

export function numberParser(value: string | undefined): number | undefined {
  if (!value)
    return undefined;
  return +value;
}

export function resolutionParser(name: string, value: string | undefined): ViewportSize | undefined {
  if (!value)
    return undefined;
  if (value.includes('x')) {
    const [width, height] = value.split('x').map(v => +v);
    if (isNaN(width) || isNaN(height) || width <= 0 || height <= 0)
      throw new Error(`Invalid resolution format: use ${name}="800x600"`);
    return { width, height };
  }

  // Legacy format
  if (value.includes(',')) {
    const [width, height] = value.split(',').map(v => +v);
    if (isNaN(width) || isNaN(height) || width <= 0 || height <= 0)
      throw new Error(`Invalid resolution format: use ${name}="800x600"`);
    return { width, height };
  }

  throw new Error(`Invalid resolution format: use ${name}="800x600"`);
}

export function headerParser(arg: string | undefined, previous?: Record<string, string>): Record<string, string> {
  if (!arg)
    return previous || {};
  const result: Record<string, string> = previous || {};
  const [name, value] = arg.split(':').map(v => v.trim());
  result[name] = value;
  return result;
}

export function enumParser<T extends string>(name: string, options: T[], value: string): T {
  if (!options.includes(value as T))
    throw new Error(`Invalid ${name}: ${value}. Valid values are: ${options.join(', ')}`);
  return value as T;
}

function envToBoolean(value: string | undefined): boolean | undefined {
  if (value === 'true' || value === '1')
    return true;
  if (value === 'false' || value === '0')
    return false;
  return undefined;
}

function envToString(value: string | undefined): string | undefined {
  return value ? value.trim() : undefined;
}


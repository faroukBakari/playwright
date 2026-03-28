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

import type * as playwright from '../..';

export type ToolCapability =
  'config' |
  'core' |
  'core-navigation' |
  'core-tabs' |
  'core-input' |
  'core-install' |
  'network' |
  'pdf' |
  'storage' |
  'testing' |
  'vision' |
  'devtools' |
  'downloads';

export type Config = {
  /**
   * The browser to use.
   */
  browser?: {
    /**
     * The type of browser to use.
     */
    browserName?: 'chromium' | 'firefox' | 'webkit';

    /**
     * Keep the browser profile in memory, do not save it to disk.
     */
    isolated?: boolean;

    /**
     * Path to a user data directory for browser profile persistence.
     * Temporary directory is created by default.
     */
    userDataDir?: string;

    /**
     * Launch options passed to
     * @see https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context
     *
     * This is useful for settings options like `channel`, `headless`, `executablePath`, etc.
     */
    launchOptions?: playwright.LaunchOptions;

    /**
     * Context options for the browser context.
     *
     * This is useful for settings options like `viewport`.
     */
    contextOptions?: playwright.BrowserContextOptions;

    /**
     * Chrome DevTools Protocol endpoint to connect to an existing browser instance in case of Chromium family browsers.
     */
    cdpEndpoint?: string;

    /**
     * CDP headers to send with the connect request.
     */
    cdpHeaders?: Record<string, string>;

    /**
     * Timeout in milliseconds for connecting to CDP endpoint. Defaults to 30000 (30 seconds). Pass 0 to disable timeout.
     */
    cdpTimeout?: number;

    /**
     * Remote endpoint to connect to an existing Playwright server.
     */
    remoteEndpoint?: string;

    /**
     * Paths to TypeScript files to add as initialization scripts for Playwright page.
     */
    initPage?: string[];

    /**
     * Paths to JavaScript files to add as initialization scripts.
     * The scripts will be evaluated in every page before any of the page's scripts.
     */
    initScript?: string[];
  },

  /**
   * Connect to a running browser instance (Edge/Chrome only). If specified, `browser`
   * config is ignored.
   * Requires the "Playwright MCP Bridge" browser extension to be installed.
   */
  extension?: boolean;

  server?: {
    /**
     * The port to listen on for SSE or MCP transport.
     */
    port?: number;

    /**
     * The host to bind the server to. Default is localhost. Use 0.0.0.0 to bind to all interfaces.
     */
    host?: string;

    /**
     * The hosts this server is allowed to serve from. Defaults to the host server is bound to.
     * This is not for CORS, but rather for the DNS rebinding protection.
     */
    allowedHosts?: string[];
  },

  /**
   * List of enabled tool capabilities. Possible values:
   *   - 'core': Core browser automation features.
   *   - 'pdf': PDF generation and manipulation.
   *   - 'vision': Coordinate-based interactions.
   *   - 'devtools': Developer tools features.
   */
  capabilities?: ToolCapability[];

  /**
   * Whether to save the Playwright session into the output directory.
   */
  saveSession?: boolean;

  /**
   * Reuse the same browser context between all connected HTTP clients.
   */
  sharedBrowserContext?: boolean;

  /**
   * Secrets are used to prevent LLM from getting sensitive data while
   * automating scenarios such as authentication.
   * Prefer the browser.contextOptions.storageState over secrets file as a more secure alternative.
   */
  secrets?: Record<string, string>;

  /**
   * The directory to save output files.
   */
  outputDir?: string;

  /**
   * The directory where the browser process saves downloaded files.
   * Must be a path the browser can access (e.g., a Windows path when
   * Chrome runs on Windows). The server passes this value opaquely
   * to the browser — no format conversion is applied.
   */
  downloadsPath?: string;

  /**
   * Whether to save snapshots, console messages, network logs and other session logs to a file or to the standard output. Defaults to "stdout".
   */
  outputMode?: 'file' | 'stdout';

  console?: {
    /**
     * The level of console messages to return. Each level includes the messages of more severe levels. Defaults to "info".
     */
    level?: 'error' | 'warning' | 'info' | 'debug';
    /**
     * URL prefix patterns to exclude from console output. Messages whose source URL
     * starts with any of these prefixes are dropped before reaching the Events section.
     * Defaults to ["chrome-extension://"].
     */
    excludePatterns?: string[];
    /**
     * Maximum number of console lines in the Events section of tool responses.
     * When exceeded, only the last N lines are kept and a summary line is prepended.
     * Defaults to 50.
     */
    maxEvents?: number;
  },

  network?: {
    /**
     * List of origins to allow the browser to request. Default is to allow all. Origins matching both `allowedOrigins` and `blockedOrigins` will be blocked.
     *
     * Supported formats:
     * - Full origin: `https://example.com:8080` - matches only that origin
     * - Wildcard port: `http://localhost:*` - matches any port on localhost with http protocol
     */
    allowedOrigins?: string[];

    /**
     * List of origins to block the browser to request. Origins matching both `allowedOrigins` and `blockedOrigins` will be blocked.
     *
     * Supported formats:
     * - Full origin: `https://example.com:8080` - matches only that origin
     * - Wildcard port: `http://localhost:*` - matches any port on localhost with http protocol
     */
    blockedOrigins?: string[];
  };

  /**
   * Specify the attribute to use for test ids, defaults to "data-testid".
   */
  testIdAttribute?: string;

  /**
   * Unified timeout matrix for deadline propagation framework.
   * Budget = per-call dispatch timeout, Playwright = inner action ceilings,
   * Infrastructure = bridge/extension-level headroom.
   * Settle timeouts live in `performance.*` and are resolved into the matrix at load time.
   */
  timeouts?: {
    /** Per-call budget: total time allocated for a tool invocation. */
    budget?: {
      /** Default budget for readOnly/input/action/assertion tools (ms). Default: 5000 */
      default?: number;
      /** Budget for navigation tools (ms). Default: 15000 */
      navigate?: number;
      /** Budget for browser_run_code (ms). Default: 30000 */
      runCode?: number;
    };
    /** Playwright inner timeouts — ceilings within the budget. */
    playwright?: {
      /** Locator action timeout (ms). Default: 5000 */
      action?: number;
      /** Page navigation timeout (ms). Default: 60000 */
      navigation?: number;
      /** Expect/assertion timeout (ms). Default: 5000 */
      expect?: number;
    };
    /** Infrastructure-level timeouts (bridge, extension). */
    infrastructure?: {
      /** Bridge HTTP timeout buffer above max budget (ms). Default: 5000 */
      bridgeBuffer?: number;
    };
  };

  /**
   * Whether to send image responses to the client. Can be "allow", "omit", or "auto". Defaults to "auto", which sends images if the client can display them.
   */
  imageResponses?: 'allow' | 'omit';

  snapshot?: {
    /**
     * When taking snapshots for responses, specifies the mode to use.
     */
    mode?: 'incremental' | 'full' | 'none';

    /**
     * Maximum character count for snapshot text in responses. Snapshots exceeding
     * this limit are truncated with a footer indicating the original size.
     * Undefined means no limit.
     */
    maxChars?: number;

    /**
     * When true, snapshots only include interactable elements and their ancestor
     * containers. Non-interactive text nodes, decorative elements, and layout
     * containers are filtered out. Reduces snapshot size by 50-80% on complex pages.
     */
    interactableOnly?: boolean;

    /**
     * Settling strategy before snapshot capture.
     * - 'none' (T0): no settling — immediate snapshot
     * - 'quick' (T1): microtask drain + double rAF (~32ms) — catches framework re-renders
     * - 'thorough' (T2): T1 + filtered MutationObserver quiescence
     * Defaults to 'quick'.
     */
    settleMode?: 'none' | 'quick' | 'thorough';

    /**
     * Quiet window (ms) for the MutationObserver in 'thorough' mode.
     * The observer resolves after no meaningful mutations for this duration.
     * Defaults to 150.
     */
    settleQuietMs?: number;

    /**
     * Enable negative gates (Navigation API, View Transitions, aria-busy)
     * that detect in-progress transitions before snapshot capture.
     * Defaults to true.
     */
    gatesEnabled?: boolean;

    /**
     * Maximum time (ms) to wait for any single gate to clear.
     * Defaults to 2000.
     */
    gateTimeoutMs?: number;

    /**
     * Maximum timeout (ms) for the snapshotWaitFor parameter on action tools.
     * Defaults to 3000.
     */
    waitForTimeout?: number;

    /**
     * When false, link URLs are stripped from accessibility snapshots.
     * Links still show their text content and ref — only the [url=...] prop
     * is omitted. Saves ~14% of snapshot token budget on link-heavy pages.
     * Defaults to true.
     */
    includeUrls?: boolean;
  };

  /**
   * Whether to allow file uploads from anywhere on the file system.
   * By default (false), file uploads are restricted to paths within the MCP roots only.
   */
  allowUnrestrictedFileAccess?: boolean;

  /**
   * Specify the language to use for code generation.
   */
  codegen?: 'typescript' | 'none';

  evaluate?: {
    /** Maximum character count for evaluate result text. Results exceeding
     * this limit are truncated with a footer. Default: 10000. */
    maxResultLength?: number;
  };

  /**
   * Maximum total character count for any tool response. If exceeded, the
   * largest section (Result or Snapshot) is truncated to fit. Error and Page
   * sections are never truncated. Default: 50000.
   */
  maxResponseChars?: number;

  /**
   * Logging configuration.
   */
  logging?: {
    /** Number of days to retain perf and error log files. Default: 10 */
    retentionDays?: number;
  };

  relay?: {
    /** Maximum number of concurrent CDP clients. Default: 4 */
    maxConcurrentClients?: number;
    /** Per-session grace TTL in ms. Preserves tab binding during brief disconnects. Default: 30000 */
    sessionGraceTTL?: number;
  };

  performance?: {
    /** Post-action request collection window (ms). Default: 100 */
    postActionDelay?: number;
    /** Post-settlement cooldown (ms). Default: 10 */
    postSettlementDelay?: number;
    /** Network race timeout (ms). Default: 3000 */
    networkRaceTimeout?: number;
    /** Navigation load state: 'load' | 'domcontentloaded'. Default: 'domcontentloaded' */
    navigationLoadState?: 'load' | 'domcontentloaded';
    /** Navigation load state timeout (ms). Default: 5000 */
    navigationLoadTimeout?: number;
    /** Post-navigate load state: 'load' | 'domcontentloaded'. Default: 'domcontentloaded' */
    postNavigateLoadState?: 'load' | 'domcontentloaded';
    /** Post-navigate load state timeout (ms). Default: 3000 */
    postNavigateLoadTimeout?: number;
    /** Interval in ms between fast-poll retries for text wait (default 200). */
    waitFastPollInterval?: number;
    /** Number of fast-poll retries before falling back to locator (default 5). */
    waitFastPollRetries?: number;
    /** Default wait timeout in ms (default 3000). */
    waitDefaultTimeout?: number;
    /** Maximum allowed wait timeout in ms (default 30000). */
    waitMaxTimeout?: number;
  };
};

/**
 * Unified timeout matrix — deadline propagation framework.
 * Defines all timeout layers and their cascade relationships.
 * See docs/timeout-framework.md for architecture and rationale.
 */
export type TimeoutMatrix = {
  /** Per-call budget: total time allocated for a tool invocation. */
  budget: {
    /** Default budget for readOnly/input/action/assertion tools (ms). */
    default: number;
    /** Budget for navigation tools (ms). */
    navigate: number;
    /** Budget for browser_run_code (ms). */
    runCode: number;
  };
  /** Playwright inner timeouts — ceilings within the budget. */
  playwright: {
    /** Locator action timeout (ms). */
    action: number;
    /** Page navigation timeout (ms). */
    navigation: number;
    /** Expect/assertion timeout (ms). */
    expect: number;
  };
  /** Post-action settle phase timeouts. */
  settle: {
    /** Post-action request collection window (ms). */
    postActionDelay: number;
    /** Navigation load state timeout (ms). */
    navigationLoad: number;
    /** Network race timeout (ms). */
    networkRace: number;
    /** Post-settlement cooldown (ms). */
    postSettlement: number;
  };
  /** Infrastructure-level timeouts (bridge, CDP, extension). */
  infrastructure: {
    /** Bridge HTTP timeout buffer above max budget (ms). */
    bridgeBuffer: number;
    /** Extension initial connection timeout (ms). */
    extensionConnect: number;
    /** Extension CDP command timeout (ms). */
    extensionCommand: number;
    /** Per-session grace TTL (ms). */
    sessionGrace: number;
  };
};

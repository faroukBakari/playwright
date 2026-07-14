import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { defaultConfig, mergeConfig, configFromEnv } from 'playwright-core/src/mcp/config';

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('PLAYWRIGHT_MCP_')) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  }
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('PLAYWRIGHT_MCP_'))
      delete process.env[key];
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value !== undefined)
      process.env[key] = value;
  }
});

describe('defaultConfig.codegen', () => {
  it('defaults to none', () => {
    expect(defaultConfig.codegen).toBe('none');
  });
});

describe('defaultConfig has no performance section', () => {
  it('performance is undefined after Phase 3 consolidation', () => {
    expect(defaultConfig.performance).toBeUndefined();
  });
});

describe('mergeConfig infrastructure timeouts', () => {
  it('merges sessionTransportIdleTTL from override', () => {
    const result = mergeConfig(defaultConfig, {
      timeouts: { infrastructure: { sessionTransportIdleTTL: 60000 } },
    });
    expect(result.timeouts?.infrastructure?.sessionTransportIdleTTL).toBe(60000);
  });

  it('uses default when override omits infrastructure', () => {
    const result = mergeConfig(defaultConfig, {
      timeouts: { budget: { default: 8000 } },
    });
    expect(result.timeouts?.infrastructure).toEqual({
      sessionTransportIdleTTL: 120000,
    });
  });
});

describe('mergeConfig snapshot', () => {
  it('merges snapshot mode override', () => {
    const result = mergeConfig(defaultConfig, {
      snapshot: { mode: 'full' as const, maxChars: 15000 },
    });
    expect(result.snapshot?.mode).toBe('full');
    expect(result.snapshot?.maxChars).toBe(15000);
  });

  it('preserves snapshot defaults when override is partial', () => {
    const base = mergeConfig(defaultConfig, {
      snapshot: { mode: 'incremental' as const, maxChars: 20000, interactableOnly: true, includeUrls: false },
    });
    const result = mergeConfig(base, { snapshot: { maxChars: 10000 } });
    expect(result.snapshot?.mode).toBe('incremental');
    expect(result.snapshot?.maxChars).toBe(10000);
    expect(result.snapshot?.interactableOnly).toBe(true);
    expect(result.snapshot?.includeUrls).toBe(false);
  });
});

describe('mergeConfig codegen override', () => {
  it('codegen can be overridden to typescript', () => {
    const result = mergeConfig(defaultConfig, { codegen: 'typescript' });
    expect(result.codegen).toBe('typescript');
  });

  it('codegen preserves none default when not overridden', () => {
    const result = mergeConfig(defaultConfig, {});
    expect(result.codegen).toBe('none');
  });
});

describe('configFromEnv snapshot overrides', () => {
  it('reads PLAYWRIGHT_MCP_SNAPSHOT_INCLUDE_URLS env var', () => {
    process.env.PLAYWRIGHT_MCP_SNAPSHOT_INCLUDE_URLS = 'true';
    const config = configFromEnv();
    expect(config.snapshot?.includeUrls).toBe(true);
  });

  it('no snapshot overrides when no env vars set', () => {
    const config = configFromEnv();
    expect(config.snapshot?.includeUrls).toBeUndefined();
    expect(config.snapshot?.maxChars).toBeUndefined();
  });
});

describe('configFromEnv evaluate and maxResponseChars', () => {
  it('reads PLAYWRIGHT_MCP_EVAL_MAX_RESULT_LENGTH', () => {
    process.env.PLAYWRIGHT_MCP_EVAL_MAX_RESULT_LENGTH = '5000';
    const config = configFromEnv();
    expect(config.evaluate?.maxResultLength).toBe(5000);
  });

  it('reads PLAYWRIGHT_MCP_MAX_RESPONSE_CHARS', () => {
    process.env.PLAYWRIGHT_MCP_MAX_RESPONSE_CHARS = '25000';
    const config = configFromEnv();
    expect(config.maxResponseChars).toBe(25000);
  });
});

describe('configFromEnv general env vars', () => {
  it('reads port and host', () => {
    process.env.PLAYWRIGHT_MCP_PORT = '8080';
    process.env.PLAYWRIGHT_MCP_HOST = '0.0.0.0';
    const config = configFromEnv();
    expect(config.server?.port).toBe(8080);
    expect(config.server?.host).toBe('0.0.0.0');
  });

  it('reads console level', () => {
    process.env.PLAYWRIGHT_MCP_CONSOLE_LEVEL = 'error';
    const config = configFromEnv();
    expect(config.console?.level).toBe('error');
  });

  it('reads boolean flags', () => {
    process.env.PLAYWRIGHT_MCP_HEADLESS = 'true';
    process.env.PLAYWRIGHT_MCP_ISOLATED = 'false';
    process.env.PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS = '1';
    const config = configFromEnv();
    expect(config.browser?.launchOptions?.headless).toBe(true);
    expect(config.browser?.isolated).toBe(false);
    expect(config.allowUnrestrictedFileAccess).toBe(true);
  });

  it('reads image responses enum', () => {
    process.env.PLAYWRIGHT_MCP_IMAGE_RESPONSES = 'omit';
    const config = configFromEnv();
    expect(config.imageResponses).toBe('omit');
  });

  it('returns clean config when no env vars are set', () => {
    const config = configFromEnv();
    expect(config.performance).toBeUndefined();
    expect(config.evaluate).toBeUndefined();
    expect(config.maxResponseChars).toBeUndefined();
  });
});

describe('configFromEnv viewport and proxy', () => {
  it('reads viewport size in WxH format', () => {
    process.env.PLAYWRIGHT_MCP_VIEWPORT_SIZE = '1920x1080';
    const config = configFromEnv();
    expect(config.browser?.contextOptions?.viewport).toEqual({ width: 1920, height: 1080 });
  });

  it('reads viewport size in legacy comma format', () => {
    process.env.PLAYWRIGHT_MCP_VIEWPORT_SIZE = '800,600';
    const config = configFromEnv();
    expect(config.browser?.contextOptions?.viewport).toEqual({ width: 800, height: 600 });
  });

  it('reads proxy server', () => {
    process.env.PLAYWRIGHT_MCP_PROXY_SERVER = 'http://proxy:3128';
    process.env.PLAYWRIGHT_MCP_PROXY_BYPASS = 'localhost';
    const config = configFromEnv();
    expect(config.browser?.launchOptions?.proxy?.server).toBe('http://proxy:3128');
    expect(config.browser?.launchOptions?.proxy?.bypass).toBe('localhost');
  });

  it('reads CDP headers', () => {
    process.env.PLAYWRIGHT_MCP_CDP_HEADERS = 'Authorization: Bearer token123';
    const config = configFromEnv();
    expect(config.browser?.cdpHeaders).toEqual({ Authorization: 'Bearer token123' });
  });

  it('reads comma-separated allowed hosts', () => {
    process.env.PLAYWRIGHT_MCP_ALLOWED_HOSTS = 'a.com, b.com';
    const config = configFromEnv();
    expect(config.server?.allowedHosts).toEqual(['a.com', 'b.com']);
  });

  it('reads semicolon-separated allowed origins', () => {
    process.env.PLAYWRIGHT_MCP_ALLOWED_ORIGINS = 'https://a.com;https://b.com';
    const config = configFromEnv();
    expect(config.network?.allowedOrigins).toEqual(['https://a.com', 'https://b.com']);
  });

  it('reads blocked origins', () => {
    process.env.PLAYWRIGHT_MCP_BLOCKED_ORIGINS = 'https://bad.com';
    const config = configFromEnv();
    expect(config.network?.blockedOrigins).toEqual(['https://bad.com']);
  });

  it('reads init script and init page', () => {
    process.env.PLAYWRIGHT_MCP_INIT_SCRIPT = '/path/to/script.js';
    process.env.PLAYWRIGHT_MCP_INIT_PAGE = '/path/to/page.ts';
    const config = configFromEnv();
    expect(config.browser?.initScript).toEqual(['/path/to/script.js']);
    expect(config.browser?.initPage).toEqual(['/path/to/page.ts']);
  });

  it('reads console exclude patterns', () => {
    process.env.PLAYWRIGHT_MCP_CONSOLE_EXCLUDE_PATTERNS = 'chrome-extension://,devtools://';
    const config = configFromEnv();
    expect(config.console?.excludePatterns).toEqual(['chrome-extension://', 'devtools://']);
  });

  it('reads console max events', () => {
    process.env.PLAYWRIGHT_MCP_CONSOLE_MAX_EVENTS = '100';
    const config = configFromEnv();
    expect(config.console?.maxEvents).toBe(100);
  });
});

describe('configFromEnv browser options', () => {
  it('reads browser channel', () => {
    process.env.PLAYWRIGHT_MCP_BROWSER = 'msedge';
    const config = configFromEnv();
    expect(config.browser?.browserName).toBe('chromium');
    expect(config.browser?.launchOptions?.channel).toBe('msedge');
  });

  it('reads chromium browser as chrome-for-testing', () => {
    process.env.PLAYWRIGHT_MCP_BROWSER = 'chromium';
    const config = configFromEnv();
    expect(config.browser?.browserName).toBe('chromium');
    expect(config.browser?.launchOptions?.channel).toBe('chrome-for-testing');
  });

  it('reads cdp endpoint and timeout', () => {
    process.env.PLAYWRIGHT_MCP_CDP_ENDPOINT = 'ws://127.0.0.1:9222';
    process.env.PLAYWRIGHT_MCP_CDP_TIMEOUT = '5000';
    const config = configFromEnv();
    expect(config.browser?.cdpEndpoint).toBe('ws://127.0.0.1:9222');
    expect(config.browser?.cdpTimeout).toBe(5000);
  });

  it('reads block service workers', () => {
    process.env.PLAYWRIGHT_MCP_BLOCK_SERVICE_WORKERS = 'true';
    const config = configFromEnv();
    expect(config.browser?.contextOptions?.serviceWorkers).toBe('block');
  });

  it('reads user agent', () => {
    process.env.PLAYWRIGHT_MCP_USER_AGENT = 'Custom/1.0';
    const config = configFromEnv();
    expect(config.browser?.contextOptions?.userAgent).toBe('Custom/1.0');
  });

  it('reads grant permissions', () => {
    process.env.PLAYWRIGHT_MCP_GRANT_PERMISSIONS = 'clipboard-read,notifications';
    const config = configFromEnv();
    expect(config.browser?.contextOptions?.permissions).toEqual(['clipboard-read', 'notifications']);
  });

  it('reads ignore https errors', () => {
    process.env.PLAYWRIGHT_MCP_IGNORE_HTTPS_ERRORS = 'true';
    const config = configFromEnv();
    expect(config.browser?.contextOptions?.ignoreHTTPSErrors).toBe(true);
  });

  it('reads output dir and mode', () => {
    process.env.PLAYWRIGHT_MCP_OUTPUT_DIR = '/tmp/output';
    const config = configFromEnv();
    expect(config.outputDir).toBe('/tmp/output');
  });

  it('reads sandbox flag', () => {
    process.env.PLAYWRIGHT_MCP_SANDBOX = 'false';
    const config = configFromEnv();
    expect(config.browser?.launchOptions?.chromiumSandbox).toBe(false);
  });
});

describe('resolutionParser edge cases', () => {
  it('rejects invalid WxH format', () => {
    expect(() => {
      process.env.PLAYWRIGHT_MCP_VIEWPORT_SIZE = 'abcxdef';
      configFromEnv();
    }).toThrow(/Invalid resolution format/);
  });

  it('rejects unsupported format', () => {
    expect(() => {
      process.env.PLAYWRIGHT_MCP_VIEWPORT_SIZE = '800';
      configFromEnv();
    }).toThrow(/Invalid resolution format/);
  });
});

describe('mergeConfig logging and relay', () => {
  it('merges logging retentionDays', () => {
    const result = mergeConfig(defaultConfig, {
      logging: { retentionDays: 30 },
    });
    expect(result.logging?.retentionDays).toBe(30);
  });

  it('merges relay config', () => {
    const result = mergeConfig(defaultConfig, {
      relay: { maxConcurrentClients: 8, sessionGraceTTL: 60000, backendDisposalTTL: 120000 },
    });
    expect(result.relay?.maxConcurrentClients).toBe(8);
    expect(result.relay?.sessionGraceTTL).toBe(60000);
  });
});

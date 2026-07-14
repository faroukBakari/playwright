import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// Import from compiled playwright-core (file: dependency)
import { configFromEnv, mergeConfig, defaultConfig } from 'playwright-core/src/mcp/config';
import { Response } from 'playwright-core/src/tools/response';

// Minimal context stub — matches pattern from snapshotControl.test.ts.
function createStubContext(configOverrides: Record<string, any> = {}) {
  return {
    id: 'test-context-id',
    config: { ...configOverrides },
    options: { cwd: '/tmp' },
    currentTab: () => undefined,
    tabs: () => [],
  } as any;
}

// Save and restore all PLAYWRIGHT_MCP_ env vars to avoid test pollution
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

// ---------------------------------------------------------------------------
// Patch 4d: interactableOnly config + env var parsing
// ---------------------------------------------------------------------------

describe('PLAYWRIGHT_MCP_SNAPSHOT_INTERACTABLE_ONLY env var', () => {
  it('parses "true" into config.snapshot.interactableOnly', () => {
    process.env.PLAYWRIGHT_MCP_SNAPSHOT_INTERACTABLE_ONLY = 'true';
    const config = configFromEnv();
    expect(config.snapshot?.interactableOnly).toBe(true);
  });

  it('parses "1" into config.snapshot.interactableOnly', () => {
    process.env.PLAYWRIGHT_MCP_SNAPSHOT_INTERACTABLE_ONLY = '1';
    const config = configFromEnv();
    expect(config.snapshot?.interactableOnly).toBe(true);
  });

  it('parses "false" into config.snapshot.interactableOnly', () => {
    process.env.PLAYWRIGHT_MCP_SNAPSHOT_INTERACTABLE_ONLY = 'false';
    const config = configFromEnv();
    expect(config.snapshot?.interactableOnly).toBe(false);
  });

  it('leaves interactableOnly undefined when env var is not set', () => {
    const config = configFromEnv();
    expect(config.snapshot?.interactableOnly).toBeUndefined();
  });
});

describe('mergeConfig snapshot.interactableOnly', () => {
  it('deep-merges interactableOnly into snapshot config', () => {
    const result = mergeConfig(defaultConfig, {
      snapshot: { interactableOnly: true },
    });
    expect(result.snapshot?.interactableOnly).toBe(true);
  });

  it('preserves mode and maxChars when interactableOnly is set', () => {
    const base = mergeConfig(defaultConfig, { snapshot: { mode: 'full', maxChars: 10000 } });
    const result = mergeConfig(base, { snapshot: { interactableOnly: true } });
    expect(result.snapshot?.mode).toBe('full');
    expect(result.snapshot?.maxChars).toBe(10000);
    expect(result.snapshot?.interactableOnly).toBe(true);
  });

  it('preserves interactableOnly when other snapshot fields are overridden', () => {
    const base = mergeConfig(defaultConfig, { snapshot: { interactableOnly: true } });
    const result = mergeConfig(base, { snapshot: { mode: 'incremental' } });
    expect(result.snapshot?.interactableOnly).toBe(true);
    expect(result.snapshot?.mode).toBe('incremental');
  });
});

// ---------------------------------------------------------------------------
// Patch 4e: snapshotSelector threading via Response
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// snapshot.includeUrls config + env var parsing
// ---------------------------------------------------------------------------

describe('PLAYWRIGHT_MCP_SNAPSHOT_INCLUDE_URLS env var', () => {
  it('parses "true" into config.snapshot.includeUrls', () => {
    process.env.PLAYWRIGHT_MCP_SNAPSHOT_INCLUDE_URLS = 'true';
    const config = configFromEnv();
    expect(config.snapshot?.includeUrls).toBe(true);
  });

  it('parses "false" into config.snapshot.includeUrls', () => {
    process.env.PLAYWRIGHT_MCP_SNAPSHOT_INCLUDE_URLS = 'false';
    const config = configFromEnv();
    expect(config.snapshot?.includeUrls).toBe(false);
  });

  it('parses "0" into config.snapshot.includeUrls false', () => {
    process.env.PLAYWRIGHT_MCP_SNAPSHOT_INCLUDE_URLS = '0';
    const config = configFromEnv();
    expect(config.snapshot?.includeUrls).toBe(false);
  });

  it('leaves includeUrls undefined when env var is not set', () => {
    const config = configFromEnv();
    expect(config.snapshot?.includeUrls).toBeUndefined();
  });
});

describe('mergeConfig snapshot.includeUrls', () => {
  it('deep-merges includeUrls into snapshot config', () => {
    const result = mergeConfig(defaultConfig, {
      snapshot: { includeUrls: false },
    });
    expect(result.snapshot?.includeUrls).toBe(false);
  });

  it('preserves other snapshot fields when includeUrls is set', () => {
    const base = mergeConfig(defaultConfig, { snapshot: { mode: 'full', interactableOnly: true } });
    const result = mergeConfig(base, { snapshot: { includeUrls: false } });
    expect(result.snapshot?.mode).toBe('full');
    expect(result.snapshot?.interactableOnly).toBe(true);
    expect(result.snapshot?.includeUrls).toBe(false);
  });

  it('preserves includeUrls when other snapshot fields are overridden', () => {
    const base = mergeConfig(defaultConfig, { snapshot: { includeUrls: false } });
    const result = mergeConfig(base, { snapshot: { mode: 'incremental' } });
    expect(result.snapshot?.includeUrls).toBe(false);
    expect(result.snapshot?.mode).toBe('incremental');
  });

  it('defaults to true (undefined treated as true)', () => {
    const result = mergeConfig(defaultConfig, {});
    // undefined means "include URLs" — backwards compat
    expect(result.snapshot?.includeUrls).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Patch 4e: snapshotSelector threading via Response
// ---------------------------------------------------------------------------

describe('Response snapshotSelector', () => {
  it('stores snapshotSelector from constructor', () => {
    const ctx = createStubContext({ snapshot: { mode: 'incremental' } });
    const response = new Response(ctx, 'browser_click', {}, undefined, '#main-content');
    expect((response as any)._snapshotSelector).toBe('#main-content');
  });

  it('snapshotSelector is undefined by default', () => {
    const ctx = createStubContext();
    const response = new Response(ctx, 'browser_click', {});
    expect((response as any)._snapshotSelector).toBeUndefined();
  });
});

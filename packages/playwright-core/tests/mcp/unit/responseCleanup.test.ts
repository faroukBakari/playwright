import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { configFromEnv, mergeConfig, defaultConfig } from 'playwright-core/src/mcp/config';
import { Response } from 'playwright-core/src/tools/response';

// Minimal context stub — same pattern as snapshotControl.test.ts
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
// Patch 8c: evaluate.maxResultLength config + env var
// ---------------------------------------------------------------------------

describe('PLAYWRIGHT_MCP_EVAL_MAX_RESULT_LENGTH env var', () => {
  it('parses numeric value into config.evaluate.maxResultLength', () => {
    process.env.PLAYWRIGHT_MCP_EVAL_MAX_RESULT_LENGTH = '10000';
    const config = configFromEnv();
    expect(config.evaluate?.maxResultLength).toBe(10000);
  });

  it('leaves maxResultLength undefined when env var is not set', () => {
    const config = configFromEnv();
    expect(config.evaluate?.maxResultLength).toBeUndefined();
  });

  it('merges evaluate config correctly', () => {
    const result = mergeConfig(defaultConfig, {
      evaluate: { maxResultLength: 5000 },
    });
    expect(result.evaluate?.maxResultLength).toBe(5000);
  });
});

// ---------------------------------------------------------------------------
// Patch 8e: maxResponseChars config + env var
// ---------------------------------------------------------------------------

describe('PLAYWRIGHT_MCP_MAX_RESPONSE_CHARS env var', () => {
  it('parses numeric value into config.maxResponseChars', () => {
    process.env.PLAYWRIGHT_MCP_MAX_RESPONSE_CHARS = '50000';
    const config = configFromEnv();
    expect(config.maxResponseChars).toBe(50000);
  });

  it('leaves maxResponseChars undefined when env var is not set', () => {
    const config = configFromEnv();
    expect(config.maxResponseChars).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Patch 8e: Response maxResponseChars guard
// ---------------------------------------------------------------------------

describe('Response maxResponseChars guard', () => {
  it('truncates when response exceeds maxResponseChars', async () => {
    const ctx = createStubContext({ maxResponseChars: 200 });
    const response = new Response(ctx, 'browser_evaluate', {});
    // Add a large result that exceeds the limit
    response.addTextResult('x'.repeat(500));
    const result = await response.serialize();
    const text = (result.content[0] as any).text;
    expect(text.length).toBeLessThanOrEqual(300); // some slack for headers
    expect(text).toContain('[response truncated to fit 200 char limit]');
  });

  it('does not truncate when response is under maxResponseChars', async () => {
    const ctx = createStubContext({ maxResponseChars: 50000 });
    const response = new Response(ctx, 'browser_evaluate', {});
    response.addTextResult('short result');
    const result = await response.serialize();
    const text = (result.content[0] as any).text;
    expect(text).not.toContain('[response truncated');
    expect(text).toContain('short result');
  });

  it('never truncates Error sections', async () => {
    const ctx = createStubContext({ maxResponseChars: 100 });
    const response = new Response(ctx, 'browser_evaluate', {});
    response.addError('Critical error message that must be preserved');
    response.addTextResult('x'.repeat(500));
    const result = await response.serialize();
    const text = (result.content[0] as any).text;
    expect(text).toContain('Critical error message that must be preserved');
  });

  it('does not truncate when maxResponseChars is not set', async () => {
    const ctx = createStubContext({});
    const response = new Response(ctx, 'browser_evaluate', {});
    response.addTextResult('x'.repeat(1000));
    const result = await response.serialize();
    const text = (result.content[0] as any).text;
    expect(text).not.toContain('[response truncated');
  });
});

// ---------------------------------------------------------------------------
// isClose behavior: _hadTabsAtConstruction guard
// ---------------------------------------------------------------------------

describe('isClose behavior', () => {
  it('does not set isClose when tabs are always empty (fresh session)', async () => {
    // Simulates a fresh session that never had tabs — _hadTabsAtConstruction = false
    const ctx = createStubContext({});
    // ctx.tabs already returns [] by default from createStubContext
    const response = new Response(ctx, 'browser_list_tabs', {});
    response.addTextResult('No tabs');
    const result = await response.serialize();
    expect(result.isClose).toBeUndefined();
  });

  it('sets isClose when tabs decrease from >0 to 0 (browser closed)', async () => {
    // Simulates a session that HAD tabs at construction, then lost them all
    let callCount = 0;
    const mockTab = { headerSnapshot: async () => ({ current: true, url: 'about:blank', title: '', changed: false, console: { errors: 0, warnings: 0 } }) };
    const ctx = {
      id: 'test-context-id',
      config: {},
      options: { cwd: '/tmp' },
      currentTab: () => undefined,
      tabs: () => callCount++ === 0 ? [mockTab] : [],
    } as any;
    const response = new Response(ctx, 'browser_navigate', {});
    response.addTextResult('Navigated');
    const result = await response.serialize();
    expect(result.isClose).toBe(true);
  });
});

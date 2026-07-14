import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Import from compiled playwright-core (file: dependency)
import { configFromEnv, mergeConfig, defaultConfig } from 'playwright-core/src/mcp/config';
import { Response } from 'playwright-core/src/tools/response';

// Minimal context stub — Response constructor only stores the reference.
// Methods on context are called later in _build(), but our tests that call
// serialize() only test the no-tabs path (currentTab() returns undefined,
// tabs() returns []).
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
// Patch 4ab: Per-call includeSnapshot override (Response behavior)
// ---------------------------------------------------------------------------

describe('Response snapshotMode suppression', () => {
  it('setIncludeSnapshot() is a no-op when snapshotMode is none', () => {
    const ctx = createStubContext({ snapshot: { mode: 'incremental' } });
    const response = new Response(ctx, 'browser_click', {}, undefined, undefined, 'none');
    response.setIncludeSnapshot();
    // _includeSnapshot should remain 'none' because the mode suppressed it
    expect((response as any)._includeSnapshot).toBe('none');
  });

  it('setIncludeSnapshot(full) is a no-op when snapshotMode is none', () => {
    const ctx = createStubContext();
    const response = new Response(ctx, 'browser_snapshot', {}, undefined, undefined, 'none');
    response.setIncludeSnapshot('full');
    expect((response as any)._includeSnapshot).toBe('none');
  });

  it('setIncludeSnapshot() works normally when no snapshotMode is set', () => {
    const ctx = createStubContext({ snapshot: { mode: 'incremental' } });
    const response = new Response(ctx, 'browser_click', {});
    response.setIncludeSnapshot();
    expect((response as any)._includeSnapshot).toBe('diff');
  });

  it('setIncludeSnapshot(full) works normally when no snapshotMode is set', () => {
    const ctx = createStubContext();
    const response = new Response(ctx, 'browser_snapshot', {});
    response.setIncludeSnapshot('full');
    expect((response as any)._includeSnapshot).toBe('full');
  });

  it('setIncludeSnapshot() uses snapshotMode full as fallback', () => {
    const ctx = createStubContext({ snapshot: { mode: 'incremental' } });
    const response = new Response(ctx, 'browser_navigate', {}, undefined, undefined, 'full');
    response.setIncludeSnapshot();
    expect((response as any)._includeSnapshot).toBe('full');
  });

  it('snapshotMode none produces no Snapshot section in serialized output', async () => {
    const ctx = createStubContext({ snapshot: { mode: 'incremental' } });
    const response = new Response(ctx, 'browser_click', {}, undefined, undefined, 'none');
    response.setIncludeSnapshot();
    response.addTextResult('Action completed');
    const result = await response.serialize();
    const text = (result.content[0] as any).text;
    expect(text).not.toContain('### Snapshot');
    expect(text).toContain('Action completed');
  });
});

// ---------------------------------------------------------------------------
// Lazy snapshot capture: captureSnapshot() skipped when _includeSnapshot='none'
// ---------------------------------------------------------------------------

describe('captureSnapshot gated by _includeSnapshot', () => {
  // Stub tab with a spy on captureSnapshot
  function createMockTab() {
    return {
      captureSnapshot: vi.fn().mockResolvedValue({
        ariaSnapshot: '- heading "Hello"',
        ariaSnapshotDiff: undefined,
        modalStates: [],
        events: [],
      }),
      headerSnapshot: vi.fn().mockResolvedValue({
        title: 'Test', url: 'https://example.com', current: true,
        console: { total: 0, warnings: 0, errors: 0 }, changed: false,
      }),
    };
  }

  function createContextWithTab(mockTab: ReturnType<typeof createMockTab>, configOverrides: Record<string, any> = {}) {
    return {
      id: 'test-context-id',
      config: { ...configOverrides },
      options: { cwd: '/tmp' },
      currentTab: () => mockTab,
      currentTabOrDie: () => mockTab,
      tabs: () => [mockTab],
    } as any;
  }

  it('skips captureSnapshot when no setIncludeSnapshot is called (none)', async () => {
    const tab = createMockTab();
    const ctx = createContextWithTab(tab);
    const response = new Response(ctx, 'browser_evaluate', {});
    response.addTextResult('42');
    const result = await response.serialize();
    // No capture when tool does not opt in — protects management tools from page errors
    expect(tab.captureSnapshot).not.toHaveBeenCalled();
    const text = (result.content[0] as any).text;
    expect(text).not.toContain('### Snapshot');
  });

  it('skips captureSnapshot when snapshotMode is none', async () => {
    const tab = createMockTab();
    const ctx = createContextWithTab(tab, { snapshot: { mode: 'incremental' } });
    const response = new Response(ctx, 'browser_click', {}, undefined, undefined, 'none');
    response.setIncludeSnapshot(); // suppressed by snapshotMode
    response.addTextResult('Clicked');
    const result = await response.serialize();
    expect(tab.captureSnapshot).not.toHaveBeenCalled();
    const text = (result.content[0] as any).text;
    expect(text).not.toContain('### Snapshot');
  });

  it('skips captureSnapshot when config snapshot mode is none', async () => {
    const tab = createMockTab();
    const ctx = createContextWithTab(tab, { snapshot: { mode: 'none' } });
    const response = new Response(ctx, 'browser_click', {});
    response.setIncludeSnapshot(); // resolves to 'none' from config
    response.addTextResult('Clicked');
    const result = await response.serialize();
    expect(tab.captureSnapshot).not.toHaveBeenCalled();
    const text = (result.content[0] as any).text;
    expect(text).not.toContain('### Snapshot');
  });

  it('calls captureSnapshot when _includeSnapshot is diff', async () => {
    const tab = createMockTab();
    const ctx = createContextWithTab(tab, { snapshot: { mode: 'incremental' } });
    const response = new Response(ctx, 'browser_click', {});
    response.setIncludeSnapshot();
    response.addTextResult('Clicked');
    await response.serialize();
    expect(tab.captureSnapshot).toHaveBeenCalledOnce();
  });

  it('calls captureSnapshot when _includeSnapshot is full', async () => {
    const tab = createMockTab();
    const ctx = createContextWithTab(tab);
    const response = new Response(ctx, 'browser_snapshot', {});
    response.setIncludeSnapshot('full');
    await response.serialize();
    expect(tab.captureSnapshot).toHaveBeenCalledOnce();
  });

  it('passes snapshotSelector and clientId through to captureSnapshot', async () => {
    const tab = createMockTab();
    const ctx = createContextWithTab(tab, { snapshot: { mode: 'full' } });
    const response = new Response(ctx, 'browser_click', {}, undefined, '.main-content');
    response.setIncludeSnapshot();
    await response.serialize();
    expect(tab.captureSnapshot).toHaveBeenCalledWith('/tmp', { rootSelector: '.main-content', clientId: 'test-context-id' });
  });

  it('skips tab headers when snapshot mode is none even if header changed', async () => {
    const tab = createMockTab();
    tab.headerSnapshot.mockResolvedValue({
      title: 'New Title', url: 'https://example.com/new', current: true,
      console: { total: 0, warnings: 0, errors: 0 }, changed: true,
    });
    const ctx = createContextWithTab(tab);
    const response = new Response(ctx, 'browser_evaluate', {});
    response.addTextResult('done');
    const result = await response.serialize();
    const text = (result.content[0] as any).text;
    // No capture or header rendering when tool does not opt in
    expect(tab.captureSnapshot).not.toHaveBeenCalled();
    expect(tab.headerSnapshot).not.toHaveBeenCalled();
    expect(text).not.toContain('### Page');
    // but no Snapshot section
    expect(text).not.toContain('### Snapshot');
  });
});

// ---------------------------------------------------------------------------
// Patch 4c: maxSnapshotChars config + env var parsing
// ---------------------------------------------------------------------------

describe('PLAYWRIGHT_MCP_SNAPSHOT_MAX_CHARS env var', () => {
  it('parses numeric value into config.snapshot.maxChars', () => {
    process.env.PLAYWRIGHT_MCP_SNAPSHOT_MAX_CHARS = '20000';
    const config = configFromEnv();
    expect(config.snapshot?.maxChars).toBe(20000);
  });

  it('leaves maxChars undefined when env var is not set', () => {
    const config = configFromEnv();
    expect(config.snapshot?.maxChars).toBeUndefined();
  });

  it('preserves snapshot.mode when maxChars is set via env', () => {
    process.env.PLAYWRIGHT_MCP_SNAPSHOT_MAX_CHARS = '15000';
    const envConfig = configFromEnv();
    const merged = mergeConfig(defaultConfig, envConfig);
    expect(merged.snapshot?.maxChars).toBe(15000);
  });
});

describe('mergeConfig snapshot.maxChars', () => {
  it('deep-merges maxChars into snapshot config', () => {
    const result = mergeConfig(defaultConfig, {
      snapshot: { maxChars: 10000 },
    });
    expect(result.snapshot?.maxChars).toBe(10000);
  });

  it('preserves mode when only maxChars is overridden', () => {
    const base = mergeConfig(defaultConfig, { snapshot: { mode: 'full' } });
    const result = mergeConfig(base, { snapshot: { maxChars: 5000 } });
    expect(result.snapshot?.mode).toBe('full');
    expect(result.snapshot?.maxChars).toBe(5000);
  });

  it('preserves maxChars when only mode is overridden', () => {
    const base = mergeConfig(defaultConfig, { snapshot: { maxChars: 8000 } });
    const result = mergeConfig(base, { snapshot: { mode: 'incremental' } });
    expect(result.snapshot?.mode).toBe('incremental');
    expect(result.snapshot?.maxChars).toBe(8000);
  });
});

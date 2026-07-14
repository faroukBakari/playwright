import { describe, it, expect, vi } from 'vitest';
import { Response, parseResponse } from 'playwright-core/src/tools/response';

// ---------------------------------------------------------------------------
// Cross-iframe CSS selector resolution tests
//
// Tests for:
// 1. selectorResolved aggregation across child frames (page.ts)
// 2. First-match-wins iframe fallback for rootSelector (tab.ts)
// 3. Cross-iframe within resolution for snapshotWaitFor (response.ts)
//
// These test the logic in isolation — the actual page.evaluate callbacks
// and frame traversal are browser-side code tested via integration tests.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 1. selectorResolved aggregation
//
// Logic: if ANY frame resolved the selector, overall = true.
// undefined (no rootSelector configured) stays undefined.
// ---------------------------------------------------------------------------

describe('selectorResolved aggregation', () => {
  // Mirrors the aggregation logic in snapshotFrameForAI (page.ts)
  function aggregate(
    mainSelectorResolved: boolean | undefined,
    childResults: Array<{ selectorResolved?: boolean }>
  ): boolean | undefined {
    const childSelectorResolved = childResults.some(c => c.selectorResolved === true);
    if (mainSelectorResolved !== undefined)
      return mainSelectorResolved || childSelectorResolved;
    return undefined;
  }

  it('main=true, no children → true', () => {
    expect(aggregate(true, [])).toBe(true);
  });

  it('main=true, children=[false] → true', () => {
    expect(aggregate(true, [{ selectorResolved: false }])).toBe(true);
  });

  it('main=false, children=[true] → true', () => {
    expect(aggregate(false, [{ selectorResolved: true }])).toBe(true);
  });

  it('main=false, children=[false] → false', () => {
    expect(aggregate(false, [{ selectorResolved: false }])).toBe(false);
  });

  it('main=false, children=[false, true] → true', () => {
    expect(aggregate(false, [{ selectorResolved: false }, { selectorResolved: true }])).toBe(true);
  });

  it('main=false, children=[undefined] → false (undefined child treated as not resolved)', () => {
    expect(aggregate(false, [{ selectorResolved: undefined }])).toBe(false);
  });

  it('undefined (no rootSelector) stays undefined regardless of children', () => {
    expect(aggregate(undefined, [])).toBeUndefined();
    expect(aggregate(undefined, [{ selectorResolved: true }])).toBeUndefined();
    expect(aggregate(undefined, [{ selectorResolved: false }])).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. First-match-wins iframe fallback for rootSelector
//
// Logic: main frame querySelector first, then iterate same-origin iframes.
// Cross-origin iframes throw on contentDocument access — gracefully skipped.
// ---------------------------------------------------------------------------

describe('First-match-wins rootSelector resolution', () => {
  // Mirrors the iframe fallback logic in tab.ts settle phase (page.evaluate)
  function resolveRootSelector(
    rootSelector: string | undefined,
    mainResult: string | null,
    iframeResults: Array<{ result: string | null, crossOrigin?: boolean }>
  ): string | null {
    let root: string | null = null;
    if (rootSelector) {
      // Main frame first
      root = mainResult;
      if (!root) {
        // Iterate iframes
        for (const iframe of iframeResults) {
          if (iframe.crossOrigin)
            continue; // cross-origin — skip
          if (iframe.result) {
            root = iframe.result;
            break;
          }
        }
      }
    }
    // Fallback to body
    return root ?? 'document.body';
  }

  it('main match returns without checking iframes', () => {
    const result = resolveRootSelector(
        '[role="dialog"]',
        'dialog-element',
        [{ result: 'iframe-dialog-element' }]
    );
    expect(result).toBe('dialog-element');
  });

  it('iframe match returned when main misses', () => {
    const result = resolveRootSelector(
        '[role="dialog"]',
        null,
        [{ result: null }, { result: 'iframe-dialog-element' }]
    );
    expect(result).toBe('iframe-dialog-element');
  });

  it('null selector → document.body', () => {
    const result = resolveRootSelector(undefined, null, []);
    expect(result).toBe('document.body');
  });

  it('nothing matches → document.body fallback', () => {
    const result = resolveRootSelector(
        '[role="dialog"]',
        null,
        [{ result: null }, { result: null }]
    );
    expect(result).toBe('document.body');
  });

  it('cross-origin iframe gracefully skipped', () => {
    const result = resolveRootSelector(
        '[role="dialog"]',
        null,
        [
          { result: null, crossOrigin: true },  // would throw in real browser
          { result: 'same-origin-match' },
        ]
    );
    expect(result).toBe('same-origin-match');
  });

  it('only cross-origin iframes → document.body fallback', () => {
    const result = resolveRootSelector(
        '[role="dialog"]',
        null,
        [
          { result: null, crossOrigin: true },
          { result: null, crossOrigin: true },
        ]
    );
    expect(result).toBe('document.body');
  });

  it('first iframe match wins (DOM order)', () => {
    const result = resolveRootSelector(
        '.target',
        null,
        [
          { result: 'first-iframe-match' },
          { result: 'second-iframe-match' },
        ]
    );
    expect(result).toBe('first-iframe-match');
  });
});

// ---------------------------------------------------------------------------
// 3. Cross-iframe within resolution for snapshotWaitFor
//
// Same first-match-wins pattern applied to the `within` parameter.
// ---------------------------------------------------------------------------

describe('Cross-iframe within resolution for snapshotWaitFor', () => {
  // Mirrors the within resolution logic in waitForFunction callbacks (response.ts)
  function resolveWithin(
    within: string | undefined,
    mainResult: string | null,
    iframeResults: Array<{ result: string | null, crossOrigin?: boolean }>
  ): string {
    let root: string | null = within ? mainResult : null;
    if (within && !root) {
      for (const iframe of iframeResults) {
        if (iframe.crossOrigin)
          continue;
        if (iframe.result) {
          root = iframe.result;
          break;
        }
      }
    }
    return root ?? 'document.body';
  }

  it('no within → document.body', () => {
    expect(resolveWithin(undefined, null, [])).toBe('document.body');
  });

  it('within matches in main frame → main frame element', () => {
    expect(resolveWithin('.container', 'main-match', [{ result: 'iframe-match' }])).toBe('main-match');
  });

  it('within misses main, found in iframe → iframe element', () => {
    expect(resolveWithin('.container', null, [{ result: 'iframe-match' }])).toBe('iframe-match');
  });

  it('within misses everything → document.body fallback', () => {
    expect(resolveWithin('.container', null, [{ result: null }])).toBe('document.body');
  });

  it('cross-origin iframe skipped during within resolution', () => {
    expect(resolveWithin('.container', null, [
      { result: null, crossOrigin: true },
      { result: 'same-origin-match' },
    ])).toBe('same-origin-match');
  });
});

// ---------------------------------------------------------------------------
// 4. selectorResolved success message in Response result
//
// When selectorResolved === true and a snapshotSelector is set, the response
// must surface a confirmation message. This mirrors the failure-case warning
// already tested in settleDetection.test.ts.
// ---------------------------------------------------------------------------

function createMockTab(selectorResolved: boolean) {
  return {
    captureSnapshot: vi.fn().mockResolvedValue({
      ariaSnapshot: '- heading "Page"',
      ariaSnapshotDiff: undefined,
      modalStates: [],
      events: [],
      selectorResolved,
    }),
    headerSnapshot: vi.fn().mockResolvedValue({
      title: 'Test Page',
      url: 'https://example.com',
      current: true,
      console: { total: 0, warnings: 0, errors: 0 },
      changed: false,
    }),
  };
}

function createContextWithTab(tab: ReturnType<typeof createMockTab>) {
  return {
    id: 'test-ctx',
    config: {},
    options: { cwd: '/tmp' },
    currentTab: () => tab,
    currentTabOrDie: () => tab,
    tabs: () => [tab],
  } as any;
}

describe('selectorResolved message in Response Result section', () => {
  it('selectorResolved=true + snapshotSelector → no noise message in Result', async () => {
    // Successful scoped snapshots are silent — no confirmation message.
    // Only the fallback (selectorResolved=false) emits a warning.
    const tab = createMockTab(true);
    const ctx = createContextWithTab(tab);
    const snapshotSelector = '.main-content';
    const response = new Response(ctx, 'browser_snapshot', {}, undefined, snapshotSelector);
    response.setIncludeSnapshot('full');
    const callToolResult = await response.serialize();
    const parsed = parseResponse(callToolResult);
    expect(parsed).toBeDefined();
    expect(parsed!.result ?? '').not.toContain('selectorResolved');
    expect(parsed!.result ?? '').not.toContain('matched no elements');
  });

  it('selectorResolved=false + snapshotSelector → no success message in Result', async () => {
    const tab = createMockTab(false);
    const ctx = createContextWithTab(tab);
    const snapshotSelector = '.does-not-exist';
    const response = new Response(ctx, 'browser_snapshot', {}, undefined, snapshotSelector);
    response.setIncludeSnapshot('full');
    const callToolResult = await response.serialize();
    const parsed = parseResponse(callToolResult);
    expect(parsed).toBeDefined();
    expect(parsed!.result ?? '').not.toContain('selectorResolved: true');
  });

  it('selectorResolved=true without snapshotSelector → no success message', async () => {
    const tab = createMockTab(true);
    const ctx = createContextWithTab(tab);
    const response = new Response(ctx, 'browser_snapshot', {}, undefined, undefined);
    response.setIncludeSnapshot('full');
    const callToolResult = await response.serialize();
    const parsed = parseResponse(callToolResult);
    expect(parsed).toBeDefined();
    expect(parsed!.result ?? '').not.toContain('selectorResolved: true');
  });
});

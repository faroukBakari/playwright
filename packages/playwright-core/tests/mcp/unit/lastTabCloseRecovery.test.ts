/**
 * Tests for page gate reset after last tab close.
 *
 * The Context class (context.ts) uses a one-shot _firstPagePromise to
 * synchronize ensureTab() with the CDP page-created event. When the last
 * tab closes, the promise must reset so ensureTab() can wait for a new
 * tab to materialize. Without the reset, the already-resolved promise
 * short-circuits the wait and ensureTab() returns undefined — causing
 * TypeError on the next tool call.
 *
 * These tests exercise the promise lifecycle in isolation, extracting
 * the exact pattern from context.ts without needing a real BrowserContext.
 */
import { describe, it, expect, beforeEach } from 'vitest';

type Tab = { id: string; page: { url: string } };

/**
 * Minimal extraction of the Context tab lifecycle from context.ts.
 * Only the fields and methods relevant to the page gate behavior.
 */
class TabLifecycle {
  _tabs: Tab[] = [];
  _currentTab: Tab | undefined;
  _firstPageResolve: (() => void) | undefined;
  _firstPagePromise: Promise<void> | undefined;

  constructor() {
    this._firstPagePromise = new Promise<void>(resolve => {
      this._firstPageResolve = resolve;
    });
  }

  // context.ts:297-307 + fix
  onPageCreated(page: { url: string }) {
    if (this._firstPageResolve) {
      this._firstPageResolve();
      this._firstPageResolve = undefined;
    }
    const tab: Tab = { id: `tab-${this._tabs.length}`, page };
    this._tabs.push(tab);
    if (!this._currentTab)
      this._currentTab = tab;
    return tab;
  }

  // context.ts:309-322 (with fix applied)
  onPageClosed(tab: Tab) {
    const index = this._tabs.indexOf(tab);
    if (index === -1)
      return;
    this._tabs.splice(index, 1);
    if (this._currentTab === tab)
      this._currentTab = this._tabs[Math.min(index, this._tabs.length - 1)];

    if (this._tabs.length === 0) {
      this._firstPagePromise = new Promise<void>(resolve => {
        this._firstPageResolve = resolve;
      });
    }
  }

  // Simplified ensureTab — extension mode branch (context.ts:217-251)
  async ensureTab(options?: { onCreateRequested?: () => void }): Promise<Tab | undefined> {
    if (!this._currentTab) {
      options?.onCreateRequested?.();
      let timeoutId: ReturnType<typeof setTimeout>;
      await Promise.race([
        this._firstPagePromise!.then(() => clearTimeout(timeoutId)),
        new Promise<void>((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error('Timed out waiting for page')), 2000);
        }),
      ]);
    }
    return this._currentTab;
  }
}

describe('last tab close recovery', () => {
  let ctx: TabLifecycle;

  beforeEach(() => {
    ctx = new TabLifecycle();
  });

  it('first page creation resolves the gate and returns a tab', async () => {
    setTimeout(() => ctx.onPageCreated({ url: 'https://first.com' }), 20);
    const tab = await ctx.ensureTab();
    expect(tab).toBeDefined();
    expect(tab!.page.url).toBe('https://first.com');
  });

  it('gate resolver is consumed after first page (one-shot)', () => {
    ctx.onPageCreated({ url: 'https://example.com' });
    expect(ctx._firstPageResolve).toBeUndefined();
  });

  it('closing last tab resets the gate', () => {
    const tab = ctx.onPageCreated({ url: 'https://example.com' });
    expect(ctx._firstPageResolve).toBeUndefined();

    ctx.onPageClosed(tab);

    expect(ctx._tabs).toHaveLength(0);
    expect(ctx._currentTab).toBeUndefined();
    expect(ctx._firstPageResolve).toBeTypeOf('function');
  });

  it('ensureTab waits for new page after last tab close', async () => {
    // Create and close the first tab
    const tab1 = ctx.onPageCreated({ url: 'https://first.com' });
    ctx.onPageClosed(tab1);

    // Schedule new page arrival 100ms after ensureTab is called
    let createRequested = false;
    setTimeout(() => ctx.onPageCreated({ url: 'https://recovered.com' }), 100);

    const t0 = Date.now();
    const tab2 = await ctx.ensureTab({
      onCreateRequested: () => { createRequested = true; },
    });
    const elapsed = Date.now() - t0;

    expect(createRequested).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(80);
    expect(tab2).toBeDefined();
    expect(tab2!.page.url).toBe('https://recovered.com');
  });

  it('recovery is repeatable across multiple close/create cycles', async () => {
    for (let i = 0; i < 3; i++) {
      const tab = ctx.onPageCreated({ url: `https://cycle-${i}.com` });
      expect(ctx._currentTab).toBe(tab);
      ctx.onPageClosed(tab);
      expect(ctx._currentTab).toBeUndefined();
    }

    // Final recovery
    setTimeout(() => ctx.onPageCreated({ url: 'https://final.com' }), 20);
    const finalTab = await ctx.ensureTab();
    expect(finalTab!.page.url).toBe('https://final.com');
  });

  it('closing one of two tabs does NOT reset the gate', () => {
    const tab1 = ctx.onPageCreated({ url: 'https://one.com' });
    const tab2 = ctx.onPageCreated({ url: 'https://two.com' });
    expect(ctx._tabs).toHaveLength(2);

    // Close tab1 — tab2 remains
    ctx.onPageClosed(tab1);

    expect(ctx._tabs).toHaveLength(1);
    expect(ctx._currentTab).toBe(tab2);
    // Gate should NOT be reset — still undefined from initial consumption
    expect(ctx._firstPageResolve).toBeUndefined();
  });

  it('closing non-existent tab is a no-op', () => {
    const tab = ctx.onPageCreated({ url: 'https://example.com' });
    const fake = { id: 'fake', page: { url: 'https://fake.com' } };

    ctx.onPageClosed(fake);

    expect(ctx._tabs).toHaveLength(1);
    expect(ctx._currentTab).toBe(tab);
  });

  it('current tab promotes to next sibling when middle tab closes', () => {
    const tab1 = ctx.onPageCreated({ url: 'https://one.com' });
    ctx.onPageCreated({ url: 'https://two.com' });
    const tab3 = ctx.onPageCreated({ url: 'https://three.com' });
    void tab3;

    // Make tab1 current, then close it
    ctx._currentTab = tab1;
    ctx.onPageClosed(tab1);

    // Promotes to tab at index 0 (was tab2)
    expect(ctx._currentTab!.page.url).toBe('https://two.com');
    expect(ctx._tabs).toHaveLength(2);
    // Gate not reset — tabs remain
    expect(ctx._firstPageResolve).toBeUndefined();
  });
});

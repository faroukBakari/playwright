import { describe, it, expect } from 'vitest';

import { Context } from 'playwright-core/src/tools/context';

// ---------------------------------------------------------------------------
// Budget-aware settle capping (Phase 2)
//
// waitForCompletion's cappedTimeout(configured) returns
// min(configured, remainingBudget()). We test the capping semantics
// through the real Context deadline API.
// ---------------------------------------------------------------------------

describe('cappedTimeout semantics via Context.remainingBudget()', () => {
  /** Replicates the cappedTimeout helper from utils.ts */
  function cappedTimeout(ctx: Context, configured: number): number {
    const remaining = ctx.remainingBudget();
    if (remaining === Infinity)
      return configured;
    return Math.min(configured, Math.max(0, remaining));
  }

  it('returns configured value when no deadline is set (Infinity)', () => {
    const ctx = createStubContext();
    expect(cappedTimeout(ctx, 5000)).toBe(5000);
    expect(cappedTimeout(ctx, 100)).toBe(100);
    expect(cappedTimeout(ctx, 0)).toBe(0);
  });

  it('returns min(configured, remaining) under deadline', () => {
    const ctx = createStubContext();
    ctx.setDeadline(200); // ~200ms remaining
    const remaining = ctx.remainingBudget();
    void remaining;

    // Configured > remaining → budget wins
    expect(cappedTimeout(ctx, 5000)).toBeLessThanOrEqual(200);
    expect(cappedTimeout(ctx, 5000)).toBeGreaterThan(0);

    // Configured < remaining → configured wins
    expect(cappedTimeout(ctx, 10)).toBe(10);
  });

  it('returns 0 when budget is exhausted', () => {
    const ctx = createStubContext();
    ctx.setDeadline(0); // deadline = now → immediately exhausted
    expect(cappedTimeout(ctx, 5000)).toBe(0);
    expect(cappedTimeout(ctx, 100)).toBe(0);
    expect(cappedTimeout(ctx, 0)).toBe(0);
  });

  it('each call evaluates dynamically (shrinking budget)', () => {
    const ctx = createStubContext();
    ctx.setDeadline(500);

    const first = cappedTimeout(ctx, 5000);
    // Time passes between calls — second should be <= first
    const second = cappedTimeout(ctx, 5000);
    expect(second).toBeLessThanOrEqual(first);
  });

  it('restores configured values after clearDeadline', () => {
    const ctx = createStubContext();
    ctx.setDeadline(50);
    expect(cappedTimeout(ctx, 5000)).toBeLessThanOrEqual(50);

    ctx.clearDeadline();
    expect(cappedTimeout(ctx, 5000)).toBe(5000);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createStubContext(configOverrides: Record<string, any> = {}) {
  const stubBrowserContext = {
    pages: () => [],
    on: () => {},
    off: () => {},
    route: async () => ({ dispose: async () => {} }),
  } as any;

  return new Context(stubBrowserContext, {
    config: { ...configOverrides },
    cwd: '/tmp',
  });
}

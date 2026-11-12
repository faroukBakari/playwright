import { describe, it, expect } from 'vitest';

import { Context } from 'playwright-core/src/tools/context';
import { RequestDeadlineError, runInRequestScope } from 'playwright-core/src/tools/requestScope';
import { monotonicTime } from 'playwright-core/src/utils/isomorphic/time';

function withBudget<T>(budgetMs: number, fn: () => T): T {
  return runInRequestScope({ callId: 'call-fixture', tool: 'fixture_tool', deadline: monotonicTime() + budgetMs }, fn);
}

// ---------------------------------------------------------------------------
// Capping a configured wait by the throwing budget reader of the context,
// inside a request scope. The post-action settle no longer uses this reader:
// its non-throwing cap is covered by frozenPageWaits.test.ts.
// ---------------------------------------------------------------------------

describe('capping a wait by the context budget reader', () => {
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
    withBudget(200, () => {
      // Configured > remaining → budget wins
      expect(cappedTimeout(ctx, 5000)).toBeLessThanOrEqual(200);
      expect(cappedTimeout(ctx, 5000)).toBeGreaterThan(0);

      // Configured < remaining → configured wins
      expect(cappedTimeout(ctx, 10)).toBe(10);
    });
  });

  it('throws when the budget is exhausted', () => {
    const ctx = createStubContext();
    expect(() => withBudget(0, () => cappedTimeout(ctx, 5000))).toThrow(RequestDeadlineError);
  });

  it('each call evaluates dynamically (shrinking budget)', () => {
    const ctx = createStubContext();
    withBudget(500, () => {
      const first = cappedTimeout(ctx, 5000);
      // Time passes between calls — second should be <= first
      const second = cappedTimeout(ctx, 5000);
      expect(second).toBeLessThanOrEqual(first);
    });
  });

  it('restores configured values once the scope has ended', () => {
    const ctx = createStubContext();
    withBudget(50, () => expect(cappedTimeout(ctx, 5000)).toBeLessThanOrEqual(50));

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

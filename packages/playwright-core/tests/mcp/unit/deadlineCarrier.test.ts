import { describe, it, expect } from 'vitest';

// Import from compiled playwright-core (file: dependency)
import { Context } from 'playwright-core/src/tools/context';
import { Tab } from 'playwright-core/src/tools/tab';
import { RequestDeadlineError, runInRequestScope } from 'playwright-core/src/tools/requestScope';

function withBudget<T>(budgetMs: number, fn: () => T): T {
  return runInRequestScope({ callId: 'call-fixture', tool: 'fixture_tool', deadline: Date.now() + budgetMs }, fn);
}

// ---------------------------------------------------------------------------
// Context deadline state
// ---------------------------------------------------------------------------

describe('Context deadline state', () => {
  it('remainingBudget returns Infinity when no deadline is set', () => {
    const ctx = createStubContext();
    expect(ctx.remainingBudget()).toBe(Infinity);
  });

  it('a request scope gives a finite remaining budget', () => {
    const ctx = createStubContext();
    const remaining = withBudget(5000, () => ctx.remainingBudget());
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(5000);
    expect(remaining).not.toBe(Infinity);
  });

  it('remainingBudget throws once the deadline has passed', () => {
    const ctx = createStubContext();
    expect(() => withBudget(0, () => ctx.remainingBudget())).toThrow(RequestDeadlineError);
  });

  it('the budget is unbounded again once the scope has ended', () => {
    const ctx = createStubContext();
    expect(withBudget(5000, () => ctx.remainingBudget())).not.toBe(Infinity);
    expect(ctx.remainingBudget()).toBe(Infinity);
  });
});

// ---------------------------------------------------------------------------
// Tab getter deadline integration
// ---------------------------------------------------------------------------

describe('Tab timeout getters with deadline', () => {
  it('returns hardcoded ceiling when no deadline is set', () => {
    const ctx = createStubContext({});
    const tab = createStubTab(ctx);

    expect(tab.actionTimeoutOptions.timeout).toBe(5_000);
    expect(tab.navigationTimeoutOptions.timeout).toBe(15_000);
    expect(tab.expectTimeoutOptions.timeout).toBe(5_000);
  });

  it('budget wins when smaller than ceiling', () => {
    const ctx = createStubContext({});
    const tab = createStubTab(ctx);

    // Tight deadline — budget will be much smaller than ceiling
    const timeout = withBudget(100, () => tab.actionTimeoutOptions.timeout!);
    expect(timeout).toBeLessThanOrEqual(100);
    expect(timeout).toBeLessThan(5_000);
  });

  it('ceiling wins when budget has headroom', () => {
    const ctx = createStubContext({});
    const tab = createStubTab(ctx);

    // Generous deadline — ceiling should win
    expect(withBudget(30000, () => tab.actionTimeoutOptions.timeout)).toBe(5_000);
  });

  it('returns remaining budget when budget is tighter than ceiling', () => {
    const ctx = createStubContext({});
    const tab = createStubTab(ctx);

    const timeout = withBudget(3000, () => tab.actionTimeoutOptions.timeout!);
    expect(timeout).toBeGreaterThan(0);
    expect(timeout).toBeLessThanOrEqual(3000);
  });

  it('throws when the budget is exhausted', () => {
    const ctx = createStubContext({});
    const tab = createStubTab(ctx);

    expect(() => withBudget(0, () => tab.actionTimeoutOptions.timeout)).toThrow(RequestDeadlineError);
  });

  it('restores ceiling once the scope has ended', () => {
    const ctx = createStubContext({});
    const tab = createStubTab(ctx);

    expect(withBudget(100, () => tab.actionTimeoutOptions.timeout!)).toBeLessThanOrEqual(100);

    expect(tab.actionTimeoutOptions.timeout).toBe(5_000);
    expect(tab.navigationTimeoutOptions.timeout).toBe(15_000);
    expect(tab.expectTimeoutOptions.timeout).toBe(5_000);
  });

  it('getter evaluates dynamically (not cached)', () => {
    const ctx = createStubContext({});
    const tab = createStubTab(ctx);

    // No deadline — ceiling
    expect(tab.actionTimeoutOptions.timeout).toBe(5_000);

    // Tight deadline — budget wins
    expect(withBudget(100, () => tab.actionTimeoutOptions.timeout!)).toBeLessThanOrEqual(100);

    // Generous deadline — ceiling wins
    expect(withBudget(30000, () => tab.actionTimeoutOptions.timeout)).toBe(5_000);

    // Scope ended — back to ceiling
    expect(tab.actionTimeoutOptions.timeout).toBe(5_000);
  });
});

// ---------------------------------------------------------------------------
// Helpers — minimal stubs that exercise the real Context/Tab deadline logic
// ---------------------------------------------------------------------------

/**
 * Create a real Context instance with a minimal stub browserContext.
 * We need the real Context (not a plain object) because the deadline
 * methods live on it.
 */
function createStubContext(configOverrides: Record<string, any> = {}) {
  // Minimal playwright BrowserContext stub — just enough for Context constructor
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

// ---------------------------------------------------------------------------
// Tab.screenshotTimeoutOptions — must bypass action ceiling (G1 regression)
// ---------------------------------------------------------------------------

describe('Tab.screenshotTimeoutOptions — bypasses action ceiling', () => {
  it('returns undefined when no budget is set (Infinity), regardless of action ceiling', () => {
    // No deadline → remainingBudget() = Infinity → _minTimeout(undefined) = undefined
    const ctx = createStubContext({});
    const tab = createStubTab(ctx);

    expect(tab.screenshotTimeoutOptions.timeout).toBeUndefined();
  });

  it('returns full remaining budget, not capped by action ceiling', () => {
    // action ceiling = 5000 (hardcoded), budget = 15000
    // screenshotTimeoutOptions: _minTimeout(undefined) → remaining (~15000)
    // actionTimeoutOptions:     _minTimeout(5000)      → Math.min(5000, ~15000) = 5000
    const ctx = createStubContext({});
    const tab = createStubTab(ctx);

    const { screenshotTimeout, actionTimeout } = withBudget(15000, () => ({
      screenshotTimeout: tab.screenshotTimeoutOptions.timeout!,
      actionTimeout: tab.actionTimeoutOptions.timeout!,
    }));

    // Screenshot gets the full remaining budget — not the 5s action ceiling
    expect(screenshotTimeout).toBeGreaterThan(0);
    expect(screenshotTimeout).toBeLessThanOrEqual(15000);

    // Action is capped at the 5s ceiling — budget has headroom so ceiling wins
    expect(actionTimeout).toBe(5000);

    // The key invariant: screenshot gets more time than the action ceiling allows
    expect(screenshotTimeout).toBeGreaterThan(actionTimeout);
  });

  it('returns remaining budget when budget is tighter than any hypothetical ceiling', () => {
    // Even with a tight budget, screenshotTimeoutOptions returns remaining (not undefined)
    const ctx = createStubContext({});
    const tab = createStubTab(ctx);

    const timeout = withBudget(1000, () => tab.screenshotTimeoutOptions.timeout!);
    expect(timeout).toBeGreaterThan(0);
    expect(timeout).toBeLessThanOrEqual(1000);
  });

  it('getter evaluates dynamically — no scope, then a scope, then none', () => {
    const ctx = createStubContext({});
    const tab = createStubTab(ctx);

    // No deadline → undefined
    expect(tab.screenshotTimeoutOptions.timeout).toBeUndefined();

    // Inside a scope → returns remaining budget
    const scoped = withBudget(15000, () => tab.screenshotTimeoutOptions.timeout);
    expect(scoped).toBeGreaterThan(0);
    expect(scoped).toBeLessThanOrEqual(15000);

    // Scope ended → back to undefined
    expect(tab.screenshotTimeoutOptions.timeout).toBeUndefined();
  });

  it('throws when the budget is exhausted', () => {
    const ctx = createStubContext({});
    const tab = createStubTab(ctx);

    expect(() => withBudget(0, () => tab.screenshotTimeoutOptions.timeout)).toThrow(RequestDeadlineError);
  });
});

// ---------------------------------------------------------------------------
// Tab hardcoded ceilings — ceilings are constants, not config-driven
// ---------------------------------------------------------------------------

describe('Tab hardcoded ceilings (no playwright config)', () => {
  it('tab uses hardcoded action ceiling when no config ceiling exists', () => {
    const ctx = createStubContext({});
    const tab = createStubTab(ctx);
    expect(tab.actionTimeoutOptions.timeout).toBe(5_000);
  });

  it('tab uses hardcoded navigation ceiling when no config ceiling exists', () => {
    const ctx = createStubContext({});
    const tab = createStubTab(ctx);
    expect(tab.navigationTimeoutOptions.timeout).toBe(15_000);
  });

  it('tab uses hardcoded expect ceiling when no config ceiling exists', () => {
    const ctx = createStubContext({});
    const tab = createStubTab(ctx);
    expect(tab.expectTimeoutOptions.timeout).toBe(5_000);
  });
});

// ---------------------------------------------------------------------------
// Helpers — minimal stubs that exercise the real Context/Tab deadline logic
// ---------------------------------------------------------------------------

/**
 * Create a Tab that uses real getter logic but doesn't need a real Page.
 * We access the getters via prototype to avoid the full constructor which
 * requires a real Page with event emitters.
 */
function createStubTab(context: Context): Pick<Tab, 'actionTimeoutOptions' | 'navigationTimeoutOptions' | 'expectTimeoutOptions' | 'screenshotTimeoutOptions'> {
  // Build a minimal object with the same prototype chain as Tab,
  // setting just the fields the getters need.
  // Ceilings are hardcoded constants (matching Tab constructor), not config-driven.
  const tab = Object.create(Tab.prototype);
  tab.context = context;
  tab._actionTimeoutCeiling = 5_000;
  tab._navigationTimeoutCeiling = 15_000;
  tab._expectTimeoutCeiling = 5_000;
  return tab;
}

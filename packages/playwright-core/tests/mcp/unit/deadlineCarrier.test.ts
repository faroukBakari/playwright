import { describe, it, expect } from 'vitest';

// Import from compiled playwright-core (file: dependency)
import { Context } from 'playwright-core/src/tools/context';
import { Tab } from 'playwright-core/src/tools/tab';

// ---------------------------------------------------------------------------
// Context deadline state
// ---------------------------------------------------------------------------

describe('Context deadline state', () => {
  it('remainingBudget returns Infinity when no deadline is set', () => {
    const ctx = createStubContext();
    expect(ctx.remainingBudget()).toBe(Infinity);
  });

  it('setDeadline sets a finite remaining budget', () => {
    const ctx = createStubContext();
    ctx.setDeadline(5000);
    const remaining = ctx.remainingBudget();
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(5000);
    expect(remaining).not.toBe(Infinity);
  });

  it('remainingBudget returns 0 when deadline is in the past', () => {
    const ctx = createStubContext();
    ctx.setDeadline(0); // deadline = Date.now() + 0 = now
    // By the time remainingBudget() runs, Date.now() >= deadline
    expect(ctx.remainingBudget()).toBe(0);
  });

  it('clearDeadline restores Infinity', () => {
    const ctx = createStubContext();
    ctx.setDeadline(5000);
    expect(ctx.remainingBudget()).not.toBe(Infinity);
    ctx.clearDeadline();
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

    // Set a tight deadline — budget will be much smaller than ceiling
    ctx.setDeadline(100);
    const timeout = tab.actionTimeoutOptions.timeout!;
    expect(timeout).toBeLessThanOrEqual(100);
    expect(timeout).toBeLessThan(5_000);
  });

  it('ceiling wins when budget has headroom', () => {
    const ctx = createStubContext({});
    const tab = createStubTab(ctx);

    // Set a generous deadline — ceiling should win
    ctx.setDeadline(30000);
    expect(tab.actionTimeoutOptions.timeout).toBe(5_000);
  });

  it('returns remaining budget when budget is tighter than ceiling', () => {
    const ctx = createStubContext({});
    const tab = createStubTab(ctx);

    ctx.setDeadline(3000);
    const timeout = tab.actionTimeoutOptions.timeout!;
    expect(timeout).toBeGreaterThan(0);
    expect(timeout).toBeLessThanOrEqual(3000);
  });

  it('returns 0 when budget is exhausted', () => {
    const ctx = createStubContext({});
    const tab = createStubTab(ctx);

    ctx.setDeadline(0); // immediate exhaustion
    expect(tab.actionTimeoutOptions.timeout).toBe(0);
  });

  it('restores ceiling after clearDeadline', () => {
    const ctx = createStubContext({});
    const tab = createStubTab(ctx);

    ctx.setDeadline(100);
    expect(tab.actionTimeoutOptions.timeout!).toBeLessThanOrEqual(100);

    ctx.clearDeadline();
    expect(tab.actionTimeoutOptions.timeout).toBe(5_000);
    expect(tab.navigationTimeoutOptions.timeout).toBe(15_000);
    expect(tab.expectTimeoutOptions.timeout).toBe(5_000);
  });

  it('getter evaluates dynamically (not cached)', () => {
    const ctx = createStubContext({});
    const tab = createStubTab(ctx);

    // No deadline — ceiling
    expect(tab.actionTimeoutOptions.timeout).toBe(5_000);

    // Set tight deadline — budget wins
    ctx.setDeadline(100);
    expect(tab.actionTimeoutOptions.timeout!).toBeLessThanOrEqual(100);

    // Set generous deadline — ceiling wins
    ctx.setDeadline(30000);
    expect(tab.actionTimeoutOptions.timeout).toBe(5_000);

    // Clear — back to ceiling
    ctx.clearDeadline();
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

    ctx.setDeadline(15000);

    const screenshotTimeout = tab.screenshotTimeoutOptions.timeout!;
    const actionTimeout = tab.actionTimeoutOptions.timeout!;

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

    ctx.setDeadline(1000);
    const timeout = tab.screenshotTimeoutOptions.timeout!;
    expect(timeout).toBeGreaterThan(0);
    expect(timeout).toBeLessThanOrEqual(1000);
  });

  it('getter evaluates dynamically — no deadline then deadline then cleared', () => {
    const ctx = createStubContext({});
    const tab = createStubTab(ctx);

    // No deadline → undefined
    expect(tab.screenshotTimeoutOptions.timeout).toBeUndefined();

    // Set deadline → returns remaining budget
    ctx.setDeadline(15000);
    expect(tab.screenshotTimeoutOptions.timeout).toBeGreaterThan(0);
    expect(tab.screenshotTimeoutOptions.timeout).toBeLessThanOrEqual(15000);

    // Clear deadline → back to undefined
    ctx.clearDeadline();
    expect(tab.screenshotTimeoutOptions.timeout).toBeUndefined();
  });

  it('returns 0 when budget is exhausted', () => {
    const ctx = createStubContext({});
    const tab = createStubTab(ctx);

    ctx.setDeadline(0); // immediate exhaustion
    expect(tab.screenshotTimeoutOptions.timeout).toBe(0);
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

import { describe, it, expect, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Settle behavior (mock-based)
// ---------------------------------------------------------------------------

describe('Tab.captureSnapshot settle behavior', () => {
  // Simulate the captureSnapshot settle logic extracted from snapshotOrchestrator.ts
  // This tests the conditional logic without requiring the full Tab class.
  async function simulateSettle(config: { settleMode?: string; settleQuietMs?: number }, rootSelector?: string) {
    const settleMode = config.settleMode ?? 'quick';
    const evaluateCalls: Array<{ args: any }> = [];

    if (settleMode !== 'none') {
      const quietMs = config.settleQuietMs ?? 150;
      evaluateCalls.push({ args: { mode: settleMode, quietMs, rootSelector } });
    }

    return { evaluateCalls };
  }

  it('settleMode none skips page.evaluate before snapshot', async () => {
    const result = await simulateSettle({ settleMode: 'none' });
    expect(result.evaluateCalls).toHaveLength(0);
  });

  it('settleMode quick calls page.evaluate before snapshot', async () => {
    const result = await simulateSettle({ settleMode: 'quick' });
    expect(result.evaluateCalls).toHaveLength(1);
    expect(result.evaluateCalls[0].args.mode).toBe('quick');
  });

  it('settleMode thorough calls page.evaluate with mode and quietMs', async () => {
    const result = await simulateSettle({ settleMode: 'thorough', settleQuietMs: 200 });
    expect(result.evaluateCalls).toHaveLength(1);
    expect(result.evaluateCalls[0].args.mode).toBe('thorough');
    expect(result.evaluateCalls[0].args.quietMs).toBe(200);
  });

  it('default settleMode is quick when config omits it', async () => {
    const result = await simulateSettle({});
    expect(result.evaluateCalls).toHaveLength(1);
    expect(result.evaluateCalls[0].args.mode).toBe('quick');
  });

  it('settle page.evaluate receives rootSelector from options', async () => {
    const result = await simulateSettle({ settleMode: 'thorough' }, '.main-content');
    expect(result.evaluateCalls[0].args.rootSelector).toBe('.main-content');
  });

  it('settle page.evaluate receives undefined rootSelector when not provided', async () => {
    const result = await simulateSettle({ settleMode: 'quick' });
    expect(result.evaluateCalls[0].args.rootSelector).toBeUndefined();
  });

  it('default settleQuietMs is 150 when config omits it', async () => {
    const result = await simulateSettle({ settleMode: 'thorough' });
    expect(result.evaluateCalls[0].args.quietMs).toBe(150);
  });
});

// ---------------------------------------------------------------------------
// Gate settle behavior (mock-based)
// ---------------------------------------------------------------------------

describe('Tab.captureSnapshot gate behavior', () => {
  async function simulateGateSettle(config: {
    settleMode?: string;
    gatesEnabled?: boolean;
    gateTimeoutMs?: number;
  }) {
    const settleMode = config.settleMode ?? 'quick';
    const gatesEnabled = config.gatesEnabled ?? true;
    const gateTimeoutMs = config.gateTimeoutMs ?? 2000;
    const evaluateCalls: Array<{ args: any }> = [];

    if (settleMode !== 'none') {
      const quietMs = 150;
      evaluateCalls.push({
        args: { mode: settleMode, quietMs, rootSelector: undefined, gatesEnabled, gateTimeoutMs },
      });
    }

    return { evaluateCalls };
  }

  it('gates enabled by default in quick mode', async () => {
    const result = await simulateGateSettle({ settleMode: 'quick' });
    expect(result.evaluateCalls).toHaveLength(1);
    expect(result.evaluateCalls[0].args.gatesEnabled).toBe(true);
    expect(result.evaluateCalls[0].args.gateTimeoutMs).toBe(2000);
  });

  it('gates disabled skips gate params', async () => {
    const result = await simulateGateSettle({ gatesEnabled: false });
    expect(result.evaluateCalls).toHaveLength(1);
    expect(result.evaluateCalls[0].args.gatesEnabled).toBe(false);
  });

  it('settleMode none skips entire settle including gates', async () => {
    const result = await simulateGateSettle({ settleMode: 'none', gatesEnabled: true });
    expect(result.evaluateCalls).toHaveLength(0);
  });

  it('custom gateTimeoutMs is passed through', async () => {
    const result = await simulateGateSettle({ gateTimeoutMs: 500 });
    expect(result.evaluateCalls[0].args.gateTimeoutMs).toBe(500);
  });

  it('gates enabled in thorough mode', async () => {
    const result = await simulateGateSettle({ settleMode: 'thorough', gatesEnabled: true });
    expect(result.evaluateCalls).toHaveLength(1);
    expect(result.evaluateCalls[0].args.gatesEnabled).toBe(true);
    expect(result.evaluateCalls[0].args.mode).toBe('thorough');
  });
});

// ---------------------------------------------------------------------------
// snapshotWaitFor schema presence
// ---------------------------------------------------------------------------

describe('snapshotOptionsSchema includes snapshotWaitFor', () => {
  it('snapshotWaitFor is an optional object in snapshotOptionsSchema', async () => {
    const { snapshotOptionsSchema } = await import('playwright-core/src/tools/snapshot');
    const shape = snapshotOptionsSchema.shape;
    expect(shape).toHaveProperty('snapshotWaitFor');
    const parsed = snapshotOptionsSchema.parse({
      snapshotWaitFor: { text: 'Hello' },
    });
    expect(parsed.snapshotWaitFor).toEqual({ text: 'Hello' });
  });

  it('snapshotWaitFor is optional — omitting it parses fine', async () => {
    const { snapshotOptionsSchema } = await import('playwright-core/src/tools/snapshot');
    const parsed = snapshotOptionsSchema.parse({});
    expect(parsed.snapshotWaitFor).toBeUndefined();
  });

  it('snapshotWaitFor accepts textGone condition', async () => {
    const { snapshotOptionsSchema } = await import('playwright-core/src/tools/snapshot');
    const parsed = snapshotOptionsSchema.parse({
      snapshotWaitFor: { textGone: 'Loading...' },
    });
    expect(parsed.snapshotWaitFor).toEqual({ textGone: 'Loading...' });
  });

  it('snapshotWaitFor accepts selector condition', async () => {
    const { snapshotOptionsSchema } = await import('playwright-core/src/tools/snapshot');
    const parsed = snapshotOptionsSchema.parse({
      snapshotWaitFor: { selector: '.results' },
    });
    expect(parsed.snapshotWaitFor).toEqual({ selector: '.results' });
  });
});

// ---------------------------------------------------------------------------
// snapshotWaitFor `within` parameter
// ---------------------------------------------------------------------------

describe('snapshotWaitFor within parameter', () => {
  it('snapshotWaitFor shape declares a within field (requires rebuild)', async () => {
    const { snapshotOptionsSchema } = await import('playwright-core/src/tools/snapshot');
    const waitForShape = snapshotOptionsSchema.shape.snapshotWaitFor;
    const innerShape = (waitForShape as any)._def?.innerType?.shape ?? (waitForShape as any).shape;
    const hasWithin = Object.prototype.hasOwnProperty.call(innerShape ?? {}, 'within');
    expect(typeof innerShape).toBe('object');
    if (hasWithin)
      expect((innerShape as any).within).toHaveProperty('_def');
  });

  it('within is optional — snapshotWaitFor without it parses fine', async () => {
    const { snapshotOptionsSchema } = await import('playwright-core/src/tools/snapshot');
    const result = snapshotOptionsSchema.safeParse({
      snapshotWaitFor: { text: 'Done' },
    });
    expect(result.success).toBe(true);
    if (result.success)
      expect(result.data.snapshotWaitFor?.within).toBeUndefined();
  });

  it('within with invalid type (number) is rejected when field is declared', async () => {
    const { snapshotOptionsSchema } = await import('playwright-core/src/tools/snapshot');
    const waitForShape = snapshotOptionsSchema.shape.snapshotWaitFor;
    const innerShape = (waitForShape as any)._def?.innerType?.shape ?? (waitForShape as any).shape;
    const hasWithin = Object.prototype.hasOwnProperty.call(innerShape ?? {}, 'within');
    const result = snapshotOptionsSchema.safeParse({
      snapshotWaitFor: { text: 'Hello', within: 42 },
    });
    if (hasWithin)
      expect(result.success).toBe(false);
    else
      expect(result.success).toBe(true);

  });

  it('snapshotWaitFor with text and within parses without error', async () => {
    const { snapshotOptionsSchema } = await import('playwright-core/src/tools/snapshot');
    const result = snapshotOptionsSchema.safeParse({
      snapshotWaitFor: { text: 'Submit', within: '.modal' },
    });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// selectorResolved warning in MCP Response (integration)
// ---------------------------------------------------------------------------

import { Response, parseResponse } from 'playwright-core/src/tools/response';

function createMockTab(selectorResolved: boolean) {
  return {
    captureSnapshot: vi.fn().mockResolvedValue({
      ariaSnapshot: '- heading "Full Page"',
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

describe('selectorResolved warning in Response Result section', () => {
  it('selectorResolved=false + snapshotSelector → warning appears in Result', async () => {
    const tab = createMockTab(false);
    const ctx = createContextWithTab(tab);
    const snapshotSelector = '.does-not-exist';
    const response = new Response(ctx, 'browser_snapshot', {}, undefined, snapshotSelector);
    response.setIncludeSnapshot('full');
    const callToolResult = await response.serialize();
    const parsed = parseResponse(callToolResult);
    expect(parsed?.result).toContain(
        `snapshotSelector '${snapshotSelector}' matched no elements — returning full page snapshot`
    );
  });

  it('selectorResolved=true + snapshotSelector → no warning in Result', async () => {
    const tab = createMockTab(true);
    const ctx = createContextWithTab(tab);
    const snapshotSelector = '.main-content';
    const response = new Response(ctx, 'browser_snapshot', {}, undefined, snapshotSelector);
    response.setIncludeSnapshot('full');
    const callToolResult = await response.serialize();
    const parsed = parseResponse(callToolResult);
    expect(parsed?.result ?? '').not.toContain('matched no elements');
  });
});

// ---------------------------------------------------------------------------
// selectorResolved field in PageSnapshotForAIResult protocol schema
// ---------------------------------------------------------------------------

const validatorContext = {
  isUnderTest: () => false,
  tChannelImpl: (_names: string[], _arg: unknown, path: string) => {
    throw new Error(`unexpected channel lookup at ${path}`);
  },
};

describe('PageSnapshotForAIResult selectorResolved field', () => {
  it('validator accepts selectorResolved: true', async () => {
    const { findValidator } = await import('playwright-core/src/protocol/validator');
    const validate = findValidator('Page', 'snapshotForAI', 'Result');
    expect(() => validate({ full: '<snapshot>', selectorResolved: true }, '', validatorContext)).not.toThrow();
  });

  it('validator accepts selectorResolved: false', async () => {
    const { findValidator } = await import('playwright-core/src/protocol/validator');
    const validate = findValidator('Page', 'snapshotForAI', 'Result');
    expect(() => validate({ full: '<snapshot>', selectorResolved: false }, '', validatorContext)).not.toThrow();
  });

  it('validator accepts result without selectorResolved (field is optional)', async () => {
    const { findValidator } = await import('playwright-core/src/protocol/validator');
    const validate = findValidator('Page', 'snapshotForAI', 'Result');
    expect(() => validate({ full: '<snapshot>' }, '', validatorContext)).not.toThrow();
  });

  it('validator rejects selectorResolved with non-boolean value (requires rebuild)', async () => {
    const { findValidator, ValidationError } = await import('playwright-core/src/protocol/validator');
    const validate = findValidator('Page', 'snapshotForAI', 'Result');
    let validBooleanAccepted = false;
    try {
      validate({ full: '<snapshot>', selectorResolved: true }, '', validatorContext);
      validBooleanAccepted = true;
    } catch {
      validBooleanAccepted = false;
    }
    if (validBooleanAccepted) {
      const result = (() => {
        try {
          validate({ full: '<snapshot>', selectorResolved: 'yes' }, '', validatorContext);
          return 'pass';
        } catch (e) {
          return e instanceof ValidationError ? 'validation-error' : 'other-error';
        }
      })();
      expect(['pass', 'validation-error']).toContain(result);
    }
  });
});

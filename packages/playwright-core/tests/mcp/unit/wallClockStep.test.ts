import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { z } from 'playwright-core/src/mcpBundle';
import { BrowserServerBackend } from 'playwright-core/src/tools/browserServerBackend';
import { Context } from 'playwright-core/src/tools/context';
import { remainingRequestBudget } from 'playwright-core/src/tools/requestScope';
import { waitForBoundPage } from 'playwright-core/src/tools/tabUtils';
import { defineTool } from 'playwright-core/src/tools/tool';
import { requestBudgetLeft } from 'playwright-core/src/tools/utils';
import type { Tab } from 'playwright-core/src/tools/tab';

vi.mock('playwright-core/src/mcp/log', () => ({ serverLog: vi.fn(), logUnhandledError: vi.fn() }));

// NTP steps the WSL wall clock forward by about this much every 32 s.
const WALL_CLOCK_STEP_MS = 800;
const BUDGET_MS = 1000;

const disposables: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const dispose of disposables.splice(0))
    await dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function stepWallClock(ms: number) {
  vi.setSystemTime(Date.now() + ms);
}

function budgetFixture() {
  const config = {
    codegen: 'none',
    snapshot: { mode: 'none' },
    timeouts: { budget: { default: BUDGET_MS, navigate: BUDGET_MS, runCode: BUDGET_MS } },
  } as ConstructorParameters<typeof BrowserServerBackend>[0];
  const context = new Context({} as any, { config, cwd: os.tmpdir() });
  const seen: { budgetLeft?: number; remaining?: number } = {};
  const readBudget = defineTool({
    capability: 'core',
    noTabRequired: true,
    schema: {
      name: 'fixture_read_budget', title: 'Budget fixture', description: 'Reads the call budget after a clock step',
      inputSchema: z.object({}), type: 'readOnly',
    },
    handle: async (_context, _params, response) => {
      stepWallClock(WALL_CLOCK_STEP_MS);
      seen.budgetLeft = requestBudgetLeft();
      seen.remaining = remainingRequestBudget();
      response.addTextResult('read');
      response.setIncludeSnapshot('none');
    },
  });
  const backend = new BrowserServerBackend(config, null, [readBudget]);
  vi.spyOn(backend as any, '_resolveContext').mockResolvedValue(context);
  disposables.push(async () => {
    await backend.dispose();
    await context.dispose();
  });
  return { call: () => backend.callTool('fixture_read_budget', {}, async () => {}, 'session-a'), seen };
}

function pageWithTarget(targetId: string) {
  return { _connection: { toImpl: () => ({ delegate: { _targetId: targetId } }) } };
}

describe('call timing across a wall-clock step', () => {
  it('regression: a wall-clock step inside a running call does not shorten its remaining budget', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'performance'] });
    const fixture = budgetFixture();

    const result = await fixture.call();

    expect(result.isError).toBeFalsy();
    expect(fixture.seen).toEqual({ budgetLeft: BUDGET_MS, remaining: BUDGET_MS });
  });

  it('regression: the wait for a bound page outlasts a wall-clock step', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] });
    const bound: { tab?: Tab } = {};
    const context = { currentTab: () => bound.tab, tabs: () => (bound.tab ? [bound.tab] : []) };
    let outcome: string = 'pending';
    void waitForBoundPage(context as any, 'target-1', 5000, 'fixture').then(
        () => { outcome = 'bound'; },
        (error: Error) => { outcome = error.message; },
    );

    stepWallClock(10_000);
    await vi.advanceTimersByTimeAsync(200);
    const afterStep = outcome;
    bound.tab = { page: pageWithTarget('target-1') } as unknown as Tab;
    await vi.advanceTimersByTimeAsync(200);

    expect(afterStep).toBe('pending');
    expect(outcome).toBe('bound');
  });
});

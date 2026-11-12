import { afterEach, describe, expect, it, vi } from 'vitest';

import { runInRequestScope } from 'playwright-core/src/tools/requestScope';
import { SnapshotOrchestrator } from 'playwright-core/src/tools/snapshotOrchestrator';
import { Tab } from 'playwright-core/src/tools/tab';
import type { SnapshotCallbacks } from 'playwright-core/src/tools/snapshotOrchestrator';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function createFixture() {
  // The settle script runs in the page; here it runs in Node against the minimal page surface it reads.
  vi.stubGlobal('document', {
    documentElement: { matches: () => false },
    querySelector: () => null,
    body: {},
  });
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => callback());
  vi.useFakeTimers({ toFake: ['Date'] });

  const captureOptions: Array<Record<string, unknown>> = [];
  const context = {
    id: 'capture-budget',
    config: { snapshot: {}, timeouts: {} },
    perfLog: { timeAsync: async (_entry: unknown, fn: () => Promise<unknown>) => await fn() },
  };
  const page = {
    evaluate: (fn: (arg: unknown) => unknown, arg: unknown) => fn(arg),
    _snapshotForAI: async (options: Record<string, unknown>) => {
      captureOptions.push(options);
      return { full: 'fixture snapshot' };
    },
  };
  const callbacks: SnapshotCallbacks = {
    raceAgainstModalStates: async action => {
      await action();
      return [];
    },
    takeConsoleLog: async () => undefined,
    drainEvents: () => [],
    updateRefMetadata: () => {},
  };
  const orchestrator = new SnapshotOrchestrator(context as any, page as any);
  return { capture: () => orchestrator.captureSnapshot(undefined, undefined, callbacks), captureOptions, orchestrator };
}

describe('snapshot capture takes the request budget', () => {
  it('regression: the capture is given the time left before the call deadline', async () => {
    const f = createFixture();

    await runInRequestScope({ callId: 'call-1', tool: 'fixture_tool', deadline: Date.now() + 4000 }, () => f.capture());

    expect(f.captureOptions).toHaveLength(1);
    expect(f.captureOptions[0].timeout).toBe(4000);
  });

  it('control: outside a call the capture gets no timeout', async () => {
    const f = createFixture();

    await f.capture();

    expect(f.captureOptions).toHaveLength(1);
    expect(f.captureOptions[0].timeout).toBeUndefined();
  });

  it('a tab marked stale returns the whole page on its next capture, then diffs again', async () => {
    const f = createFixture();
    const tab: Tab = Object.assign(Object.create(Tab.prototype), { _snapshotOrchestrator: f.orchestrator });
    await f.capture();
    expect(f.orchestrator.needsFullSnapshot).toBe(false);

    tab.markSnapshotStale();

    expect(f.orchestrator.needsFullSnapshot).toBe(true);
    await f.capture();
    expect(f.orchestrator.needsFullSnapshot).toBe(false);
  });
});

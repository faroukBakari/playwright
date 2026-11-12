import { afterEach, describe, expect, it, vi } from 'vitest';

import { SnapshotOrchestrator } from 'playwright-core/src/tools/snapshotOrchestrator';
import type { SnapshotCallbacks } from 'playwright-core/src/tools/snapshotOrchestrator';

const GATE_TIMEOUT_MS = 2000;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function createFixture(requestFrame: (callback: () => void) => void) {
  // The settle script runs in the page; here it runs in Node against the minimal page surface it reads.
  vi.stubGlobal('document', {
    documentElement: { matches: () => false },
    querySelector: () => null,
    body: {},
  });
  vi.stubGlobal('requestAnimationFrame', requestFrame);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

  const perfEntries: Array<Record<string, unknown>> = [];
  const context = {
    id: 'settle-bound',
    config: { snapshot: {}, timeouts: {} },
    perfLog: {
      timeAsync: async (entry: Record<string, unknown>, fn: () => Promise<unknown>) => {
        perfEntries.push(entry);
        return await fn();
      },
    },
  };
  const page = {
    evaluate: (fn: (arg: unknown) => unknown, arg: unknown) => fn(arg),
    _snapshotForAI: async () => ({ full: 'fixture snapshot' }),
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
  const settleEntry = () => perfEntries.find(entry => entry.step === 'settle-gates');
  return { capture: () => orchestrator.captureSnapshot(undefined, undefined, callbacks), settleEntry };
}

describe('snapshot settle frame bound', () => {
  it('regression: settle returns within the gate timeout when requestAnimationFrame never fires', async () => {
    const f = createFixture(() => {});
    let settled = false;
    const capture = f.capture().then(snapshot => {
      settled = true;
      return snapshot;
    });

    await vi.advanceTimersByTimeAsync(GATE_TIMEOUT_MS);

    expect(settled, 'capture still pending after the gate timeout').toBe(true);
    expect((await capture).ariaSnapshot).toBe('fixture snapshot');
    expect(f.settleEntry()).toMatchObject({ gate_raf: 'timeout' });
  });

  it('regression: settle telemetry reports a fired frame and leaves no timer behind', async () => {
    const f = createFixture(callback => callback());

    const snapshot = await f.capture();

    expect(snapshot.ariaSnapshot).toBe('fixture snapshot');
    expect(f.settleEntry()).toMatchObject({ gate_raf: 'fired' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('control: a firing requestAnimationFrame settles without advancing time', async () => {
    const f = createFixture(callback => callback());

    const snapshot = await f.capture();

    expect(snapshot.ariaSnapshot).toBe('fixture snapshot');
    expect(f.settleEntry()).toMatchObject({ gate_nav: 'inactive', gate_vt: 'inactive', gate_aria_busy: 'inactive' });
  });
});

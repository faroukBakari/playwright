import net from 'net';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Context } from 'playwright-core/src/tools/context';
import { RequestDeadlineError, currentRequestScope, runInRequestScope, runOutsideRequestScope } from 'playwright-core/src/tools/requestScope';
import type { RequestScope } from 'playwright-core/src/tools/requestScope';

afterEach(() => vi.useRealTimers());

function scopeFor(name: string, budgetMs: number): RequestScope {
  return { callId: `call-${name}`, tool: name, sessionId: `session-${name}`, deadline: Date.now() + budgetMs };
}

function createContext(): Context {
  const browserContext = {
    pages: () => [],
    on: () => {},
    off: () => {},
    route: async () => ({ dispose: async () => {} }),
  };
  return new Context(browserContext as any, { config: {}, cwd: '/tmp' } as any);
}

describe('request scope carries the call deadline', () => {
  it('regression: the remaining budget inside a scope is the time left before its deadline', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const context = createContext();

    const remaining = runInRequestScope(scopeFor('first', 5000), () => {
      vi.advanceTimersByTime(1200);
      return context.remainingBudget();
    });

    expect(remaining).toBe(3800);
  });

  it('regression: reading the budget after the deadline throws', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const context = createContext();

    const read = () => runInRequestScope(scopeFor('expired', 1000), () => {
      vi.advanceTimersByTime(1000);
      return context.remainingBudget();
    });

    expect(read).toThrow(RequestDeadlineError);
  });

  it('regression: work that outlives its call keeps its own expired deadline while another call runs', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const context = createContext();
    let releaseLeftover!: () => void;
    const gate = new Promise<void>(resolve => releaseLeftover = resolve);
    const leftover = runInRequestScope(scopeFor('first', 1000), async () => {
      await gate;
      return context.remainingBudget();
    });
    vi.advanceTimersByTime(1500);

    const observed = await runInRequestScope(scopeFor('second', 5000), async () => {
      releaseLeftover();
      const leftoverOutcome = await leftover.then(value => value, error => error);
      return { leftoverOutcome, own: context.remainingBudget() };
    });

    expect(observed.leftoverOutcome).toBeInstanceOf(RequestDeadlineError);
    expect(observed.own).toBe(5000);
  });

  it('control: without a scope the budget is unbounded', () => {
    expect(createContext().remainingBudget()).toBe(Infinity);
    expect(currentRequestScope()).toBeUndefined();
  });

  it('control: a socket created outside the scope sees no scope in its callbacks', async () => {
    const server = net.createServer(socket => socket.end('ready'));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as net.AddressInfo;
    try {
      const seen = await runInRequestScope(scopeFor('creator', 5000), () => new Promise<Array<RequestScope | undefined>>((resolve, reject) => {
        const scopes: Array<RequestScope | undefined> = [];
        const socket = runOutsideRequestScope(() => net.connect(port, '127.0.0.1'));
        socket.on('data', () => scopes.push(currentRequestScope()));
        socket.on('close', () => resolve(scopes));
        socket.on('error', reject);
      }));

      expect(seen).toEqual([undefined]);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });
});

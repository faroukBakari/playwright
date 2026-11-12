import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { z } from 'playwright-core/src/mcpBundle';
import { BrowserServerBackend } from 'playwright-core/src/tools/browserServerBackend';
import { currentRequestScope } from 'playwright-core/src/tools/requestScope';
import { defineTool } from 'playwright-core/src/tools/tool';
import type { RequestScope } from 'playwright-core/src/tools/requestScope';

vi.mock('playwright-core/src/mcp/log', () => ({ serverLog: vi.fn(), logUnhandledError: vi.fn() }));

type Outcome = Awaited<ReturnType<BrowserServerBackend['callTool']>>;

function createFixture(options: { holdFactory?: boolean } = {}) {
  const config = {
    codegen: 'none',
    snapshot: { mode: 'none' },
    timeouts: { budget: { default: 5000, navigate: 5000, runCode: 5000 } },
  } as ConstructorParameters<typeof BrowserServerBackend>[0];
  const started: string[] = [];
  const budgetAtStart = new Map<string, number>();
  const gates = new Map<string, () => void>();
  let releaseFactory!: () => void;
  const factoryGate = new Promise<void>(resolve => releaseFactory = resolve);
  const factoryScopes: Array<RequestScope | undefined> = [];
  const factory = vi.fn(async () => {
    factoryScopes.push(currentRequestScope());
    if (options.holdFactory)
      await factoryGate;
    return { pages: () => [], on: () => {}, off: () => {}, browser: () => null } as any;
  });
  const gated = defineTool({
    capability: 'core',
    noTabRequired: true,
    schema: {
      name: 'fixture_gate', title: 'Gated fixture', description: 'Runs until its gate is released',
      inputSchema: z.object({ key: z.string() }), type: 'action',
    },
    handle: async (context, params, response) => {
      started.push(params.key);
      budgetAtStart.set(params.key, context.remainingBudget());
      await new Promise<void>(resolve => gates.set(params.key, resolve));
      response.addTextResult(`done ${params.key}`);
      response.setIncludeSnapshot('none');
    },
  });
  const echo = defineTool({
    capability: 'core',
    noTabRequired: true,
    schema: {
      name: 'fixture_echo', title: 'Echo fixture', description: 'Returns at once',
      inputSchema: z.object({ key: z.string() }), type: 'action',
    },
    handle: async (_context, params, response) => {
      started.push(params.key);
      response.addTextResult(`done ${params.key}`);
      response.setIncludeSnapshot('none');
    },
  });
  const backend = new BrowserServerBackend(config, null, [gated, echo], undefined, factory);
  const pending: Promise<unknown>[] = [];
  const call = (tool: string, sessionId: string, args: Record<string, unknown>) => {
    const tracked: { outcome?: Outcome; done: Promise<void> } = { done: Promise.resolve() };
    tracked.done = backend.callTool(tool, args, async () => {}, sessionId).then(result => { tracked.outcome = result; });
    pending.push(tracked.done);
    return tracked;
  };
  return {
    call,
    started,
    budgetAtStart,
    factory,
    factoryScopes,
    releaseFactory,
    release: (key: string) => gates.get(key)?.(),
    async cleanup() {
      releaseFactory();
      for (let round = 0; round < 5; round++) {
        for (const release of gates.values())
          release();
        await vi.advanceTimersByTimeAsync(0);
      }
      await Promise.all(pending);
      await backend.dispose();
      expect(vi.getTimerCount()).toBe(0);
    },
  };
}

function textOf(outcome: Outcome | undefined): string {
  return (outcome?.content ?? []).map(part => part.type === 'text' ? part.text : '').join('\n');
}

let fixture: ReturnType<typeof createFixture> | undefined;

beforeEach(() => vi.useFakeTimers());

afterEach(async () => {
  try {
    await fixture?.cleanup();
  } finally {
    fixture = undefined;
    vi.restoreAllMocks();
    vi.useRealTimers();
  }
});

describe('one call at a time per session', () => {
  it('regression: a second call of the same session starts after the first result and keeps its own deadline', async () => {
    fixture = createFixture();
    const first = fixture.call('fixture_gate', 'session-a', { key: 'one', timeout: 10 });
    const second = fixture.call('fixture_gate', 'session-a', { key: 'two', timeout: 10 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(fixture.started).toEqual(['one']);

    fixture.release('one');
    await first.done;
    await vi.advanceTimersByTimeAsync(0);

    expect(fixture.started).toEqual(['one', 'two']);
    expect(fixture.budgetAtStart.get('two')).toBe(8000);
    fixture.release('two');
    await second.done;
    expect(textOf(second.outcome)).toContain('done two');
  });

  it('regression: a call still queued at its deadline reports the session as busy with the running tool', async () => {
    fixture = createFixture();
    fixture.call('fixture_gate', 'session-a', { key: 'one', timeout: 10 });
    const second = fixture.call('fixture_echo', 'session-a', { key: 'two', timeout: 2 });

    await vi.advanceTimersByTimeAsync(2000);

    expect(second.outcome).toMatchObject({ isError: true });
    expect(textOf(second.outcome)).toContain('Session busy: "fixture_gate" is still running');
    expect(fixture.started).toEqual(['one']);
  });

  it('regression: a call that gave up its place does not run later', async () => {
    fixture = createFixture();
    const first = fixture.call('fixture_gate', 'session-a', { key: 'one', timeout: 10 });
    fixture.call('fixture_echo', 'session-a', { key: 'two', timeout: 2 });
    const third = fixture.call('fixture_echo', 'session-a', { key: 'three', timeout: 10 });
    await vi.advanceTimersByTimeAsync(3000);

    fixture.release('one');
    await first.done;
    await third.done;

    expect(fixture.started).toEqual(['one', 'three']);
  });

  it('regression: two first calls of one session create one browser', async () => {
    fixture = createFixture({ holdFactory: true });
    const first = fixture.call('fixture_echo', 'session-new', { key: 'one' });
    const second = fixture.call('fixture_echo', 'session-new', { key: 'two' });
    await vi.advanceTimersByTimeAsync(0);

    fixture.releaseFactory();
    await first.done;
    await second.done;

    expect(fixture.factory).toHaveBeenCalledTimes(1);
    expect(fixture.started).toEqual(['one', 'two']);
  });

  it('regression: a timeout above 600 seconds is rejected with the unit stated', async () => {
    fixture = createFixture();

    const call = fixture.call('fixture_echo', 'session-a', { key: 'one', timeout: 601 });
    await call.done;

    expect(call.outcome).toMatchObject({ isError: true });
    expect(textOf(call.outcome)).toMatch(/seconds.*600/);
    expect(fixture.started).toEqual([]);
  });

  it('a timeout that is not a number is rejected the same way', async () => {
    fixture = createFixture();

    const call = fixture.call('fixture_echo', 'session-a', { key: 'one', timeout: 'soon' });
    await call.done;

    expect(call.outcome).toMatchObject({ isError: true });
    expect(textOf(call.outcome)).toMatch(/seconds.*600.*soon/);
    expect(fixture.started).toEqual([]);
  });

  it('control: another session is not delayed', async () => {
    fixture = createFixture();
    fixture.call('fixture_gate', 'session-a', { key: 'one', timeout: 10 });
    const other = fixture.call('fixture_echo', 'session-b', { key: 'two' });

    await other.done;

    expect(textOf(other.outcome)).toContain('done two');
    expect(fixture.started).toEqual(['one', 'two']);
  });

  it('control: the browser is created outside the call scope', async () => {
    fixture = createFixture();

    await fixture.call('fixture_echo', 'session-a', { key: 'one' }).done;

    expect(fixture.factoryScopes).toEqual([undefined]);
  });

  it('control: a timeout of 600 seconds is accepted', async () => {
    fixture = createFixture();

    const call = fixture.call('fixture_echo', 'session-a', { key: 'one', timeout: 600 });
    await call.done;

    expect(call.outcome?.isError).not.toBe(true);
    expect(textOf(call.outcome)).toContain('done one');
  });
});
